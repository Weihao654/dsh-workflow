// Synthetic Host, provider and command fixtures only; never sends a real model request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { harness } from './helpers.mjs'
import { resolveExec } from '../lib/roles.js'
import { planStartStatus } from '../lib/plan-start.js'
import { authorizeProject } from '../lib/authorization.js'
import { openRound } from '../lib/service.js'
import { installUsage } from '../lib/usage.js'
import { ChainController } from '../lib/controller.js'
import { bindingOf } from '../lib/runtime.js'
import { registerTools } from '../lib/tools.js'

const grant = (id, requests = 16) => ({ authorizationId: `independent-${id}`, goal: `Separate synthetic task ${id}`,
  budget: { tokens: 200000, requests, wallMinutes: 10, outputCap: 16 } })

async function fixture(t) {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-independent-plans-'))
  const h = await harness({ noOpen: true, authorityRoot })
  h.services.workingDirectory.get = session => session.header.cwd
  const dispose = installUsage(h.ctx, h.controller)
  t.after(async () => {
    dispose(); await h.close()
    const target = resolve(authorityRoot)
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && target.includes('role-chain-independent-plans-'))
    await rm(target, { recursive: true, force: true })
  })
  const add = (id, preset = 'plan', options = {}) => {
    const agent = { id, ctx: Object.freeze({ independentPlanFixture: id }) }
    h.agents.set(id, agent)
    h.sessions.set(id, { id, header: { id, cwd: options.cwd ?? h.dir, agentPreset: preset,
      ...(options.parent ? { parentSession: options.parent, ...(options.fork ? { isSeeded: true } : { origin: 'subagent' }) } : {}) } })
    return agent
  }
  const exec = agent => resolveExec(h.ctx, { agent })
  const storeOf = (agent, controller = h.controller) => controller.storeForExec(exec(agent))
  const command = (agent, args = grant(agent.id)) => h.commands.get('chain-authorize').handler({
    commandId: `fixture-human-${agent.id}`, agent, rawInput: JSON.stringify(args) })
  const stream = async (agent, onNext = () => {}) => {
    for await (const _ of h.hooks.get('llm/stream')[0]({ sessionId: agent.id,
      provider: 'fixture', model: 'deterministic', maxTokens: 16, messages: [] }, async function* () {
      await onNext()
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } }
    })) {}
  }
  return { h, authorityRoot, add, exec, storeOf, command, stream }
}

test('same-cwd new roots preview separate empty tasks without creating authority or borrowing another grant', async t => {
  const { h, authorityRoot, add, storeOf, command } = await fixture(t)
  const first = h.plan.agent, second = add('second-root-plan')
  const before = await readdir(authorityRoot)
  for (const agent of [first, second]) {
    const status = await planStartStatus(h.ctx, h.controller, agent.id)
    assert.equal(status.state, 'ready'); assert.equal(status.authorization, null)
    assert.equal(existsSync(storeOf(agent).dir), false)
  }
  assert.deepEqual(await readdir(authorityRoot), before)
  assert.equal((await command(first)).kind, 'success')
  const firstStore = storeOf(first), original = await readFile(firstStore.statePath)
  assert.equal((await planStartStatus(h.ctx, h.controller, second.id)).state, 'ready')
  await assert.rejects(h.controller.beforeRequest(second), { code: 'MANAGED_ROUND_REQUIRED' })
  assert.equal((await command(second, grant(second.id, 20))).kind, 'success')
  const secondStore = storeOf(second)
  assert.notEqual(firstStore.key, secondStore.key)
  assert.notEqual(firstStore.dir, secondStore.dir)
  assert.equal(firstStore.rootDir, secondStore.rootDir)
  assert.deepEqual(await readFile(firstStore.statePath), original)
  assert.equal(await firstStore.read(s => s.authorization.budget.requests), 16)
  assert.equal(await secondStore.read(s => s.authorization.budget.requests), 20)
  for (const [agent, store] of [[first, firstStore], [second, secondStore]]) {
    assert.equal((await planStartStatus(h.ctx, h.controller, agent.id)).state, 'bound')
    assert.equal((await h.controller.forSession(agent.id)).store.key, store.key)
    assert.equal(await store.read(s => s.authorization.sessionId), agent.id)
  }
})

test('legacy project owner keeps its exact ledger while a new root starts an independent task', async t => {
  const { h, add, exec, storeOf, command } = await fixture(t)
  const legacy = h.controller.storeForCwd(h.dir), originalArgs = grant(h.plan.agent.id)
  await authorizeProject(legacy, exec(h.plan.agent), originalArgs, 'fixture-legacy-authority')
  await openRound(legacy, exec(h.plan.agent), originalArgs)
  const before = await readFile(legacy.statePath)
  const originalGrant = await legacy.read(s => s.authorization)
  assert.equal(storeOf(h.plan.agent).key, legacy.key)
  const fresh = add('new-root-alongside-legacy')
  assert.equal((await planStartStatus(h.ctx, h.controller, fresh.id)).state, 'ready')
  assert.equal((await command(fresh)).kind, 'success')
  assert.notEqual(storeOf(fresh).key, legacy.key)
  assert.deepEqual(await readFile(legacy.statePath), before)
  assert.equal((await command(h.plan.agent, originalArgs)).kind, 'success')
  assert.deepEqual(await legacy.read(s => s.authorization), originalGrant)
  await assert.rejects(authorizeProject(legacy, exec(fresh), originalArgs, 'must-not-take-over'),
    { code: 'AUTHORIZATION_OWNER_MISMATCH' })
  assert.deepEqual(await legacy.read(s => s.authorization), originalGrant)
})

test('stopped, expired and closed original tasks never prevent a distinct root from starting or reset the original', async t => {
  const { h, add, storeOf, command } = await fixture(t)
  assert.equal((await command(h.plan.agent)).kind, 'success')
  const original = storeOf(h.plan.agent)
  for (const phase of ['stopped', 'expired', 'closed']) {
    await original.mutate(s => {
      const round = Object.values(s.rounds)[0]
      if (phase === 'stopped') round.control.resumeBlocked = true
      if (phase === 'expired') s.authorization.deadlineAt = new Date(0).toISOString()
      if (phase === 'closed') { round.closedAt = new Date().toISOString(); s.activeRoundId = null }
    })
    const bytes = await readFile(original.statePath)
    const next = add(`new-after-${phase}`)
    assert.equal((await planStartStatus(h.ctx, h.controller, next.id)).state, 'ready')
    assert.equal((await command(next)).kind, 'success')
    assert.equal((await planStartStatus(h.ctx, h.controller, next.id)).state, 'bound')
    assert.deepEqual(await readFile(original.statePath), bytes)
  }
  const sameOwnerReset = await command(h.plan.agent, grant('replacement-authority'))
  assert.equal(sameOwnerReset.kind, 'error'); assert.match(sameOwnerReset.text, /AUTHORIZATION_IMMUTABLE/)
})

test('model usage and human stop commands stay within the selected root task', async t => {
  const { h, add, storeOf, command, stream } = await fixture(t)
  const first = h.plan.agent, second = add('second-budget-root')
  for (const agent of [first, second]) assert.equal((await command(agent)).kind, 'success')
  const firstStore = storeOf(first), secondStore = storeOf(second)
  const secondBefore = await readFile(secondStore.statePath)
  await stream(first)
  assert.deepEqual(await readFile(secondStore.statePath), secondBefore)
  assert.equal(await firstStore.read(s => Object.keys(bindingOf(s, first.id).round.usage.requests).length), 1)
  await stream(second); await stream(second)
  assert.equal(await firstStore.read(s => Object.keys(bindingOf(s, first.id).round.usage.requests).length), 1)
  assert.equal(await secondStore.read(s => Object.keys(bindingOf(s, second.id).round.usage.requests).length), 2)
  const roundId = await firstStore.read(s => s.activeRoundId)
  const unregister = registerTools(h.ctx, { controller: h.controller }); t.after(unregister)
  await assert.rejects(h.definitions.get('chain_stop').execute({ roundId, requestId: 'model-cross-stop',
    reason: 'model-must-not-stop-another-task' }, { agent: second }), { code: 'NO_ROUND' })
  assert.equal(await firstStore.read(s => s.rounds[roundId].control.resumeBlocked), false)
  const ownStop = await h.commands.get('chain-stop').handler({ commandId: 'fixture-own-stop', agent: first,
    rawInput: `${roundId} independent-own-stop stop-this-task-only` })
  assert.equal(ownStop.kind, 'success', ownStop.text)
  await assert.rejects(h.controller.beforeRequest(first), { code: 'RESUME_BLOCKED' })
  assert.equal((await h.controller.beforeRequest(second)).store.key, secondStore.key)
})

test('a genuine same-cwd human can stop an exact unloaded-owner task while foreign-cwd human stop is refused', async t => {
  const { h, add, storeOf, command } = await fixture(t)
  const first = h.plan.agent, second = add('unloaded-owner-other-task')
  for (const agent of [first, second]) assert.equal((await command(agent)).kind, 'success')
  const firstStore = storeOf(first), secondStore = storeOf(second)
  const firstRound = await firstStore.read(s => s.activeRoundId)
  const secondBytes = await readFile(secondStore.statePath)
  const otherCwd = join(h.dir, 'foreign-stop-workspace'); await mkdir(otherCwd)
  const foreign = add('foreign-human-stop', 'standard', { cwd: otherCwd })
  const firstBytes = await readFile(firstStore.statePath)
  const denied = await h.commands.get('chain-stop').handler({ commandId: 'fixture-foreign-stop', agent: foreign,
    rawInput: `${firstRound} foreign-exact-stop cannot-cross-cwd` })
  assert.equal(denied.kind, 'error'); assert.match(denied.text, /EXECUTION_SCOPE_CHANGED/)
  assert.deepEqual(await readFile(firstStore.statePath), firstBytes)
  h.sessions.delete(first.id); h.agents.delete(first.id)
  const ordinary = add('local-human-stop', 'standard')
  const stopped = await h.commands.get('chain-stop').handler({ commandId: 'fixture-local-stop', agent: ordinary,
    rawInput: `${firstRound} local-exact-stop stop-unloaded-owner-task` })
  assert.equal(stopped.kind, 'success', stopped.text)
  assert.equal(await firstStore.read(s => s.rounds[firstRound].control.resumeBlocked), true)
  assert.deepEqual(await readFile(secondStore.statePath), secondBytes)
  assert.equal(await h.controller.beforeRequest(ordinary), null)
  assert.equal((await h.controller.forSession(second.id)).store.key, secondStore.key)
})

test('delegated descendants follow their scoped ancestor while ordinary chats and human forks remain independent', async t => {
  const { h, add, storeOf, command, stream, authorityRoot } = await fixture(t)
  assert.equal((await command(h.plan.agent)).kind, 'success')
  const store = storeOf(h.plan.agent), before = await readFile(store.statePath)
  const child = add('ordinary-delegated-child', 'standard', { parent: h.plan.sessionId })
  const grandchild = add('ordinary-delegated-grandchild', 'cordis', { parent: child.id })
  const ordinary = add('ordinary-unrelated', 'standard')
  const fork = add('human-fork-of-controlled-root', 'standard', { parent: h.plan.sessionId, fork: true })
  for (const agent of [child, grandchild]) {
    assert.equal(storeOf(agent).key, store.key)
    await assert.rejects(h.controller.beforeRequest(agent), { code: 'MANAGED_ROUND_REQUIRED' })
    await assert.rejects(stream(agent), { code: 'MANAGED_ROUND_REQUIRED' })
    assert.match(h.controller.guard({ agent, name: 'native_shell' }), /CONTROLLED_ROUND/)
  }
  for (const agent of [ordinary, fork]) {
    assert.equal(await h.controller.beforeRequest(agent), null)
    assert.equal(h.controller.guard({ agent, name: 'native_shell' }), undefined)
    await stream(agent)
  }
  assert.deepEqual(await readFile(store.statePath), before)
  h.sessions.delete(h.plan.sessionId)
  const cold = new ChainController(h.ctx, { authorityRoot }); h.extraControllers.push(cold)
  for (const agent of [child, grandchild])
    await assert.rejects(cold.beforeRequest(agent), { code: 'MANAGED_ROUND_REQUIRED' })
  assert.deepEqual(await readFile(store.statePath), before)
})

test('cold reconstruction retains scoped membership across preset changes and rejects cwd escape', async t => {
  const { h, add, authorityRoot, storeOf, command } = await fixture(t)
  for (const agent of [h.plan.agent, add('second-cold-root')]) assert.equal((await command(agent)).kind, 'success')
  const original = storeOf(h.plan.agent), before = await readFile(original.statePath)
  const cold = new ChainController(h.ctx, { authorityRoot }); h.extraControllers.push(cold)
  h.sessions.get(h.plan.sessionId).header.agentPreset = 'standard'
  assert.equal(storeOf(h.plan.agent, cold).key, original.key)
  assert.equal((await cold.forSession(h.plan.sessionId)).store.key, original.key)
  const moved = join(h.dir, 'scoped-cwd-escape'); await mkdir(moved)
  h.sessions.get(h.plan.sessionId).header.cwd = moved
  try {
    for (const controller of [h.controller, cold]) {
      await assert.rejects(controller.beforeRequest(h.plan.agent), { code: 'EXECUTION_SCOPE_CHANGED' })
      await assert.rejects(controller.forSession(h.plan.sessionId), { code: 'EXECUTION_SCOPE_CHANGED' })
      assert.match(controller.guard({ agent: h.plan.agent, name: 'native_shell' }), /^CONTROL_STATE_UNAVAILABLE:/)
    }
    assert.deepEqual(await readFile(original.statePath), before)
  } finally { h.sessions.get(h.plan.sessionId).header.cwd = h.dir }
})

test('corrupt scoped authority fails closed instead of letting another root or ordinary chat hide membership', async t => {
  const { h, add, storeOf, command } = await fixture(t)
  assert.equal((await command(h.plan.agent)).kind, 'success')
  const store = storeOf(h.plan.agent), original = await readFile(store.statePath)
  const fresh = add('new-root-next-to-corrupt-task'), ordinary = add('ordinary-next-to-corrupt-task', 'standard')
  await writeFile(store.statePath, '{ invalid-scoped-ledger')
  try {
    for (const agent of [fresh, ordinary])
      await assert.rejects(h.controller.beforeRequest(agent), { code: 'STATE_UNREADABLE' })
    await assert.rejects(planStartStatus(h.ctx, h.controller, fresh.id), { code: 'STATE_UNREADABLE' })
    assert.equal(await readFile(store.statePath, 'utf8'), '{ invalid-scoped-ledger')
  } finally { await writeFile(store.statePath, original) }
})

test('duplicate durable membership across two task ledgers is refused as ambiguous without rewriting either', async t => {
  const { h, add, storeOf, command } = await fixture(t)
  const first = h.plan.agent, second = add('duplicate-membership-other-root')
  for (const agent of [first, second]) assert.equal((await command(agent)).kind, 'success')
  const firstStore = storeOf(first), secondStore = storeOf(second)
  const firstBytes = await readFile(firstStore.statePath), secondBytes = await readFile(secondStore.statePath)
  const binding = await firstStore.read(s => s.sessionBindings[first.id])
  await secondStore.mutate(s => { s.sessionBindings[first.id] = binding })
  const corrupted = await readFile(secondStore.statePath)
  try {
    await assert.rejects(h.controller.beforeRequest(first), error => {
      assert.ok(error.code && error.code !== 'MANAGED_ROUND_REQUIRED')
      assert.match(error.message, /multiple|duplicate|ambiguous|conflict|original|ownership/i)
      return true
    })
    assert.deepEqual(await readFile(firstStore.statePath), firstBytes)
    assert.deepEqual(await readFile(secondStore.statePath), corrupted)
  } finally { await writeFile(secondStore.statePath, secondBytes) }
})

test('bound dispatched workers and registered tools resolve their own task after cold reconstruction', async t => {
  const { h, add, exec, storeOf, command, authorityRoot } = await fixture(t)
  const second = add('registered-tools-other-root')
  for (const agent of [h.plan.agent, second]) assert.equal((await command(agent)).kind, 'success')
  const firstStore = storeOf(h.plan.agent), secondStore = storeOf(second)
  const spawned = await h.controller.dispatch(firstStore, exec(h.plan.agent), { role: 'work', task: 'Synthetic scoped child' })
  const child = h.agents.get(spawned.childId)
  assert.equal(storeOf(child).key, firstStore.key)
  assert.equal((await h.controller.beforeRequest(child)).store.key, firstStore.key)
  const cold = new ChainController(h.ctx, { authorityRoot }); h.extraControllers.push(cold)
  assert.equal((await cold.forSession(child.id)).store.key, firstStore.key)
  const unregister = registerTools(h.ctx, { controller: cold }); t.after(unregister)
  const status = h.definitions.get('chain_status')
  const originalRound = await firstStore.read(s => s.activeRoundId)
  const secondRound = await secondStore.read(s => s.activeRoundId)
  assert.equal((await status.execute({ detail: 'full' }, { agent: child })).roundId, originalRound)
  assert.equal((await status.execute({ detail: 'full' }, { agent: second })).roundId, secondRound)
  await assert.rejects(status.execute({ roundId: originalRound, detail: 'full' }, { agent: second }), { code: 'NO_ROUND' })
  await h.complete(child.id)
})

test('removing or changing scoped state metadata or its initialization marker cannot make an old task look new', async t => {
  const { h, add, storeOf, command } = await fixture(t)
  assert.equal((await command(h.plan.agent)).kind, 'success')
  const store = storeOf(h.plan.agent), originalState = await readFile(store.statePath), originalMarker = await readFile(store.markerPath)
  const fresh = add('fresh-next-to-tampered-scope')
  for (const mode of ['scope-removed', 'scope-changed', 'marker-removed', 'marker-corrupt', 'marker-legacy']) {
    try {
      if (mode.startsWith('scope')) {
        const state = JSON.parse(originalState)
        if (mode === 'scope-removed') delete state.ledgerScope
        else state.ledgerScope.rootSessionId = 'forged-root-plan'
        await writeFile(store.statePath, JSON.stringify(state))
      } else if (mode === 'marker-removed') await unlink(store.markerPath)
      else await writeFile(store.markerPath, mode === 'marker-legacy' ? 'role-chain-state-v2\n' : '{ invalid-marker')
      await assert.rejects(planStartStatus(h.ctx, h.controller, fresh.id), { code: 'STATE_UNREADABLE' }, mode)
      await assert.rejects(h.controller.beforeRequest(fresh), { code: 'STATE_UNREADABLE' }, mode)
    } finally {
      await writeFile(store.statePath, originalState)
      await writeFile(store.markerPath, originalMarker)
    }
  }
  assert.equal((await planStartStatus(h.ctx, h.controller, fresh.id)).state, 'ready')
})

test('a non-directory authority entry is rejected without modifying a healthy task', async t => {
  const { h, add, authorityRoot, storeOf, command } = await fixture(t)
  assert.equal((await command(h.plan.agent)).kind, 'success')
  const store = storeOf(h.plan.agent), original = await readFile(store.statePath)
  // Real Windows junction creation is unavailable in the sandbox; this fixture
  // verifies the non-directory branch, without claiming native link coverage.
  const alias = join(authorityRoot, 'f'.repeat(64)), fresh = add('fresh-next-to-invalid-ledger-entry')
  await writeFile(alias, 'not a ledger directory')
  try {
    await assert.rejects(planStartStatus(h.ctx, h.controller, fresh.id), { code: 'STATE_UNREADABLE' })
    assert.deepEqual(await readFile(store.statePath), original)
  } finally { await unlink(alias) }
  assert.equal((await planStartStatus(h.ctx, h.controller, fresh.id)).state, 'ready')
})

test('a scoped owner cannot become ordinary after durable authorization or membership is removed or reassigned', async t => {
  const { h, authorityRoot, add, storeOf, command } = await fixture(t)
  const ungranted = storeOf(add('fresh-ungranted-persistence'))
  assert.ok(ungranted.snapshot().ledgerScope)
  await assert.rejects(ungranted.mutate(() => {}), { code: 'STATE_UNREADABLE' })
  assert.equal(existsSync(ungranted.statePath), false)
  assert.equal(existsSync(ungranted.markerPath), false)
  assert.equal((await command(h.plan.agent)).kind, 'success')
  const store = storeOf(h.plan.agent), original = await readFile(store.statePath)
  const marker = await readFile(store.markerPath), entries = await readdir(authorityRoot)
  const cold = new ChainController(h.ctx, { authorityRoot }); h.extraControllers.push(cold)
  h.sessions.get(h.plan.sessionId).header.agentPreset = 'standard'
  try {
    for (const mode of ['authorization-and-membership-removed', 'only-authorization-removed', 'authorization-owner-reassigned']) {
      const state = JSON.parse(original)
      if (mode === 'authorization-owner-reassigned') state.authorization.sessionId = 'forged-replacement-owner'
      else delete state.authorization
      if (mode === 'authorization-and-membership-removed') {
        state.rounds = {}; state.sessionBindings = {}; state.activeRoundId = null
      }
      const corrupted = JSON.stringify(state)
      await writeFile(store.statePath, corrupted)
      await assert.rejects(cold.beforeRequest(h.plan.agent), { code: 'STATE_UNREADABLE' }, mode)
      await assert.rejects(cold.forSession(h.plan.sessionId), { code: 'STATE_UNREADABLE' }, mode)
      assert.match(cold.guard({ agent: h.plan.agent, name: 'native_shell' }), /^CONTROL_STATE_UNAVAILABLE:/, mode)
      await assert.rejects(planStartStatus(h.ctx, cold, h.plan.sessionId), { code: 'STATE_UNREADABLE' }, mode)
      assert.equal(await readFile(store.statePath, 'utf8'), corrupted)
      assert.deepEqual(await readFile(store.markerPath), marker)
      assert.deepEqual(await readdir(authorityRoot), entries)
    }
  } finally {
    await writeFile(store.statePath, original)
    h.sessions.get(h.plan.sessionId).header.agentPreset = 'plan'
  }
})

test('unattributed model I/O cannot persist an empty scoped ledger or prevent later genuine authorization', async t => {
  const { h, authorityRoot, storeOf, command } = await fixture(t)
  const store = storeOf(h.plan.agent)
  await assert.rejects(h.controller.beforeRequest(h.plan.agent), { code: 'MANAGED_ROUND_REQUIRED' })
  assert.equal(existsSync(store.statePath), false)
  assert.equal(existsSync(store.markerPath), false)
  const entries = await readdir(authorityRoot)
  let nextCalls = 0
  await assert.rejects(async () => {
    for await (const _ of h.hooks.get('llm/stream')[0]({ provider: 'fixture', model: 'deterministic',
      maxTokens: 16, messages: [] }, async function* () { nextCalls++ })) {}
  }, { code: 'ATTRIBUTION_REQUIRED' })
  assert.equal(nextCalls, 0)
  assert.equal(existsSync(store.statePath), false)
  assert.equal(existsSync(store.markerPath), false)
  assert.deepEqual(await readdir(authorityRoot), entries)
  const authorized = await command(h.plan.agent)
  assert.equal(authorized.kind, 'success', authorized.text)
  assert.equal((await planStartStatus(h.ctx, h.controller, h.plan.sessionId)).state, 'bound')
})
