// Deterministic provider/Host stand-ins. No real LLM request or invoice is generated.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './helpers.mjs'
import { bindingOf, usageTotals } from '../lib/runtime.js'
import { inputReservation, normalizeUsage, reserveRequest, settleRequest, startPlanningRequest,
  settlePlanningRequest, installUsage } from '../lib/usage.js'
import * as svc from '../lib/service.js'
const code = expected => error => error.code === expected
async function fixture(t, options = {}) {
  const h = await harness(options); t.after(() => h.close())
  const dispose = installUsage(h.ctx, h.controller); t.after(dispose)
  return h
}
async function identity(h, sessionId = h.plan.sessionId) {
  return h.store.read(s => { const { round, execution } = bindingOf(s, sessionId)
    return { sessionId, roundId: round.id, executionId: execution.id, generation: execution.generation } })
}
const reserve = { provider: 'fake', model: 'stand-in', maxTokens: 64, inputTokens: 100 }
const opts = sessionId => ({ sessionId, provider: 'fake', model: 'stand-in', maxTokens: 64, messages: [] })
async function stream(h, options, chunks = [], failure = null) {
  const middleware = h.hooks.get('llm/stream')[0], output = []
  for await (const chunk of middleware(options, async function* () { yield* chunks; if (failure) throw failure })) output.push(chunk)
  return output
}
const usage = (inputTokens, outputTokens, extra = {}) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...extra })

test('Host disjoint cache buckets count once; reasoning stays inside output; contradictions remain unknown', () => {
  assert.deepEqual(normalizeUsage(usage(100, 20, { totalTokens: 185, cacheReadTokens: 60, cacheWriteTokens: 5, reasoningTokens: 10 })),
    { inputTokens: 100, outputTokens: 20, totalTokens: 185, cacheReadTokens: 60, cacheWriteTokens: 5, reasoningTokens: 10 })
  assert.equal(normalizeUsage(usage(100, 20, { cacheReadTokens: 60 })), null)
  assert.equal(normalizeUsage(usage(100, 20, { reasoningTokens: 21 })), null)
  assert.equal(normalizeUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 9 }), null)
  assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: 2 }), null)
  assert.equal(normalizeUsage(null), null)
})

test('all roles and reuse stages accumulate; duplicate/late receipts never charge a new generation', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  const child = await h.controller.dispatch(h.store, work, { role: 'code', task: 'source', family: 'A' })
  const reviewer = await h.controller.dispatch(h.store, work, { role: 'review', task: 'independent check' })
  const ids = [h.plan.sessionId, work.sessionId, child.childId, reviewer.childId]
  const amounts = [[20, 5], [40, 10], [70, 20], [10, 5]], identities = []
  for (let i = 0; i < ids.length; i++) {
    const who = await identity(h, ids[i]); identities.push(who)
    await reserveRequest(h.store, who, `Q-role-${i}`, reserve)
    await settleRequest(h.store, who, `Q-role-${i}`, usage(...amounts[i]), 'completed')
  }
  for (const id of [child.childId, reviewer.childId, work.sessionId]) await h.complete(id)
  const next = await h.controller.dispatch(h.store, h.plan, { role: 'work', phase: 'second-stage', task: 'continue same round' })
  assert.equal(next.childId, work.sessionId)
  const who = await identity(h, next.childId)
  await reserveRequest(h.store, who, 'Q-stage-two', reserve)
  await settleRequest(h.store, who, 'Q-stage-two', usage(20, 5), 'completed')
  const duplicate = await settleRequest(h.store, identities[1], 'Q-role-1', usage(40, 10), 'completed')
  assert.equal(duplicate.duplicate, true)
  await assert.rejects(settleRequest(h.store, identities[1], 'Q-role-1', usage(41, 10), 'completed'), code('REQUEST_ID_CONFLICT'))
  await assert.rejects(reserveRequest(h.store, identities[1], 'Q-stale', reserve), code('STALE_EXECUTION'))
  const round = await h.store.read(s => s.rounds[h.opened.roundId]), total = usageTotals(round)
  assert.equal(total.requests, 5); assert.equal(total.totalTokens, 205); assert.equal(total.pendingRequests, 0)
  assert.deepEqual(new Set(Object.values(round.usage.requests).map(r => r.role)), new Set(['plan', 'work', 'code', 'review']))
  assert.equal(round.usage.requests['Q-stage-two'].phase, 'second-stage')
  assert.equal(total.cost.amount, null); assert.equal(total.cost.status, 'unknown')
})

test('reservation precedes provider I/O, rejects overcommit, and deduplicates stable request identity', async t => {
  const h = await fixture(t, { budget: { tokens: 2000 } }), who = await identity(h)
  const options = { ...reserve, inputTokens: 1000, maxTokens: 500 }
  await reserveRequest(h.store, who, 'Q-reserve', options)
  assert.equal((await reserveRequest(h.store, who, 'Q-reserve', options)).duplicate, true)
  await assert.rejects(reserveRequest(h.store, who, 'Q-reserve', { ...options, model: 'changed' }), code('REQUEST_ID_CONFLICT'))
  await settleRequest(h.store, who, 'Q-reserve', usage(100, 50), 'interrupted')
  let total = await h.store.read(s => usageTotals(s.rounds[who.roundId]))
  assert.equal(total.totalTokens, 150); assert.equal(total.pendingReserved, 1350)
  await assert.rejects(reserveRequest(h.store, who, 'Q-overcommit', { ...reserve, inputTokens: 500, maxTokens: 1 }), code('TOKEN_BUDGET_REACHED'))
  await settleRequest(h.store, who, 'Q-reserve', usage(400, 50), 'completed')
  await reserveRequest(h.store, who, 'Q-next', options)
  total = await h.store.read(s => usageTotals(s.rounds[who.roundId]))
  assert.equal(total.totalTokens, 450); assert.equal(total.pendingReserved, 1500)
})

test('pre-round model bootstrap is denied; legacy journal adoption is explicit and never renewed', async t => {
  const h = await fixture(t, { noOpen: true })
  let called = false
  const middleware = h.hooks.get('llm/stream')[0]
  await assert.rejects(async () => { for await (const _ of middleware(opts(h.plan.sessionId), async function* () { called = true })) {} }, code('MANAGED_ROUND_REQUIRED'))
  assert.equal(called, false)
  // Historical migration helper is exercised directly, not treated as model authorization.
  await startPlanningRequest(h.store, h.plan.sessionId, 'Q-legacy', opts(h.plan.sessionId))
  const first = await svc.openRound(h.store, h.plan, { goal: 'adopt preexisting historical journal' })
  await settlePlanningRequest(h.store, 'Q-legacy', usage(80, 10), 'completed')
  assert.equal(usageTotals(await h.store.read(s => s.rounds[first.roundId])).totalTokens, 90)
  await h.store.mutate(s => { s.rounds[first.roundId].closedAt = new Date().toISOString(); s.activeRoundId = null })
  const other = await svc.openRound(h.store, h.plan, { goal: 'separate explicit test objective' })
  assert.equal(Object.keys(await h.store.read(s => s.rounds[other.roundId].usage.requests)).length, 0)
  assert.equal((await h.store.read(s => s.planningUsage['Q-legacy'])).adoptedTo.roundId, first.roundId)
})

test('missing planning cap/usage remains pending and blocks a declared budget rather than charging zero', async t => {
  const h = await fixture(t, { noOpen: true })
  await startPlanningRequest(h.store, h.plan.sessionId, 'Q-uncapped-plan', { provider: 'fake', model: 'stand-in', messages: [] })
  await settlePlanningRequest(h.store, 'Q-uncapped-plan', null, 'interrupted')
  const opened = await svc.openRound(h.store, h.plan, { goal: 'uncertainty is explicit', budget: { tokens: 10000, closeoutRequests: 0 } })
  const who = await identity(h)
  await assert.rejects(reserveRequest(h.store, who, 'Q-not-free', reserve), code('TOKEN_BUDGET_REACHED'))
  const { work } = await h.spawnWork()
  await assert.rejects(h.controller.compute(h.store, work, { argv: ['node', '-e', '0'] }), code('TOKEN_BUDGET_REACHED'))
  const total = usageTotals(await h.store.read(s => s.rounds[opened.roundId]))
  assert.equal(total.unknownReservations, 1); assert.equal(total.pendingRequests, 1)
  assert.equal(total.knownUsageIsLowerBound, true); assert.equal(total.cost.amount, null)
})

test('observable retry attempts are separate rows; usage snapshots are not summed, interruption is pending', async t => {
  const h = await fixture(t)
  await assert.rejects(stream(h, opts(h.plan.sessionId), [
    { type: 'usage', usage: usage(10, 2) }, { type: 'usage', usage: usage(100, 20) },
  ], new Error('synthetic transport interruption')), /synthetic transport interruption/)
  await stream(h, opts(h.plan.sessionId), [{ type: 'usage', usage: usage(200, 30) }])
  await stream(h, opts(h.plan.sessionId), [{ type: 'text', text: 'provider omitted usage' }])
  const round = await h.store.read(s => s.rounds[h.opened.roundId]), rows = Object.values(round.usage.requests), total = usageTotals(round)
  assert.equal(new Set(rows.map(r => r.id)).size, 3)
  assert.equal(rows[0].usage.totalTokens, 120); assert.equal(rows[0].status, 'pending')
  assert.equal(rows[1].status, 'settled'); assert.equal(rows[2].usage, null)
  assert.equal(total.totalTokens, 350); assert.equal(total.pendingRequests, 2); assert.equal(total.knownUsageIsLowerBound, true)
})

test('output caps preserve waterfall config; explicit attribution wins, local initiator is attribution only', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  const hook = h.hooks.get('agent/request')[0], original = Object.freeze({ maxTokens: 9000, marker: 'preserved' })
  const config = await hook({ agent: work.agent }, async () => original)
  assert.equal(config.maxTokens, 2048); assert.equal(config.marker, 'preserved'); assert.equal(original.maxTokens, 9000)
  h.services.agents.currentInitiator = () => work.agent
  await stream(h, Object.freeze({ ...opts(h.plan.sessionId), messages: Object.freeze([]) }), [{ type: 'usage', usage: usage(10, 1) }])
  await stream(h, { ...opts(undefined) }, [{ type: 'usage', usage: usage(20, 2) }])
  const rows = await h.store.read(s => Object.values(s.rounds[h.opened.roundId].usage.requests))
  assert.deepEqual(rows.map(r => r.role), ['plan', 'work'])
  assert.equal(rows[0].sessionId, h.plan.sessionId); assert.equal(rows[1].sessionId, work.sessionId)
})

test('unattributable stream marks uncertainty, revokes controlled work and never invokes downstream', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  let called = false
  const middleware = h.hooks.get('llm/stream')[0]
  await assert.rejects(async () => { for await (const _ of middleware(opts(undefined), async function* () { called = true })) {} }, code('ATTRIBUTION_REQUIRED'))
  assert.equal(called, false)
  const round = await h.store.read(s => s.rounds[h.opened.roundId])
  assert.equal(round.usage.attributionUnknown, true); assert.equal(round.usage.unattributedAttempts, 1)
  assert.equal(round.control.resumeBlocked, true)
  const brief = await svc.status(h.store)
  assert.ok(brief.blockers.some(value => /attribution is unknown/.test(value)))
  await assert.rejects(h.controller.beforeRequest(work.agent), code('RESUME_BLOCKED'))
})

test('a blocked execution phase cannot call the provider while an independent phase remains admitted', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  const paused = await h.controller.dispatch(h.store, work, { role: 'code', family: 'paused', phase: 'paused-step', task: 'blocked task' })
  const other = await h.controller.dispatch(h.store, work, { role: 'code', family: 'other', phase: 'other-step', task: 'independent task' })
  await svc.askGate(h.ctx, h.store, work, { question: 'dependency unavailable', classification: 'blocker', affectedStep: 'paused-step' })
  await assert.rejects(h.controller.beforeRequest(h.agents.get(paused.childId)), code('STEP_BLOCKED'))
  await assert.rejects(reserveRequest(h.store, await identity(h, paused.childId), 'Q-paused', reserve), code('STEP_BLOCKED'))
  assert.ok(await h.controller.beforeRequest(h.agents.get(other.childId)))
})

test('post-response overrun is recorded and revokes further work; it is not an absolute prepaid ceiling', async t => {
  const options = opts('root-plan'), limit = inputReservation(options) + options.maxTokens
  const h = await fixture(t, { budget: { tokens: limit } })
  await stream(h, options, [{ type: 'usage', usage: usage(limit, 10) }])
  const round = await h.store.read(s => s.rounds[h.opened.roundId])
  assert.equal(usageTotals(round).totalTokens, limit + 10); assert.equal(round.control.resumeBlocked, true)
  let called = false
  const middleware = h.hooks.get('llm/stream')[0]
  await assert.rejects(async () => { for await (const _ of middleware(options, async function* () { called = true })) {} }, code('RESUME_BLOCKED'))
  assert.equal(called, false)
})

test('terminal provider failure charges its reservation upper bound and does not poison later admission', async t => {
  const h = await fixture(t), options = opts(h.plan.sessionId)
  const reserved = inputReservation(options) + options.maxTokens
  const failure = { type: 'finish', reason: { kind: 'error', failure: { message: 'Service is too busy.', code: 'SERVER', status: 503 } } }
  await stream(h, options, [failure])
  const rows = await h.store.read(s => Object.values(s.rounds[h.opened.roundId].usage.requests))
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'failed')
  assert.equal(rows[0].chargeTokens, reserved); assert.equal(rows[0].usage, null)
  const total = await h.store.read(s => usageTotals(s.rounds[h.opened.roundId]))
  assert.equal(total.totalTokens, reserved); assert.equal(total.pendingRequests, 0); assert.equal(total.failedRequests, 1)
  await stream(h, options, [{ type: 'usage', usage: usage(10, 2) }])
  const after = await h.store.read(s => usageTotals(s.rounds[h.opened.roundId]))
  assert.equal(after.requests, 2); assert.equal(after.totalTokens, reserved + 12); assert.equal(after.pendingRequests, 0)
})