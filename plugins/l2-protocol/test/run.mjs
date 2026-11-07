// Repeatable regression entry for the role-chain protocol.
//
//   node test/run.mjs             deterministic fixture group, one child process per file
//   node test/run.mjs --native    fixture group + native group (real Windows Job,
//                                 real supervisor, real WSL/bwrap)
//   node test/run.mjs --all       alias of --native
//   node test/run.mjs --in-process  single process fallback for sandboxes that forbid
//                                 spawning grandchildren; weaker (see the warning it prints)
//
// Default mode runs each test file in its own child process so per-file counts are visible;
// --in-process is a weaker fallback for sandboxes that forbid spawning grandchildren.
// Exit code 0 only when every selected test passed.
//
// Skipped tests are NOT a pass (`.21`): if the native group is requested while
// DSH_BRIDGE_LIVE=0 suppresses the live WSL tests, or if any selected file reports
// a skip in --spawn mode, this entry prints INCOMPLETE and exits 2, so missing
// evidence can never be read as a green run. Exit codes: 0 pass, 1 failure,
// 2 incomplete (skipped/uncovered evidence).
//
// Nothing here sends a model request. The native group is the strongest evidence
// available without a Host.
//
// Platform scope: the native group is Windows-only (windows.mjs and
// evidence-native.mjs print UNCOVERED and exit 2 elsewhere; bridge-live and
// guest-boundaries need a WSL distro). The fixture group is platform-independent.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = new Set(process.argv.slice(2))
const native = args.has('--native') || args.has('--all')
const inProcess = args.has('--in-process')
// Spawn mode is the default because a child process with no test summary is detectable;
// an in-process fixture that calls process.exit(0) would otherwise hide its own failure.
// Evidence therefore requires per-file counts (pass >= 1, fail 0, skipped 0).
const spawnMode = !inProcess

const fixtures = [
  'smoke.mjs', 'control.mjs', 'dispatch.mjs', 'authorization.mjs', 'authority-guard.mjs',
  'budget-admission.mjs', 'closeout-reserve.mjs', 'request-gate.mjs', 'role-binding.mjs', 'ordinary-scope.mjs', 'usage.mjs',
  'plan-start.mjs', 'plan-start-api.mjs', 'plan-start-client.mjs',
  'independent-plans.mjs',
  'workflow-mode.mjs',
  'workflow-tools.mjs',
  'bridge.mjs', 'compute-guest.mjs', 'evidence-interface.mjs', 'profile-dir.mjs',
]
const scripts = ['api.mjs', 'routes.mjs']
const natives = ['git.mjs', 'windows.mjs', 'evidence-native.mjs', 'bridge-live.mjs', 'guest-boundaries.mjs']

const selected = [...fixtures, ...(native ? natives : [])]

// A requested native group with the live tests suppressed would produce a green run
// with missing evidence; refuse that instead of reporting it as a pass.
if (native && process.env.DSH_BRIDGE_LIVE === '0') {
  console.error('# INCOMPLETE: --native requested but DSH_BRIDGE_LIVE=0 suppresses the live WSL tests.')
  console.error('# Treat this as missing evidence (exit 2), not as a pass.')
  process.exit(2)
}

// Expected numbers of tests per file. A fixture that exits before registering its tests is
// reported by node:test as one file-level pass, so comparing the count is what actually
// detects a silently truncated file. Update this table when a file gains or loses tests.
const expected = {
  'smoke.mjs': 13, 'control.mjs': 19, 'dispatch.mjs': 3, 'authorization.mjs': 11,
  'authority-guard.mjs': 2, 'budget-admission.mjs': 11, 'closeout-reserve.mjs': 18, 'request-gate.mjs': 4,
  'role-binding.mjs': 5, 'ordinary-scope.mjs': 18, 'usage.mjs': 11, 'bridge.mjs': 11, 'compute-guest.mjs': 4,
  'plan-start.mjs': 7, 'plan-start-api.mjs': 3, 'plan-start-client.mjs': 21, 'independent-plans.mjs': 14, 'workflow-mode.mjs': 15, 'workflow-tools.mjs': 9,
  'evidence-interface.mjs': 6, 'profile-dir.mjs': 4, 'git.mjs': 2, 'windows.mjs': 1, 'evidence-native.mjs': 1,
  'bridge-live.mjs': 10, 'guest-boundaries.mjs': 8,
}
if (spawnMode) {
  let failed = 0
  let skippedFiles = 0
  let spawnDenied = 0
  for (const file of selected) {
    const r = spawnSync(process.execPath, ['--test', join(here, file)], { encoding: 'utf8', cwd: join(here, '..') })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const pass = /^ℹ pass (\d+)/m.exec(out)?.[1]
    const fail = /^ℹ fail (\d+)/m.exec(out)?.[1]
    const skipped = Number(/^ℹ skipped (\d+)/m.exec(out)?.[1] ?? 0)
    const want = expected[file]
    const counted = pass !== undefined && Number(pass) === want && Number(fail) === 0 && skipped === 0
    const ok = r.status === 0 && counted
    const spawnNote = r.error ? ` spawn=${r.error.code ?? r.error.message}` : ''
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(26)} pass=${pass ?? '?'} fail=${fail ?? '?'} skipped=${skipped} exit=${r.status}${spawnNote}`)
    if (r.error) console.log(`      SPAWN ERROR in ${file}: ${r.error.code ?? r.error.message} - the file did not run; that is missing evidence, not a failure of the code under test`)
    if (r.status === 0 && !counted) console.log(`      COUNT MISMATCH in ${file}: expected ${want} passed test(s), saw pass=${pass ?? 'none'} fail=${fail ?? 'none'} - not evidence`)
    if (skipped > 0) console.log(`      SKIPPED ${skipped} test(s) in ${file} - skipped evidence is not a pass`)
    if (skipped > 0) skippedFiles++
    if (r.error) spawnDenied++
    if (ok) {
      // counted as a pass already
    } else if (r.error || (skipped > 0 && Number(fail ?? 0) === 0)) {
      // skipped evidence is incomplete, not a hard failure (exit 2 below)
    } else {
      failed++
      console.log(out.split('\n').filter(l => /not ok|Error|error:/.test(l)).slice(0, 8).map(l => '      ' + l).join('\n'))
    }
  }
  for (const file of scripts) {
    const r = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8', cwd: join(here, '..') })
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${file.padEnd(26)} (script) exit=${r.status}`)
    if (r.status !== 0) { failed++; console.log((r.stdout ?? '') + (r.stderr ?? '')) }
  }
  if (failed > 0) {
    console.log(`${failed} FILE(S) FAILED`)
    process.exit(1)
  }
  if (spawnDenied > 0) {
    console.log(`INCOMPLETE: ${spawnDenied} file(s) could not be started in this sandbox (spawn denied); `
      + 'that is missing evidence, not a pass (exit 2). Use --in-process only if you accept its weaker counting.')
    process.exit(2)
  }
  if (skippedFiles > 0) {
    console.log(`INCOMPLETE: ${skippedFiles} file(s) reported skipped tests; that is not a pass (exit 2).`)
    process.exit(2)
  }
  console.log('ALL SELECTED TESTS PASSED')
  process.exit(0)
}

// In-process mode: each file registers its tests; node:test executes them after the
// imports settle, and a failing test makes this process exit non-zero.
console.log(`# in-process: ${selected.length} test files${native ? ' (with native group)' : ' (fixtures only; pass --native for native group)'}`)
console.log('# WARNING: --in-process cannot assert per-file test counts; a fixture that exits early (or calls process.exit(0)) can hide a failure. Use the default spawn mode for evidence.')
for (const file of selected) {
  await import(pathToFileURL(join(here, file)).href)
}
for (const file of scripts) {
  await import(pathToFileURL(join(here, file)).href)
}
console.log(`# imported ${selected.length + scripts.length} files; node:test reports below`)
