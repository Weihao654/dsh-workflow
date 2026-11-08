// Pure generation logic for the dsh-role-chain umbrella bundle.
//
// The umbrella owns no source of its own: plugins/l1-presets and plugins/l2-protocol
// stay authoritative and every file here is derived from them. L2's files are
// mirrored at the SAME relative paths it uses as a standalone package (lib/, bridge/,
// locale/, icon.svg) because lib/profile-dir.js derives the profile from its own
// module location as <profile>/node_modules/<package>/lib/index.js; a nested
// vendor/<dir> copy would make that derivation fail on a desktop Host (which exports
// no DSH_PROFILE_DIR) with AUTHORITY_LOCATION_REQUIRED.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export class SyncError extends Error {}
const fail = message => { throw new SyncError(message) }

export const MIRROR_DIRS = ['lib', 'bridge', 'locale']
export const MIRROR_FILES = ['icon.svg']

// Files the runtime actually needs from L2; missing one is a hard error even when
// the source tree still contains it somewhere else.
export const REQUIRED = [
  'lib/index.js', 'lib/client.js', 'lib/profile-dir.js', 'lib/windows-supervisor.ps1',
  'bridge/runner.mjs', 'bridge/wsl-bwrap.mjs', 'locale/en.json', 'locale/zh.json', 'icon.svg',
]

const PRESET_ROW = /^[ \t]*- id: preset-[a-z]+[ \t]*$/m
const PROTOCOL_ROW = /^([ \t]*)name: 'dsh-role-chain-protocol'[ \t]*$/m

const read = file => readFileSync(file, 'utf8')
const readJson = file => JSON.parse(read(file))

function walk(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else if (statSync(full).isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/**
 * Compute the exact file set the umbrella should contain.
 * @param {string} root umbrella package directory
 * @param {string} repo repository root (contains plugins/ and LICENSE)
 */
export function buildPlan(root, repo) {
  const L1 = join(repo, 'plugins', 'l1-presets')
  const L2 = join(repo, 'plugins', 'l2-protocol')
  if (!existsSync(join(L1, 'cordis.patch.yml'))) fail(`missing L1 source at ${L1}`)
  if (!existsSync(join(L2, 'cordis.patch.yml'))) fail(`missing L2 source at ${L2}`)

  const l1Pkg = readJson(join(L1, 'package.json'))
  const l2Pkg = readJson(join(L2, 'package.json'))
  const l1Patch = read(join(L1, 'cordis.patch.yml'))
  const l2Patch = read(join(L2, 'cordis.patch.yml'))

  if ((l1Patch.match(new RegExp(PRESET_ROW.source, 'gm')) ?? []).length !== 4) fail('l1 patch no longer declares exactly four preset rows')
  if (l1Patch.includes('role-chain-protocol')) fail('l1 patch unexpectedly inserts the protocol row')

  const protocolRows = l2Patch.match(new RegExp(PROTOCOL_ROW.source, 'gm')) ?? []
  if (protocolRows.length !== 1) fail(`l2 patch must name 'dsh-role-chain-protocol' exactly once, found ${protocolRows.length}`)
  const umbrellaPatch = l2Patch.replace(PROTOCOL_ROW, (_line, indent) => `${indent}name: './lib/index.js'`)
  if (!umbrellaPatch.includes("name: './lib/index.js'")) fail('protocol row rewrite produced no relative entry')

  /** @type {Map<string, Buffer | string>} */
  const expected = new Map()
  expected.set('presets.patch.yml', l1Patch)
  expected.set('cordis.patch.yml', umbrellaPatch)
  expected.set('LICENSE', read(join(repo, 'LICENSE')))
  for (const dir of MIRROR_DIRS) {
    for (const rel of walk(join(L2, dir))) expected.set(`${dir}/${rel}`, readFileSync(join(L2, dir, rel)))
  }
  for (const rel of MIRROR_FILES) expected.set(rel, readFileSync(join(L2, rel)))
  for (const rel of REQUIRED) if (!expected.has(rel)) fail(`expected runtime file ${rel} is missing from the L2 source`)

  const pkgFile = join(root, 'package.json')
  if (!existsSync(pkgFile)) fail('umbrella package.json is missing')
  const umbrellaPkg = readJson(pkgFile)
  const contents = umbrellaPkg.dsh?.roleChain?.contents
  if (!contents) fail('package.json is missing dsh.roleChain.contents')
  const next = { presets: `${l1Pkg.name}@${l1Pkg.version}`, protocol: `${l2Pkg.name}@${l2Pkg.version}` }
  const pkgChanged = contents.presets !== next.presets || contents.protocol !== next.protocol
  if (pkgChanged) {
    umbrellaPkg.dsh.roleChain.contents = next
    expected.set('package.json', JSON.stringify(umbrellaPkg, null, 2) + '\n')
  }

  return {
    root,
    repo,
    expected,
    pkgChanged,
    contents: next,
    versions: { presets: l1Pkg.version, protocol: l2Pkg.version },
  }
}

/**
 * Compare the umbrella on disk with the computed plan.
 * @returns {string[]} human-readable drift lines (empty = in sync)
 */
export function driftOf(plan) {
  const drift = []
  for (const [rel, want] of plan.expected) {
    const file = join(plan.root, rel)
    if (!existsSync(file)) { drift.push(`missing   ${rel}`); continue }
    const have = readFileSync(file)
    const expectedBytes = Buffer.isBuffer(want) ? want : Buffer.from(want)
    if (!have.equals(expectedBytes)) drift.push(`changed   ${rel}`)
  }
  for (const dir of MIRROR_DIRS) {
    const base = join(plan.root, dir)
    if (!existsSync(base)) continue
    for (const rel of walk(base)) if (!plan.expected.has(`${dir}/${rel}`)) drift.push(`stale     ${dir}/${rel}`)
  }
  return drift
}

/** Write the plan to disk: remove stale mirror files, write every expected file. */
export function writePlan(plan) {
  for (const dir of MIRROR_DIRS) {
    const base = join(plan.root, dir)
    if (!existsSync(base)) { mkdirSync(base, { recursive: true }); continue }
    for (const rel of walk(base)) if (!plan.expected.has(`${dir}/${rel}`)) rmSync(join(base, rel), { force: true })
  }
  for (const [rel, want] of plan.expected) {
    const file = join(plan.root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, want)
  }
  return plan.expected.size
}
