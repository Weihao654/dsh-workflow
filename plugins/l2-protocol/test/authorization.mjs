import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { harness } from './helpers.mjs'
import { RoundStore } from '../lib/store.js'
import { openRound } from '../lib/service.js'
import { authorizeProject, parseAuthorizationInput, projectUsage } from '../lib/authorization.js'
import { reserveRequest, settleRequest, installUsage } from '../lib/usage.js'
import { resolveExec } from '../lib/roles.js'
import { bindingOf } from '../lib/runtime.js'
const grant = { authorizationId: 'human-approval-1', goal: 'Deterministic protected project',
  budget: { tokens: 100000, requests: 2, outputCap: 16, wallMinutes: 10, fixes: 1, reruns: 1, restarts: 0 } }
const request = { provider: 'fixture', model: 'deterministic', maxTokens: 16, inputTokens: 20 }
async function setup(t) {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-authority-test-'))
  const h = await harness({ noOpen: true, authorityRoot })
  const exec = resolveExec(h.ctx, { agent: h.agents.get('root-plan') }), store = h.controller.storeForExec(exec)
  t.after(async () => {
    await h.close()
    const path = resolve(authorityRoot)
    assert.ok(path.startsWith(`${resolve(tmpdir())}${sep}`) && path.includes('role-chain-authority-test-'))
    await rm(path, { recursive: true, force: true })
  })
  const command = h.commands.get('chain-authorize')
  const invoke = (args = grant, agent = h.agents.get('root-plan')) => command.handler({ commandId: 'host-command-1', agent, rawInput: JSON.stringify(args) })
  const identity = () => store.read(state => { const { round, execution } = bindingOf(state, exec.sessionId); return { sessionId: exec.sessionId, roundId: round.id, executionId: execution.id, generation: execution.generation } })
  return { h, store, exec, invoke, identity, authorityRoot }
}
test('authorization parser accepts one JSON object with or without the Host command prefix', () => {
  const json = JSON.stringify(grant)
  assert.deepEqual(parseAuthorizationInput(`  ${json}\n`), grant)
  assert.deepEqual(parseAuthorizationInput(`/chain-authorize ${json}`), grant)
  assert.deepEqual(parseAuthorizationInput('{"authorizationId":"without-budget","goal":"Use existing defaults"}'),
    { authorizationId: 'without-budget', goal: 'Use existing defaults' })
})

test('malformed authorization command refuses trailing data before any ledger mutation', async t => {
  const { h, store } = await setup(t)
  const handler = h.commands.get('chain-authorize').handler
  let mutations = 0
  const mutate = store.mutate.bind(store)
  store.mutate = (...args) => { mutations++; return mutate(...args) }
  for (const rawInput of [
    `${JSON.stringify(grant)} explanation`,
    `${JSON.stringify(grant)} {"another":"object"}`,
    `${JSON.stringify(grant)}\n/chain-authorize ${JSON.stringify(grant)}`,
    `\`\`\`json\n${JSON.stringify(grant)}\n\`\`\``,
    '',
  ]) {
    const result = await handler({ commandId: 'invalid-json-command', agent: h.plan.agent, rawInput })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /^BAD_ARGS:.*one \/chain-authorize command and one JSON object/)
    assert.match(result.text, /code fences, explanations or another command/)
  }
  assert.equal(mutations, 0)
  assert.equal(await store.read(state => state.authorization), undefined)
  assert.deepEqual(await store.read(state => state.rounds), {})
})

test('invalid authorization object and budget shapes cannot persist a grant through either entry', async t => {
  const { store, exec, invoke } = await setup(t)
  let mutations = 0
  const mutate = store.mutate.bind(store)
  store.mutate = (...args) => { mutations++; return mutate(...args) }
  for (const args of [null, [], 'text', 1, true, ...[null, [], 'text', 1, true].map(budget => ({ ...grant, budget }))]) {
    assert.throws(() => parseAuthorizationInput(JSON.stringify(args)), { code: 'BAD_ARGS' })
    const result = await invoke(args)
    assert.equal(result.kind, 'error'); assert.match(result.text, /^BAD_ARGS:/)
    await assert.rejects(authorizeProject(store, exec, args, 'direct-invalid-shape'), { code: 'BAD_ARGS' })
  }
  assert.equal(mutations, 0)
  assert.equal(await store.read(state => state.authorization), undefined)
  assert.deepEqual(await store.read(state => state.rounds), {})
})

test('closeout reserve minima are validated before an immutable authorization can be written', async t => {
  const { store, exec, invoke } = await setup(t)
  let mutations = 0
  const mutate = store.mutate.bind(store)
  store.mutate = (...args) => { mutations++; return mutate(...args) }
  for (const budget of [{ ...grant.budget, closeoutRequests: 5 }, { ...grant.budget, closeoutTimeMs: 119999 }]) {
    const args = { ...grant, budget }
    const result = await invoke(args)
    assert.equal(result.kind, 'error'); assert.match(result.text, /^BAD_BUDGET:.*closeout.*reserve/)
    await assert.rejects(authorizeProject(store, exec, args, 'invalid-closeout'), { code: 'BAD_BUDGET' })
  }
  assert.equal(mutations, 0)
  assert.equal(await store.read(state => state.authorization), undefined)
  assert.deepEqual(await store.read(state => state.rounds), {})
  const accepted = await invoke({ ...grant, budget: { ...grant.budget, closeoutRequests: 6, closeoutTimeMs: 120000 } })
  assert.equal(accepted.kind, 'success', accepted.text)
  assert.ok(JSON.parse(accepted.text).roundId)
})

test('authorization identity failures diagnose each unmet condition without writing a grant', async t => {
  const { h, store, exec } = await setup(t)
  let mutations = 0
  const mutate = store.mutate.bind(store)
  store.mutate = (...args) => { mutations++; return mutate(...args) }
  const cases = [
    { actual: { ...exec, preset: 'standard', role: null }, commandId: 'human-command', details: /preset=standard, role=none, root=true, bindingValid=true, commandIdPresent=true/ },
    { actual: { ...exec, isRoot: false }, commandId: 'human-command', details: /preset=plan, role=plan, root=false, bindingValid=true, commandIdPresent=true/ },
    { actual: { ...exec, bindingValid: false }, commandId: 'human-command', details: /preset=plan, role=plan, root=true, bindingValid=false, commandIdPresent=true/ },
    { actual: exec, commandId: undefined, details: /preset=plan, role=plan, root=true, bindingValid=true, commandIdPresent=false/ },
  ]
  for (const { actual, commandId, details } of cases) {
    await assert.rejects(authorizeProject(store, actual, grant, commandId), error => {
      assert.equal(error.code, 'ROLE_DENIED'); assert.match(error.message, details)
      assert.match(error.message, /Select the actual root plan session/)
      return true
    })
  }
  const forged = await h.commands.get('chain-authorize').handler({ commandId: 'human-command',
    agent: { ...h.plan.agent }, rawInput: JSON.stringify(grant) })
  assert.equal(forged.kind, 'error'); assert.match(forged.text, /^ROLE_DENIED:.*bindingValid=false/)
  assert.equal(mutations, 0)
  assert.equal(await store.read(state => state.authorization), undefined)
  assert.deepEqual(await store.read(state => state.rounds), {})
})

test('Host human command bootstraps before model; projection identity and immutable authorization', async t => {
  const { h, store, exec, invoke } = await setup(t)
  await assert.rejects(openRound(store, exec, grant), { code: 'AUTHORIZATION_REQUIRED' })
  assert.equal((await invoke(grant, { ...h.agents.get('root-plan') })).kind, 'error')
  const first = await invoke(); assert.equal(first.kind, 'success', first.text)
  assert.ok(JSON.parse(first.text).roundId)
  assert.equal((await invoke()).kind, 'success')
  const changed = await invoke({ ...grant, budget: { ...grant.budget, requests: 3 } })
  assert.equal(changed.kind, 'error'); assert.match(changed.text, /AUTHORIZATION_IMMUTABLE/)
  assert.ok(!store.dir.startsWith(`${resolve(h.dir)}${sep}`))
  const auth = await store.read(state => state.authorization)
  assert.equal(auth.commandId, 'host-command-1')
  assert.equal((await h.controller.beforeRequest(h.agents.get('root-plan'))).store, store)
})
test('only the immutable grant owner can recover its authorization; a new root receives its own grant', async t => {
  const { h, store, exec, invoke } = await setup(t)
  await authorizeProject(store, exec, grant, 'original-grant-owner-command')
  const other = { id: 'other-root-plan', ctx: Object.freeze({ fixtureAgent: 'other-root-plan' }) }
  h.agents.set(other.id, other)
  h.sessions.set(other.id, { id: other.id, header: { id: other.id, cwd: h.dir, agentPreset: 'plan' } })
  const before = await readFile(store.statePath)
  await assert.rejects(authorizeProject(store, resolveExec(h.ctx, { agent: other }), grant, 'cannot-adopt-owner'),
    { code: 'AUTHORIZATION_OWNER_MISMATCH' })
  const independent = await invoke(grant, other)
  assert.equal(independent.kind, 'success', independent.text)
  assert.notEqual(h.controller.storeForExec(resolveExec(h.ctx, { agent: other })).key, store.key)
  assert.deepEqual(await readFile(store.statePath), before)
  assert.deepEqual(await store.read(state => state.rounds), {})
  assert.deepEqual(await store.read(state => state.sessionBindings), {})
  const recovered = await invoke()
  assert.equal(recovered.kind, 'success', recovered.text)
  assert.ok(JSON.parse(recovered.text).roundId)
  assert.deepEqual(await store.read(state => Object.keys(state.sessionBindings)), [exec.sessionId])
  const opened = await readFile(store.statePath)
  assert.equal((await invoke(grant, other)).kind, 'success')
  assert.deepEqual(await readFile(store.statePath), opened)
})

test('cross-round and cold-rebuild attempts remain cumulative, deadline cannot restart', async t => {
  const { store, exec, invoke, identity, authorityRoot, h } = await setup(t)
  assert.equal((await invoke()).kind, 'success')
  const first = await identity()
  await reserveRequest(store, first, 'q1', request)
  await settleRequest(store, first, 'q1', { inputTokens: 20, outputTokens: 4, totalTokens: 24 }, 'completed')
  const original = await store.read(state => state.authorization)
  // Deterministic fixture closure only; not evidence of production shutdown.
  await store.mutate(state => { state.rounds[first.roundId].closedAt = new Date().toISOString(); state.activeRoundId = null })
  await openRound(store, exec, { goal: 'Second deterministic round' })
  const second = await identity()
  await reserveRequest(store, second, 'q2', request)
  await settleRequest(store, second, 'q2', { inputTokens: 20, outputTokens: 4, totalTokens: 24 }, 'completed')
  const cold = new RoundStore(h.dir, { authorityRoot, rootSessionId: exec.sessionId })
  await assert.rejects(reserveRequest(cold, second, 'q3', request), { code: 'PROJECT_REQUEST_BUDGET_REACHED' })
  assert.equal((await cold.read(projectUsage)).requests, 2)
  assert.deepEqual(await cold.read(state => state.authorization), original)
  await assert.rejects(authorizeProject(cold, exec, { ...grant, authorizationId: 'reset' }, 'another'), { code: 'AUTHORIZATION_IMMUTABLE' })
})
test('unknown receipt and expired envelope fail closed across reconstruction', async t => {
  const { store, invoke, identity } = await setup(t)
  await invoke(); const who = await identity()
  await reserveRequest(store, who, 'failed', request)
  await settleRequest(store, who, 'failed', null, 'interrupted')
  await assert.rejects(reserveRequest(store, who, 'retry', request), { code: 'PROJECT_TOKEN_BUDGET_REACHED' })
  const deadline = await store.read(state => Date.parse(state.authorization.deadlineAt))
  await assert.rejects(reserveRequest(store, who, 'late', request, deadline + 1), { code: 'PROJECT_DEADLINE_REACHED' })
})
test('profile authority storage alone does not protect an ordinary standard session', async t => {
  const { h } = await setup(t)
  const agent = h.agents.get('root-plan'); h.sessions.get(agent.id).header.agentPreset = 'standard'
  const dispose = installUsage(h.ctx, h.controller); t.after(dispose)
  const middleware = h.hooks.get('llm/stream')[0]; let calls = 0
  for await (const chunk of middleware({ sessionId: agent.id, maxTokens: 16 }, async function* () { calls++; yield { type: 'text', text: 'ordinary fixture' } })) {}
  assert.equal(calls, 1)
})
test('authority under project including dot-dot-prefixed child is rejected', () => {
  assert.throws(() => new RoundStore(process.cwd(), { authorityRoot: join(process.cwd(), '..private') }), { code: 'AUTHORITY_LOCATION_UNSAFE' })
})
