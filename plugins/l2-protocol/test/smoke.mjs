// Functional smoke test for the round state machine, without the host.
// Runs the real service.js + store.js against a fake ctx (a subprocess whose
// spawn always throws, so the baseline falls back to no-git deterministically —
// whether or not this checkout happens to sit inside a git repository) and a
// fake userQuestions.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as svc from '../lib/service.js'
import { RoundStore } from '../lib/store.js'

const DIR = join(process.cwd(), '.smoke')
await rm(DIR, { recursive: true, force: true })

const store = new RoundStore(DIR)
const ctx = {
  subprocess: {
    spawn() {
      throw new Error('no subprocess available in this test')
    },
  },
  userQuestions: {
    async ask(req) {
      ctx.lastAsk = req
      return { answers: [{ id: 'gate', selected: ['批准'] }] }
    },
  },
}

const mk = (role, isRoot = false) => ({ agent: { id: `agent-${role}` }, role, isRoot, preset: role, sessionId: `s-${role}`, cwd: DIR })
const plan = mk('plan', true)
const work = mk('work')
const code = mk('code')
const review = mk('review')

let pass = 0
let fail = 0

function check(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

async function expectCode(label, code, fn) {
  try {
    await fn()
    check(label, false, `expected ${code}, got success`)
  } catch (err) {
    check(label, err.code === code, `expected ${code}, got ${err.code}: ${err.message}`)
  }
}

console.log('1) open round')
const opened = await svc.openRound(store, plan, { goal: 'smoke', budget: { fixes: 2, reruns: 2, restarts: 3 } })
check('returns roundId', typeof opened.roundId === 'string', opened.roundId)
check('budget defaults kept', opened.budget.testFailures === undefined && opened.budget.reruns === 2)
await expectCode('second open rejected', 'ROUND_ALREADY_OPEN', () => svc.openRound(store, plan, { goal: 'again' }))

console.log('2) single T0')
await expectCode('evidence before T0 rejected', 'NO_BASELINE', () =>
  svc.recordEvidence(store, work, { layer: 'command', payload: { command: 'x', exitCode: 0 } }),
)
const t0 = await svc.freezeBaseline(ctx, store, work, {})
check('no-git fallback recorded', t0.baseline.mode === 'no-git', JSON.stringify(t0.baseline))
await expectCode('second freeze rejected', 'BASELINE_ALREADY_FROZEN', () => svc.freezeBaseline(ctx, store, work, {}))

console.log('3) evidence layers')
const ev = await svc.recordEvidence(store, work, { layer: 'command', payload: { command: 'npm test', exitCode: 0, outputDigest: 'sha256:abc' } })
check('command evidence bound to t0', ev.evidence.t0Id === t0.baseline.t0Id, ev.evidence.t0Id)
await expectCode('work cannot write review layer', 'EVIDENCE_LAYER_MISMATCH', () =>
  svc.recordEvidence(store, work, { layer: 'review', payload: { verdict: 'pass', scope: [], uncovered: [] } }),
)
await expectCode('review layer needs verdict/scope/uncovered', 'BAD_ARGS', () =>
  svc.recordEvidence(store, review, { layer: 'review', payload: { verdict: 'pass' } }),
)
await svc.recordEvidence(store, review, { layer: 'review', payload: { verdict: 'pass', scope: ['src/'], uncovered: ['无'] } })
await svc.recordEvidence(store, code, { layer: 'artifact', payload: { path: 'dist/app.js', bytes: 10 } })

console.log('4) counters and limits')
await svc.recordFailure(store, work, { kind: 'test', signature: 'pytest::test_login' })
await svc.recordFailure(store, work, { kind: 'test', signature: 'pytest::test_login' })
const third = await svc.recordFailure(store, work, { kind: 'test', signature: 'pytest::test_login' })
check('third same-signature failure flags exceeded', third.exceeded === 'test', JSON.stringify(third))
check('count is per signature', third.signatureCount === 3, String(third.signatureCount))
const other = await svc.recordFailure(store, work, { kind: 'test', signature: 'pytest::test_other' })
check('other signature does not inherit the count', other.signatureCount === 1, String(other.signatureCount))

console.log('5) close is refused while exceeded')
const closeout = {
  version: { commit: '(no-git)' },
  result: 'partial',
  uncovered: ['未跑真实浏览器'],
  servicesStopped: true,
  cost: { tokens: 1234, estimate: true },
}
let rejected
try {
  await svc.closeRound(store, plan, { closeout })
} catch (err) {
  rejected = err
}
check('closeout rejected', rejected?.code === 'CLOSEOUT_REJECTED', String(rejected?.message))
check('reason names the exceeded counter', JSON.stringify(rejected?.extra?.problems ?? []).includes('force'), JSON.stringify(rejected?.extra))

console.log('6) gate: subagent escalates, root blocks and records')
const escalated = await svc.askGate(ctx, store, work, { kind: 'force', question: '允许越过重试上限吗？' })
check('subagent gets ESCALATE_TO_PARENT', escalated.ok === false && escalated.code === 'ESCALATE_TO_PARENT', JSON.stringify(escalated))
const gate = await svc.askGate(ctx, store, plan, { kind: 'force', question: '允许越过重试上限吗？', options: [{ label: '批准' }, { label: '拒绝' }] })
check('root gate recorded a decision', gate.ok === true && gate.gate.decision === '批准', JSON.stringify(gate))

console.log('7) close passes and exports the audit copy')
const closed = await svc.closeRound(store, plan, { closeout })
check('close succeeds', closed.ok === true, JSON.stringify(closed))
check('summary carries version/result/uncovered/cost', /版本：(no-git)|结果：partial|未覆盖项|费用：/.test(closed.summary), closed.summary)
check('audit file written', typeof closed.auditPath === 'string' && closed.auditPath.endsWith('.json'), closed.auditPath)

console.log('8) status after close')
const st = await svc.status(store, { roundId: closed.roundId })
check('round reported closed', typeof st.closedAt === 'string', String(st.closedAt))
const idle = await svc.status(store, {})
check('no active round remains', idle.activeRoundId === null, JSON.stringify(idle))

console.log(`\n${pass} passed, ${fail} failed`)
await rm(DIR, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
