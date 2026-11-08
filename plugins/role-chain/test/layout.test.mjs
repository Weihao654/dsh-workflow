// The mirror is flat on purpose. lib/profile-dir.js derives the profile from its
// own module location as <profile>/node_modules/<package>/lib/index.js; a nested
// vendor/<dir> copy breaks that derivation on a desktop Host (which exports no
// DSH_PROFILE_DIR) with AUTHORITY_LOCATION_REQUIRED. These tests pin both the
// working shape and the reason, plus the patch invariants the Host relies on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(file, 'utf8')

function profileFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'role-chain-layout-'))
  const profile = join(dir, 'profiles', 'p')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  return { dir, profile }
}

const resolver = async moduleFile => {
  const mod = await import(pathToFileURL(moduleFile).href)
  return mod.resolveProfileDir
}

test('an installed umbrella (<profile>/node_modules/dsh-role-chain/lib) derives the profile', async () => {
  const { dir, profile } = profileFixture()
  try {
    const installed = join(profile, 'node_modules', 'dsh-role-chain')
    cpSync(join(ROOT, 'lib'), join(installed, 'lib'), { recursive: true })
    const resolveProfileDir = await resolver(join(installed, 'lib', 'profile-dir.js'))
    const result = resolveProfileDir({
      envDir: undefined,
      moduleUrl: pathToFileURL(join(installed, 'lib', 'index.js')).href,
      exists: existsSync,
      readJson: file => JSON.parse(readFileSync(file, 'utf8')),
    })
    assert.deepEqual(result, { dir: profile, source: 'module' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a nested vendor/<dir> copy cannot derive the profile, which is why the mirror is flat', async () => {
  const { dir, profile } = profileFixture()
  try {
    const nested = join(profile, 'node_modules', 'dsh-role-chain', 'vendor', 'l2')
    cpSync(join(ROOT, 'lib'), join(nested, 'lib'), { recursive: true })
    const resolveProfileDir = await resolver(join(nested, 'lib', 'profile-dir.js'))
    assert.throws(() => resolveProfileDir({
      envDir: undefined,
      moduleUrl: pathToFileURL(join(nested, 'lib', 'index.js')).href,
      exists: existsSync,
      readJson: file => JSON.parse(readFileSync(file, 'utf8')),
    }), /AUTHORITY_LOCATION_REQUIRED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DSH_PROFILE_DIR still wins over module derivation', async () => {
  const resolveProfileDir = await resolver(join(ROOT, 'lib', 'profile-dir.js'))
  const result = resolveProfileDir({
    envDir: 'C:\\some\\profile',
    moduleUrl: pathToFileURL(join(ROOT, 'lib', 'index.js')).href,
    exists: existsSync,
    readJson: file => JSON.parse(readFileSync(file, 'utf8')),
  })
  assert.deepEqual(result, { dir: 'C:\\some\\profile', source: 'env' })
})

test('the protocol row is a relative entry and the presets patch carries the four presets only', () => {
  const protocol = read(join(ROOT, 'cordis.patch.yml'))
  assert.equal((protocol.match(/- id: role-chain-protocol/g) ?? []).length, 1)
  assert.match(protocol, /name: '\.\/lib\/index\.js'/)
  assert.equal(protocol.includes('dsh-role-chain-protocol'), false, 'the shipped patch must not name the standalone package')

  const presets = read(join(ROOT, 'presets.patch.yml'))
  assert.equal((presets.match(/^\s*- id: preset-/gm) ?? []).length, 4)
  assert.equal(/preset-(plan|work|code|review)/.test(presets), true)
  assert.equal(presets.includes('role-chain-protocol'), false)
})

test('runtime files sit next to the modules that read them', () => {
  // lib/managed-jobs.js resolves ./windows-supervisor.ps1 relative to itself.
  assert.match(read(join(ROOT, 'lib', 'managed-jobs.js')), /new URL\('\.\/windows-supervisor\.ps1', import\.meta\.url\)/)
  cpSync(join(ROOT, 'lib', 'windows-supervisor.ps1'), join(tmpdir(), 'role-chain-runtime-probe.ps1'), { force: true })
})
