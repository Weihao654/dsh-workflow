// The twelve chain_* tools.
//
// Every tool re-derives the caller's role from runtime facts before doing
// anything, so a wrong role gets a ROLE_DENIED error even though the schema is
// visible. P0 registers these globally (single instance, no per-preset rows);
// once §10.B/C are verified, P1 moves the registration into each preset so the
// wrong role has no tool at all.

import { resolveExec } from './roles.js'
import { forCwd } from './store.js'
import { describeRoutes, loadRoutes, saveRoleModels } from './role-models.js'
import { dispatch, readRoster, release } from './dispatch.js'
import * as svc from './service.js'

const ALL = ['plan', 'work', 'code', 'review']

function text(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: text(value) }],
}

function define(ctx, spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: OUTPUT,
    async execute(args, exec) {
      const runner = resolveExec(ctx, exec)
      if (!runner.role) {
        throw new Error(
          `ROLE_DENIED: ${spec.name} 只用于角色链（plan/work/code/review）。当前 preset = ${runner.preset ?? 'unknown'}。`,
        )
      }
      if (spec.roles && !spec.roles.includes(runner.role)) {
        throw new Error(`ROLE_DENIED: ${spec.name} 只给 ${spec.roles.join(' / ')}，当前角色是 ${runner.role}。`)
      }
      const store = forCwd(runner.cwd)
      // Reuse policy rides along with the caller, so dispatch() never re-reads the
      // file and a policy edit applies to the next handoff, not the next restart.
      runner.reuse = loadRoutes(runner.cwd).reuse
      return spec.run({ ctx, store, exec: runner, args: args ?? {} })
    },
  }
}

const ROUND_ID = {
  roundId: {
    type: 'string',
    description: '轮次 id。省略则用当前活跃轮次。',
  },
}

export function registerTools(ctx, options = {}) {
  const tracker = options.tracker
  const disposers = []

  const push = (spec) => {
    const definition = define(ctx, spec)
    const disposer = ctx.tools.register(definition)
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  push({
    name: 'chain_open_round',
    description:
      '开启一轮角色链工作：记录目标与预算（token / 修正 / 重跑 / 重启上限），并把它设为当前活跃轮次。已有一轮未关闭时拒绝。',
    roles: ['plan'],
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '本轮目标，一句话，可验收。' },
        budget: {
          type: 'object',
          description: '可选。省略则用协议默认上限。',
          properties: {
            tokens: { type: 'number', description: '本轮 token 预算，0 表示未声明。' },
            fixes: { type: 'number', description: '修正次数上限，默认 2。' },
            reruns: { type: 'number', description: '全量重跑上限，默认 2。' },
            restarts: { type: 'number', description: '服务重启上限，默认 3。' },
          },
        },
      },
      required: ['goal'],
    },
    run: ({ store, exec, args }) => svc.openRound(store, exec, args),
  })

  push({
    name: 'chain_freeze_baseline',
    description:
      '冻结本轮唯一的 T0：插件自己跑 git rev-parse HEAD 与 git status --porcelain，不听模型自述。已冻结则报 BASELINE_ALREADY_FROZEN。',
    roles: ['work'],
    parameters: { type: 'object', properties: { ...ROUND_ID } },
    run: ({ ctx, store, exec, args }) => svc.freezeBaseline(ctx, store, exec, args),
  })

  push({
    name: 'chain_check_baseline',
    description: '对比当前工作区与本轮 T0：commit 是否变了、是否脏。没有 T0 时报 NO_BASELINE。',
    roles: ALL,
    parameters: { type: 'object', properties: { ...ROUND_ID } },
    run: ({ ctx, store, exec, args }) => svc.checkBaseline(ctx, store, exec, args),
  })

  push({
    name: 'chain_record_failure',
    description:
      '按签名累计失败/修正/重跑/重启次数。同一个测试第三次失败会被识别（signature 相同即同一测试），越限后本轮将无法关闭，除非先有一条 force 门禁记录。',
    roles: ['work', 'code'],
    parameters: {
      type: 'object',
      properties: {
        ...ROUND_ID,
        kind: { type: 'string', enum: ['test', 'fix', 'rerun', 'restart'], description: '计数类别。' },
        signature: { type: 'string', description: 'test 类必填，例如 pytest::test_login。rerun/restart 可省略（记为 full）。' },
        detail: { type: 'string', description: '可选，失败摘要，会截断到 500 字符。' },
      },
      required: ['kind'],
    },
    run: ({ store, exec, args }) => svc.recordFailure(store, exec, args),
  })

  push({
    name: 'chain_record_evidence',
    description:
      '记一条分层证据。层与角色绑定：command/artifact 只有 work/code 能写，review 层只有 review 能写，self-report 谁都能写但会被标记为未经独立验证。证据自动绑定本轮 T0。',
    roles: ALL,
    parameters: {
      type: 'object',
      properties: {
        ...ROUND_ID,
        layer: { type: 'string', enum: ['command', 'artifact', 'self-report', 'review'], description: '证据层级。' },
        payload: {
          type: 'object',
          description:
            'command: {command, exitCode, outputDigest?}；artifact: {path, bytes?, sha256?}；self-report: {text}；review: {verdict: pass|fail|partial, scope: string[], uncovered: string[]}',
        },
      },
      required: ['layer', 'payload'],
    },
    run: ({ store, exec, args }) => svc.recordEvidence(store, exec, args),
  })

  push({
    name: 'chain_gate',
    description:
      '阻塞式门禁：弹出问题等用户回答，并把决定写入本轮记录。只有根 agent 能真正问人；子代理调用会返回 ESCALATE_TO_PARENT，要求把问题带回 plan。',
    roles: ALL,
    parameters: {
      type: 'object',
      properties: {
        ...ROUND_ID,
        kind: { type: 'string', enum: ['scope', 'budget', 'rule', 'accept', 'force'], description: '门禁类型。' },
        question: { type: 'string', description: '要用户拍板的问题。' },
        detail: { type: 'string', description: '可选，补充说明或选项背景。' },
        header: { type: 'string', description: '可选，卡片标题。' },
        options: {
          type: 'array',
          description: '可选，给用户点选的选项。',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, description: { type: 'string' } },
            required: ['label'],
          },
        },
      },
      required: ['question'],
    },
    run: ({ ctx, store, exec, args }) => svc.askGate(ctx, store, exec, args),
  })

  push({
    name: 'chain_close_round',
    description:
      '关闭本轮并产出结论。六项校验：T0 存在、越限有 force 记录、至少一条 command 证据、至少一条 review 证据、closeout 字段齐全、服务已停。通过后自动导出 .dsh/rounds/<roundId>.json。',
    roles: ['plan'],
    parameters: {
      type: 'object',
      properties: {
        ...ROUND_ID,
        closeout: {
          type: 'object',
          properties: {
            version: {
              type: 'object',
              properties: { commit: { type: 'string' }, tag: { type: 'string' }, artifact: { type: 'string' } },
              description: '交付版本。commit 必填（非 git 项目写 "(no-git)"）。',
            },
            result: { type: 'string', enum: ['delivered', 'partial', 'blocked'] },
            uncovered: { type: 'array', items: { type: 'string' }, description: '未覆盖项，没有就写 ["无"]。' },
            servicesStopped: { type: 'boolean', description: '本轮起的服务是否已停。必须是 true。' },
            cost: {
              type: 'object',
              properties: { tokens: { type: 'number' }, estimate: { type: 'boolean' }, note: { type: 'string' } },
            },
          },
          required: ['version', 'result', 'uncovered', 'servicesStopped'],
        },
        costOverride: { type: 'number', description: '可选，人工填的费用，会覆盖估算值并标记 estimate=false。' },
        costNote: { type: 'string', description: '可选，费用来源说明。' },
      },
      required: ['closeout'],
    },
    run: ({ store, exec, args }) => svc.closeRound(store, exec, args),
  })

  push({
    name: 'chain_dispatch',
    description:
      '把任务交给一个角色，并按 reuse 策略决定复用已有子代理还是新建。plan 可派 work；work 可派 code / review。复用是真复用：同一个子代理会话继续，不重建上下文、不重复传授背景。返回值里的 action 是 spawn 还是 reuse。',
    roles: ['plan', 'work'],
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['work', 'code', 'review'], description: '交给哪个角色。' },
        task: { type: 'string', description: '任务说明。复用时会作为一条新消息发给该角色已有的子代理。' },
        family: {
          type: 'string',
          description: '可选：任务族（只对 code 有意义）。同一个 family 复用同一个 code 子代理，不同 family 各一个。缺省 default。',
        },
        fresh: { type: 'boolean', description: '可选：强制新建，无视 reuse 策略（review 的独立审核通常这样用）。' },
        maxDepth: { type: 'number', description: '可选：派发深度上限，默认 2（plan→work→code）。' },
      },
      required: ['role', 'task'],
    },
    run: ({ ctx, store, exec, args }) => dispatch(ctx, store, exec, args),
  })

  push({
    name: 'chain_release',
    description:
      '释放并移除名册里的子代理（常驻的 work、按族的 code）。只有派发它的那个会话能释放。省略 role 表示全部释放。释放后下次派发会新建。',
    roles: ['plan', 'work'],
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['work', 'code', 'review'], description: '可选：释放哪个角色。省略表示全部。' },
        family: { type: 'string', description: '可选：只释放这个任务族的 code 子代理。' },
      },
    },
    run: ({ ctx, store, exec, args }) => release(ctx, store, exec, args),
  })

  push({
    name: 'chain_status',
    description:
      '只读看板：当前轮次、T0、预算与计数、失败签名、证据与门禁、角色名册（哪些角色有常驻子代理），以及角色→模型映射（含本会话实际生效的那条）。',
    roles: ALL,
    parameters: { type: 'object', properties: { ...ROUND_ID } },
    run: async ({ ctx, store, exec, args }) => {
      const board = svc.status(store, args)
      board.roleModels = describeRoutes(ctx, exec, tracker)
      board.agents = await readRoster(store)
      return board
    },
  })

  push({
    name: 'chain_export_audit',
    description: '把一轮的完整记录导出成 .dsh/rounds/<roundId>.json，供人审计。',
    roles: ['plan'],
    parameters: { type: 'object', properties: { ...ROUND_ID } },
    run: ({ store, args }) => svc.exportAudit(store, args),
  })

  push({
    name: 'chain_role_models',
    description:
      '读或改本项目的「角色→模型」表（写入 <cwd>/.dsh/role-chain.json，下一轮请求即生效，无需重启）。带 listModels:true 可先列出可选模型。改模型只能由根会话（plan）发起；子代理请把请求带回 plan。',
    roles: ALL,
    parameters: {
      type: 'object',
      properties: {
        set: {
          type: 'object',
          description: '要写入的角色映射，例如 { "code": { "provider": "openai", "model": "gpt-6-luna", "reasoningEffort": "low" } }。',
          additionalProperties: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string', description: '可选：minimal / low / medium / high 等，模型支持什么就写什么。' },
            },
            required: ['provider', 'model'],
          },
        },
        clear: { type: 'array', items: { type: 'string' }, description: '要删除的角色，例如 ["review"]。' },
        enabled: { type: 'boolean', description: '可选：整体开关。false 时路由暂停，表保留。' },
        listModels: {
          type: 'boolean',
          description: '可选：只读，列出当前可选的 provider 与其模型 id（与界面模型选择器同源）。写表前不知道该填什么时先调这个。',
        },
        skipValidation: {
          type: 'boolean',
          description: '可选：跳过写前校验。默认会先问 llm.resolveModelInfo，provider/model 不存在或 effort 不被接受就拒写。',
        },
      },
    },
    run: async ({ ctx, exec, args }) => {
      if (args.listModels) {
        const llm = serviceOf(ctx, 'llm')
        if (!llm) return { ok: false, error: 'llm 服务不可用，读不到模型清单' }
        try {
          const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
          const out = []
          for (const provider of providers) {
            let models = []
            try {
              models = await llm.listModels(provider.id)
            } catch (error) {
              out.push({ provider: provider.id, name: provider.name, error: error.message, models: [] })
              continue
            }
            const rows = []
            for (const model of models) {
              const row = { id: model.id, name: model.name }
              // The efforts this model advertises, so a `set` never names one the
              // validator would then refuse (deepseek-flash has no "medium").
              if (typeof llm.resolveModelInfo === 'function') {
                try {
                  const info = await llm.resolveModelInfo(provider.id, model.id)
                  const efforts = info?.reasoning?.efforts
                  if (Array.isArray(efforts)) row.efforts = efforts.map((effort) => String(effort?.id ?? effort))
                  if (info?.reasoning?.defaultEffort) row.defaultEffort = String(info.reasoning.defaultEffort)
                } catch {
                  // a model that cannot be resolved simply lists without efforts
                }
              }
              rows.push(row)
            }
            out.push({ provider: provider.id, name: provider.name, models: rows })
          }
          return {
            ok: true,
            providers: out,
            note: '把这些 id 填进 set 就能用；reasoningEffort 只能在 efforts 里选。写错了不会自动降级，调用会直接失败。',
            effective: describeRoutes(ctx, exec, tracker),
          }
        } catch (error) {
          return { ok: false, error: error.message }
        }
      }
      const writes = Boolean(args.set || args.clear || typeof args.enabled === 'boolean')
      if (writes && !exec.isRoot) {
        return {
          ok: false,
          code: 'ESCALATE_TO_PARENT',
          message: '改角色→模型表要由根会话（plan）发起；子代理请把改动带回 plan。',
          current: describeRoutes(ctx, exec, tracker),
        }
      }
      if (!writes) return describeRoutes(ctx, exec, tracker)
      if (!args.skipValidation) {
        const problems = await validateRoutes(ctx, args.set)
        if (problems.length > 0) {
          return {
            ok: false,
            code: 'ROUTE_UNKNOWN',
            path: describeRoutes(ctx, exec, tracker).configPath,
            errors: problems,
            hint: '写错不会自动降级，那一环会直接失败，所以先拒写。确认要用就带 skipValidation:true。',
            current: describeRoutes(ctx, exec, tracker),
          }
        }
      }
      const saved = saveRoleModels(exec.cwd, { set: args.set, clear: args.clear, enabled: args.enabled })
      if (!saved.ok) return { ok: false, path: saved.path, errors: saved.errors }
      return {
        ok: true,
        path: saved.path,
        document: saved.document,
        note: '已写入。从下一次模型请求起生效；如果本会话在浏览器里手动选过模型，手选优先。',
        effective: describeRoutes(ctx, exec, tracker),
      }
    },
  })

  return () => {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Read a service without tripping the Cordis inject guard: property access to a
 * service the fiber did not inject throws, while `ctx.get()` is always legal.
 */
export function serviceOf(ctx, name) {
  try {
    const viaGet = ctx.get?.(name)
    if (viaGet) return viaGet
  } catch {
    // get() unavailable — fall through
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Ask the LLM registry whether each candidate route really exists, and whether
 * the model accepts the requested reasoning effort.
 *
 * The routing contract has no soft landing: an unsupported provider/model or an
 * effort the model does not advertise fails that call outright, and a chain
 * fails at the step that needed it. A typo is cheap to prevent here and
 * expensive to diagnose mid-round, so a write is refused unless it validates.
 */
export async function validateRoutes(ctx, routes) {
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') return []
  if (!routes || typeof routes !== 'object') return []

  const problems = []
  for (const [role, route] of Object.entries(routes)) {
    if (!route || typeof route !== 'object') continue
    const provider = typeof route.provider === 'string' ? route.provider.trim() : ''
    const model = typeof route.model === 'string' ? route.model.trim() : ''
    if (!provider || !model) continue // normalizeRoleModels already reports these

    let info
    try {
      info = await llm.resolveModelInfo(provider, model)
    } catch (error) {
      problems.push(`${role}: ${provider}/${model} 不可用（${error?.message ?? error}）`)
      continue
    }

    const efforts = Array.isArray(info?.reasoning?.efforts)
      ? info.reasoning.efforts.map((entry) => String(entry?.id ?? '')).filter(Boolean)
      : []
    const effort = typeof route.reasoningEffort === 'string' ? route.reasoningEffort.trim() : ''
    if (effort && efforts.length > 0 && !efforts.includes(effort)) {
      problems.push(`${role}: ${provider}/${model} 不接受 reasoningEffort="${effort}"（可用：${efforts.join(' / ')}）`)
    }
  }
  return problems
}
