// Round state machine (P0).
//
// The six-step protocol is enforced here, not in a prompt: the single T0,
// per-signature failure counting, evidence layers bound to both a role and the
// T0, force-only escalation past a limit, six checks before a round may close,
// and an audit copy on disk. tools.js is a thin wrapper over these functions.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export const LIMITS = { testFailures: 3, fixes: 2, reruns: 2, restarts: 3 }

export const DEFAULT_BUDGET = {
  tokens: 0,
  fixes: LIMITS.fixes,
  reruns: LIMITS.reruns,
  restarts: LIMITS.restarts,
}

// Which role may write which evidence layer. This is the "分层证据" rule: a
// role can never widen its own claim into another layer.
export const LAYER_ROLES = {
  command: ['work', 'code'],
  artifact: ['work', 'code'],
  'self-report': ['plan', 'work', 'code', 'review'],
  review: ['review'],
}

export const GATE_KINDS = ['scope', 'budget', 'rule', 'accept', 'force']

const REJECTED = /^(拒绝|不行|不批准|驳回|reject|denied|no)$/i

export class ChainError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'ChainError'
    this.code = code
    this.extra = extra
  }
}

function fail(code, message, extra) {
  throw new ChainError(code, message, extra)
}

function nowIso() {
  return new Date().toISOString()
}

function shortId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/** Resolve the round by id, or the active one. Throws NO_ROUND when there is none. */
function roundOf(state, roundId) {
  const id = roundId ?? state.activeRoundId
  if (!id) fail('NO_ROUND', '当前没有轮次。plan 先调用 chain_open_round 开一轮。')
  const round = state.rounds[id]
  if (!round) fail('NO_ROUND', `找不到轮次 ${id}。`)
  return round
}

function assertOpen(round) {
  if (round.closedAt) fail('ROUND_CLOSED', `第 ${round.id} 轮已在 ${round.closedAt} 关闭，改事实请开新一轮。`)
}

function budgetOf(round) {
  return {
    tokens: Math.max(0, Number(round.budget?.tokens ?? 0)),
    testFailures: Math.max(1, Number(round.budget?.testFailures ?? LIMITS.testFailures)),
    fixes: Math.max(1, Number(round.budget?.fixes ?? LIMITS.fixes)),
    reruns: Math.max(1, Number(round.budget?.reruns ?? LIMITS.reruns)),
    restarts: Math.max(1, Number(round.budget?.restarts ?? LIMITS.restarts)),
  }
}

function validatePayload(layer, payload) {
  if (!payload || typeof payload !== 'object') fail('BAD_ARGS', `layer=${layer} 需要 payload 对象。`)
  if (layer === 'command') {
    if (typeof payload.command !== 'string' || !payload.command.trim())
      fail('BAD_ARGS', 'command 证据需要 {command, exitCode}：命令原文不能省。')
    if (typeof payload.exitCode !== 'number')
      fail('BAD_ARGS', 'command 证据需要数字 exitCode；没跑过的命令不算证据。')
    return
  }
  if (layer === 'artifact') {
    if (typeof payload.path !== 'string' || !payload.path.trim()) fail('BAD_ARGS', 'artifact 证据需要 {path}。')
    if (payload.bytes !== undefined && typeof payload.bytes !== 'number')
      fail('BAD_ARGS', 'artifact.bytes 必须是数字。')
    return
  }
  if (layer === 'self-report') {
    if (typeof payload.text !== 'string' || !payload.text.trim()) fail('BAD_ARGS', 'self-report 证据需要 {text}。')
    return
  }
  if (layer === 'review') {
    if (!['pass', 'fail', 'partial'].includes(payload.verdict))
      fail('BAD_ARGS', 'review 证据需要 verdict = pass | fail | partial。')
    if (!Array.isArray(payload.scope)) fail('BAD_ARGS', 'review 证据需要 scope 数组（通过范围）。')
    if (!Array.isArray(payload.uncovered) || payload.uncovered.length === 0)
      fail('BAD_ARGS', 'review 证据需要非空 uncovered 数组；没有未覆盖项就写 ["无"]。')
  }
}

const textOf = (chunk) => String(chunk?.text ?? '')
const isTruncated = (chunk) => chunk?.truncated === true || chunk?.spilled === true

async function gitOutput(ctx, cwd, args) {
  const subprocess = ctx?.subprocess
  if (subprocess && typeof subprocess.spawn === 'function') {
    try {
      const handle = subprocess.spawn({
        argv: ['git', ...args],
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 65536 } },
        graceMs: 5000,
      })
      await handle?.waitForExit?.()
      const chunk = handle?.collected?.stdout
      const body = chunk && typeof chunk.readFrom === 'function' ? chunk.readFrom(0) : chunk
      const exitCode = handle?.control?.exitCode ?? handle?.collected?.exitCode
      if (typeof exitCode === 'number' && exitCode !== 0) return null
      if (isTruncated(body)) return null
      return textOf(body)
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await runFile('git', args, { cwd, timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 })
    return stdout
  } catch {
    return null
  }
}

/** T0 facts, produced by this plugin running git itself — never by the model's claim. */
async function gitFacts(ctx, cwd) {
  const head = await gitOutput(ctx, cwd, ['rev-parse', 'HEAD'])
  const status = await gitOutput(ctx, cwd, ['status', '--porcelain'])
  if (head === null || status === null) return { mode: 'no-git', commit: null, dirty: null }
  return { mode: 'git', commit: head.trim() || null, dirty: status.trim().length > 0 }
}

// 1) 开轮 -------------------------------------------------------------------

export async function openRound(store, exec, args = {}) {
  const goal = String(args.goal ?? '').trim()
  if (!goal) fail('BAD_ARGS', 'goal 必填：一句话写清本轮要达成什么，之后按它验收。')
  const wanted = args.budget ?? {}
  return store.mutate((state) => {
    if (state.activeRoundId) {
      const active = state.rounds[state.activeRoundId]
      if (active && !active.closedAt)
        fail(
          'ROUND_ALREADY_OPEN',
          `第 ${active.id} 轮还没关闭（目标：${active.goal}）。先 chain_close_round，或 chain_status 看它卡在哪。`,
        )
    }
    const id = shortId('R')
    const budget = {
      tokens: Math.max(0, Number(wanted.tokens ?? DEFAULT_BUDGET.tokens)),
      fixes: Math.max(1, Number(wanted.fixes ?? DEFAULT_BUDGET.fixes)),
      reruns: Math.max(1, Number(wanted.reruns ?? DEFAULT_BUDGET.reruns)),
      restarts: Math.max(1, Number(wanted.restarts ?? DEFAULT_BUDGET.restarts)),
    }
    const round = {
      id,
      goal,
      openedAt: nowIso(),
      openedBy: { sessionId: exec.sessionId ?? 'unknown', agentPreset: exec.preset ?? null },
      budget,
      counters: { fixes: 0, reruns: 0, restarts: 0 },
      failures: {},
      evidence: [],
      gates: [],
      baseline: null,
      closeout: null,
      closedAt: null,
    }
    state.rounds[id] = round
    state.activeRoundId = id
    return {
      roundId: id,
      goal,
      budget,
      limits: LIMITS,
      next: '第 2 步：work 用 chain_freeze_baseline 冻结唯一 T0，然后才允许实施。',
    }
  })
}

// 2) 冻结唯一 T0 ------------------------------------------------------------

export async function freezeBaseline(ctx, store, exec, args = {}) {
  const facts = await gitFacts(ctx, exec.cwd)
  return store.mutate((state) => {
    const round = roundOf(state, args.roundId)
    assertOpen(round)
    if (round.baseline)
      fail(
        'BASELINE_ALREADY_FROZEN',
        `本轮 T0 已冻结在 ${round.baseline.t0Id}（commit ${round.baseline.commit ?? 'none'}）。T0 唯一，不重冻；换了基线就要开新一轮。`,
      )
    round.baseline = {
      t0Id: shortId('T0'),
      commit: facts.commit,
      dirty: facts.dirty,
      mode: facts.mode,
      frozenAt: nowIso(),
      frozenBySession: exec.sessionId ?? 'unknown',
    }
    return {
      roundId: round.id,
      baseline: round.baseline,
      next:
        facts.mode === 'git'
          ? 'T0 已钉住。之后的每条证据都会绑定这个 t0Id；全部实施基于它，不中途换基线。'
          : '项目不是 git 仓库，T0 只能记 no-git：证据照常绑定本轮，但无法用 commit 证明基线。收尾时 version.commit 写 "(no-git)"。',
    }
  })
}

// 2b) 核对基线 --------------------------------------------------------------

export async function checkBaseline(ctx, store, exec, args = {}) {
  const facts = await gitFacts(ctx, exec.cwd)
  return store.read((state) => {
    const round = roundOf(state, args.roundId)
    if (!round.baseline) fail('NO_BASELINE', '本轮还没有 T0。work 先 chain_freeze_baseline。')
    const t0 = round.baseline
    const commitChanged = facts.commit !== t0.commit
    const dirty = facts.dirty === true
    return {
      roundId: round.id,
      t0: { t0Id: t0.t0Id, commit: t0.commit, dirty: t0.dirty, mode: t0.mode, frozenAt: t0.frozenAt },
      now: facts,
      commitChanged,
      dirty,
      verdict: commitChanged ? 'baseline-moved' : dirty ? 'baseline-dirty' : 'clean',
      note: commitChanged
        ? 'HEAD 与本轮 T0 不一致：要么有人换了基线，要么这些证据不是同一轮的。先停下核对。'
        : dirty
          ? '工作区相对 T0 是脏的：这可能是本轮改动，但交付前必须交代改了什么。'
          : '工作区与 T0 一致。',
    }
  })
}

// 3) 限定修正：按签名累计 ----------------------------------------------------

const COUNTER_KEY = { fix: 'fixes', rerun: 'reruns', restart: 'restarts' }

export async function recordFailure(store, exec, args = {}) {
  const kind = String(args.kind ?? '')
  if (!['test', 'fix', 'rerun', 'restart'].includes(kind)) fail('BAD_ARGS', 'kind 必须是 test | fix | rerun | restart。')
  const signature = String(args.signature ?? (kind === 'test' ? '' : 'full')).trim()
  if (kind === 'test' && !signature)
    fail('BAD_ARGS', 'kind=test 必须带 signature（例如 pytest::test_login），否则认不出"同一个测试"。')
  const detail = args.detail === undefined ? undefined : String(args.detail).slice(0, 500)
  return store.mutate((state) => {
    const round = roundOf(state, args.roundId)
    assertOpen(round)
    const limits = budgetOf(round)

    let signatureCount = null
    if (kind === 'test') {
      const row = round.failures[signature] ?? { signature, count: 0, firstAt: nowIso(), lastAt: nowIso() }
      row.count += 1
      row.lastAt = nowIso()
      if (detail) row.lastDetail = detail
      round.failures[signature] = row
      signatureCount = row.count
    } else {
      const key = COUNTER_KEY[kind]
      round.counters[key] = (round.counters[key] ?? 0) + 1
    }

    let exceeded = null
    if (kind === 'test' && signatureCount >= limits.testFailures) exceeded = 'test'
    if (round.counters.fixes >= limits.fixes) exceeded = exceeded ?? 'fix'
    if (round.counters.reruns >= limits.reruns) exceeded = exceeded ?? 'rerun'
    if (round.counters.restarts >= limits.restarts) exceeded = exceeded ?? 'restart'

    return {
      roundId: round.id,
      kind,
      signature,
      signatureCount,
      counters: { ...round.counters },
      limits,
      exceeded,
      next: exceeded
        ? `已到上限（${exceeded}）：停手。要么缩小范围，要么让 plan 用 chain_gate kind=force 拿到用户批准才能继续；在此之前本轮无法关闭。`
        : '计数已记录，继续限定修正。',
    }
  })
}

// 4) 分层证据 ---------------------------------------------------------------

export async function recordEvidence(store, exec, args = {}) {
  const layer = String(args.layer ?? '')
  if (!LAYER_ROLES[layer]) fail('BAD_ARGS', `layer 必须是 ${Object.keys(LAYER_ROLES).join(' / ')}。`)
  const allowed = LAYER_ROLES[layer]
  if (!allowed.includes(exec.role))
    fail(
      'EVIDENCE_LAYER_MISMATCH',
      `layer=${layer} 只有 ${allowed.join(' / ')} 能写，当前角色是 ${exec.role ?? 'unknown'}。证据分层不能互相扩大：谁做的谁写。`,
    )
  const payload = args.payload
  validatePayload(layer, payload)
  return store.mutate((state) => {
    const round = roundOf(state, args.roundId)
    assertOpen(round)
    if (!round.baseline) fail('NO_BASELINE', '本轮还没有 T0，证据无法绑定基线。work 先 chain_freeze_baseline。')
    const evidence = {
      id: `${round.id}#e${round.evidence.length + 1}`,
      roundId: round.id,
      t0Id: round.baseline.t0Id,
      layer,
      authorRole: exec.role,
      authorSession: exec.sessionId ?? 'unknown',
      at: nowIso(),
      payload,
    }
    round.evidence.push(evidence)
    const byLayer = round.evidence.reduce((acc, item) => ({ ...acc, [item.layer]: (acc[item.layer] ?? 0) + 1 }), {})
    return { roundId: round.id, evidence, evidenceCount: round.evidence.length, byLayer }
  })
}

// 5) 门禁 -------------------------------------------------------------------

export async function askGate(ctx, store, exec, args = {}) {
  const question = String(args.question ?? '').trim()
  if (!question) fail('BAD_ARGS', 'question 必填：门禁是为了让用户拍板，不是让人猜。')
  const kind = String(args.kind ?? 'accept')
  if (!GATE_KINDS.includes(kind)) fail('BAD_ARGS', `kind 必须是 ${GATE_KINDS.join(' / ')}。`)
  const roundId = await store.read((state) => roundOf(state, args.roundId).id)

  if (!exec.isRoot) {
    return {
      ok: false,
      code: 'ESCALATE_TO_PARENT',
      roundId,
      kind,
      question,
      next: '子代理问不了人（宿主只允许根 agent 弹卡片）。把这个问题和证据带回 plan，让根 agent 用 chain_gate 问用户。',
    }
  }

  const questions = ctx?.userQuestions
  if (!questions || typeof questions.ask !== 'function')
    fail('NO_USER_QUESTIONS', '当前会话没有 userQuestions 服务，门禁弹不出卡片。把问题写进回复，等用户回答后再继续。')

  const item = { id: 'gate', question }
  if (args.detail) item.detail = String(args.detail)
  if (args.header) item.header = String(args.header)
  if (Array.isArray(args.options) && args.options.length)
    item.options = args.options.map((option) => ({
      label: String(option?.label ?? ''),
      ...(option?.description ? { description: String(option.description) } : {}),
    }))

  let answer
  try {
    answer = await questions.ask({ agent: exec.agent, questions: [item], items: [item] })
  } catch (err) {
    fail('GATE_FAILED', `门禁没拿到用户回答（${err?.code ?? 'error'}）：${err?.message ?? String(err)}`, {
      reason: err?.code ?? null,
    })
  }

  const answers = Array.isArray(answer?.answers) ? answer.answers : []
  const first = answers.find((entry) => entry?.id === 'gate') ?? answers[0] ?? {}
  const selected = Array.isArray(first.selected) ? first.selected : []
  const custom = typeof first.custom === 'string' ? first.custom.trim() : ''
  const decision = custom || selected.join(' / ') || '无回答'
  const approved = !REJECTED.test(decision)

  return store.mutate((state) => {
    const round = roundOf(state, roundId)
    assertOpen(round)
    const gate = {
      id: `${round.id}#g${round.gates.length + 1}`,
      roundId: round.id,
      kind,
      question,
      detail: item.detail ?? null,
      askedByRole: exec.role,
      askedBySession: exec.sessionId ?? 'unknown',
      at: nowIso(),
      decision,
      approved,
    }
    round.gates.push(gate)
    return {
      ok: true,
      roundId: round.id,
      gate,
      next: approved ? '用户已批准，按批准的边界继续。' : '用户没有批准：不要绕过，改方案或缩小范围再问。',
    }
  })
}

// 6) 交付并关闭 -------------------------------------------------------------

function exceededList(round) {
  const limits = budgetOf(round)
  const out = []
  for (const row of Object.values(round.failures ?? {}))
    if (row.count >= limits.testFailures) out.push(`test:${row.signature} ${row.count}/${limits.testFailures}`)
  if (round.counters.fixes >= limits.fixes) out.push(`fix ${round.counters.fixes}/${limits.fixes}`)
  if (round.counters.reruns >= limits.reruns) out.push(`rerun ${round.counters.reruns}/${limits.reruns}`)
  if (round.counters.restarts >= limits.restarts) out.push(`restart ${round.counters.restarts}/${limits.restarts}`)
  return out
}

export async function closeRound(store, exec, args = {}) {
  const closeout = args.closeout ?? {}
  return store.mutate(async (state) => {
    const round = roundOf(state, args.roundId)
    assertOpen(round)
    const problems = []

    if (!round.baseline) problems.push('本轮没有 T0：第 3 步之前必须先 chain_freeze_baseline。')

    const exceeded = exceededList(round)
    if (exceeded.length) {
      const forced = round.gates.some((gate) => gate.kind === 'force' && gate.approved === true)
      if (!forced)
        problems.push(`已越限但没有任何 force 门禁记录（${exceeded.join('；')}）：先 chain_gate kind=force 拿到用户批准。`)
    }

    if (!round.evidence.some((item) => item.layer === 'command'))
      problems.push('缺 command 证据：本轮没有任何一条真实命令记录（work/code 写）。')
    if (!round.evidence.some((item) => item.layer === 'review'))
      problems.push('缺 review 证据：独立终审没写结论（review 写）。')

    const version = closeout.version
    if (!version || typeof version !== 'object' || typeof version.commit !== 'string' || !version.commit.trim())
      problems.push('closeout.version.commit 必填（非 git 项目写 "(no-git)"）。')
    if (!['delivered', 'partial', 'blocked'].includes(closeout.result))
      problems.push('closeout.result 必须是 delivered | partial | blocked。')
    if (!Array.isArray(closeout.uncovered) || closeout.uncovered.length === 0)
      problems.push('closeout.uncovered 必须非空：没有未覆盖项就写 ["无"]。')
    if (closeout.servicesStopped !== true) problems.push('closeout.servicesStopped 必须是 true：本轮起的服务要停掉。')

    if (problems.length)
      fail('CLOSEOUT_REJECTED', `本轮还不能关闭（${problems.length} 项不满足）：\n- ${problems.join('\n- ')}`, {
        problems,
        exceeded,
      })

    const cost =
      typeof args.costOverride === 'number'
        ? { tokens: Math.max(0, args.costOverride), estimate: false, note: args.costNote ?? '人工覆盖' }
        : {
            tokens: Math.max(0, Number(closeout.cost?.tokens ?? 0)),
            estimate: closeout.cost?.estimate !== false,
            note: closeout.cost?.note ?? (closeout.cost ? undefined : '未提供费用数据'),
          }

    const final = {
      version: {
        commit: version.commit.trim(),
        ...(version.tag ? { tag: String(version.tag) } : {}),
        ...(version.artifact ? { artifact: String(version.artifact) } : {}),
      },
      result: closeout.result,
      uncovered: closeout.uncovered.map(String),
      cost,
      servicesStopped: true,
    }

    round.closeout = final
    round.closedAt = nowIso()
    if (state.activeRoundId === round.id) state.activeRoundId = null

    const auditPath = await store.exportRound(round)
    const layers = [...new Set(round.evidence.map((item) => item.layer))]
    const summary = [
      `第 ${round.id} 轮已关闭（目标：${round.goal}）`,
      `版本：${final.version.commit}${final.version.tag ? ` (${final.version.tag})` : ''}`,
      `结果：${final.result}`,
      `未覆盖项：${final.uncovered.join('；')}`,
      `费用：${final.cost.tokens} tokens${final.cost.estimate ? '（估算）' : '（人工）'}`,
      '服务：已停',
      `T0：${round.baseline.t0Id} @ ${round.baseline.commit ?? 'no-git'}`,
      `证据：${round.evidence.length} 条（${layers.join(' / ') || '无'}）`,
      `门禁：${round.gates.length} 条`,
      `审计副本：${auditPath}`,
    ].join('\n')

    return { ok: true, roundId: round.id, summary, auditPath, closeout: final }
  })
}

// 看板 ----------------------------------------------------------------------

export async function status(store, args = {}) {
  return store.read((state) => {
    const id = args.roundId ?? state.activeRoundId
    if (!id) {
      return {
        activeRoundId: null,
        rounds: Object.keys(state.rounds).length,
        note: '当前没有活跃轮次。plan 用 chain_open_round 开一轮。',
      }
    }
    const round = state.rounds[id]
    if (!round) fail('NO_ROUND', `找不到轮次 ${id}。`)
    const byLayer = round.evidence.reduce((acc, item) => ({ ...acc, [item.layer]: (acc[item.layer] ?? 0) + 1 }), {})
    return {
      roundId: round.id,
      goal: round.goal,
      activeRoundId: state.activeRoundId,
      openedAt: round.openedAt,
      openedBy: round.openedBy,
      closedAt: round.closedAt ?? null,
      baseline: round.baseline,
      budget: budgetOf(round),
      limits: LIMITS,
      counters: round.counters,
      failures: Object.values(round.failures ?? {}),
      exceeded: exceededList(round),
      evidence: { total: round.evidence.length, byLayer },
      gates: round.gates.map((gate) => ({
        id: gate.id,
        kind: gate.kind,
        decision: gate.decision,
        approved: gate.approved,
        at: gate.at,
      })),
      closeout: round.closeout,
    }
  })
}

export async function exportAudit(store, args = {}) {
  return store.read(async (state) => {
    const round = roundOf(state, args.roundId)
    const auditPath = await store.exportRound(round)
    return { roundId: round.id, auditPath, bytes: JSON.stringify(round).length }
  })
}
