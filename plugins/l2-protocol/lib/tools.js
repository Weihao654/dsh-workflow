// The nine chain_* tools.
//
// Every tool re-derives the caller's role from runtime facts before doing
// anything, so a wrong role gets a ROLE_DENIED error even though the schema is
// visible. P0 registers these globally (single instance, no per-preset rows);
// once §10.B/C are verified, P1 moves the registration into each preset so the
// wrong role has no tool at all.

import { resolveExec } from './roles.js'
import { forCwd } from './store.js'
import { describeRoutes } from './role-models.js'
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
    name: 'chain_status',
    description:
      '只读看板：当前轮次、T0、预算与计数、失败签名、证据与门禁，以及角色→模型映射（含本会话实际生效的那条）。',
    roles: ALL,
    parameters: { type: 'object', properties: { ...ROUND_ID } },
    run: ({ ctx, store, exec, args }) => {
      const board = svc.status(store, args)
      board.roleModels = describeRoutes(ctx, exec, tracker)
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
