// Direct enumeration of the tools the shipped code registers.
//
// The plugin registers every tool through ctx.tools.register(definition) inside
// registerTools(); the Host's own session tool table is only observable from a
// model session, which these tests must not open. This imports the umbrella's
// shipped lib/tools.js, runs the same registration path with a stub tool service,
// and compares the result with the L2 source package.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(ROOT, '..', '..')

const EXPECTED = [
  'chain_check_baseline', 'chain_close_round', 'chain_compute', 'chain_dispatch',
  'chain_export_audit', 'chain_freeze_baseline', 'chain_gate', 'chain_open_round',
  'chain_record_evidence', 'chain_record_failure', 'chain_release', 'chain_role_models',
  'chain_status', 'chain_stop',
]

const stubCtx = seen => ({
  logger: { info() {} },
  tools: {
    register(definition) {
      seen.push(definition)
      return () => {}
    },
  },
})

async function enumerate(entry) {
  const { registerTools } = await import(entry)
  const seen = []
  registerTools(stubCtx(seen), {})
  return seen
}

test('the umbrella registers exactly the 14 chain_* tools', async () => {
  const seen = await enumerate(new URL('../lib/tools.js', import.meta.url).href)
  const names = seen.map(definition => definition.name)
  assert.equal(names.length, 14, `registered ${names.length} tools: ${names.join(', ')}`)
  assert.deepEqual([...names].sort(), [...EXPECTED].sort())
  for (const name of names) assert.match(name, /^chain_/)
})

test('registration matches the L2 source package name for name and shape for shape', async () => {
  const umbrella = await enumerate(new URL('../lib/tools.js', import.meta.url).href)
  const source = await enumerate(new URL('../../l2-protocol/lib/tools.js', import.meta.url).href)
  assert.deepEqual(umbrella.map(item => item.name), source.map(item => item.name))
  assert.deepEqual(
    umbrella.map(item => Object.keys(item.parameters.properties ?? {}).sort()),
    source.map(item => Object.keys(item.parameters.properties ?? {}).sort()),
  )
  for (const definition of umbrella) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('every tool declares the roles it accepts', async () => {
  const seen = await enumerate(new URL('../lib/tools.js', import.meta.url).href)
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(resolve(REPO, 'plugins', 'l2-protocol', 'lib', 'tools.js'), 'utf8')
  assert.equal((source.match(/push\(\{ name: 'chain_/g) ?? []).length, 14)
  for (const definition of seen) assert.match(source, new RegExp(`name: '${definition.name}'`))
})
