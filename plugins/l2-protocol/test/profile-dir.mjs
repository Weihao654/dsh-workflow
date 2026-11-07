import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveProfileDir } from '../lib/profile-dir.js'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

function profileFixture(bundles) {
  const root = mkdtempSync(join(tmpdir(), 'role-chain-profile-'))
  const packageRoot = join(root, 'node_modules', 'dsh-role-chain-protocol')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-fixture',
    dsh: bundles === undefined ? {} : { profile: { bundles } },
  }))
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-role-chain-protocol', version: '0.0.0' }))
  writeFileSync(join(packageRoot, 'lib', 'index.js'), '// fixture\n')
  return { root, moduleUrl: pathToFileURL(join(packageRoot, 'lib', 'index.js')).href }
}

const resolve = (overrides) => resolveProfileDir({ exists: existsSync, readJson, ...overrides })

test('.40: the launcher environment wins over the module location', () => {
  const { moduleUrl } = profileFixture(['@deepseek-ai/dsh-base'])
  assert.deepEqual(resolve({ envDir: 'C:\\env\\profile', moduleUrl }), { dir: 'C:\\env\\profile', source: 'env' })
})

test('.40: an installed copy derives the profile above node_modules', () => {
  const fixture = profileFixture(['@deepseek-ai/dsh-base', 'dsh-role-chain-protocol'])
  assert.deepEqual(resolve({ envDir: '', moduleUrl: fixture.moduleUrl }), { dir: fixture.root, source: 'module' })
})

test('.40: a module outside any profile is refused, not guessed', () => {
  const fixture = profileFixture(undefined)
  assert.throws(
    () => resolve({ envDir: undefined, moduleUrl: fixture.moduleUrl }),
    /AUTHORITY_LOCATION_REQUIRED: a profile-owned ledger is mandatory/,
  )
})

test('.40: no environment and no derivable profile fails closed', () => {
  assert.throws(
    () => resolve({ envDir: '   ', moduleUrl: 'not a url at all' }),
    /AUTHORITY_LOCATION_REQUIRED: a profile-owned ledger is mandatory/,
  )
})
