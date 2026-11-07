// Controlled fixtures supersede the old unbound-agent/no-git-on-error smoke checks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { harness } from './helpers.mjs'
import { writeReceipt } from './receipt-fixture.mjs'
import * as svc from '../lib/service.js'
const closeout = { version: { commit: '(no-git)', artifact: 'fixture only' }, result: 'partial', uncovered: ['Real Host integration and invoice excluded.'], servicesStopped: true }
async function giveReceipt(h, id) {
  const round = await h.store.read(state => Object.values(state.rounds)
    .find(r => Object.values(r.executions ?? {}).some(e => e.id === id)))
  const { ref } = writeReceipt(h.store, round, round.executions[id])
  await h.store.mutate(state => { state.rounds[round.id].executions[id].evidenceRefs = [ref] })
}
async function evidence(h, work) {
  // Command evidence is bound to a settled job record; an unbound command+exitCode is refused
  // (COMMAND_BINDING_REQUIRED), so this fixture writes the job record a real compute would leave.
  const roundId = await h.store.mutate(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {})
      .some(e => e.ownerSessionId === work.sessionId || e.childSessionId === work.sessionId))
    assert.ok(round, 'fixture smoke round must exist')
    round.executions['J-smoke-1'] = { id: 'J-smoke-1', roundId: round.id, role: 'work', kind: 'job', generation: 1,
      nonce: 'nonce-J-smoke-1', state: 'completed', jobsQuiescent: true, agentQuiescent: true,
      outcome: 'natural-completion', exitCode: 0, ownerSessionId: work.sessionId,
      spec: { requested: ['sh', '-c', 'printf smoke'], argv: ['sh', '-c', 'printf smoke'] }, evidenceRefs: [] }
    return round.id
  })
  {
    const round = await h.store.read(state => state.rounds[roundId])
    const { ref } = writeReceipt(h.store, round, round.executions['J-smoke-1'])
    await h.store.mutate(state => { state.rounds[roundId].executions['J-smoke-1'].evidenceRefs = [ref] })
  }
  await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-smoke-1' } })
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'independent fixture review' })
  await svc.recordEvidence(h.store, h.exec(review.childId), { layer: 'review', payload: { verdict: 'partial', scope: ['fixture'], uncovered: ['Host integration'] } })
  await h.complete(review.childId)
}
test('six-step fixture closes only after actual fixture exits, keeps unknown cost, and fences the closed root', async t => {
  const h = await harness(); t.after(() => h.close())
  const { work, result } = await h.spawnWork()
  await evidence(h, work)
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout }), e => e.code === 'CLOSEOUT_REJECTED')
  await h.complete(result.childId)
  const resultClose = await svc.closeRound(h.store, h.plan, { closeout })
  assert.equal(resultClose.ok, true); assert.equal(resultClose.closeout.cost.amount, null)
  assert.equal((await svc.status(h.store)).activeRoundId, null)
  await assert.rejects(h.controller.beforeRequest(h.plan.agent, h.plan.signal), e => e.code === 'ROUND_CLOSED' || e.code === 'RESUME_BLOCKED')
})
test('bootstrap round that never ran a protected step closes as abortedEmpty instead of deadlocking', async t => {
  const h = await harness(); t.after(() => h.close())
  assert.ok(h.opened?.roundId, 'harness opens a bootstrap round')
  const closed = await svc.closeRound(h.store, h.plan, { closeout })
  assert.equal(closed.ok, true)
  assert.equal(closed.closeout.abortedEmpty, true)
  assert.equal(closed.closeout.result, 'partial')
  assert.equal((await svc.status(h.store)).activeRoundId ?? null, null)
  assert.match(closed.summary, /abortedEmpty/)
})
test('an empty planning round cannot claim delivered', async t => {
  const h = await harness(); t.after(() => h.close())
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout: { ...closeout, result: 'delivered' } }),
    e => e.code === 'CLOSEOUT_REJECTED' && /empty planning round cannot claim delivered/.test(e.message))
  const closed = await svc.closeRound(h.store, h.plan, { closeout: { ...closeout, result: 'blocked' } })
  assert.equal(closed.ok, true)
  assert.equal(closed.closeout.abortedEmpty, true)
})
test('round with a dispatched child still needs T0 and layered evidence to close', async t => {
  const h = await harness(); t.after(() => h.close())
  const { result } = await h.spawnWork()
  await h.complete(result.childId)
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout }), e => e.code === 'CLOSEOUT_REJECTED' && /Missing command evidence/.test(e.message))
})
test('force approval covers the presented counts, not later failures', async t => {
  const h = await harness({ answers: { answers: [{ id: 'gate', selected: ['批准'] }] } }); t.after(() => h.close())
  const { work, result } = await h.spawnWork(); await evidence(h, work)
  for (let i = 0; i < 3; i++) await svc.recordFailure(h.store, work, { kind: 'test', signature: 'fixture-stable', detail: 'known failing stand-in' })
  let shownQuestion
  h.services.userQuestions.ask = async request => { shownQuestion = request.questions[0].question; return { answers: [{ id: 'gate', selected: ['批准'] }] } }
  const gate = await svc.askGate(h.ctx, h.store, h.plan, { kind: 'force', classification: 'new-authority', question: '批准按当前三次失败部分收尾？',
    change: '仅授权当前失败计数的部分收尾', originalAuthorization: '固定失败上限', whyNotCovered: '已达上限，需要明确的收尾例外' })
  assert.equal(gate.gate.approved, true)
  assert.equal(gate.gate.authorizedCounts.failures['fixture-stable'], 3)
  assert.ok(shownQuestion.includes(JSON.stringify(gate.gate.authorizedCounts)))
  assert.equal(gate.gate.question, shownQuestion)
  await svc.recordFailure(h.store, work, { kind: 'test', signature: 'fixture-stable' })
  await h.complete(result.childId)
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout }), e => e.code === 'CLOSEOUT_REJECTED' && /current counts/.test(e.message))
})

test('closeout role and parameter requirements are enforced deterministically', async t => {
  const h = await harness(); t.after(() => h.close())
  const { work, result } = await h.spawnWork(); await evidence(h, work)
  await h.complete(result.childId)
  // Only the owning root plan may close.
  await assert.rejects(svc.closeRound(h.store, work, { closeout }), e => e.code === 'ROLE_DENIED')
  // servicesStopped is required in addition to real quiescence.
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout: { ...closeout, servicesStopped: false } }),
    e => e.code === 'CLOSEOUT_REJECTED' && /servicesStopped/.test(e.message))
  // version.commit and non-empty uncovered are required.
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout: { ...closeout, version: { commit: '' } } }),
    e => e.code === 'CLOSEOUT_REJECTED' && /version\.commit/.test(e.message))
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout: { ...closeout, uncovered: [] } }),
    e => e.code === 'CLOSEOUT_REJECTED' && /uncovered/.test(e.message))
})
test('acceptance gate is refused before independent review evidence exists', async t => {
  const h = await harness({ answers: { answers: [{ id: 'gate', selected: ['批准'] }] } }); t.after(() => h.close())
  const { work, result } = await h.spawnWork(); await h.complete(result.childId)
  const early = await svc.askGate(h.ctx, h.store, h.plan, { kind: 'accept', classification: 'closeout', stage: 'closeout', question: '验收？' })
  assert.equal(early.ok, false); assert.equal(early.code, 'NOT_GATED'); assert.match(early.disposition, /independent review/)
  await evidence(h, work)
  const late = await svc.askGate(h.ctx, h.store, h.plan, { kind: 'accept', classification: 'closeout', stage: 'closeout', question: '验收？' })
  assert.equal(late.ok, true); assert.equal(late.gate.approved, true)
})
test('command evidence derives a settled job exit code and refuses unsettled or unknown jobs', async t => {
  const h = await harness()
  const fixtureJobs = ['J-fixture-7', 'J-fixture-run', 'J-fixture-noexit']
  t.after(async () => {
    await h.store.mutate(state => {
      for (const round of Object.values(state.rounds)) for (const id of fixtureJobs) if (round.executions?.[id]) delete round.executions[id]
    })
    await h.close()
  })
  const { work } = await h.spawnWork()
  const jobSpec = (id, extra, roundId) => ({ id, kind: 'job', role: 'work', childSessionId: work.sessionId,
    generation: 1, nonce: 'nonce-' + id, evidenceRefs: [], ...extra })
  await h.store.mutate(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {})
      .some(e => e.role === 'work' && (e.childSessionId === work.sessionId || e.ownerSessionId === work.sessionId)))
    assert.ok(round, 'fixture work execution must be bound to a round')
    const add = (id, extra) => { round.executions[id] = { ...jobSpec(id, extra, round.id), roundId: round.id } }
    add('J-fixture-7', { state: 'completed', exitCode: 7, jobsQuiescent: true, outcome: 'natural-completion', spec: { argv: ['sh', '-c', 'exit 7'] } })
    add('J-fixture-run', { state: 'running', jobsQuiescent: false })
    add('J-fixture-noexit', { state: 'completed', jobsQuiescent: true })
  })
  await giveReceipt(h, 'J-fixture-7')
  const rec = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fixture-7' } })
  assert.equal(rec.evidence.payload.exitCode, 7)
  assert.equal(rec.evidence.payload.command, 'sh -c exit 7')
  assert.equal(rec.evidence.payload.jobId, 'J-fixture-7')
  assert.match(rec.evidence.payload.evidenceRef, /receipt\.json$/)
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-unknown' } }),
    e => e.code === 'BAD_ARGS')
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fixture-run' } }),
    e => e.code === 'JOB_NOT_SETTLED')
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fixture-noexit' } }),
    e => e.code === 'JOB_EXIT_UNKNOWN')
})
test('job-bound command evidence supports a full same-round close', async t => {
  const h = await harness()
  const fixtureJobs = ['J-full-0', 'J-other-round']
  t.after(async () => {
    await h.store.mutate(state => {
      for (const round of Object.values(state.rounds)) for (const id of fixtureJobs) if (round.executions?.[id]) delete round.executions[id]
      delete state.rounds['R-other-round']
    })
    await h.close()
  })
  const { work, result } = await h.spawnWork()
  await h.store.mutate(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {})
      .some(e => e.role === 'work' && (e.childSessionId === work.sessionId || e.ownerSessionId === work.sessionId)))
    round.executions['J-full-0'] = { id: 'J-full-0', roundId: round.id, kind: 'job', role: 'work', childSessionId: work.sessionId,
      generation: 1, state: 'completed', exitCode: 0, jobsQuiescent: true, agentQuiescent: true,
      outcome: 'natural-completion', spec: { argv: ['sh', '-c', 'printf CLOSE_OK; exit 0'] },
      nonce: 'nonce-J-full-0', evidenceRefs: [] }
    state.rounds['R-other-round'] = { id: 'R-other-round', executions: { 'J-other-round': { id: 'J-other-round', roundId: 'R-other-round',
      kind: 'job', role: 'work', state: 'completed', exitCode: 0, jobsQuiescent: true, spec: { argv: ['sh', '-c', 'exit 0'] } } } }
  })
  await giveReceipt(h, 'J-full-0')
  // A job from another round is not admissible evidence for this round.
  // A job from another round is refused with an explicit code (not silently accepted).
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-other-round' } }),
    e => e.code === 'JOB_WRONG_ROUND')
  // Only work/code may record command evidence.
  await assert.rejects(svc.recordEvidence(h.store, h.plan, { layer: 'command', payload: { jobId: 'J-full-0' } }),
    e => e.code === 'EVIDENCE_LAYER_MISMATCH')
  const first = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-full-0' } })
  assert.equal(first.evidence.payload.exitCode, 0)
  // Recording is append-only: a repeated registration is a second row, not a rewrite.
  const again = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-full-0' } })
  assert.equal(again.evidence.payload.exitCode, 0)
  assert.equal(again.evidence.id === first.evidence.id, false)
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'independent fixture review' })
  await svc.recordEvidence(h.store, h.exec(review.childId), { layer: 'review', payload: { verdict: 'pass', scope: ['fixture'], uncovered: ['Host integration excluded'] } })
  await h.complete(review.childId)
  await h.complete(result.childId)
  const closed = await svc.closeRound(h.store, h.plan, { closeout })
  assert.equal(closed.ok, true)
  assert.equal(closed.closeout.cost.amount, null)
  const status = await svc.status(h.store)
  assert.equal(status.activeRoundId, null)
})
test('a delivered closeout requires a passing review verdict and well-formed close fields', async t => {
  const h = await harness()
  t.after(() => h.close())
  const { work, result } = await h.spawnWork()
  await evidence(h, work)
  await h.complete(result.childId)
  // D1: the review verdict is recorded as "partial" here; "delivered" must not be closable.
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout: { ...closeout, result: 'delivered' } }),
    e => e.code === 'CLOSEOUT_REJECTED' && /review verdict/.test(e.message))
  // D2: self-asserted close fields are checked against their shape, not just presence.
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout: { ...closeout, version: { commit: 'not-a-real-commit' } } }),
    e => e.code === 'CLOSEOUT_REJECTED' && /commit must be/.test(e.message))
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout: { ...closeout, uncovered: ['   '] } }),
    e => e.code === 'CLOSEOUT_REJECTED' && /uncovered entries must not be blank/.test(e.message))
  const closed = await svc.closeRound(h.store, h.plan, { closeout })
  assert.equal(closed.ok, true)
  assert.equal(closed.closeout.servicesStopped, true)
  assert.match(String(closed.closeout.servicesStoppedMeans), /declaration by the closing agent/)
})
test('a command row without a bound job or recorded digest cannot satisfy the close gate', async t => {
  const h = await harness()
  t.after(() => h.close())
  const { work, result } = await h.spawnWork()
  await evidence(h, work)
  await h.complete(result.childId)
  // Strip the binding from the recorded command row: the close must refuse instead of skipping it.
  const kept = await h.store.read(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {}).some(e => e.id === 'J-smoke-1'))
    const row = round.evidence.find(e => e.layer === 'command')
    return { jobId: row.payload.jobId, digest: row.payload.receiptDigest }
  })
  await h.store.mutate(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {}).some(e => e.id === 'J-smoke-1'))
    for (const row of round.evidence) if (row.layer === 'command') delete row.payload.receiptDigest
  })
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout }),
    e => e.code === 'CLOSEOUT_REJECTED' && /cannot be re-verified/.test(e.message))
  // Restoring the digest makes the same row closable again: the refusal is about the missing proof, not a stuck round.
  await h.store.mutate(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {}).some(e => e.id === 'J-smoke-1'))
    for (const row of round.evidence) if (row.layer === 'command') row.payload.receiptDigest = kept.digest
  })
  const closed = await svc.closeRound(h.store, h.plan, { closeout })
  assert.equal(closed.ok, true)
})
test('a receipt edited after the command evidence was recorded blocks the close', async t => {
  const h = await harness()
  t.after(() => h.close())
  const { work, result } = await h.spawnWork()
  await evidence(h, work)
  // Rewrite the native receipt behind the already-recorded command evidence.
  const { round, job } = await h.store.read(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {}).some(e => e.id === 'J-smoke-1'))
    return { round, job: round.executions['J-smoke-1'] }
  })
  const file = String(job.evidenceRefs.find(ref => String(ref).startsWith('windows-job-empty:')))
    .slice('windows-job-empty:'.length)
  const body = JSON.parse(readFileSync(file, 'utf8'))
  body.exitCode = body.exitCode === 0 ? 3 : 0
  writeFileSync(file, JSON.stringify(body))
  await h.complete(result.childId)
  await assert.rejects(svc.closeRound(h.store, h.plan, { closeout }),
    e => e.code === 'CLOSEOUT_REJECTED' && /receipt changed after the command evidence was recorded|its receipt no longer verifies/.test(e.message))
})
import { lossless } from '../lib/lossless.js'
test('chain_status full is forced to lossless JSON (no NaN/BigInt/function/cycle leaks)', () => {
  const cyclic = { a: 1 }; cyclic.self = cyclic
  const board = { ok: true, at: new Date('2026-11-04T00:00:00Z'), bad: NaN, inf: Infinity,
    arr: [undefined, 1n], fn: () => 1, nested: { u: undefined, v: 'x' }, cyclic }
  const out = lossless(board)
  assert.equal(out.ok, true)
  assert.equal(out.bad, null)
  assert.equal(out.inf, null)
  assert.deepEqual(out.arr, [null, '1'])
  assert.equal('fn' in out, false)
  assert.equal('u' in out.nested, false)
  assert.equal(out.cyclic.self, null)
  assert.equal(typeof out.at, 'string')
  JSON.parse(JSON.stringify(out))
})