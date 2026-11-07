import { resolveExec } from './roles.js'
import { forCwd } from './store.js'
import { describeRoutes, loadRoutes, saveRoleModels } from './role-models.js'
import { lossless } from './lossless.js'
import { dispatch, readRoster, release } from './dispatch.js'
import { serviceOf } from './host.js'
import * as svc from './service.js'
export { serviceOf }
const ALL = ['plan', 'work', 'code', 'review']
const S = description => ({ type: 'string', description })
const ROUND_ID = { roundId: S('省略使用当前轮次；不会因此创建或重置轮次。') }
const PHASE = { phase: S('沿用本轮阶段，或指定本次执行的阶段；不会重置 T0、期限或累计用量。') }
const OUTPUT = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }

export function registerTools(ctx, options = {}) {
  const { tracker, controller } = options, disposers = []
  const push = spec => {
    const definition = { name: spec.name, description: spec.description,
      parameters: { type: 'object', properties: spec.properties ?? {}, ...(spec.required ? { required: spec.required } : {}) },
      output: OUTPUT,
      async execute(args, raw) {
        const exec = resolveExec(ctx, raw)
        if (!exec.role || !spec.roles.includes(exec.role)) throw new Error(`ROLE_DENIED: ${spec.name} requires ${spec.roles.join('/')}; actual preset=${exec.preset ?? 'unknown'}.`)
        const store = controller ? controller.storeForExec(exec) : forCwd(exec.cwd)
        controller?.assertSessionLocation(store, exec)
        if (spec.name !== 'chain_role_models' && controller?.isWorkflowSession(exec, store))
          return { ok: false, code: 'NATIVE_WORKFLOW', message: '当前 plan 直接使用原生工具：plan 调用 dispatch_work，work 调用 dispatch_code / dispatch_review，同任务使用 send_message 继续现有子会话。无需开启受控轮次或填写预算。' }
        exec.reuse = loadRoutes(exec.cwd).reuse
        exec.controller = controller
        if (controller) await controller.attach(store, exec)
        return spec.run({ ctx, exec, store, args: args ?? {} })
      } }
    const dispose = ctx.tools.register(definition)
    controller?.registerDefinition(definition)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  push({ name: 'chain_open_round', roles: ['plan'], description: '开启可验收的一轮并登记总预算；已有未关闭轮次则拒绝。仅实际根 plan 可开轮。',
    properties: { goal: S('可验收的目标。'), scope: S('授权范围；省略沿用目标。'),
      budget: { type: 'object', properties: {
        requests: { type: 'integer', minimum: 1, description: '本轮全角色可观测模型尝试总上限，默认16；失败、取消和重试不返还名额。' },
        tokens: { type: 'integer', minimum: 0, description: '本轮全角色累计 token 额度，包含缓存；输入为估算准入，不是硬 token 封顶。0 表示未声明。' },
        wallMinutes: { type: 'number', minimum: 0.001, maximum: 90, description: '原始 T0 起的总分钟数，默认90；可缩短测试，不可延长或重置。' },
        outputCap: { type: 'integer', minimum: 1, description: '每次请求的输出 token 上限，默认2048；输入另作估算预留。' },
        fixes: { type: 'integer', minimum: 0 }, reruns: { type: 'integer', minimum: 0 }, restarts: { type: 'integer', minimum: 0 },
      } } }, required: ['goal'], run: async ({ store, exec, args }) => {
        const result = await svc.openRound(store, exec, args)
        await controller?.attach(store, exec)
        if (controller) { const e = await store.read(s => s.rounds[result.roundId].executions[s.sessionBindings[exec.sessionId].executionId]); controller.watchIdle(store, e, exec.agent) }
        return result
      } })
  push({ name: 'chain_freeze_baseline', roles: ['work'], description: '读取真实 Git 事实并冻结唯一 T0及绝对期限；无法读取不冒充 no-git。',
    properties: ROUND_ID, run: ({ ctx, store, exec, args }) => svc.freezeBaseline(ctx, store, exec, args) })
  push({ name: 'chain_check_baseline', roles: ALL, description: '只读比较当前 Git事实与原始 T0；不重冻、不重置期限。', properties: ROUND_ID,
    run: ({ ctx, store, exec, args }) => svc.checkBaseline(ctx, store, exec, args) })
  push({ name: 'chain_record_failure', roles: ['work', 'code'], description: '累计同签名失败与修正/重跑/重启次数；不清零历史计数。',
    properties: { ...ROUND_ID, kind: { type: 'string', enum: ['test', 'fix', 'rerun', 'restart'] },
      signature: S('test 必填稳定测试签名；其他省略记 full。'), detail: S('失败摘要，最多保存500字符。') }, required: ['kind'],
    run: ({ store, exec, args }) => svc.recordFailure(store, exec, args) })
  push({ name: 'chain_record_evidence', roles: ALL, description: '按调用者实际角色记录最小证据，自动绑定原始 T0与执行代际；自述不是独立验证。',
    properties: { ...ROUND_ID, layer: { type: 'string', enum: ['command', 'artifact', 'self-report', 'review'] },
      payload: { type: 'object', description: 'command:{jobId}（必填绑定）：jobId 填 chain_compute 返回的 jobId 或其 executionId；command/exitCode/outcome/argv 一律从该 job 的账本记录与原生回执推导，补齐值仅在完全一致时才接受，不匹配即 EVIDENCE_MISMATCH；无 jobId 的自填 command+exitCode 一律拒绝（COMMAND_BINDING_REQUIRED，自述不能当回执）。返回 payload 另含 jobId(executionId)、hostJobId、argv（调用方请求的 argv 数组）/executedArgv（受限后实际调度的 argv 数组，执行事实）、executedCommand（展示串）与 ownerSessionId/parentExecutionId（来源）。artifact:{path}；self-report:{text}；review:{verdict:pass|fail|partial,scope:[],uncovered:[]}。' } },
    required: ['layer', 'payload'], run: ({ store, exec, args }) => svc.recordEvidence(store, exec, args) })
  push({ name: 'chain_dispatch', roles: ['plan', 'work'], description: '受控派发：plan→同轮work，work→按族code/独立review。同轮跨阶段复用，忙或取消时不另开替身；返回确切执行代际。',
    properties: { ...ROUND_ID, ...PHASE, role: { type: 'string', enum: ['work', 'code', 'review'] }, task: S('本次任务/差量指令。'),
      family: S('按族复用的稳定任务族，默认default。'), fresh: { type: 'boolean', description: '仅review可设true；work/code不得用新建绕过忙碌或取消记录。' },
      maxDepth: { type: 'integer', minimum: 1, description: '绝对委派深度上限，默认2。' }, waitMs: { type: 'integer', minimum: 0, maximum: 600000, description: 'bounded in-call wait: polls the local ledger only, never a model request; returns settled:false on timeout' } }, required: ['role', 'task'],
    run: ({ ctx, store, exec, args }) => dispatch(ctx, store, exec, args) })
  push({ name: 'chain_compute', roles: ['work', 'code'], description: '仅在完整只读隔离可用时启动本机Windows受控计算；partial或缺失隔离直接拒绝，不得裸shell/远程回退。原始T0期限不重置。',
    properties: { ...ROUND_ID, ...PHASE, argv: { type: 'array', items: { type: 'string' }, minItems: 1,
      description: '程序及逐项参数；不是shell字符串。当前仅支持本机Windows。' }, label: S('简短任务名。'), waitMs: { type: 'integer', minimum: 0, maximum: 600000, description: '有界同调用等待：优先宿主 job 完成通知，回退本地账本轮询，绝不产生模型请求；超时返回 settled:false。省略时访客运行器默认等待45000ms，0表示不等待。' } }, required: ['argv'],
    run: ({ store, exec, args }) => { if (!controller) throw new Error('NO_CONTROLLER'); return controller.compute(store, exec, args) } })
  push({ name: 'chain_stop', roles: ALL, description: '持久化停止意图后取消自有执行，分别确认Agent/计算退出；原生启动封闭可能仍pending。accepted或无活跃项不等于已停。',
    properties: { ...ROUND_ID, requestId: S('调用方稳定请求id，重试沿用；不得给不同停止请求复用id。'), reason: S('撤销原因。'),
      executionId: S('省略停止整轮；指定时必须同时给原执行generation。'), generation: { type: 'integer', minimum: 1 },
      waitMs: { type: 'integer', minimum: 0, maximum: 1000, description: '有界确认等待，默认500ms；超时仍持久化待确认。' } },
    required: ['requestId', 'reason'], run: ({ store, exec, args }) => { if (!controller) throw new Error('NO_CONTROLLER'); return controller.stop(store, exec, args) } })
  push({ name: 'chain_release', roles: ['plan', 'work'], description: '停止并确认自有子代理退出后移除复用名册；未知不删除。省略role/family覆盖自己的全部匹配子代理。',
    properties: { role: { type: 'string', enum: ['work', 'code', 'review'] }, family: S('限定任务族；省略不漏掉其他code族。') },
    run: ({ ctx, store, exec, args }) => release(ctx, store, exec, args) })
  push({ name: 'chain_status', roles: ALL, description: '默认六字段短卡：目标/T0、执行/停止、预算、关键交付、实际阻塞、下一步。退出证据与累计用量缺失明确标unknown/pending；full才展开。',
    properties: { ...ROUND_ID, detail: { type: 'string', enum: ['brief', 'full'], description: '默认brief；full包含账本/名册/门禁/逐执行证据。' } },
    run: async ({ ctx, store, exec, args }) => {
      if (controller) { const id = await store.read(s => args.roundId ?? s.activeRoundId); if (id) await controller.refresh(store, id) }
      const board = await svc.status(store, args)
      if (args.detail === 'full') { board.roleModels = describeRoutes(ctx, exec, tracker); board.agents = await readRoster(store) }
      return lossless(board)
    } })
  push({ name: 'chain_gate', roles: ALL, description: '仅具体的新范围/预算/业务规则/权限变更交用户；子代理通过原work上交plan。NOT_GATED不是安全许可，技术问题由work处理或暂停受阻步；accept仅收尾。',
    properties: { ...ROUND_ID, kind: { type: 'string', enum: ['scope', 'budget', 'rule', 'accept', 'force'] }, question: S('需要用户拍板的具体决定。'),
      classification: { type: 'string', enum: ['scope', 'budget', 'business-rule', 'new-authority', 'unchanged-premise', 'authorized-technical', 'blocker', 'closeout'] },
      change: S('具体变化，不要泛问是否继续。'), originalAuthorization: S('引用原授权/规则。'), whyNotCovered: S('为什么现有授权不能覆盖。'),
      stage: S('accept 必须为closeout。'), affectedStep: S('技术阻塞只暂停这个步骤/阶段。'), header: S('卡片短标题。'),
      options: { type: 'array', items: { type: 'object', properties: { label: S('明确批准/拒绝；模糊回答不授新权。'), description: S('选择影响。') }, required: ['label'] } } },
    required: ['question', 'classification'], run: ({ ctx, store, exec, args }) => svc.askGate(ctx, store, exec, args) })
  push({ name: 'chain_close_round', roles: ['plan'], description: '校验T0、分层证据、失败授权与真实Agent/job退出后关闭并导出。servicesStopped自述不能替代退出证据，费用未知不能填0。',
    properties: { ...ROUND_ID, closeout: { type: 'object', properties: {
      version: { type: 'object', properties: { commit: S('实际交付commit，非git写(no-git)。'), tag: S('可选tag。'), artifact: S('交付物。') }, required: ['commit'] },
      result: { type: 'string', enum: ['delivered', 'partial', 'blocked'] }, uncovered: { type: 'array', items: { type: 'string' } }, servicesStopped: { type: 'boolean' },
    }, required: ['version', 'result', 'uncovered', 'servicesStopped'] } }, required: ['closeout'],
    run: ({ store, exec, args }) => svc.closeRound(store, exec, args) })
  push({ name: 'chain_export_audit', roles: ['plan'], description: '仅显式需要时导出完整轮次记录；常规汇报用短状态卡，不追加审计套审计。', properties: ROUND_ID,
    run: ({ store, args }) => svc.exportAudit(store, args) })
  push({ name: 'chain_role_models', roles: ALL, description: '读/改项目内角色模型与reuse表，下一请求生效，手选模型优先。写仅根plan；listModels按真实模型列出efforts。',
    properties: { set: { type: 'object', additionalProperties: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: S('使用该模型真实支持的effort id。') }, required: ['provider', 'model'] } },
      clear: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, reuse: { type: 'object', description: 'work仅persistent；code为family或persistent；review仅fresh；null清除覆盖。', additionalProperties: { type: ['string', 'null'] } },
      listModels: { type: 'boolean' }, skipValidation: { type: 'boolean', description: '显式跳过模型身份校验；不跳过角色和参数校验。' } },
    run: async ({ ctx, exec, args }) => {
      if (args.listModels) {
        const llm = serviceOf(ctx, 'llm')
        if (!llm) return { ok: false, error: 'llm 服务不可用' }
        const providers = []
        for (const provider of llm.listProviders()) {
          const providerId = provider.provider
          try {
            const models = []
            for (const model of await llm.listModels(providerId)) {
              const row = { id: model.id, name: model.name }
              try { const info = await llm.resolveModelInfo(providerId, model.id); if (info?.reasoning?.efforts) row.efforts = info.reasoning.efforts.map(e => String(e.id ?? e)); if (info?.reasoning?.defaultEffort) row.defaultEffort = String(info.reasoning.defaultEffort) } catch {}
              models.push(row)
            }
            providers.push({ provider: providerId, name: provider.displayName, models })
          } catch (error) { providers.push({ provider: providerId, error: error.message, models: [] }) }
        }
        return { ok: true, providers, effective: describeRoutes(ctx, exec, tracker) }
      }
      const writes = Boolean(args.set || args.clear || args.reuse || typeof args.enabled === 'boolean')
      if (writes && (!exec.isRoot || exec.role !== 'plan')) return { ok: false, code: 'ESCALATE_TO_PARENT', message: 'Only the root plan may change routes/reuse.' }
      if (!writes) return describeRoutes(ctx, exec, tracker)
      const errors = args.skipValidation ? [] : await validateRoutes(ctx, args.set)
      if (errors.length) return { ok: false, code: 'ROUTE_UNKNOWN', errors }
      const saved = saveRoleModels(exec.cwd, { set: args.set, clear: args.clear, reuse: args.reuse, enabled: args.enabled })
      return { ...saved, effective: describeRoutes(ctx, exec, tracker) }
    } })
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
export async function validateRoutes(ctx, routes) {
  const llm = serviceOf(ctx, 'llm'), problems = []
  if (!llm?.resolveModelInfo || !routes || typeof routes !== 'object') return problems
  for (const [role, route] of Object.entries(routes)) {
    if (!route?.provider || !route?.model) continue
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      const efforts = info?.reasoning?.efforts?.map(e => String(e.id ?? e)) ?? []
      if (route.reasoningEffort && !efforts.includes(route.reasoningEffort)) problems.push(`${role}: ${route.provider}/${route.model} 不接受 reasoningEffort="${route.reasoningEffort}"（可用：${efforts.join(' / ')}）`)
    } catch (error) { problems.push(`${role}: ${route.provider}/${route.model} 不可用（${error.message}）`) }
  }
  return problems
}
