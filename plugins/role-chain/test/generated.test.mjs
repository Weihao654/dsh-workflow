// The umbrella is generated from plugins/l1-presets + plugins/l2-protocol.
// These tests pin the generation contract: bytes, patch rewrites, metadata and
// the npm "files" allowlist (so a packed release cannot silently lose a runtime file).
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlan, driftOf, writePlan, MIRROR_DIRS, MIRROR_FILES, CLIENT_BUNDLE_ID, rewriteClientIdentity, SyncError } from '../scripts/sync-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(ROOT, '..', '..')
const L1 = join(REPO, 'plugins', 'l1-presets')
const L2 = join(REPO, 'plugins', 'l2-protocol')
const read = file => readFileSync(file, 'utf8')
const readJson = file => JSON.parse(read(file))

function mirrorFiles(sourceDir, rel) {
  const out = []
  const walk = (base, prefix) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const full = join(base, entry.name)
      const item = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, item)
      else out.push(item)
    }
  }
  walk(join(sourceDir, rel), '')
  return out.sort()
}

// Throwaway copy of the three plugin directories, so drift tests can mutate files
// without touching the working tree.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'role-chain-sync-'))
  for (const name of ['l1-presets', 'l2-protocol', 'role-chain']) {
    cpSync(join(REPO, 'plugins', name), join(dir, 'plugins', name), { recursive: true })
  }
  writeFileSync(join(dir, 'LICENSE'), read(join(REPO, 'LICENSE')))
  return { dir, root: join(dir, 'plugins', 'role-chain') }
}

test('the working tree is already in sync', () => {
  const plan = buildPlan(ROOT, REPO)
  assert.deepEqual(driftOf(plan), [])
  assert.equal(plan.expected.size, 31)
  assert.deepEqual(plan.versions, {
    presets: readJson(join(L1, 'package.json')).version,
    protocol: readJson(join(L2, 'package.json')).version,
  })
})

test('mirrored sources are byte-identical except the client identity rewrite, and presets/LICENSE are exact copies', () => {
  for (const dir of MIRROR_DIRS) {
    for (const rel of mirrorFiles(L2, dir)) {
      if (`${dir}/${rel}` === 'lib/client.js') continue
      assert.deepEqual(readFileSync(join(ROOT, dir, rel)), readFileSync(join(L2, dir, rel)), `${dir}/${rel} drifted from l2-protocol`)
    }
  }
  for (const rel of MIRROR_FILES) {
    assert.deepEqual(readFileSync(join(ROOT, rel)), readFileSync(join(L2, rel)), `${rel} drifted from l2-protocol`)
  }
  assert.deepEqual(readFileSync(join(ROOT, 'presets.patch.yml')), readFileSync(join(L1, 'cordis.patch.yml')), 'presets patch must be a byte copy of the L1 patch')
  assert.deepEqual(readFileSync(join(ROOT, 'LICENSE')), readFileSync(join(REPO, 'LICENSE')), 'LICENSE must match the repository LICENSE')
})

test('the mirrored client bundle registers the umbrella package id, not L2\u2019s', () => {
  const l2 = read(join(L2, 'lib/client.js'))
  const shipped = read(join(ROOT, 'lib/client.js'))
  assert.equal(shipped, rewriteClientIdentity(l2))
  assert.notEqual(shipped, l2, 'the identity rewrite must actually change the bundle')
  assert.equal(shipped.split(`id: '${CLIENT_BUNDLE_ID}',`).length - 1, 1, 'exactly one module id, named after the umbrella package')
  assert.equal(shipped.split(`name: '${CLIENT_BUNDLE_ID}',`).length - 1, 1, 'exactly one client plugin name')
  assert.equal(shipped.includes(`id: 'dsh-role-chain-protocol'`), false, 'the shipped bundle must not register the standalone package id')
  assert.equal(shipped.includes(`name: 'dsh-role-chain-protocol'`), false, 'the shipped bundle must not declare the standalone plugin name')
  // L2 itself stays untouched: the rewrite exists only in the generated copy.
  assert.equal(l2.split(`id: 'dsh-role-chain-protocol',`).length - 1, 1)
})

test('the protocol patch differs from L2 only in the single entry name line', () => {
  const source = read(join(L2, 'cordis.patch.yml')).split('\n')
  const umbrella = read(join(ROOT, 'cordis.patch.yml')).split('\n')
  assert.equal(umbrella.length, source.length)
  const diffs = []
  for (let i = 0; i < source.length; i += 1) if (source[i] !== umbrella[i]) diffs.push(i)
  assert.equal(diffs.length, 1, `expected exactly one changed line, got ${diffs.length}`)
  assert.match(source[diffs[0]], /name: 'dsh-role-chain-protocol'/)
  assert.equal(umbrella[diffs[0]].trim(), "name: './lib/index.js'")
})

test('package metadata points at both contained packages and covers every runtime file', () => {
  const pkg = readJson(join(ROOT, 'package.json'))
  assert.deepEqual(pkg.dsh.bundle.patch, ['./presets.patch.yml', './cordis.patch.yml'])
  assert.equal(pkg.dsh.roleChain.contents.presets, `${readJson(join(L1, 'package.json')).name}@${readJson(join(L1, 'package.json')).version}`)
  assert.equal(pkg.dsh.roleChain.contents.protocol, `${readJson(join(L2, 'package.json')).name}@${readJson(join(L2, 'package.json')).version}`)

  const packed = rel => pkg.files.some(entry => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry))
  const runtime = [
    'lib/index.js', 'lib/client.js', 'lib/tools.js', 'lib/profile-dir.js', 'lib/controller.js',
    'lib/windows-supervisor.ps1', 'bridge/runner.mjs', 'bridge/wsl-bwrap.mjs',
    'locale/en.json', 'locale/zh.json', 'icon.svg', 'cordis.patch.yml', 'presets.patch.yml',
    'LICENSE', 'README.md',
  ]
  for (const rel of runtime) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} must exist in the umbrella`)
    assert.ok(packed(rel), `${rel} must be reachable through package.json "files"`)
  }
  for (const excluded of ['scripts/sync-umbrella.mjs', 'scripts/sync-lib.mjs', 'test/run.mjs', 'test/generated.test.mjs']) {
    assert.equal(packed(excluded), false, `${excluded} must not ship in the package`)
  }
})

test('drift is reported for changed and stale files, and writePlan repairs it', () => {
  const box = sandbox()
  try {
    const plan = () => buildPlan(box.root, box.dir)
    assert.deepEqual(driftOf(plan()), [], 'sandbox copy should start in sync')

    appendFileSync(join(box.root, 'lib', 'runtime.js'), '\n// drift\n')
    assert.match(driftOf(plan()).join('\n'), /changed\s+lib\/runtime\.js/)

    writeFileSync(join(box.root, 'lib', 'stale-file.js'), 'export {}\n')
    assert.match(driftOf(plan()).join('\n'), /stale\s+lib\/stale-file\.js/)

    writePlan(plan())
    assert.equal(existsSync(join(box.root, 'lib', 'stale-file.js')), false, 'writePlan must delete stale mirror files')
    assert.deepEqual(driftOf(plan()), [])
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('a version bump in a source package is surfaced as drift', () => {
  const box = sandbox()
  try {
    const file = join(box.dir, 'plugins', 'l2-protocol', 'package.json')
    const pkg = readJson(file)
    pkg.version = '9.9.9-drift.1'
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
    assert.match(driftOf(buildPlan(box.root, box.dir)).join('\n'), /changed\s+package\.json/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('generation fails closed when the sources stop matching the assumed shape', () => {
  const box = sandbox()
  try {
    const patch = join(box.dir, 'plugins', 'l2-protocol', 'cordis.patch.yml')
    writeFileSync(patch, `${read(patch)}      name: 'dsh-role-chain-protocol'\n`)
    assert.throws(() => buildPlan(box.root, box.dir), SyncError)

    const presets = join(box.dir, 'plugins', 'l1-presets', 'cordis.patch.yml')
    writeFileSync(presets, read(presets).replace(/\s*- id: preset-review[^\n]*/, ''))
    assert.throws(() => buildPlan(box.root, box.dir), SyncError)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})
