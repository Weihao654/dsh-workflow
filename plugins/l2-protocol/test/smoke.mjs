// Controlled fixtures supersede the old unbound-agent/no-git-on-error smoke checks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './helpers.mjs'
import * as svc from '../lib/service.js'
const closeout = { version: { commit: '(no-git)', artifact: 'fixture only' }, result: 'partial', uncovered: ['Real Host integration and invoice excluded.'], servicesStopped: true }
async function evidence(h, work) {
  await svc.recordEvidence(h.store, work, { layer: 'command', payload: { command: 'deterministic fixture, not a real shell test', exitCode: 0 } })
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
