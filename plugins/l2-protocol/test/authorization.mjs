import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { harness } from './helpers.mjs'
import { RoundStore } from '../lib/store.js'
import { openRound } from '../lib/service.js'
import { authorizeProject, projectUsage } from '../lib/authorization.js'
import { reserveRequest, settleRequest, installUsage } from '../lib/usage.js'
import { resolveExec } from '../lib/roles.js'
import { bindingOf } from '../lib/runtime.js'
const grant = { authorizationId: 'human-approval-1', goal: 'Deterministic protected project',
  budget: { tokens: 100000, requests: 2, outputCap: 16, wallMinutes: 10, fixes: 1, reruns: 1, restarts: 0 } }
const request = { provider: 'fixture', model: 'deterministic', maxTokens: 16, inputTokens: 20 }
async function setup(t) {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-authority-test-'))
  const h = await harness({ noOpen: true, authorityRoot })
  const store = h.controller.storeForCwd(h.dir), exec = resolveExec(h.ctx, { agent: h.agents.get('root-plan') })
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
  const cold = new RoundStore(h.dir, { authorityRoot })
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
