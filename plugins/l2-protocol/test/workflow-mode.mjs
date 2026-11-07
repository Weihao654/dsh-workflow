// Fake Host identities, commands and model streams only; no installed Host/model I/O.
// Native tools are checked only for the absence of an L2 managed-round fence.
// A role's actual tool availability and read-only matrix remain L1 responsibilities.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { harness } from './helpers.mjs'
import { ChainController } from '../lib/controller.js'
import { resolveExec } from '../lib/roles.js'
import { planStartStatus } from '../lib/plan-start.js'
import { authorizeProject } from '../lib/authorization.js'
import { openRound } from '../lib/service.js'
import { installUsage } from '../lib/usage.js'
import { registerTools } from '../lib/tools.js'

const grant = { authorizationId: 'explicit-controlled-fixture', goal: 'Explicitly opted-in synthetic controlled task',
  budget: { tokens: 200000, requests: 16, wallMinutes: 10, outputCap: 16 } }

async function fixture(t, options = {}) {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-workflow-mode-'))
  const h = await harness({ noOpen: true, workflowByDefault: true, ...options, authorityRoot })
  h.services.workingDirectory.get = session => session.header.cwd
  const disposeUsage = installUsage(h.ctx, h.controller)
  t.after(async () => {
    disposeUsage(); await h.close()
    const target = resolve(authorityRoot)
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && target.includes('role-chain-workflow-mode-'))
    await rm(target, { recursive: true, force: true })
  })
  const add = (id, preset = 'plan', options = {}) => {
    const agent = { id, ctx: Object.freeze({ workflowFixtureAgent: id }) }
    h.agents.set(id, agent)
    h.sessions.set(id, { id, header: { id, agentPreset: preset, cwd: options.cwd ?? h.dir,
      ...(options.parent ? { parentSession: options.parent,
        ...(options.fork ? { isSeeded: true } : { origin: 'subagent' }) } : {}) } })
    return agent
  }
  const exec = agent => resolveExec(h.ctx, { agent })
  const storeOf = (agent = h.plan.agent, controller = h.controller) => controller.storeForExec(exec(agent))
  const request = (agent, config = { maxTokens: 9000, fixtureMarker: 'original' }) =>
    h.hooks.get('agent/request')[0]({ agent }, async () => config)
  const stream = async (agent, onNext = () => {}, overrides = {}) => {
    const chunks = []
    for await (const chunk of h.hooks.get('llm/stream')[0]({ sessionId: agent.id,
      provider: 'fixture', model: 'deterministic', purpose: 'agent', maxTokens: 9000, messages: [], ...overrides }, async function* () {
      await onNext()
      yield { type: 'text', text: 'workflow synthetic response' }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } }
    })) chunks.push(chunk)
    return chunks
  }
  const command = (agent = h.plan.agent, args = grant) => h.commands.get('chain-authorize').handler({
    commandId: `fixture-explicit-human-${agent.id}`, agent, rawInput: JSON.stringify(args) })
  return { h, authorityRoot, add, exec, storeOf, request, stream, command }
}

test('new root plan is immediately workflow-ready and its status creates no authority or budget', async t => {
  const { h, authorityRoot, exec, storeOf } = await fixture(t)
  const before = await readdir(authorityRoot), store = storeOf()
  assert.equal(h.controller.isWorkflowSession(exec(h.plan.agent), store, store.snapshot()), true)
  assert.equal(await h.controller.beforeRequest(h.plan.agent), null)
  const status = await planStartStatus(h.ctx, h.controller, h.plan.sessionId)
  assert.equal(status.state, 'workflow'); assert.equal(status.authorization, null); assert.equal(status.roundId, null)
  assert.equal(existsSync(store.statePath), false); assert.equal(existsSync(store.markerPath), false)
  assert.deepEqual(await readdir(authorityRoot), before)
})

test('workflow plan uses normal request config and model stream without L2 output caps, request slots or closeout reserve', async t => {
  const { h, authorityRoot, request, stream, storeOf } = await fixture(t)
  const config = Object.freeze({ maxTokens: 9000, fixtureMarker: 'untouched' })
  assert.equal(await request(h.plan.agent, config), config)
  let nextCalls = 0
  for (let i = 0; i < 24; i++) assert.equal((await stream(h.plan.agent, () => { nextCalls++ })).length, 2)
  assert.equal(nextCalls, 24)
  assert.equal(existsSync(storeOf().statePath), false)
  assert.equal(existsSync(storeOf().markerPath), false)
  assert.deepEqual(await readdir(authorityRoot), [])
  assert.equal(h.controller.guard({ agent: h.plan.agent, name: 'dispatch_work', arguments: { task: 'native workflow' } }), undefined)
})

test('Host-delegated work, code and review descend from workflow plan without managed-round admission', async t => {
  const { h, add, request, stream, exec } = await fixture(t)
  const work = add('workflow-work', 'work', { parent: h.plan.sessionId })
  const code = add('workflow-code', 'code', { parent: work.id })
  const review = add('workflow-review', 'review', { parent: work.id })
  for (const agent of [work, code, review]) {
    assert.equal(h.controller.isWorkflowSession(exec(agent)), true)
    assert.equal(await h.controller.beforeRequest(agent), null)
    assert.equal((await request(agent)).maxTokens, 9000)
    assert.equal((await stream(agent)).length, 2)
  }
  for (const [agent, name] of [[work, 'dispatch_code'], [work, 'dispatch_review'], [work, 'pwsh'],
    [code, 'pwsh'], [code, 'write'], [review, 'read']])
    assert.equal(h.controller.guard({ agent, name }), undefined)
})

test('unrelated manually created work, code or review roots do not acquire workflow authority from their name', async t => {
  const { h, add, exec } = await fixture(t)
  for (const role of ['work', 'code', 'review']) {
    const agent = add(`standalone-${role}`, role)
    assert.equal(h.controller.isWorkflowSession(exec(agent)), false)
    await assert.rejects(h.controller.beforeRequest(agent), { code: 'MANAGED_ROUND_REQUIRED' })
  }
})

test('legacy authorization in the same or another cwd does not enroll a fresh workflow root', async t => {
  const { h, add, exec, stream } = await fixture(t)
  const legacy = h.controller.storeForCwd(h.dir)
  await authorizeProject(legacy, exec(h.plan.agent), grant, 'fixture-old-legacy-command')
  await openRound(legacy, exec(h.plan.agent), grant)
  const original = await readFile(legacy.statePath)
  const other = join(h.dir, 'fresh-workflow-cwd'); await mkdir(other)
  for (const agent of [add('same-cwd-workflow'), add('other-cwd-workflow', 'plan', { cwd: other })]) {
    assert.equal(await h.controller.beforeRequest(agent), null)
    assert.equal((await planStartStatus(h.ctx, h.controller, agent.id)).state, 'workflow')
    assert.equal((await stream(agent)).length, 2)
    assert.equal(h.controller.guard({ agent, name: 'dispatch_work' }), undefined)
    const work = add(`${agent.id}-work`, 'work', { parent: agent.id, cwd: exec(agent).cwd })
    const code = add(`${agent.id}-code`, 'code', { parent: work.id, cwd: exec(agent).cwd })
    const review = add(`${agent.id}-review`, 'review', { parent: work.id, cwd: exec(agent).cwd })
    for (const child of [work, code, review]) {
      assert.equal(await h.controller.beforeRequest(child), null)
      assert.equal((await stream(child)).length, 2)
      assert.equal(h.controller.guard({ agent: child, name: child === review ? 'read' : 'pwsh' }), undefined)
    }
    assert.deepEqual(await readFile(legacy.statePath), original)
  }
  assert.equal(h.controller.isWorkflowSession(exec(h.plan.agent)), false)
  assert.equal((await h.controller.beforeRequest(h.plan.agent)).store.key, legacy.key)
})

test('explicit human authorization still opts a workflow root into immutable controlled admission', async t => {
  const { h, exec, storeOf, command, request } = await fixture(t)
  assert.equal((await planStartStatus(h.ctx, h.controller, h.plan.sessionId)).state, 'workflow')
  const started = await command()
  assert.equal(started.kind, 'success', started.text)
  const store = storeOf(), original = await store.read(s => s.authorization)
  assert.equal(h.controller.isWorkflowSession(exec(h.plan.agent), store, store.snapshot()), false)
  assert.equal((await planStartStatus(h.ctx, h.controller, h.plan.sessionId)).state, 'bound')
  assert.equal((await h.controller.beforeRequest(h.plan.agent)).store.key, store.key)
  assert.equal((await request(h.plan.agent)).maxTokens, 16)
  assert.match(h.controller.guard({ agent: h.plan.agent, name: 'dispatch_work' }), /CONTROLLED_ROUND/)
  const changed = await command(h.plan.agent, { ...grant, budget: { ...grant.budget, requests: 100 } })
  assert.equal(changed.kind, 'error'); assert.match(changed.text, /AUTHORIZATION_IMMUTABLE/)
  assert.deepEqual(await store.read(s => s.authorization), original)
})

test('stopped or expired controlled owners cannot opt out through workflow defaults, preset changes or cold controllers', async t => {
  for (const phase of ['stopped', 'expired']) {
    const { h, authorityRoot, exec, storeOf, command, stream } = await fixture(t)
    assert.equal((await command()).kind, 'success')
    const store = storeOf()
    await store.mutate(s => {
      if (phase === 'stopped') s.rounds[s.activeRoundId].control.resumeBlocked = true
      else s.authorization.deadlineAt = new Date(0).toISOString()
    })
    const original = await readFile(store.statePath)
    const cold = new ChainController(h.ctx, { authorityRoot, workflowByDefault: true }); h.extraControllers.push(cold)
    h.sessions.get(h.plan.sessionId).header.agentPreset = 'standard'
    for (const controller of [h.controller, cold]) {
      assert.equal(controller.isWorkflowSession(exec(h.plan.agent)), false)
      await assert.rejects(controller.beforeRequest(h.plan.agent), error =>
        ['RESUME_BLOCKED', 'PROJECT_DEADLINE_REACHED', 'DEADLINE_REACHED'].includes(error.code))
      assert.match(controller.guard({ agent: h.plan.agent, name: 'pwsh' }), /RESUME_BLOCKED|CONTROL_STATE_UNAVAILABLE/)
    }
    await assert.rejects(stream(h.plan.agent, () => {}, { maxTokens: 16 }), error =>
      ['RESUME_BLOCKED', 'PROJECT_DEADLINE_REACHED', 'DEADLINE_REACHED'].includes(error.code))
    // No assertion treats asynchronous deadline stop evidence as unchanged bytes.
    assert.deepEqual(await store.read(s => s.authorization), JSON.parse(original).authorization)
    const other = join(h.dir, `forbidden-${phase}-cwd`); await mkdir(other)
    h.sessions.get(h.plan.sessionId).header.cwd = other
    try {
      for (const controller of [h.controller, cold])
        await assert.rejects(controller.beforeRequest(h.plan.agent), { code: 'EXECUTION_SCOPE_CHANGED' })
    } finally { h.sessions.get(h.plan.sessionId).header.cwd = h.dir }
  }
})

test('unbound descendants of an old controlled owner remain controlled after the owner is unloaded', async t => {
  const { h, add, authorityRoot, exec, command } = await fixture(t)
  assert.equal((await command()).kind, 'success')
  const child = add('old-controlled-child', 'work', { parent: h.plan.sessionId })
  const grandchild = add('old-controlled-grandchild', 'standard', { parent: child.id })
  h.sessions.delete(h.plan.sessionId)
  const cold = new ChainController(h.ctx, { authorityRoot, workflowByDefault: true }); h.extraControllers.push(cold)
  for (const agent of [child, grandchild]) {
    assert.equal(cold.isWorkflowSession(exec(agent)), false)
    await assert.rejects(cold.beforeRequest(agent), { code: 'MANAGED_ROUND_REQUIRED' })
    assert.match(cold.guard({ agent, name: 'native_shell' }), /CONTROLLED_ROUND/)
  }
})

test('ordinary chats and human-created ordinary forks preserve native behavior beside a controlled ancestor', async t => {
  const { h, add, request, stream, command, storeOf } = await fixture(t)
  assert.equal((await command()).kind, 'success')
  const store = storeOf(), original = await readFile(store.statePath)
  const ordinary = add('workflow-neighbor-standard', 'standard')
  const cordis = add('workflow-neighbor-cordis', 'cordis')
  const fork = add('workflow-human-fork', 'standard', { parent: h.plan.sessionId, fork: true })
  h.sessions.delete(h.plan.sessionId)
  for (const agent of [ordinary, cordis, fork]) {
    const config = Object.freeze({ maxTokens: 10000, marker: 'ordinary-original' })
    assert.equal(await request(agent, config), config)
    assert.equal((await stream(agent)).length, 2)
    assert.equal(h.controller.guard({ agent, name: 'native_shell' }), undefined)
  }
  assert.deepEqual(await readFile(store.statePath), original)
})

test('missing, cyclic or inconsistent delegated ancestry cannot manufacture workflow membership', async t => {
  const { h, add } = await fixture(t)
  const missing = add('missing-workflow-parent', 'work', { parent: 'missing-parent' })
  await assert.rejects(h.controller.beforeRequest(missing), { code: 'SESSION_LINEAGE_UNAVAILABLE' })
  const cyclic = add('cyclic-workflow-parent', 'work', { parent: 'cyclic-workflow-parent' })
  await assert.rejects(h.controller.beforeRequest(cyclic), { code: 'SESSION_LINEAGE_INVALID' })
  const badRoot = add('inconsistent-workflow-root', 'plan')
  h.sessions.get(badRoot.id).header.id = 'different-header-id'
  const child = add('inconsistent-workflow-child', 'code', { parent: badRoot.id })
  await assert.rejects(h.controller.beforeRequest(child), { code: 'SESSION_LINEAGE_INVALID' })
})

test('corrupt old scoped authority never falls through into workflow mode', async t => {
  const { h, authorityRoot, command, storeOf, add } = await fixture(t)
  assert.equal((await command()).kind, 'success')
  const store = storeOf(), original = await readFile(store.statePath)
  const state = JSON.parse(original)
  delete state.authorization; state.rounds = {}; state.sessionBindings = {}; state.activeRoundId = null
  await writeFile(store.statePath, JSON.stringify(state))
  const fresh = add('new-workflow-near-corrupt-authority')
  const cold = new ChainController(h.ctx, { authorityRoot, workflowByDefault: true }); h.extraControllers.push(cold)
  try {
    for (const agent of [h.plan.agent, fresh])
      await assert.rejects(cold.beforeRequest(agent), { code: 'STATE_UNREADABLE' })
  } finally { await writeFile(store.statePath, original) }
})

test('without the trusted workflow default the existing controlled bootstrap requirement remains', async t => {
  const { h, exec, stream } = await fixture(t, { workflowByDefault: false })
  assert.equal(h.controller.isWorkflowSession(exec(h.plan.agent)), false)
  await assert.rejects(h.controller.beforeRequest(h.plan.agent), { code: 'MANAGED_ROUND_REQUIRED' })
  await assert.rejects(stream(h.plan.agent), { code: 'MANAGED_ROUND_REQUIRED' })
  assert.equal((await planStartStatus(h.ctx, h.controller, h.plan.sessionId)).state, 'ready')
})

test('a nested wrapper and upstream in normal workflow traverse the hooks without creating accounting rows or request slots', async t => {
  const { h, authorityRoot, storeOf } = await fixture(t)
  const middleware = h.hooks.get('llm/stream')[0]
  const options = { sessionId: h.plan.sessionId, provider: 'modlens-fixture-command-code', model: 'fixture-model',
    purpose: 'agent', maxTokens: 9000, messages: [] }
  let wrapperCalls = 0, upstreamCalls = 0
  for await (const _ of middleware(options, async function* () {
    wrapperCalls++
    yield* middleware({ ...options, provider: 'fixture-command-code', via: options.provider }, async function* () {
      upstreamCalls++
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } }
    })
  })) {}
  assert.equal(wrapperCalls, 1); assert.equal(upstreamCalls, 1)
  assert.equal(existsSync(storeOf().statePath), false); assert.equal(existsSync(storeOf().markerPath), false)
  assert.deepEqual(await readdir(authorityRoot), [])
})

test('controller creation hides controlled schemas before the first request and explicit authorization restores them before openRound', async t => {
  const { h, storeOf, command } = await fixture(t)
  const agent = h.plan.agent, filters = new Set(), counters = { installed: 0, released: 0 }
  const nativeNames = ['read', 'dispatch_work', 'send_message']
  for (const name of nativeNames) h.definitions.set(name, { name })
  const scopedTools = {
    get(name, scope) {
      if (!h.definitions.has(name)) return undefined
      if (scope === agent && [...filters].some(filter => filter.deny.includes(name))) return undefined
      return h.definitions.get(name)
    },
    schemas(scope) { return [...h.definitions.keys()].map(name => scopedTools.get(name, scope)).filter(Boolean) },
    restrict(filter) {
      assert.ok(filter.deny.length > 0)
      assert.ok(filter.deny.every(name => h.definitions.has(name)))
      filters.add(filter); counters.installed++
      let active = true
      return () => { if (active) { active = false; filters.delete(filter); counters.released++ } }
    },
  }
  agent.ctx = { get: name => name === 'tools' ? scopedTools : undefined }
  const unregister = registerTools(h.ctx, { controller: h.controller }); t.after(unregister)
  const controlledNames = [...h.definitions.keys()].filter(name => name.startsWith('chain_') && name !== 'chain_role_models')
  assert.equal(controlledNames.length, 13)
  for (const name of controlledNames) assert.ok(scopedTools.get(name, agent))
  for (const created of h.hooks.get('agent/created') ?? []) await created({ agent })
  // No agent/request hook or beforeRequest has run: the initial schema assembly
  // already sees only the native catalog plus the optional role-model settings.
  for (const name of controlledNames) assert.equal(scopedTools.get(name, agent), undefined)
  assert.deepEqual(scopedTools.schemas(agent).map(row => row.name), [...nativeNames, 'chain_role_models'])
  assert.deepEqual(counters, { installed: 1, released: 0 })
  const store = storeOf(), mutate = store.mutate
  let mutations = 0, openSawRestored = false
  store.mutate = function (fn) {
    mutations++
    // authorizeProject is the first transaction; first openRound is the next.
    // Its model-facing chain definitions must be restored before it begins.
    if (mutations === 2) {
      openSawRestored = true
      assert.equal(counters.released, 1)
      for (const name of controlledNames) assert.ok(scopedTools.get(name, agent))
    }
    return mutate.call(this, fn)
  }
  try {
    const authorized = await command()
    assert.equal(authorized.kind, 'success', authorized.text)
    assert.equal(openSawRestored, true)
    assert.deepEqual(counters, { installed: 1, released: 1 })
    assert.equal(filters.size, 0)
    for (const name of [...nativeNames, 'chain_role_models', ...controlledNames]) assert.ok(scopedTools.get(name, agent))
    assert.equal((await planStartStatus(h.ctx, h.controller, agent.id)).state, 'bound')
  } finally { store.mutate = mutate }
})

test('selecting plan in an existing blank standard session filters the first schema assembly and switching back releases it', async t => {
  const { h, authorityRoot, command } = await fixture(t)
  const agent = h.plan.agent, filters = new Set(), counters = { installed: 0, released: 0 }
  const nativeNames = ['read', 'dispatch_work', 'send_message']
  for (const name of nativeNames) h.definitions.set(name, { name })
  const scopedTools = {
    get(name, scope) {
      return scope === agent && [...filters].some(filter => filter.deny.includes(name))
        ? undefined : h.definitions.get(name)
    },
    restrict(filter) {
      assert.ok(filter.deny.length > 0)
      assert.ok(filter.deny.every(name => h.definitions.has(name)))
      filters.add(filter); counters.installed++
      let active = true
      return () => { if (active) { active = false; filters.delete(filter); counters.released++ } }
    },
  }
  agent.ctx = { get: name => name === 'tools' ? scopedTools : undefined }
  const unregister = registerTools(h.ctx, { controller: h.controller }); t.after(unregister)
  const controlledNames = [...h.definitions.keys()].filter(name => name.startsWith('chain_') && name !== 'chain_role_models')
  assert.equal(controlledNames.length, 13)
  h.sessions.get(agent.id).header.agentPreset = 'standard'
  for (const created of h.hooks.get('agent/created') ?? []) await created({ agent })
  for (const name of controlledNames) assert.ok(scopedTools.get(name, agent))
  assert.deepEqual(counters, { installed: 0, released: 0 })
  const selectedHandlers = h.hooks.get('agent-preset/selected') ?? []
  assert.ok(selectedHandlers.length > 0)
  // The public event uses positional (sessionId, preset) arguments. Its name
  // alone is no authority: a stale announced plan cannot override live standard.
  for (const selected of selectedHandlers) await selected(agent.id, 'plan')
  assert.deepEqual(counters, { installed: 0, released: 0 })
  for (const preset of ['plan', 'standard', 'plan']) {
    h.sessions.get(agent.id).header.agentPreset = preset
    for (const selected of selectedHandlers) await selected(agent.id, preset)
    for (const name of controlledNames)
      if (preset === 'plan') assert.equal(scopedTools.get(name, agent), undefined)
      else assert.ok(scopedTools.get(name, agent))
    for (const name of [...nativeNames, 'chain_role_models']) assert.ok(scopedTools.get(name, agent))
  }
  // No new agent/created or agent/request event was needed after selection.
  assert.deepEqual(counters, { installed: 2, released: 1 })
  assert.deepEqual(await readdir(authorityRoot), [])
  const authorized = await command()
  assert.equal(authorized.kind, 'success', authorized.text)
  assert.deepEqual(counters, { installed: 2, released: 2 })
  assert.equal(filters.size, 0)
  for (const name of controlledNames) assert.ok(scopedTools.get(name, agent))
})
