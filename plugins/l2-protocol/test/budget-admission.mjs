// Deterministic budget-admission checks. No real LLM request is made.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './helpers.mjs'
import { RoundStore } from '../lib/store.js'
import { closeoutReserveOf } from '../lib/runtime.js'
import { bindingOf, usageTotals } from '../lib/runtime.js'
import { reserveRequest, settleRequest } from '../lib/usage.js'

const request = { provider: 'fake', model: 'deterministic', maxTokens: 16, inputTokens: 20 }
const reserveOf = request.inputTokens + request.maxTokens

async function setup(t, budget) {
  const h = await harness({ budget: { closeoutRequests: 0, ...budget } }); t.after(() => h.close())
  const who = await h.store.read(s => { const { round, execution } = bindingOf(s, h.plan.sessionId)
    return { sessionId: h.plan.sessionId, roundId: round.id, executionId: execution.id, generation: execution.generation } })
  return { h, who }
}

const refuses = code => error => error.code === code

test('a pending reservation blocks a second admission atomically', async t => {
  const { h, who } = await setup(t, { tokens: reserveOf * 2 - 1, requests: 8 })
  await reserveRequest(h.store, who, 'Q-a', request)
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-b', request), refuses('TOKEN_BUDGET_REACHED'))
  const totals = await h.store.read(s => usageTotals(s.rounds[who.roundId]))
  assert.equal(totals.pendingReserved, reserveOf)
  assert.equal(totals.totalTokens, 0)
})

test('settled usage plus pending reservations gate the next request', async t => {
  const { h, who } = await setup(t, { tokens: 100, requests: 8 })
  await reserveRequest(h.store, who, 'Q-a', request)
  await settleRequest(h.store, who, 'Q-a', { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'completed')
  await reserveRequest(h.store, who, 'Q-b', request)
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-c', request), refuses('TOKEN_BUDGET_REACHED'))
  const totals = await h.store.read(s => usageTotals(s.rounds[who.roundId]))
  assert.equal(totals.totalTokens, 30)
  assert.equal(totals.pendingReserved, reserveOf)
})

test('a settlement above its reservation is charged and blocks the next request', async t => {
  const { h, who } = await setup(t, { tokens: 100, requests: 8 })
  await reserveRequest(h.store, who, 'Q-a', request)
  const oversized = { inputTokens: 70, outputTokens: 20, totalTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0 }
  await settleRequest(h.store, who, 'Q-a', oversized, 'completed')
  const totals = await h.store.read(s => usageTotals(s.rounds[who.roundId]))
  assert.equal(totals.totalTokens, 90)
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-b', request), refuses('TOKEN_BUDGET_REACHED'))
})

test('an unknown receipt keeps the reservation instead of recording zero', async t => {
  const { h, who } = await setup(t, { tokens: 500, requests: 8 })
  await reserveRequest(h.store, who, 'Q-a', request)
  await settleRequest(h.store, who, 'Q-a', null, 'failed')
  const row = await h.store.read(s => s.rounds[who.roundId].usage.requests['Q-a'])
  assert.equal(row.status, 'failed')
  assert.equal(row.chargeTokens, reserveOf)
  const totals = await h.store.read(s => usageTotals(s.rounds[who.roundId]))
  assert.equal(totals.totalTokens, reserveOf)
  assert.equal(totals.failedCharged, reserveOf)
})

test('a rebuilt store keeps the pending reservation and still refuses', async t => {
  const { h, who } = await setup(t, { tokens: reserveOf * 2 - 1, requests: 8 })
  await reserveRequest(h.store, who, 'Q-a', request)
  const rebuilt = new RoundStore(h.dir)
  await assert.rejects(() => reserveRequest(rebuilt, who, 'Q-b', request), refuses('TOKEN_BUDGET_REACHED'))
  const totals = await rebuilt.read(s => usageTotals(s.rounds[who.roundId]))
  assert.equal(totals.pendingReserved, reserveOf)
})

test('failed attempts consume request slots and the N+1 attempt is refused', async t => {
  const { h, who } = await setup(t, { tokens: 100000, requests: 2 })
  await reserveRequest(h.store, who, 'Q-a', request)
  await settleRequest(h.store, who, 'Q-a', null, 'failed')
  await reserveRequest(h.store, who, 'Q-b', request)
  await settleRequest(h.store, who, 'Q-b', { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'completed')
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-c', request), refuses('REQUEST_BUDGET_REACHED'))
})


// --- closeout reserve (.29): the closing steps keep their room ---

async function addEvidence(h, who, layers) {
  await h.store.mutate(state => {
    const round = state.rounds[who.roundId]
    round.evidence ??= []
    for (const layer of layers) {
      round.evidence.push({ id: 'E-close-' + round.evidence.length, roundId: round.id, layer,
        authorExecutionId: who.executionId, authorRole: 'plan', recordedAt: new Date().toISOString(),
        payload: layer === 'command' ? { command: '/bin/true', exitCode: 0 } : { verdict: 'partial', scope: ['fixture'], uncovered: ['fixture has no product code'] } })
    }
  })
}

const floorRequest = { provider: 'fake', model: 'deterministic', maxTokens: 16, inputTokens: 20 }
const perCloseRequest = 8192 + 16
const closeoutHold = 2 * perCloseRequest

test('ordinary requests stop at the reserve boundary and the closing request may cross it', async t => {
  const { h, who } = await setup(t, { tokens: 100000, requests: 8, closeoutRequests: 2, outputCap: 16 })
  const reserve = await h.store.read(state => closeoutReserveOf(state.rounds[who.roundId]))
  let admitted = 0
  for (;;) {
    try { await reserveRequest(h.store, who, 'Q-ordinary-' + admitted, floorRequest); admitted += 1 }
    catch (error) { assert.equal(error.code, 'CLOSEOUT_RESERVE_PROTECTED'); break }
    if (admitted > 8) throw new Error('ordinary requests never reached the reserve boundary')
  }
  assert.ok(admitted >= 1 && admitted <= 8)
  assert.equal(await h.store.read(state => state.rounds[who.roundId].usage.closeout ?? null), null)
  await addEvidence(h, who, ['command'])
  await reserveRequest(h.store, who, 'Q-close', floorRequest)
  const spent = await h.store.read(state => state.rounds[who.roundId].usage.closeout)
  assert.equal(spent.requests, 1)
  assert.ok(reserve.requests >= 1)
})

test('the reserve grows with the largest plan input estimate seen so far', async t => {
  const { h, who } = await setup(t, { tokens: 400000, requests: 8, closeoutRequests: 2, outputCap: 16 })
  await h.store.mutate(state => { state.rounds[who.roundId].usage.estimates = { plan: 90000 } })
  const reserve = await h.store.read(state => closeoutReserveOf(state.rounds[who.roundId]))
  assert.equal(reserve.perRequest, 90000 + 16)
  assert.equal(reserve.tokens, 2 * (90000 + 16))
  assert.equal(reserve.requests, 2)
})

test('request slots are held for the closing steps', async t => {
  const { h, who } = await setup(t, { tokens: 1000000, requests: 8, closeoutRequests: 2, outputCap: 16 })
  for (let i = 0; i < 6; i++) await reserveRequest(h.store, who, 'Q-slot-' + i, floorRequest)
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-slot-6', floorRequest), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  // the two held slots must both remain: closing request one and two are admitted
  await addEvidence(h, who, ['command', 'review'])
  await reserveRequest(h.store, who, 'Q-slot-close-1', floorRequest)
  await reserveRequest(h.store, who, 'Q-slot-close-2', floorRequest)
})

test('the time reserve stops new work inside the closing window', async t => {
  const { h, who } = await setup(t, { tokens: 100000, requests: 8, closeoutRequests: 2, outputCap: 16 })
  const now = Date.now()
  await h.store.mutate(state => {
    const round = state.rounds[who.roundId]
    round.time = { t0: new Date(now).toISOString(), authorizedAt: new Date(now).toISOString(),
      durationMs: 3600000, authorizedDurationMs: 3600000, shutdownGraceMs: 2000,
      deadlineAt: new Date(now + 60000).toISOString(), signalDueAt: new Date(now + 58000).toISOString() }
  })
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-late-work', floorRequest), refuses('CLOSEOUT_WINDOW_TOO_SMALL'))
  await addEvidence(h, who, ['command', 'review'])
  await reserveRequest(h.store, who, 'Q-late-close', floorRequest)
})

test('pending reservations and the closeout reserve are counted together', async t => {
  const { h, who } = await setup(t, { tokens: 100000, requests: 8, closeoutRequests: 2, outputCap: 16 })
  const reserve = await h.store.read(state => closeoutReserveOf(state.rounds[who.roundId]))
  const perOrdinary = floorRequest.inputTokens + floorRequest.maxTokens
  const ordinarySlots = 8 - reserve.requests
  for (let i = 0; i < ordinarySlots; i++) await reserveRequest(h.store, who, 'Q-fill-' + i, floorRequest)
  const totals = await h.store.read(state => usageTotals(state.rounds[who.roundId]))
  assert.equal(totals.pendingReserved, ordinarySlots * perOrdinary)
  await assert.rejects(() => reserveRequest(h.store, who, 'Q-over', floorRequest), refuses('CLOSEOUT_RESERVE_PROTECTED'))
  await addEvidence(h, who, ['command'])
  await reserveRequest(h.store, who, 'Q-close', floorRequest)
  const after = await h.store.read(state => usageTotals(state.rounds[who.roundId]))
  assert.equal(after.pendingReserved, (ordinarySlots + 1) * perOrdinary)
})
