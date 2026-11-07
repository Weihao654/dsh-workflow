// Deterministic Host/provider stand-ins only. No real Host, provider, or model I/O.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { harness } from './helpers.mjs'
import { installUsage } from '../lib/usage.js'
import { resolveExec } from '../lib/roles.js'
import { authorizeProject } from '../lib/authorization.js'
import { bindingOf } from '../lib/runtime.js'
import { ChainController } from '../lib/controller.js'

const grant = { authorizationId: 'ordinary-scope-fixture', goal: 'Synthetic protected execution',
  budget: { tokens: 200000, requests: 16, outputCap: 16, wallMinutes: 10, fixes: 1, reruns: 1, restarts: 0 } }

async function fixture(t, { authority = true, noOpen = true } = {}) {
  const authorityRoot = authority ? await mkdtemp(join(tmpdir(), 'role-chain-ordinary-scope-')) : null
  const h = await harness({ noOpen, ...(authorityRoot ? { authorityRoot } : {}) })
  const dispose = installUsage(h.ctx, h.controller)
  t.after(async () => {
    dispose(); await h.close()
    if (authorityRoot) {
      const path = resolve(authorityRoot)
      assert.ok(path.startsWith(`${resolve(tmpdir())}${sep}`) && path.includes('role-chain-ordinary-scope-'))
      await rm(path, { recursive: true, force: true })
    }
  })
  // Separate the actual mount/projection from historical session-header evidence.
  const actual = new Map()
  h.services.agentPresets.composedPreset = context => {
    const agent = [...h.agents.values()].find(value => value.ctx === context)
    return actual.has(agent?.id) ? actual.get(agent.id).mounted : h.sessions.get(agent?.id)?.header.agentPreset
  }
  h.services.sessionProjections.stateOf = (session, key) => key === 'agentPreset'
    ? (actual.has(session.id) ? actual.get(session.id).projected : session.header.agentPreset) : undefined
  h.services.workingDirectory.get = session => session.header.cwd
  const add = (id, preset, options = {}) => {
    const agent = { id, ctx: Object.freeze({ ordinaryScopeAgent: id }) }
    h.agents.set(id, agent)
    h.sessions.set(id, { id, header: { id, cwd: options.cwd ?? h.dir,
      agentPreset: options.historicalPreset ?? preset, ...(options.parent ? { parentSession: options.parent,
        ...(options.fork ? { isSeeded: true } : { origin: 'subagent' }) } : {}) } })
    actual.set(id, { mounted: preset, projected: preset })
    return agent
  }
  const setPreset = (id, preset) => actual.set(id, { mounted: preset, projected: preset })
  const config = { provider: 'fixture', model: 'deterministic', maxTokens: 16, fixtureOnly: true }
  const request = agent => h.hooks.get('agent/request')[0]({ agent }, async () => config)
  const stream = async (id, onNext = () => {}) => {
    const chunks = []
    for await (const chunk of h.hooks.get('llm/stream')[0]({ sessionId: id,
      provider: 'fixture', model: 'deterministic', maxTokens: 16, messages: [] }, async function* () {
      await onNext()
      yield { type: 'text', text: 'deterministic stand-in' }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } }
    })) chunks.push(chunk)
    return chunks
  }
  const deny = async (agent, code = 'MANAGED_ROUND_REQUIRED') => {
    await assert.rejects(request(agent), { code })
    let calls = 0
    await assert.rejects(stream(agent.id, () => { calls++ }), { code })
    assert.equal(calls, 0)
  }
  return { h, add, actual, setPreset, config, request, stream, deny, authorityRoot }
}

test('ordinary new/old standard and cordis pass both hooks and native tools without ledger writes', async t => {
  const { h, add, config, request, stream } = await fixture(t)
  const store = h.controller.storeForCwd(h.dir)
  assert.equal(store.requiresAuthorization, true)
  for (const preset of ['standard', 'cordis']) {
    for (const age of ['new', 'old']) {
      const agent = add(`${age}-${preset}`, preset, { historicalPreset: age === 'old' ? 'plan' : preset })
      assert.equal(resolveExec(h.ctx, { agent }).role, null)
      assert.equal(await request(agent), config)
      let calls = 0
      assert.equal((await stream(agent.id, () => { calls++ })).length, 2)
      assert.equal(calls, 1)
      assert.equal(h.controller.guard({ agent, name: 'native_shell', arguments: { command: 'fixture-only' } }), undefined)
      assert.equal(h.controller.guard({ agent, name: 'write', arguments: { file_path: join(h.dir, 'ordinary.txt') } }), undefined)
    }
  }
  assert.equal(existsSync(store.dir), false)
})

test('explicit plan/work/code/review cannot use model I/O without a trusted round binding', async t => {
  const { h, add, deny } = await fixture(t)
  for (const role of ['plan', 'work', 'code', 'review']) {
    const agent = add(`unbound-${role}`, role, { historicalPreset: 'standard' })
    await deny(agent)
    assert.match(h.controller.guard({ agent, name: 'native_shell' }), /CONTROLLED_ROUND/)
  }
  assert.equal(existsSync(h.controller.storeForCwd(h.dir).dir), false)
})

test('durable authorization does not enroll unrelated ordinary chats in the same workspace', async t => {
  const { h, add, request, stream } = await fixture(t)
  const store = h.controller.storeForCwd(h.dir)
  await authorizeProject(store, resolveExec(h.ctx, { agent: h.plan.agent }), grant, 'fixture-human-command')
  const before = await readFile(store.statePath)
  for (const preset of ['standard', 'cordis']) {
    const agent = add(`granted-${preset}`, preset)
    assert.equal((await request(agent)).fixtureOnly, true)
    let calls = 0; await stream(agent.id, () => { calls++ }); assert.equal(calls, 1)
    assert.equal(h.controller.guard({ agent, name: 'native_shell' }), undefined)
  }
  assert.deepEqual(await readFile(store.statePath), before)
})

test('an active round does not enroll unrelated ordinary chats without a profile authority flag', async t => {
  const { h, add, request, stream } = await fixture(t, { authority: false, noOpen: false })
  const before = await readFile(h.store.statePath)
  for (const preset of ['standard', 'cordis']) {
    const agent = add(`active-${preset}`, preset)
    assert.equal((await request(agent)).fixtureOnly, true)
    let calls = 0; await stream(agent.id, () => { calls++ }); assert.equal(calls, 1)
    assert.equal(h.controller.guard({ agent, name: 'native_shell' }), undefined)
  }
  assert.deepEqual(await readFile(h.store.statePath), before)
})

test('actual workingDirectory overrides historical cwd without enrolling an unrelated ordinary chat', async t => {
  const { h, add, config, request, stream, deny } = await fixture(t)
  const other = join(h.dir, 'other-workspace'); await mkdir(other)
  const store = h.controller.storeForCwd(other)
  const plan = add('other-plan', 'plan', { cwd: other })
  await authorizeProject(store, resolveExec(h.ctx, { agent: plan }), grant, 'fixture-workspace-command')
  const before = await readFile(store.statePath)
  const agent = add('projected-cwd', 'standard', { cwd: h.dir })
  h.services.workingDirectory.get = session => session.id === agent.id ? other : session.header.cwd
  assert.equal(resolveExec(h.ctx, { agent }).cwd, other)
  assert.equal((await request(agent)).fixtureOnly, true)
  let firstCalls = 0; await stream(agent.id, () => { firstCalls++ }); assert.equal(firstCalls, 1)
  assert.deepEqual(await readFile(store.statePath), before)
  h.sessions.get(agent.id).header.cwd = other
  h.services.workingDirectory.get = session => session.id === agent.id ? h.dir : session.header.cwd
  assert.equal(await request(agent), config)
  let calls = 0; await stream(agent.id, () => { calls++ }); assert.equal(calls, 1)
  assert.equal(existsSync(h.controller.storeForCwd(h.dir).dir), false)
})

test('unknown/conflicting live identity is rejected before downstream in ordinary and protected workspaces', async t => {
  const { h, add, actual, deny, request } = await fixture(t)
  for (const protectedWorkspace of [false, true]) {
    if (protectedWorkspace) await authorizeProject(h.controller.storeForCwd(h.dir), resolveExec(h.ctx, { agent: h.plan.agent }), grant, 'fixture-identity-command')
    for (const [mounted, projected] of [[null, 'standard'], ['cordis', null], ['standard', 'plan'], ['', 'cordis']]) {
      const agent = add(`unknown-${protectedWorkspace}-${String(mounted)}-${String(projected)}`, 'standard')
      actual.set(agent.id, { mounted, projected })
      await deny(agent, 'ROLE_BINDING_INVALID')
      assert.match(h.controller.guard({ agent, name: 'native_shell' }), /ROLE_BINDING_INVALID/)
    }
    const real = add(`forgery-${protectedWorkspace}`, 'standard')
    await assert.rejects(request({ ...real }), { code: 'ROLE_BINDING_INVALID' })
    await deny({ id: `absent-${protectedWorkspace}` }, 'ROLE_BINDING_INVALID')
  }
})

test('a genuine binding stays budgeted and stopped after its actual preset changes to ordinary', async t => {
  const { h, setPreset, request, stream, deny } = await fixture(t)
  const result = await h.commands.get('chain-authorize').handler({ commandId: 'fixture-binding-command',
    agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  assert.equal(result.kind, 'success', result.text)
  const store = h.controller.storeForExec(h.plan)
  const original = await store.read(state => state.authorization)
  for (const preset of ['plan', 'standard', 'cordis']) {
    setPreset(h.plan.sessionId, preset)
    const config = await request(h.plan.agent)
    assert.equal(config.maxTokens, 16)
    assert.match(h.controller.guard({ agent: h.plan.agent, name: 'native_shell' }), /CONTROLLED_ROUND/)
    let calls = 0
    await stream(h.plan.sessionId, async () => {
      calls++
      const rows = await store.read(state => Object.values(bindingOf(state, h.plan.sessionId).round.usage.requests))
      assert.equal(rows.at(-1).status, 'pending')
    })
    assert.equal(calls, 1)
  }
  const rows = await store.read(state => Object.values(bindingOf(state, h.plan.sessionId).round.usage.requests))
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.role === 'plan' && row.status === 'settled' && row.usage.totalTokens === 24))
  // The unchanged quarter-of-slots reserve leaves twelve ordinary attempts from this 16-slot grant.
  for (let i = 3; i < 12; i++) await stream(h.plan.sessionId)
  let deniedCalls = 0
  await assert.rejects(stream(h.plan.sessionId, () => { deniedCalls++ }), { code: 'CLOSEOUT_RESERVE_PROTECTED' })
  assert.equal(deniedCalls, 0)
  assert.equal((await store.read(state => Object.values(bindingOf(state, h.plan.sessionId).round.usage.requests))).length, 12)
  assert.deepEqual(await store.read(state => state.authorization), original)
  const roundId = await store.read(state => bindingOf(state, h.plan.sessionId).round.id)
  await h.controller.autoStop(store, roundId, 'ordinary-scope-fixture-stop')
  await deny(h.plan.agent, 'RESUME_BLOCKED')
  assert.match(h.controller.guard({ agent: h.plan.agent, name: 'native_shell' }), /RESUME_BLOCKED/)
})

test('a bound session cannot become ordinary by moving its live cwd, warm or cold', async t => {
  const { h, setPreset, authorityRoot } = await fixture(t)
  const result = await h.commands.get('chain-authorize').handler({ commandId: 'fixture-cwd-binding-command',
    agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  assert.equal(result.kind, 'success', result.text)
  const store = h.controller.storeForExec(h.plan)
  const original = await readFile(store.statePath)
  const other = join(h.dir, 'fresh-cwd'); await mkdir(other)
  setPreset(h.plan.sessionId, 'standard')
  h.services.workingDirectory.get = () => other
  const warmStream = h.hooks.get('llm/stream')[0]
  const cold = new ChainController(h.ctx, { authorityRoot })
  h.extraControllers.push(cold)
  const disposeColdUsage = installUsage(h.ctx, cold); t.after(disposeColdUsage)
  const coldStream = h.hooks.get('llm/stream').at(-1)
  for (const [controller, middleware] of [[h.controller, warmStream], [cold, coldStream]]) {
    await assert.rejects(controller.beforeRequest(h.plan.agent), { code: 'EXECUTION_SCOPE_CHANGED' })
    await assert.rejects(controller.forSession(h.plan.sessionId), { code: 'EXECUTION_SCOPE_CHANGED' })
    const guarded = controller.guard({ agent: h.plan.agent, name: 'native_shell' })
    assert.match(guarded, /^CONTROL_STATE_UNAVAILABLE:/)
    let calls = 0
    await assert.rejects(async () => {
      for await (const _ of middleware({ sessionId: h.plan.sessionId, provider: 'fixture', model: 'deterministic',
        maxTokens: 16, messages: [] }, async function* () { calls++; yield { type: 'text', text: 'must not run' } })) {}
    }, { code: 'EXECUTION_SCOPE_CHANGED' })
    assert.equal(calls, 0)
  }
  assert.deepEqual(await readFile(store.statePath), original)
})

test('a healthy unrelated foreign ledger does not protect an ordinary session in a different workspace', async t => {
  const { h, add, request, stream } = await fixture(t)
  // Deliberately retain a valid legacy ledger to verify marker-less upgrade compatibility.
  const protectedStore = h.controller.storeForCwd(h.dir)
  await authorizeProject(protectedStore, resolveExec(h.ctx, { agent: h.plan.agent }), grant, 'fixture-unrelated-legacy-command')
  const before = await readFile(protectedStore.statePath)
  const other = join(h.dir, 'ordinary-other-workspace'); await mkdir(other)
  for (const markerPresent of [true, false]) {
    // A valid old state without an initialized marker retains the existing load contract.
    if (!markerPresent) await rm(protectedStore.markerPath)
    for (const preset of ['standard', 'cordis']) {
      const agent = add(`unrelated-${preset}-${markerPresent}`, preset, { cwd: other })
      assert.equal((await request(agent)).fixtureOnly, true)
      let calls = 0; await stream(agent.id, () => { calls++ }); assert.equal(calls, 1)
      assert.equal(h.controller.guard({ agent, name: 'native_shell' }), undefined)
    }
    assert.deepEqual(await readFile(protectedStore.statePath), before)
  }
  assert.equal(existsSync(h.controller.storeForCwd(other).dir), false)
})

test('foreign initialized missing or corrupt authority fails closed instead of hiding a possible binding', async t => {
  for (const kind of ['missing-state', 'corrupt-state']) {
    const { h, add, deny } = await fixture(t)
    const other = join(h.dir, `foreign-${kind}`); await mkdir(other)
    const foreign = h.controller.storeForCwd(other)
    await mkdir(foreign.dir, { recursive: true })
    await writeFile(foreign.markerPath, 'role-chain-state-v2\n')
    if (kind === 'corrupt-state') await writeFile(foreign.statePath, '{ not-json')
    const markerBefore = await readFile(foreign.markerPath)
    for (const preset of ['standard', 'cordis']) {
      const agent = add(`foreign-${kind}-${preset}`, preset)
      await deny(agent, 'STATE_UNREADABLE')
      assert.match(h.controller.guard({ agent, name: 'native_shell' }), /^CONTROL_STATE_UNAVAILABLE:/)
    }
    assert.deepEqual(await readFile(foreign.markerPath), markerBefore)
    if (kind === 'corrupt-state') assert.equal(await readFile(foreign.statePath, 'utf8'), '{ not-json')
  }
})

test('changing live cwd before a second authorize cannot rebind a session with a stale historical cwd', async t => {
  const { h, authorityRoot } = await fixture(t)
  const warmHandler = h.commands.get('chain-authorize').handler
  const first = await warmHandler({ commandId: 'fixture-authorize-first', agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  assert.equal(first.kind, 'success', first.text)
  const originalStore = h.controller.storeForExec(h.plan)
  const original = await readFile(originalStore.statePath)
  const other = join(h.dir, 'authorize-other-cwd'); await mkdir(other)
  h.services.workingDirectory.get = () => other
  assert.equal(h.sessions.get(h.plan.sessionId).header.cwd, h.dir)
  const cold = new ChainController(h.ctx, { authorityRoot }).install()
  h.extraControllers.push(cold)
  const coldHandler = h.commands.get('chain-authorize').handler
  for (const handler of [warmHandler, coldHandler]) {
    const result = await handler({ commandId: 'fixture-authorize-changed-cwd', agent: h.plan.agent,
      rawInput: JSON.stringify({ ...grant, authorizationId: 'must-not-create-another-grant' }) })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /EXECUTION_SCOPE_CHANGED/)
    assert.equal(existsSync(h.controller.storeForCwd(other).dir), false)
    assert.deepEqual(await readFile(originalStore.statePath), original)
  }
})

test('initialized but unreadable authority is never treated as an ordinary empty workspace', async t => {
  const { h, add, deny } = await fixture(t)
  const store = h.controller.storeForCwd(h.dir)
  await mkdir(store.dir, { recursive: true })
  await writeFile(store.markerPath, 'role-chain-state-v2\n')
  for (const preset of ['standard', 'cordis']) await deny(add(`missing-state-${preset}`, preset), 'STATE_UNREADABLE')
  // Only remove this disposable fixture marker so controller teardown can inspect an empty state.
  await rm(store.markerPath)
})

test('unrelated ordinary chats stay independent while a same-cwd round is active, expired or closed', async t => {
  const { h, add, request, stream } = await fixture(t)
  const result = await h.commands.get('chain-authorize').handler({ commandId: 'fixture-lifecycle', agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  assert.equal(result.kind, 'success', result.text)
  const store = h.controller.storeForExec(h.plan)
  for (const phase of ['active', 'expired', 'closed']) {
    if (phase !== 'active') await store.mutate(state => {
      if (phase === 'expired') state.authorization.deadlineAt = new Date(0).toISOString()
      else { state.rounds[state.activeRoundId].closedAt = new Date().toISOString(); state.activeRoundId = null }
    })
    const before = await readFile(store.statePath)
    for (const preset of ['standard', 'cordis']) {
      const agent = add(`${phase}-ordinary-${preset}`, preset)
      assert.equal((await request(agent)).fixtureOnly, true)
      let calls = 0; await stream(agent.id, () => { calls++ }); assert.equal(calls, 1)
      assert.equal(h.controller.guard({ agent, name: 'native_shell' }), undefined)
    }
    assert.deepEqual(await readFile(store.statePath), before)
  }
})

test('grant-only owner cannot become unprotected by changing to an ordinary preset before binding', async t => {
  const { h, setPreset, deny } = await fixture(t)
  const store = h.controller.storeForCwd(h.dir)
  await authorizeProject(store, resolveExec(h.ctx, { agent: h.plan.agent }), grant, 'fixture-grant-only')
  const before = await readFile(store.statePath)
  setPreset(h.plan.sessionId, 'standard')
  await deny(h.plan.agent)
  assert.match(h.controller.guard({ agent: h.plan.agent, name: 'native_shell' }), /CONTROLLED_ROUND/)
  assert.deepEqual(await readFile(store.statePath), before)
})

test('unbound ordinary delegated children inherit controlled ancestry across preset changes and cold reconstruction', async t => {
  const { h, add, setPreset, deny, authorityRoot } = await fixture(t)
  const result = await h.commands.get('chain-authorize').handler({ commandId: 'fixture-descendants', agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  assert.equal(result.kind, 'success', result.text)
  const child = add('unbound-ordinary-child', 'standard', { parent: h.plan.sessionId })
  const grandchild = add('unbound-ordinary-grandchild', 'cordis', { parent: child.id })
  setPreset(h.plan.sessionId, 'standard')
  const store = h.controller.storeForExec(h.plan), before = await readFile(store.statePath)
  for (const agent of [child, grandchild]) {
    await deny(agent)
    assert.match(h.controller.guard({ agent, name: 'native_shell' }), /CONTROLLED_ROUND/)
  }
  // The exact missing parent id is still checked against durable membership.
  h.sessions.delete(h.plan.sessionId)
  const cold = new ChainController(h.ctx, { authorityRoot }); h.extraControllers.push(cold)
  const dispose = installUsage(h.ctx, cold); t.after(dispose)
  for (const agent of [child, grandchild]) {
    await assert.rejects(cold.beforeRequest(agent), { code: 'MANAGED_ROUND_REQUIRED' })
    let calls = 0
    await assert.rejects(async () => {
      for await (const _ of h.hooks.get('llm/stream').at(-1)({ sessionId: agent.id, maxTokens: 16, messages: [] }, async function* () { calls++ })) {}
    }, { code: 'MANAGED_ROUND_REQUIRED' })
    assert.equal(calls, 0)
  }
  assert.deepEqual(await readFile(store.statePath), before)
})

test('unrelated ordinary delegation and user-created forks stay independent, including an unloaded fork source', async t => {
  const { h, add, request, stream, deny } = await fixture(t)
  const result = await h.commands.get('chain-authorize').handler({ commandId: 'fixture-forks', agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  assert.equal(result.kind, 'success', result.text)
  const root = add('ordinary-parent', 'standard')
  const child = add('ordinary-delegated-child', 'cordis', { parent: root.id })
  const fork = add('ordinary-human-fork', 'standard', { parent: h.plan.sessionId, fork: true })
  const delegatedFork = add('ordinary-model-fork', 'standard', { parent: h.plan.sessionId })
  h.sessions.delete(h.plan.sessionId)
  const store = h.controller.storeForExec(h.plan), before = await readFile(store.statePath)
  for (const agent of [root, child, fork]) {
    assert.equal((await request(agent)).fixtureOnly, true)
    let calls = 0; await stream(agent.id, () => { calls++ }); assert.equal(calls, 1)
    assert.equal(h.controller.guard({ agent, name: 'native_shell' }), undefined)
  }
  await deny(delegatedFork)
  assert.deepEqual(await readFile(store.statePath), before)
})

test('unbound delegated descendants cannot leave an ancestor ledger by changing cwd, warm or cold', async t => {
  const { h, add, authorityRoot } = await fixture(t)
  const result = await h.commands.get('chain-authorize').handler({ commandId: 'fixture-descendant-cwd', agent: h.plan.agent, rawInput: JSON.stringify(grant) })
  assert.equal(result.kind, 'success', result.text)
  const other = join(h.dir, 'other-delegated-cwd'); await mkdir(other)
  const child = add('moved-delegated-child', 'standard', { parent: h.plan.sessionId, cwd: other })
  const store = h.controller.storeForExec(h.plan), before = await readFile(store.statePath)
  const cold = new ChainController(h.ctx, { authorityRoot }); h.extraControllers.push(cold)
  for (const controller of [h.controller, cold]) {
    await assert.rejects(controller.beforeRequest(child), { code: 'EXECUTION_SCOPE_CHANGED' })
    assert.match(controller.guard({ agent: child, name: 'native_shell' }), /^CONTROL_STATE_UNAVAILABLE:/)
  }
  assert.deepEqual(await readFile(store.statePath), before)
})

test('invalid or unavailable delegated lineage is rejected before downstream model I/O', async t => {
  const { h, add, deny } = await fixture(t)
  const loop = add('cyclic-child', 'standard', { parent: 'cyclic-child' })
  await deny(loop, 'SESSION_LINEAGE_INVALID')
  const missing = add('unknown-child', 'standard', { parent: 'missing-parent' })
  await deny(missing, 'SESSION_LINEAGE_UNAVAILABLE')
  const root = add('mismatched-parent', 'standard')
  h.sessions.get(root.id).header.id = 'different-id'
  await deny(add('mismatched-child', 'standard', { parent: root.id }), 'SESSION_LINEAGE_INVALID')
  const orphan = add('orphan-child', 'standard')
  h.sessions.get(orphan.id).header.origin = 'subagent'
  await deny(orphan, 'SESSION_LINEAGE_INVALID')
  assert.equal(existsSync(h.controller.storeForCwd(h.dir).dir), false)
})
