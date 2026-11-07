// Synthetic implementation of the inspected public Host scoped registry.
// Exercises effective tool lookup/schema visibility; no Host or model I/O.
import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowToolVisibility } from '../lib/workflow-tools.js'

const controlled = ['chain_open_round', 'chain_freeze_baseline', 'chain_check_baseline', 'chain_record_failure',
  'chain_record_evidence', 'chain_dispatch', 'chain_compute', 'chain_stop', 'chain_release', 'chain_status',
  'chain_gate', 'chain_close_round', 'chain_export_audit']
const native = ['read', 'write', 'dispatch_work', 'send_message']

function fixture() {
  const definitions = new Map([...controlled, ...native, 'chain_role_models'].map(name => [name, { name }]))
  const live = new Map(), scopes = new Map(), warnings = []
  const counters = { installed: 0, released: 0 }
  const ctx = { get: name => name === 'agents' ? { get: id => live.get(id) } : undefined,
    logger: { warn: text => warnings.push(text) } }
  const visibility = new WorkflowToolVisibility({ ctx })
  const add = (id = 'workflow-plan') => {
    const filters = new Set()
    const agent = { id, ctx: {} }
    const tools = {
      get(name, scope) {
        if (!definitions.has(name)) return undefined
        const masks = scope ? scopes.get(scope)?.filters ?? [] : []
        return [...masks].some(filter => filter.deny.includes(name)) ? undefined : definitions.get(name)
      },
      schemas(scope) { return [...definitions.keys()].map(name => tools.get(name, scope)).filter(Boolean) },
      restrict(filter) {
        assert.ok(filter.deny.length)
        assert.ok(filter.deny.every(name => definitions.has(name)), 'Host rejects unknown global tool names')
        filters.add(filter); counters.installed++
        let active = true
        return () => { if (active) { filters.delete(filter); counters.released++; active = false } }
      },
    }
    agent.ctx.get = name => name === 'tools' ? tools : undefined
    scopes.set(agent, { tools, filters }); live.set(id, agent)
    const exec = { agent, sessionId: id, bindingValid: true, role: 'plan', isRoot: true }
    return { agent, exec, tools, filters }
  }
  return { visibility, add, live, scopes, definitions, counters, warnings, ctx }
}

test('workflow uses the public scoped restriction to remove thirteen controlled schemas and keep native/model tools', () => {
  const { visibility, add, counters } = fixture(), { agent, exec, tools } = add()
  assert.equal(visibility.sync(exec, true, [...controlled, 'chain_role_models', 'read']), true)
  for (const name of controlled) assert.equal(tools.get(name, agent), undefined)
  assert.deepEqual(tools.schemas(agent).map(row => row.name), [...native, 'chain_role_models'])
  assert.equal(counters.installed, 1)
  visibility.dispose()
})

test('repeated sync for the same live instance and tool set is idempotent even though its own denied tools are hidden', () => {
  const { visibility, add, counters } = fixture(), { exec } = add()
  for (let i = 0; i < 3; i++) assert.equal(visibility.sync(exec, true, [...controlled].reverse()), true)
  assert.equal(counters.installed, 1); assert.equal(counters.released, 0)
  visibility.dispose(); assert.equal(counters.released, 1)
})

test('explicit workflow false restores controlled tools and constructor enabled false installs no restriction', () => {
  const { visibility, add, counters, ctx } = fixture(), { agent, exec, tools } = add()
  visibility.sync(exec, true, controlled)
  assert.equal(visibility.sync(exec, false, controlled), false)
  assert.ok(tools.get('chain_open_round', agent))
  assert.equal(counters.released, 1)
  const disabled = new WorkflowToolVisibility({ ctx }, { enabled: false })
  assert.equal(disabled.sync(exec, true, controlled), false)
  assert.equal(counters.installed, 1)
  visibility.dispose(); disabled.dispose()
})

test('a replacement live Agent releases the old scope and late disposal cannot clear the new scope restriction', () => {
  const { visibility, add, counters } = fixture()
  const old = add('same-session'); visibility.sync(old.exec, true, controlled)
  const next = add('same-session'); visibility.sync(next.exec, true, controlled)
  assert.ok(old.tools.get('chain_open_round', old.agent))
  assert.equal(next.tools.get('chain_open_round', next.agent), undefined)
  assert.equal(visibility.release(old.agent), false)
  assert.equal(visibility.sync(old.exec, false, controlled), false)
  assert.equal(next.tools.get('chain_open_round', next.agent), undefined)
  assert.deepEqual(counters, { installed: 2, released: 1 })
  visibility.dispose(); assert.equal(counters.released, 2)
})

test('changed tool names replace only this wrapper restriction and dispose releases every owned scope', () => {
  const { visibility, add, counters } = fixture(), first = add('first'), second = add('second')
  const externalDispose = first.tools.restrict({ deny: ['write'] })
  visibility.sync(first.exec, true, controlled)
  visibility.sync(second.exec, true, controlled)
  visibility.sync(first.exec, true, ['chain_stop'])
  assert.ok(first.tools.get('chain_open_round', first.agent))
  assert.equal(first.tools.get('chain_stop', first.agent), undefined)
  visibility.dispose()
  assert.ok(first.tools.get('chain_stop', first.agent)); assert.ok(second.tools.get('chain_open_round', second.agent))
  assert.equal(first.tools.get('write', first.agent), undefined, 'an external restriction remains owned by its plugin')
  assert.equal(counters.released, 3)
  externalDispose(); assert.equal(counters.released, 4)
})

test('only currently visible registered controlled names are denied and an empty mask never calls restrict', () => {
  const { visibility, add, definitions, counters } = fixture(), { agent, exec, tools } = add()
  definitions.delete('chain_compute')
  assert.equal(visibility.sync(exec, true, ['chain_compute', 'chain_missing', 'chain_role_models', 'read']), false)
  assert.equal(counters.installed, 0)
  assert.equal(visibility.sync(exec, true, ['chain_stop', 'chain_stop', 'chain_missing', 'chain_role_models']), true)
  assert.equal(tools.get('chain_stop', agent), undefined)
  assert.ok(tools.get('chain_role_models', agent))
  visibility.dispose()
})

test('a previously absent or externally hidden tool is filtered when it becomes visible on a later sync', () => {
  const { visibility, add, definitions, counters } = fixture(), { agent, exec, tools } = add()
  definitions.delete('chain_compute')
  const releaseExternal = tools.restrict({ deny: ['chain_status'] })
  visibility.sync(exec, true, controlled)
  definitions.set('chain_compute', { name: 'chain_compute' }); releaseExternal()
  assert.ok(tools.get('chain_compute', agent)); assert.ok(tools.get('chain_status', agent))
  visibility.sync(exec, true, controlled)
  assert.equal(tools.get('chain_compute', agent), undefined)
  assert.equal(tools.get('chain_status', agent), undefined)
  assert.equal(counters.installed, 3, 'external mask plus initial and updated workflow masks')
  visibility.dispose()
})

test('missing capability, unverified execution and stale/copied Agent identities degrade without installing a filter', () => {
  const { visibility, add, live, counters } = fixture(), { agent, exec, tools } = add()
  for (const invalid of [{ ...exec, bindingValid: false }, { ...exec, sessionId: 'different-session' },
    { ...exec, agent: { ...agent } }, { ...exec, agent: null }])
    assert.equal(visibility.sync(invalid, true, controlled), false)
  live.delete(agent.id)
  assert.equal(visibility.sync(exec, true, controlled), false)
  live.set(agent.id, agent)
  const originalGet = agent.ctx.get
  for (const capability of [undefined, {}, { get: tools.get }, { restrict: tools.restrict }]) {
    agent.ctx.get = () => capability
    assert.equal(visibility.sync(exec, true, controlled), false)
  }
  agent.ctx.get = originalGet
  assert.equal(counters.installed, 0)
  assert.ok(tools.get('dispatch_work', agent))
})

test('registry failures and cleanup errors remain contained and do not prevent other scopes from releasing', () => {
  const { visibility, add, warnings, counters } = fixture(), broken = add('broken')
  const realRestrict = broken.tools.restrict
  broken.tools.restrict = () => { throw new Error('fixture scoped registry unavailable') }
  assert.equal(visibility.sync(broken.exec, true, controlled), false)
  assert.ok(broken.tools.get('dispatch_work', broken.agent)); assert.equal(warnings.length, 1)
  broken.tools.restrict = filter => {
    const dispose = realRestrict(filter)
    return () => { dispose(); throw new Error('fixture cleanup error') }
  }
  visibility.sync(broken.exec, true, controlled)
  const healthy = add('healthy'); visibility.sync(healthy.exec, true, controlled)
  assert.doesNotThrow(() => visibility.dispose())
  assert.equal(counters.released, 2)
  assert.ok(healthy.tools.get('chain_open_round', healthy.agent))
  assert.equal(warnings.length, 2)
})
