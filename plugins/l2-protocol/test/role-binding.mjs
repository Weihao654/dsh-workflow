import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBinding, resolveExec } from '../lib/roles.js'

function fixture({ mounted = 'plan', projected = 'plan', header = 'standard', child = false } = {}) {
  const context = {}, session = { id: 's', header: { id: 's', agentPreset: header, cwd: process.cwd(), ...(child ? { parentSession: 'p', origin: 'subagent' } : {}) } }
  const agent = { id: 's', ctx: context }
  const ctx = { agents: { get: id => id === 's' ? agent : undefined }, sessions: { get: id => id === 's' ? session : undefined },
    agentPresets: { composedPreset: value => { assert.equal(value, context); return mounted } },
    sessionProjections: { stateOf: (value, key) => { assert.equal(value, session); assert.equal(key, 'agentPreset'); return projected } } }
  return { ctx, agent, session }
}

test('real mount and formal projection agree; historical standard never overrides plan', () => {
  const { ctx, agent } = fixture()
  const actual = resolveExec(ctx, { agent })
  assert.equal(actual.role, 'plan'); assert.equal(actual.isRoot, true)
})
test('standard stays unprivileged even with historical plan header', () => {
  const { ctx, agent } = fixture({ mounted: 'standard', projected: 'standard', header: 'plan' })
  assert.equal(resolveExec(ctx, { agent }).role, null)
})
test('all roles preserve child/root boundaries', () => {
  for (const role of ['plan', 'work', 'code', 'review']) {
    const { ctx, agent } = fixture({ mounted: role, projected: role, child: true })
    const actual = resolveExec(ctx, { agent }); assert.equal(actual.role, role); assert.equal(actual.isRoot, false)
  }
})
test('missing mount or projection and conflicts fail closed despite forged ordinary fields', () => {
  for (const pair of [[null, 'plan'], ['plan', null], ['plan', 'code'], ['', 'plan']]) {
    const { ctx, agent, session } = fixture({ mounted: pair[0], projected: pair[1] })
    session.agentPreset = 'plan'; session.projection = { agentPreset: 'plan' }
    const actual = resolveExec(ctx, { agent }); assert.equal(actual.role, null); assert.equal(actual.isRoot, false)
  }
})
test('forged Agent/context or session-only input cannot impersonate live Host objects', () => {
  const { ctx, agent, session } = fixture()
  assert.equal(resolveBinding(ctx, { agent: { ...agent } }).valid, false)
  assert.equal(resolveExec(ctx, { agent: { id: 'x', ctx: agent.ctx, session } }).role, null)
  assert.equal(resolveExec(ctx, { ctx: agent.ctx, session }).role, null)
  delete agent.ctx
  assert.equal(resolveBinding(ctx, { sessionId: 's' }).valid, false)
})
