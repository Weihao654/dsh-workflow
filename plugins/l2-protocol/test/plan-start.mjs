// Fixture Host and temporary ledgers only. No real Host authorization or model I/O.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { harness } from './helpers.mjs'
import { resolveExec } from '../lib/roles.js'
import { authorizeProject } from '../lib/authorization.js'
import { planStartStatus } from '../lib/plan-start.js'

const grant = { authorizationId: 'plan-form-fixture', goal: 'Fixture goal confirmed by a human form',
  budget: { tokens: 100000, requests: 8, wallMinutes: 10, outputCap: 16 } }

async function setup(t) {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-plan-start-'))
  const h = await harness({ noOpen: true, authorityRoot })
  const store = h.controller.storeForExec(resolveExec(h.ctx, { agent: h.plan.agent }))
  const invoke = () => h.commands.get('chain-authorize').handler({ commandId: 'fixture-form-command',
    agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  t.after(async () => {
    await h.close()
    const target = resolve(authorityRoot)
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && target.includes('role-chain-plan-start-'))
    await rm(target, { recursive: true, force: true })
  })
  return { h, store, invoke }
}

async function readOnlyStatus(h, store, sessionId = h.plan.sessionId) {
  const before = existsSync(store.statePath) ? readFileSync(store.statePath) : null
  const timers = [...h.controller.timers.keys()]
  const observations = [...h.controller.observations.entries()]
  const mutate = store.mutate, attach = h.controller.attach, arm = h.controller.arm
  store.mutate = () => { throw new Error('Status must not mutate the ledger') }
  h.controller.attach = () => { throw new Error('Status must not attach an execution') }
  h.controller.arm = () => { throw new Error('Status must not arm a deadline') }
  try { return await planStartStatus(h.ctx, h.controller, sessionId) }
  finally {
    store.mutate = mutate; h.controller.attach = attach; h.controller.arm = arm
    assert.deepEqual(existsSync(store.statePath) ? readFileSync(store.statePath) : null, before)
    assert.deepEqual([...h.controller.timers.keys()], timers)
    assert.deepEqual([...h.controller.observations.entries()], observations)
  }
}

test('ready preview creates no ledger and ordinary sessions receive no authorization details', async t => {
  const { h, store } = await setup(t)
  const ready = await readOnlyStatus(h, store)
  assert.equal(ready.state, 'ready'); assert.equal(ready.preset, 'plan'); assert.equal(ready.isRoot, true)
  assert.equal(ready.authorization, null); assert.equal(ready.roundId, null)
  assert.equal(existsSync(store.dir), false)
  h.sessions.get(h.plan.sessionId).header.agentPreset = 'standard'
  const ordinary = await readOnlyStatus(h, store)
  assert.equal(ordinary.state, 'ordinary'); assert.equal(ordinary.role, null)
  assert.equal(ordinary.authorization, null); assert.equal(ordinary.roundId, null)
  assert.equal(existsSync(store.dir), false)
})

test('preview requires a real matching live binding and an actual root plan', async t => {
  const { h, store } = await setup(t)
  await assert.rejects(readOnlyStatus(h, store, ''), { code: 'BAD_ARGS' })
  await assert.rejects(readOnlyStatus(h, store, 'not-live'), { code: 'ROLE_BINDING_INVALID' })
  const composed = h.services.agentPresets.composedPreset
  h.services.agentPresets.composedPreset = () => 'code'
  await assert.rejects(readOnlyStatus(h, store), { code: 'ROLE_BINDING_INVALID' })
  h.services.agentPresets.composedPreset = composed
  Object.assign(h.sessions.get(h.plan.sessionId).header, { parentSession: 'parent', origin: 'subagent' })
  await assert.rejects(readOnlyStatus(h, store), { code: 'ROLE_DENIED' })
  assert.equal(existsSync(store.dir), false)
})

test('bound preview requires the exact active root execution and returns only form authorization fields', async t => {
  const { h, store, invoke } = await setup(t)
  assert.equal((await invoke()).kind, 'success')
  const status = await readOnlyStatus(h, store)
  assert.equal(status.state, 'bound'); assert.ok(status.roundId)
  assert.deepEqual(Object.keys(status.authorization).sort(), ['budget', 'goal', 'id', 'sessionId'])
  assert.equal(status.authorization.id, grant.authorizationId)
  assert.equal(status.authorization.sessionId, h.plan.sessionId)
  await store.mutate(state => { state.activeRoundId = null })
  await assert.rejects(readOnlyStatus(h, store), { code: 'IDENTITY_MISMATCH' })
})

test('durable stops, local barriers, holds and expired authorization cannot appear bound or ready', async t => {
  const { h, store, invoke } = await setup(t)
  assert.equal((await invoke()).kind, 'success')
  const roundId = await store.read(state => state.activeRoundId)
  const editRound = change => store.mutate(state => change(state.rounds[roundId], state))
  await editRound(round => { round.control.resumeBlocked = true })
  assert.equal((await readOnlyStatus(h, store)).state, 'stopped')
  await editRound(round => { round.control.resumeBlocked = false; Object.values(round.executions)[0].resumeBlocked = true })
  assert.equal((await readOnlyStatus(h, store)).state, 'stopped')
  await editRound(round => { Object.values(round.executions)[0].resumeBlocked = false; round.control.limitHold = true })
  assert.equal((await readOnlyStatus(h, store)).state, 'stopped')
  await editRound(round => { round.control.limitHold = false })
  h.controller.barriers.add(h.controller.barrierKey(store, roundId))
  assert.equal((await readOnlyStatus(h, store)).state, 'stopped')
  h.controller.barriers.clear()
  await editRound((_round, state) => { state.authorization.deadlineAt = new Date(0).toISOString() })
  assert.equal((await readOnlyStatus(h, store)).state, 'stopped')
})

test('closed owner cannot restart while another root receives an independent ready preview', async t => {
  const { h, store, invoke } = await setup(t)
  assert.equal((await invoke()).kind, 'success')
  const other = { id: 'other-plan', ctx: Object.freeze({ fixtureAgent: 'other-plan' }) }
  h.agents.set(other.id, other)
  h.sessions.set(other.id, { id: other.id, header: { id: other.id, cwd: h.dir, agentPreset: 'plan' } })
  const otherOwner = await readOnlyStatus(h, store, other.id)
  assert.equal(otherOwner.state, 'ready'); assert.equal(otherOwner.authorization, null)
  assert.notEqual(h.controller.storeForExec(resolveExec(h.ctx, { agent: other })).key, store.key)
  h.sessions.get(other.id).header.agentPreset = 'work'
  const ordinary = await readOnlyStatus(h, store, other.id)
  assert.equal(ordinary.state, 'ordinary'); assert.equal(ordinary.authorization, null); assert.equal(ordinary.roundId, null)
  await store.mutate(state => { state.rounds[state.activeRoundId].closedAt = new Date().toISOString(); state.activeRoundId = null })
  assert.equal((await readOnlyStatus(h, store)).state, 'closed')
})

test('grant-only preview is available only to its owner before any round has ever opened', async t => {
  const { h, store } = await setup(t)
  const exec = resolveExec(h.ctx, { agent: h.plan.agent })
  await authorizeProject(store, exec, grant, 'grant-persisted-before-bootstrap-failure')
  const status = await readOnlyStatus(h, store)
  assert.equal(status.state, 'grant-only'); assert.equal(status.roundId, null)
  assert.equal(status.authorization.goal, grant.goal)
  assert.equal(await store.read(state => Object.keys(state.rounds).length), 0)
  await store.mutate(state => { state.authorization.deadlineAt = new Date(0).toISOString() })
  assert.equal((await readOnlyStatus(h, store)).state, 'stopped')
})

test('preview refuses broken generations, missing owner bindings and cwd escape without repairs', async t => {
  const { h, store, invoke } = await setup(t)
  assert.equal((await invoke()).kind, 'success')
  const original = await store.read(state => ({ ...state.sessionBindings[h.plan.sessionId] }))
  await store.mutate(state => { state.sessionBindings[h.plan.sessionId].generation++ })
  await assert.rejects(readOnlyStatus(h, store), { code: 'IDENTITY_MISMATCH' })
  await store.mutate(state => { delete state.sessionBindings[h.plan.sessionId] })
  await assert.rejects(readOnlyStatus(h, store), { code: 'MANAGED_ROUND_REQUIRED' })
  const moved = join(h.dir, 'moved-cwd'); await mkdir(moved)
  h.services.workingDirectory.get = () => moved
  await assert.rejects(readOnlyStatus(h, store), { code: 'EXECUTION_SCOPE_CHANGED' })
  // Restore this deliberately corrupted fixture so its ordinary teardown can stop it.
  h.services.workingDirectory.get = () => h.dir
  await store.mutate(state => { state.sessionBindings[h.plan.sessionId] = original })
})
