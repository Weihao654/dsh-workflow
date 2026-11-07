// The closing sequence must stay affordable once ordinary room is gone: the review run, the evidence
// write and the closing call itself. Until .34 a plan could not dispatch review at all (plan -> work
// only), so a review that was never dispatched could not be rescued by the reserve; .34 allows the ROOT plan
// that already holds command evidence to dispatch the missing review from the reserve, and the first
// review still comes from work. These checks use a real authority root so the durable-grant path is
// exercised, and they never call a model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harness } from './helpers.mjs'
import { RoundStore } from '../lib/store.js'
import { bindingOf, closeoutReady, closeoutReserveOf, DEFAULT_CLOSEOUT_REQUESTS, DEFAULT_CLOSEOUT_TIME_MS } from '../lib/runtime.js'
import { reserveRequest } from '../lib/usage.js'
import * as svc from '../lib/service.js'

const request = { provider: 'fake', model: 'deterministic', maxTokens: 16, inputTokens: 20 }
const refuses = code => error => error.code === code
const grantOf = (overrides = {}) => {
  const now = Date.now()
  return { version: 1, id: 'auth-closeout', authorizedAt: new Date(now - 1000).toISOString(),
    deadlineAt: new Date(now + 30 * 60000).toISOString(),
    budget: { tokens: 5000000, requests: 400, testFailures: 3, fixes: 2, reruns: 2, restarts: 3, wallMinutes: 30, outputCap: 2048, ...overrides } }
}
async function authorized(t, { budget = {}, durable = grantOf() } = {}) {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-closeout-'))
  const h = await harness({ noOpen: true, authorityRoot })
  t.after(async () => { await h.close(); await rm(authorityRoot, { recursive: true, force: true }) })
  await h.store.mutate(state => { state.authorization = durable })
  await svc.openRound(h.store, h.plan, { goal: 'closing sequence reserve', budget })
  return { h, authorityRoot }
}
const identityOf = (h, id) => h.store.read(s => { const { round, execution } = bindingOf(s, id)
  return { sessionId: id, roundId: round.id, executionId: execution.id, generation: execution.generation } })
const addEvidence = (h, layers) => h.store.mutate(s => {
  const round = s.rounds[s.activeRoundId]
  for (const layer of layers) round.evidence.push({ id: 'E-' + layer, layer, agentQuiescent: true, jobsQuiescent: true })
})
const countRequests = h => h.store.read(s => Object.keys(s.rounds[s.activeRoundId].usage.requests).length)
const fill = async (h, who, n) => { for (let i = 0; i < n; i++) await reserveRequest(h.store, who, 'Q-fill-' + i, request) }

test('an authorized round cannot lower the documented closeout reserve', async t => {
  const root = await mkdtemp(join(tmpdir(), 'role-chain-closeout-low-'))
  const h = await harness({ noOpen: true, authorityRoot: root })
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }) })
  await h.store.mutate(state => { state.authorization = grantOf() })
  await assert.rejects(() => svc.openRound(h.store, h.plan, { goal: 'x', budget: { closeoutRequests: 1 } }), refuses('BAD_BUDGET'))
  await assert.rejects(() => svc.openRound(h.store, h.plan, { goal: 'x', budget: { closeoutTimeMs: 1 } }), refuses('BAD_BUDGET'))
  const opened = await svc.openRound(h.store, h.plan, { goal: 'x', budget: { closeoutRequests: DEFAULT_CLOSEOUT_REQUESTS, closeoutTimeMs: DEFAULT_CLOSEOUT_TIME_MS } })
  assert.ok(opened.roundId)
})

test('a tiny budget leaves an empty round closable and a dispatched round unclosable', async t => {
  // Shape A: nothing dispatched -> the round still closes as abortedEmpty (partial).
  const tiny = { tokens: 1000, requests: 8 }
  const a = await authorized(t, { budget: tiny })
  const whoA = await identityOf(a.h, a.h.plan.sessionId)
  await assert.rejects(() => reserveRequest(a.h.store, whoA, 'Q-tiny', { ...request, maxTokens: 512 }), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  const closed = await svc.closeRound(a.h.store, a.h.plan, {
    closeout: { version: { commit: '(no-git)' }, result: 'partial', uncovered: ['tiny budget'], servicesStopped: true } })
  assert.equal(closed.closeout.result, 'partial')
  assert.equal(closed.closeout.abortedEmpty, true)

  // Shape B: work dispatched, no evidence -> no legal close.
  const b = await authorized(t, { budget: tiny })
  await b.h.spawnWork()
  await assert.rejects(() => svc.closeRound(b.h.store, b.h.plan, {
    closeout: { version: { commit: '(no-git)' }, result: 'partial', uncovered: ['tiny budget'], servicesStopped: true } }),
  error => {
    assert.equal(error.code, 'CLOSEOUT_REJECTED')
    // Pin the evidence gate itself: quiescence alone must not be able to satisfy this assertion.
    assert.match(error.message, /Missing command evidence/)
    assert.match(error.message, /Missing independent review evidence/)
    return true
  })
})

test('a durable grant written before the reserve keys existed still admits requests', async t => {
  const legacy = grantOf()
  delete legacy.budget.closeoutRequests
  delete legacy.budget.closeoutTimeMs
  const { h } = await authorized(t, { durable: legacy })
  const who = await identityOf(h, h.plan.sessionId)
  await reserveRequest(h.store, who, 'Q-legacy-grant', request)
  assert.equal(await countRequests(h), 1)
})

test('ordinary work leaves the reserve alone while a plan with command evidence may use it', async t => {
  const { h } = await authorized(t, { budget: { requests: 8, tokens: 1000000 } })
  const { work } = await h.spawnWork()
  const who = await identityOf(h, h.plan.sessionId), worker = await identityOf(h, work.sessionId)
  await addEvidence(h, ['command'])
  await fill(h, who, 6)
  await assert.rejects(() => reserveRequest(h.store, worker, 'Q-work', request), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  await reserveRequest(h.store, who, 'Q-plan-dispatch', request)
  const spent = await h.store.read(s => s.rounds[s.activeRoundId].usage.closeout)
  assert.equal(spent.requests, 1)
})

test('a review is admitted from the reserve before its evidence exists', async t => {
  const { h } = await authorized(t, { budget: { requests: 8, tokens: 1000000 } })
  const { work } = await h.spawnWork()
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'read only' })
  const reviewWho = await identityOf(h, review.childId), who = await identityOf(h, h.plan.sessionId)
  await addEvidence(h, ['command'])
  await fill(h, who, 6)
  assert.equal(await h.store.read(s => closeoutReady(s.rounds[s.activeRoundId])), false)
  await reserveRequest(h.store, reviewWho, 'Q-review-run', request)
  const spent = await h.store.read(s => s.rounds[s.activeRoundId].usage.closeout)
  assert.equal(spent.requests, 1)
})

test('the reserve cannot be looped once its requests are spent', async t => {
  const { h } = await authorized(t, { budget: { requests: 4, tokens: 1000000, closeoutRequests: DEFAULT_CLOSEOUT_REQUESTS } })
  const { work } = await h.spawnWork()
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'read only' })
  const reviewWho = await identityOf(h, review.childId), who = await identityOf(h, h.plan.sessionId)
  await addEvidence(h, ['command'])
  await fill(h, who, 2)
  await reserveRequest(h.store, who, 'Q-dispatch', request)
  // the last slot is the reserve: the review run may take it, a second attempt may not
  await reserveRequest(h.store, reviewWho, 'Q-review', request)
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-again', request), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  await assert.rejects(() => reserveRequest(h.store, reviewWho, 'Q-review-again', request), refuses('CLOSEOUT_RESERVE_PROTECTED'))
})

test('a closing window stops ordinary work but not the closing sequence', async t => {
  const { h } = await authorized(t, { budget: { requests: 8, tokens: 1000000 } })
  const { work } = await h.spawnWork()
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'read only' })
  const reviewWho = await identityOf(h, review.childId), worker = await identityOf(h, work.sessionId)
  await h.store.mutate(s => { s.rounds[s.activeRoundId].time.deadlineAt = new Date(Date.now() + 30000).toISOString() })
  await assert.rejects(() => reserveRequest(h.store, worker, 'Q-late', request), refuses('CLOSEOUT_WINDOW_TOO_SMALL'))
  await reserveRequest(h.store, reviewWho, 'Q-review-late', request)
  assert.equal(await countRequests(h), 1)
})

test('the token reserve grows with the plan input estimate and stays an estimate', async t => {
  const { h } = await authorized(t, { budget: { requests: 16, tokens: 1000000 } })
  const before = await h.store.read(s => closeoutReserveOf(s.rounds[s.activeRoundId]))
  await h.store.mutate(s => { s.rounds[s.activeRoundId].usage.estimates = { plan: 120000 } })
  const after = await h.store.read(s => closeoutReserveOf(s.rounds[s.activeRoundId]))
  assert.ok(after.tokens > before.tokens)
  assert.equal(after.requests, before.requests)
})

test('the grant still caps the closing sequence', async t => {
  const { h } = await authorized(t, { budget: { requests: 8, tokens: 500 }, durable: grantOf({ tokens: 500 }) })
  const { work } = await h.spawnWork()
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'read only' })
  const reviewWho = await identityOf(h, review.childId)
  await assert.rejects(() => reserveRequest(h.store, reviewWho, 'Q-over-grant', { ...request, inputTokens: 400, maxTokens: 2048 }), refuses('PROJECT_TOKEN_BUDGET_REACHED'))
  assert.equal(await countRequests(h), 0)
})

test('closeoutReady tracks both layers and a plan without command evidence is not a closing role', async t => {
  const { h } = await authorized(t, { budget: { requests: 8, tokens: 1000000 } })
  const who = await identityOf(h, h.plan.sessionId)
  assert.equal(await h.store.read(s => closeoutReady(s.rounds[s.activeRoundId])), false)
  await fill(h, who, 6)
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-no-command', request), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  await addEvidence(h, ['command', 'review'])
  assert.equal(await h.store.read(s => closeoutReady(s.rounds[s.activeRoundId])), true)
  await reserveRequest(h.store, who, 'Q-close', request)
})

test('ordinary slots run out before the plan closing turn, which still gets a reserved slot', async t => {
  const { h } = await authorized(t, { budget: { requests: 8, tokens: 2000000 } })
  const { work } = await h.spawnWork()
  const who = await identityOf(h, h.plan.sessionId), worker = await identityOf(h, work.sessionId)
  let ordinary = 0
  for (;;) {
    try { await reserveRequest(h.store, who, 'Q-fill-' + ordinary, request); ordinary += 1 }
    catch (error) { assert.equal(error.code, 'CLOSEOUT_RESERVE_PROTECTED'); break }
  }
  assert.ok(ordinary >= 4, 'the ordinary envelope must actually be spent first')
  await assert.rejects(() => reserveRequest(h.store, worker, 'Q-work-last', request), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  await addEvidence(h, ['command'])
  await reserveRequest(h.store, who, 'Q-plan-close', request)
  await assert.rejects(() => reserveRequest(h.store, worker, 'Q-work-after', request), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  const spent = await h.store.read(s => s.rounds[s.activeRoundId].usage.closeout)
  assert.equal(spent.requests, 1)
})

test('when one closing request costs more than half the budget the cap is that request, and it is documented', async t => {
  const { h } = await authorized(t, { budget: { requests: 16, tokens: 20000, outputCap: 2048 } })
  const who = await identityOf(h, h.plan.sessionId)
  await h.store.mutate(s => { s.rounds[s.activeRoundId].usage.estimates = { plan: 8192 } })
  const reserve = await h.store.read(s => closeoutReserveOf(s.rounds[s.activeRoundId]))
  assert.equal(reserve.perRequest, 8192 + 2048)
  assert.equal(reserve.tokenCap, 8192 + 2048)
  assert.equal(reserve.tokens, 8192 + 2048)
  assert.ok(reserve.tokens > Math.floor(20000 / 2))
  // .39: the slot promise stays at floor(16/4)=4; only the token hold is recomputed from the cap
  // (it covers one full-size request). The count no longer collapses with the cap, because a
  // collapsing count is what revoked a slot the closing turn already relied on in P1.
  assert.equal(reserve.requests, 4)
  await reserveRequest(h.store, who, 'Q-tight', request)
})

test('the reserve state is durable: a fresh store over the same authority root sees the spend', async t => {
  const { h, authorityRoot } = await authorized(t, { budget: { requests: 8, tokens: 1000000 } })
  const who = await identityOf(h, h.plan.sessionId)
  for (let i = 0; ; i++) {
    try { await reserveRequest(h.store, who, 'Q-fill-' + i, request) }
    catch (error) { assert.equal(error.code, 'CLOSEOUT_RESERVE_PROTECTED'); break }
  }
  await addEvidence(h, ['command'])
  await reserveRequest(h.store, who, 'Q-spend', request)
  const reloaded = new RoundStore(h.dir, { authorityRoot })
  const spent = await reloaded.read(s => s.rounds[s.activeRoundId].usage.closeout)
  assert.equal(spent.requests, 1)
  assert.ok(spent.tokens > 0)
  assert.match(readFileSync(join(reloaded.dir, 'state.json'), 'utf8'), /closeout/)
})

test('the token side of the reserve is capped at half the round budget', async t => {
  const { h } = await authorized(t, { budget: { requests: 16, tokens: 500000, outputCap: 2048 } })
  const big = { provider: 'fake', model: 'deterministic', maxTokens: 2048, inputTokens: 100000 }
  const who = await h.store.read(s => {
    const { round, execution } = bindingOf(s, 'root-plan')
    return { sessionId: 'root-plan', roundId: round.id, executionId: execution.id, generation: execution.generation }
  })
  await reserveRequest(h.store, who, 'Q-big-1', big)
  const reserve = await h.store.read(state => closeoutReserveOf(state.rounds[state.activeRoundId]))
  assert.ok(reserve.tokens <= Math.floor(500000 / 2), 'the reserve must stay within half the round budget')
  // .39: the token hold is the capped envelope, not a whole number of requests; the slot promise
  // stays at floor(16/4)=4 instead of collapsing to floor(hold/perRequest)=2.
  assert.equal(reserve.tokens, reserve.tokenCap)
  assert.equal(reserve.requests, 4)
  assert.ok(reserve.requests * reserve.perRequest >= reserve.tokens)
  await reserveRequest(h.store, who, 'Q-big-2', big)
  assert.equal(await countRequests(h), 2)
})

// --- .39: the P1 failure shape. The old reserve recomputed the request count as
// floor(hold / perRequest), so a larger estimate silently removed a slot the closing turn had
// already been admitted into. These checks pin the two separated promises: slots depend only on
// the grant, the token hold grows with the estimate and is checked cumulatively.
test('.39: the slot promise is fixed and the token hold never shrinks as the estimate grows', async t => {
  const { h } = await authorized(t, { budget: { requests: 20, tokens: 400000, outputCap: 2048, closeoutRequests: 6 } })
  const read = () => h.store.read(s => closeoutReserveOf(s.rounds[s.activeRoundId]))
  const base = await read()
  assert.equal(base.requests, 5)
  let previous = base
  for (const estimate of [8192, 35000, 36000, 38000, 42000, 46000, 50000, 63000, 96000, 120000, 200000]) {
    await h.store.mutate(s => { s.rounds[s.activeRoundId].usage.estimates = { plan: estimate } })
    const now = await read()
    assert.equal(now.requests, base.requests, 'the slot promise shrank at plan estimate ' + estimate)
    assert.ok(now.tokens >= previous.tokens, 'the token hold shrank at plan estimate ' + estimate)
    assert.equal(now.perRequest, estimate + 2048)
    previous = now
  }
})

test('.39: a closing turn with growing contexts keeps every reserved slot (the P1 shape)', async t => {
  const { h } = await authorized(t, { budget: { requests: 20, tokens: 800000, outputCap: 4096, closeoutRequests: 6 }, durable: grantOf({ outputCap: 4096 }) })
  const { work } = await h.spawnWork()
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'read only' })
  const who = await identityOf(h, h.plan.sessionId), reviewWho = await identityOf(h, review.childId)
  // 15 ordinary rows leave exactly the five reserved slots (floor(20/4)=5, closeoutRequests 6).
  for (let i = 0; i < 15; i++) await reserveRequest(h.store, who, 'Q-ordinary-' + i, { ...request, maxTokens: 4096 })
  await addEvidence(h, ['command', 'review'])
  // The real P1 draws: the context kept growing between the closing requests.
  const draws = [['plan', 37543], ['review', 72755], ['plan', 40298], ['plan', 43314], ['plan', 47410]]
  for (const [role, input] of draws)
    await reserveRequest(h.store, role === 'review' ? reviewWho : who, 'Q-close-' + input, { ...request, maxTokens: 4096, inputTokens: input })
  const after = await h.store.read(s => {
    const round = s.rounds[s.activeRoundId]
    return { spent: round.usage.closeout, reserve: closeoutReserveOf(round) }
  })
  assert.equal(after.spent.requests, 5)
  assert.equal(after.spent.tokens, 41639 + 76851 + 44394 + 47410 + 51506)
  assert.ok(after.spent.tokens <= after.reserve.tokens, 'cumulative draws must stay inside the hold')
  assert.ok(after.reserve.tokens <= Math.floor(800000 / 2), 'the hold must stay within half the round budget')
})

test('.39: a closing draw is judged against its own input estimate, review first or new maximum', async t => {
  const { h, authorityRoot } = await authorized(t, { budget: { requests: 20, tokens: 800000, outputCap: 4096, closeoutRequests: 6 }, durable: grantOf({ outputCap: 4096 }) })
  const { work } = await h.spawnWork()
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'read only' })
  const who = await identityOf(h, h.plan.sessionId), reviewWho = await identityOf(h, review.childId)
  for (let i = 0; i < 15; i++) await reserveRequest(h.store, who, 'Q-ordinary-' + i, { ...request, maxTokens: 4096 })
  await addEvidence(h, ['command'])
  // Review's first admission happens before any review estimate exists; its own estimate sizes the hold.
  await reserveRequest(h.store, reviewWho, 'Q-review-first', { ...request, maxTokens: 4096, inputTokens: 90000 })
  // A later plan draw sets a new plan maximum; it is judged against the hold that includes it.
  await reserveRequest(h.store, who, 'Q-plan-max', { ...request, maxTokens: 4096, inputTokens: 120000 })
  const before = await h.store.read(s => {
    const round = s.rounds[s.activeRoundId]
    return { spent: round.usage.closeout, reserve: closeoutReserveOf(round) }
  })
  assert.equal(before.spent.requests, 2)
  assert.equal(before.spent.tokens, 94096 + 124096)
  assert.ok(before.spent.tokens <= before.reserve.tokens)
  // Restart recovery: a fresh store sees the same persisted estimates and recomputes the same hold.
  const reloaded = new RoundStore(h.dir, { authorityRoot })
  const after = await reloaded.read(s => {
    const round = s.rounds[s.activeRoundId]
    return { spent: round.usage.closeout, reserve: closeoutReserveOf(round) }
  })
  assert.deepEqual(after, before)
})

test('.39: a cap-bound hold admits whole draws, never overdrafts, and refuses the next one honestly', async t => {
  const { h } = await authorized(t, { budget: { requests: 8, tokens: 200000, outputCap: 2048, closeoutRequests: 6 } })
  const { work } = await h.spawnWork()
  const review = await h.controller.dispatch(h.store, work, { role: 'review', task: 'read only' })
  const who = await identityOf(h, h.plan.sessionId), reviewWho = await identityOf(h, review.childId)
  for (let i = 0; i < 6; i++) await reserveRequest(h.store, who, 'Q-fill-' + i, request)
  await addEvidence(h, ['command'])
  const big = { provider: 'fake', model: 'deterministic', maxTokens: 2048, inputTokens: 50000 }
  await reserveRequest(h.store, reviewWho, 'Q-cap-1', big)
  // The hold is now the half-budget cap: 100000 tokens, one full 52048 draw already inside it.
  await assert.rejects(() => reserveRequest(h.store, reviewWho, 'Q-cap-2', big),
    error => {
      assert.equal(error.code, 'CLOSEOUT_RESERVE_PROTECTED')
      assert.match(error.message, /cannot cover another request of this size/)
      return true
    })
  const after = await h.store.read(s => {
    const round = s.rounds[s.activeRoundId]
    return { spent: round.usage.closeout, reserve: closeoutReserveOf(round) }
  })
  assert.deepEqual(after.spent, { requests: 1, tokens: 52048 })
  assert.equal(after.reserve.requests, 2, 'the refusal is token-side; the slot promise itself must not shrink')
  assert.ok(after.spent.tokens <= after.reserve.tokens, 'a refused draw must not overdraw the hold')
})
