import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { executionDir } from '../lib/managed-jobs.js'
import { acquireAdmissionLock } from '../lib/admission.js'
import { join } from 'node:path'
import { harness, deferred } from './helpers.mjs'
import { ChainController } from '../lib/controller.js'
import { RoundStore } from '../lib/store.js'
import { registerTools } from '../lib/tools.js'
import { requestStopIntent, freezeDeadline, aggregate, budgetOf } from '../lib/runtime.js'
import * as svc from '../lib/service.js'
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const code = expected => error => error.code === expected
async function fixture(t, options) { const h = await harness(options); t.after(() => h.close()); return h }

test('round budget/T0 is fixed and missing Git facts never become no-git', async t => {
  const h = await fixture(t)
  const { work } = await h.spawnWork()
  const original = await h.store.read(s => s.rounds[h.opened.roundId].time)
  assert.equal(Date.parse(original.deadlineAt) - Date.parse(original.t0), 90 * 60_000)
  await assert.rejects(svc.freezeBaseline(h.ctx, h.store, work), code('BASELINE_ALREADY_FROZEN'))
  await h.store.mutate(s => { const r = s.rounds[h.opened.roundId]; r.control.phase = 'review'; assert.deepEqual(freezeDeadline(r), original) })
  assert.throws(() => budgetOf({ budget: { wallMinutes: 91 } }), code('BAD_BUDGET'))
  assert.throws(() => budgetOf({ budget: { tokens: NaN } }), code('BAD_BUDGET'))
  h.services.subprocess.spawn = () => { throw new Error('provider unreachable') }
  await assert.rejects(svc.checkBaseline(h.ctx, h.store, work), code('BASELINE_UNAVAILABLE'))
})

test('same-round reuse is serialized, busy does not spawn, and review remains independent', async t => {
  const h = await fixture(t), { work, result: first } = await h.spawnWork()
  await assert.rejects(h.controller.dispatch(h.store, h.plan, { role: 'work', task: 'another stage' }), code('CHILD_BUSY'))
  await h.complete(work.sessionId)
  const reused = await h.controller.dispatch(h.store, h.plan, { role: 'work', phase: 'stage-two', task: 'continue' })
  assert.equal(reused.action, 'reuse'); assert.equal(reused.childId, first.childId); assert.equal(reused.generation, first.generation + 1)
  const work2 = h.exec(reused.childId)
  const results = await Promise.allSettled([1, 2].map(() => h.controller.dispatch(h.store, work2, { role: 'code', family: 'source', task: 'patch' })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CHILD_BUSY')
  const reviewA = await h.controller.dispatch(h.store, work2, { role: 'review', task: 'read-only review A' })
  const reviewB = await h.controller.dispatch(h.store, work2, { role: 'review', task: 'independent review B' })
  assert.notEqual(reviewA.childId, reviewB.childId)
  const full = await svc.status(h.store, { detail: 'full' })
  assert.equal(Object.values(full.executions).filter(e => e.role === 'review').length, 2)
})

test('stop admission is durable before cancel and accepted while running remains pending', async t => {
  const h = await fixture(t, { holdCancel: true, holdDispose: true }), { work, result } = await h.spawnWork()
  const record = h.records.get(work.sessionId)
  let sawDurable = false
  const live = h.controller.live.get(result.executionId), dispose = live.activation.dispose
  live.activation.dispose = async () => {
    const state = h.store.snapshot(), round = state.rounds[h.opened.roundId]
    sawDurable = round.executions[result.executionId].resumeBlocked && Boolean(round.control.stops['stop-1'])
    return dispose()
  }
  const args = { executionId: result.executionId, generation: result.generation, requestId: 'stop-1', reason: 'revoked', waitMs: 10 }
  const reply = await h.controller.stop(h.store, h.plan, args)
  assert.equal(sawDurable, true); assert.equal(reply.admission, 'persisted'); assert.equal(reply.state, 'stop-pending'); assert.notEqual(reply.agentQuiescent, true)
  await assert.rejects(h.controller.dispatch(h.store, work, { role: 'code', task: 'must not start' }), code('RESUME_BLOCKED'))
  const repeated = await h.controller.stop(h.store, h.plan, args)
  assert.equal(repeated.duplicate, true)
  await assert.rejects(h.controller.stop(h.store, h.plan, { ...args, reason: 'different request' }), code('REQUEST_ID_CONFLICT'))
  record.dispose.resolve(); await flush(); await h.store.queue
  const confirmed = await h.controller.stop(h.store, h.plan, args)
  assert.equal(confirmed.agentQuiescent, true); assert.equal(confirmed.state, 'stopped')
})

test('start/cancel race is not falsely joined by draining an absent child; late handle is reaped', async t => {
  const gate = deferred(), h = await fixture(t, { beforeSpawn: () => gate.promise })
  const pending = h.controller.dispatch(h.store, h.plan, { role: 'work', task: 'delayed start' })
  while (!h.calls.spawn.length) await new Promise(resolve => setImmediate(resolve))
  const stopped = await h.controller.stop(h.store, h.plan, { requestId: 'race', reason: 'cancel during start', waitMs: 10 })
  assert.notEqual(stopped.agentQuiescent, true); assert.equal(stopped.state, 'stop-pending')
  gate.resolve()
  const launched = await pending
  assert.equal(launched.ok, false); assert.equal(launched.code, 'STOP_PENDING')
  await flush(); await h.store.queue
  const full = await svc.status(h.store, { detail: 'full' })
  assert.equal(full.control.resumeBlocked, true)
  assert.ok(Object.values(full.executions).every(e => e.agentQuiescent === true))
})

test('late cancel/callback cannot affect a reused session generation or erase natural completion', async t => {
  const h = await fixture(t), { work, result: old } = await h.spawnWork()
  await h.complete(work.sessionId)
  const next = await h.controller.dispatch(h.store, h.plan, { role: 'work', task: 'stage two' })
  const oldExecution = await h.store.read(s => s.rounds[h.opened.roundId].executions[old.executionId])
  const beforeSignals = h.calls.interrupt.length + h.calls.drain.length
  await h.controller.stop(h.store, h.plan, { executionId: old.executionId, generation: old.generation, requestId: 'late', reason: 'old message' })
  await h.controller.proveAgent(h.store, oldExecution, 'late-test-receipt')
  assert.equal(h.calls.interrupt.length + h.calls.drain.length, beforeSignals)
  const current = await h.store.read(s => s.rounds[h.opened.roundId].executions[next.executionId])
  assert.equal(current.resumeBlocked, false); assert.equal(current.agentQuiescent, false)
  const natural = await h.store.read(s => s.rounds[h.opened.roundId].executions[old.executionId])
  assert.equal(natural.state, 'completed')
  await assert.rejects(h.controller.stop(h.store, h.plan, { executionId: next.executionId, generation: old.generation, requestId: 'wrong-generation', reason: 'stale' }), code('STALE_EXECUTION'))
})

test('mismatched Team/native channel is fenced; model cannot claim user authority', async t => {
  const h = await fixture(t); registerTools(h.ctx, { controller: h.controller })
  h.definitions.set('interrupt_agent', { name: 'interrupt_agent', parameters: { properties: { target: { type: 'string' } } }, execute() { throw new Error('must not be called') } })
  assert.match(h.controller.guard({ name: 'interrupt_agent', arguments: { target: 'e48c42e0-d81c-4c5c-9acd-1bdc4ada9d8a' }, agent: h.plan.agent }), /CONTROLLED_ROUND/)
  await assert.rejects(h.controller.stopWithAuthority(h.store, { requestId: 'forged', reason: 'not a human command' }, { kind: 'user', parentSessionId: h.plan.sessionId }), code('UNAUTHORIZED'))
  const { work } = await h.spawnWork()
  await assert.rejects(h.controller.stop(h.store, work, { requestId: 'not-root', reason: 'cannot stop whole round' }), code('UNAUTHORIZED'))
  assert.equal(h.calls.interrupt.length, 0)
})

test('genuine human command works with original parent offline, but admission is not exit proof', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  const second = new ChainController(h.ctx).install(); h.extraControllers.push(second)
  h.agents.delete(h.plan.sessionId); h.agents.delete(work.sessionId)
  h.sessions.set('human-control', { id: 'human-control', header: { id: 'human-control', agentPreset: 'standard', cwd: h.dir } })
  const result = await h.commands.get('chain-stop').handler({ rawInput: `${h.opened.roundId} offline-1 revoked from UI`, agent: { id: 'human-control' } })
  assert.equal(result.kind, 'success')
  const receipt = JSON.parse(result.text)
  assert.equal(receipt.resumeBlocked, true); assert.equal(receipt.state, 'stop-pending')
  assert.equal(h.calls.interrupt.at(-1).authority.kind, 'user')
  assert.notEqual(receipt.agentQuiescent, true)
})

test('default status is six fields, actual promise fields survive, and guarded writes cannot reset control files', async t => {
  const h = await fixture(t); registerTools(h.ctx, { controller: h.controller })
  const { work } = await h.spawnWork()
  const definition = h.definitions.get('chain_status')
  const brief = await definition.execute({}, { agent: work.agent })
  assert.deepEqual(Object.keys(brief), ['goal', 'execution', 'budget', 'artifact', 'blockers', 'next'])
  const full = await definition.execute({ detail: 'full' }, { agent: work.agent })
  assert.ok(full.control && full.agents && full.roleModels)
  h.definitions.set('write', { parameters: { properties: { file_path: {}, content: {} } }, execute() {} })
  assert.match(h.controller.guard({ name: 'write', arguments: { file_path: join(h.dir, '.dsh', 'rounds', 'state.json') }, agent: work.agent }), /CONTROL_STATE_PROTECTED/)
  const copiedDefinition = { ...definition }
  h.definitions.set('chain_status', copiedDefinition)
  assert.equal(h.controller.guard({ name: 'chain_status', arguments: {}, agent: work.agent }), undefined)
})

test('gate admission does not ask unchanged questions, pauses only blocked phase, and does not approve no answer', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  let asked = 0; h.services.userQuestions.ask = async () => { asked++; return { answers: [] } }
  const unchanged = await svc.askGate(h.ctx, h.store, work, { question: 'Unchanged known fact', classification: 'unchanged-premise', originalAuthorization: 'original approved scope' })
  assert.equal(unchanged.code, 'NOT_GATED'); assert.equal(asked, 0)
  await svc.askGate(h.ctx, h.store, work, { question: 'Dependency unreachable', classification: 'blocker', affectedStep: 'blocked-step' })
  await assert.rejects(h.controller.dispatch(h.store, work, { role: 'code', task: 'blocked work', phase: 'blocked-step' }), code('STEP_BLOCKED'))
  const independent = await h.controller.dispatch(h.store, work, { role: 'code', task: 'independent authorized work', phase: 'other-step' })
  assert.equal(independent.ok, true)
  const acceptance = await svc.askGate(h.ctx, h.store, h.plan, { kind: 'accept', question: 'too early?', classification: 'closeout', stage: 'development' })
  assert.equal(acceptance.code, 'NOT_GATED')
  const decision = await svc.askGate(h.ctx, h.store, h.plan, { kind: 'scope', question: 'specific new scope?', classification: 'scope', change: 'one new export', originalAuthorization: 'read-only report', whyNotCovered: 'export creates a file' })
  assert.equal(asked, 1); assert.equal(decision.gate.approved, false)
})

test('corrupt or deleted authority state fails closed across canonical store instances', async t => {
  const h = await fixture(t), alias = new RoundStore(join(h.dir, '.'))
  await Promise.all([1, 2, 3].map(() => alias.mutate(s => { s.testCounter = (s.testCounter ?? 0) + 1 })))
  assert.equal(await h.store.read(s => s.testCounter), 3)
  const saved = await h.store.read(s => s)
  await writeFile(h.store.statePath, '{broken', 'utf8')
  await assert.rejects(alias.read(s => s), code('STATE_UNREADABLE'))
  await writeFile(h.store.statePath, JSON.stringify(saved), 'utf8')
  await unlink(h.store.statePath)
  assert.throws(() => alias.snapshot(), code('STATE_UNREADABLE'))
  await writeFile(h.store.statePath, JSON.stringify(saved), 'utf8')
})

test('deadline survives controller recreation, old automatic stop cannot signal a new-round binding', async t => {
  const h = await fixture(t), { work, result } = await h.spawnWork()
  const original = await h.store.read(s => s.rounds[h.opened.roundId].time)
  const afterRestart = new ChainController(h.ctx, { now: () => Date.parse(original.deadlineAt) + 1 })
  h.extraControllers.push(afterRestart)
  await afterRestart.attach(h.store, h.exec(work.sessionId))
  const execution = await h.store.read(s => s.rounds[h.opened.roundId].executions[result.executionId])
  assert.throws(() => afterRestart.assertLiveAdmission(h.store, execution), error => ['DEADLINE_REACHED', 'RESUME_BLOCKED'].includes(error.code))
  assert.deepEqual(await h.store.read(s => s.rounds[h.opened.roundId].time), original)
  await h.complete(work.sessionId)
  await h.store.mutate(s => { s.sessionBindings[work.sessionId] = { roundId: 'R-other', executionId: 'E-new', generation: result.generation + 1 } })
  const count = h.calls.interrupt.length + h.calls.drain.length
  await h.controller.signalAgent(h.store, execution, { agent: h.plan.agent })
  assert.equal(h.calls.interrupt.length + h.calls.drain.length, count)
  await h.store.mutate(s => { s.sessionBindings[work.sessionId] = { roundId: h.opened.roundId, executionId: result.executionId, generation: result.generation } })
})

test('fresh, policy changes and roster release cannot replace a same-round work/code slot', async t => {
  const h = await fixture(t), { work, result } = await h.spawnWork()
  await assert.rejects(h.controller.dispatch(h.store, h.plan, { role: 'work', task: 'replacement', fresh: true }), code('REUSE_POLICY_CONFLICT'))
  const child = await h.controller.dispatch(h.store, work, { role: 'code', family: 'A', task: 'source' })
  await assert.rejects(h.controller.dispatch(h.store, { ...work, reuse: { code: 'persistent' } }, { role: 'code', family: 'B', task: 'policy bypass' }), code('CHILD_BUSY'))
  await assert.rejects(h.controller.dispatch(h.store, work, { role: 'code', family: 'A', task: 'fresh bypass', fresh: true }), code('REUSE_POLICY_CONFLICT'))
  await h.complete(child.childId)
  const released = await h.controller.release(h.store, work, { role: 'code', family: 'A' })
  assert.equal(released.ok, true)
  await assert.rejects(h.controller.dispatch(h.store, work, { role: 'code', family: 'A', task: 'released bypass' }), code('RESUME_BLOCKED'))
  await h.complete(result.childId)
  await h.store.mutate(s => { s.agents = {} })
  const reused = await h.controller.dispatch(h.store, h.plan, { role: 'work', task: 'roster reconstructed' })
  assert.equal(reused.childId, result.childId); assert.equal(reused.action, 'reuse')
})

test('old Agent disposal cannot prove a cold-resumed Agent with the same session id', async t => {
  const h = await fixture(t), { work } = await h.spawnWork(), oldAgent = work.agent
  await h.complete(work.sessionId)
  const send = h.services.subagents.sendMessage
  h.services.subagents.sendMessage = async (...args) => {
    const result = await send(...args)
    h.agents.set(work.sessionId, { ...oldAgent })
    return result
  }
  const next = await h.controller.dispatch(h.store, h.plan, { role: 'work', task: 'cold resume' })
  for (const hook of h.hooks.get('agent/disposed')) hook({ agent: oldAgent })
  for (const hook of h.hooks.get('agent/disposed')) hook({ id: work.sessionId })
  await flush(); await h.store.queue
  assert.equal(await h.store.read(s => s.rounds[h.opened.roundId].executions[next.executionId].agentQuiescent), false)
  for (const hook of h.hooks.get('agent/disposed')) hook({ agent: h.agents.get(work.sessionId) })
  await flush(); await h.store.queue
  assert.equal(await h.store.read(s => s.rounds[h.opened.roundId].executions[next.executionId].agentQuiescent), true)
})

test('real ancestor can selectively revoke a code job, but an id alone is not authority', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  const child = await h.controller.dispatch(h.store, work, { role: 'code', task: 'code-owned stand-in' })
  const e = { id: `J-${randomUUID()}`, roundId: h.opened.roundId, kind: 'job', parentExecutionId: child.executionId,
    ownerSessionId: child.childId, generation: 1, nonce: randomUUID(), state: 'running', agentQuiescent: true,
    jobsQuiescent: false, resumeBlocked: false, evidenceRefs: [] }
  await h.store.mutate(s => { s.rounds[e.roundId].executions[e.id] = e })
  h.controller.live.set(e.id, { store: h.store, execution: e })
  const args = { executionId: e.id, generation: 1, requestId: 'ancestor-stop', reason: 'revoke code job', waitMs: 10 }
  await assert.rejects(h.controller.stop(h.store, { ...work, agent: { id: work.sessionId } }, args), code('UNAUTHORIZED'))
  const receipt = await h.controller.stop(h.store, work, args)
  assert.equal(receipt.admission, 'persisted'); assert.equal(receipt.jobsQuiescent, false)
  assert.equal(await h.store.read(s => s.rounds[e.roundId].executions[child.executionId].resumeBlocked), false)
  h.controller.live.delete(e.id)
  await assert.rejects(h.controller.stop(h.store, work, args), code('UNAUTHORIZED'))
})

test('missing or partial process isolation durably rejects compute before Host job creation', async t => {
  const h = await fixture(t), { work } = await h.spawnWork()
  await assert.rejects(h.controller.compute(h.store, work, { argv: ['node', '-e', '0'] }), code('COMPUTE_ISOLATION_UNAVAILABLE'))
  let seenPolicy
  h.services.sandbox = { async confine(argv, policy) { seenPolicy = policy; return { argv, enforcement: 'partial' } } }
  await assert.rejects(h.controller.compute(h.store, work, { argv: ['node', '-e', '0'] }), code('COMPUTE_ISOLATION_UNAVAILABLE'))
  assert.equal(seenPolicy.mode, 'read-only'); assert.equal(seenPolicy.sessionId, work.sessionId)
  assert.equal(h.calls.jobs.length, 0)
  const jobs = await h.store.read(s => Object.values(s.rounds[h.opened.roundId].executions).filter(e => e.kind === 'job'))
  assert.equal(jobs.length, 2); assert.ok(jobs.every(e => e.outcome === 'not-started' && e.jobsQuiescent === true))
})

test('compute cancellation during sandbox preparation never starts a late supervisor', async t => {
  const gate = deferred(), entered = deferred(), h = await fixture(t), { work } = await h.spawnWork()
  h.services.sandbox = { async confine(argv) { entered.resolve(); await gate.promise; return { argv, enforcement: 'full' } } }
  const starting = h.controller.compute(h.store, work, { argv: ['node', '-e', '0'] })
  await entered.promise
  const e = await h.store.read(s => Object.values(s.rounds[h.opened.roundId].executions).find(e => e.kind === 'job'))
  const stopped = await h.controller.stop(h.store, h.plan, { executionId: e.id, generation: e.generation, requestId: 'prepare-stop', reason: 'cancel before admission', waitMs: 10 })
  assert.notEqual(stopped.jobsQuiescent, true)
  gate.resolve()
  await assert.rejects(starting, code('RESUME_BLOCKED'))
  assert.equal(h.calls.jobs.length, 0)
  assert.equal(await h.store.read(s => s.rounds[e.roundId].executions[e.id].outcome), 'not-started')
})

test('a matching file receipt without a trusted supervisor join remains unknown', async t => {
  const h = await fixture(t), { work, result } = await h.spawnWork()
  const time = await h.store.read(s => s.rounds[h.opened.roundId].time)
  const e = { id: `J-${randomUUID()}`, roundId: h.opened.roundId, kind: 'job', parentExecutionId: result.executionId,
    ownerSessionId: work.sessionId, generation: 1, nonce: randomUUID(), state: 'running', agentQuiescent: true,
    jobsQuiescent: null, resumeBlocked: false, evidenceRefs: [] }
  await h.store.mutate(s => { s.rounds[e.roundId].executions[e.id] = e })
  const dir = executionDir(h.store, e); await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'receipt.json'), JSON.stringify({ nonce: e.nonce, roundId: e.roundId, executionId: e.id, generation: 1,
    backend: 'windows-job-list-v1', ...time, jobEmpty: true, exitAt: new Date().toISOString(), checkedAt: new Date().toISOString() }))
  h.controller.live.set(e.id, { store: h.store, execution: e, providerJoined: false })
  await h.controller.refresh(h.store, e.roundId)
  assert.equal(await h.store.read(s => s.rounds[e.roundId].executions[e.id].jobsQuiescent), null)
})

test('lock timeout persists intent but cannot acknowledge native admission closure before join or marker', async t => {
  const h = await fixture(t), { work, result } = await h.spawnWork()
  const e = { id: `J-${randomUUID()}`, roundId: h.opened.roundId, kind: 'job', parentExecutionId: result.executionId,
    ownerSessionId: work.sessionId, generation: 1, nonce: randomUUID(), state: 'running', agentQuiescent: true,
    jobsQuiescent: false, resumeBlocked: false, evidenceRefs: [] }
  await h.store.mutate(s => { s.rounds[e.roundId].executions[e.id] = e })
  const abort = new AbortController(); let persistedBeforeSignal = false
  abort.signal.addEventListener('abort', () => { persistedBeforeSignal = true })
  h.controller.live.set(e.id, { store: h.store, execution: e, processAbort: abort })
  const release = await acquireAdmissionLock(executionDir(h.store, e))
  try {
    const receipt = await h.controller.stop(h.store, h.plan, { executionId: e.id, generation: 1,
      requestId: 'locked-create', reason: 'native call remains in flight', waitMs: 10 })
    assert.equal(receipt.admission, 'persisted'); assert.equal(receipt.nativeAdmission, 'pending')
    assert.deepEqual(receipt.pendingNativeExecutions, [e.id]); assert.equal(receipt.state, 'stop-pending')
    assert.equal(persistedBeforeSignal, true)
    const row = await h.store.read(s => s.rounds[e.roundId].executions[e.id])
    assert.equal(row.nativeAdmissionPending, true); assert.equal(row.nativeAdmissionConfirmedAt, undefined)
    assert.equal(row.resumeBlocked, true); assert.equal(row.jobsQuiescent, false)
  } finally {
    await release(); await h.complete(result.childId)
    h.records.get(h.plan.sessionId).idle.resolve()
    await Promise.all([...h.controller.pending])
  }
})

test('missing/legacy inventory is unknown, not an empty stopped scope', () => {
  const result = aggregate({ executions: {}, control: {} })
  assert.equal(result.agentQuiescent, 'unknown'); assert.equal(result.jobsQuiescent, 'unknown'); assert.notEqual(result.state, 'stopped')
  assert.throws(() => requestStopIntent({ rounds: {} }, { executions: {}, control: {} }, { requestId: 'old-v15', reason: 'cannot adopt unknown work' }), code('UNMANAGED_ROUND'))
})
