// Live denial-matrix tests for the WSL/bwrap bridge.
//
// These start the local WSL distro and bwrap and therefore are NOT part of the
// deterministic suite; run them explicitly:
//
//   node --test test/bridge-live.mjs
//
// They assert the *confinement* contract, not the plugin's own admission logic:
//   R-A workspace-write: only the workspace is writable
//   R-B read-only: nothing is writable, workspace is readable
//   R-C outside-workspace writes (/etc, /tmp) are refused
//   R-D symlink escape out of the workspace is refused
//   R-E Windows PE inside the workspace cannot re-enter Windows (interop socket hidden)
//   R-F /mnt (other Windows drives) is unreachable
//   R-G network namespace has only loopback
//   R-H child exit status is propagated exactly
//   R-I timeout kills the run and reports an unknown/non-zero outcome
//   R-J a Windows path outside the workspace is refused before bwrap starts
//
// Every test creates its own temporary workspace and removes it afterwards.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBridge } from '../bridge/wsl-bwrap.mjs'

const DISTRO = process.env.DSH_BRIDGE_DISTRO ?? 'Ubuntu'
const skip = process.env.DSH_BRIDGE_LIVE === '0' ? 'live bridge tests disabled' : false

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-'))
  writeFileSync(join(root, 'seed.txt'), 'seed\n')
  return root
}

const sh = (script) => ['sh', '-c', script]

test('R-A workspace-write writes only inside the workspace', { skip }, async () => {
  const ws = scratch()
  try {
    const run = await runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws, argv: sh('echo inside > made.txt && echo OK') })
    assert.equal(run.exitCode, 0, run.stderr)
    assert.match(run.stdout, /OK/)
    assert.equal(readFileSync(join(ws, 'made.txt'), 'utf8').trim(), 'inside')

    const outside = await runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws, argv: sh('touch /etc/dsh-escape') })
    assert.notEqual(outside.exitCode, 0)
    assert.ok(outside.denied || /Read-only file system/.test(outside.stderr), outside.stderr)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-B read-only mode cannot write the workspace but can read it', { skip }, async () => {
  const ws = scratch()
  try {
    const read = await runBridge({ distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: sh('cat seed.txt') })
    assert.equal(read.exitCode, 0, read.stderr)
    assert.match(read.stdout, /seed/)

    const write = await runBridge({ distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: sh('echo nope > blocked.txt') })
    assert.notEqual(write.exitCode, 0)
    assert.equal(existsSync(join(ws, 'blocked.txt')), false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-C writes to system directories outside the workspace are refused', { skip }, async () => {
  const ws = scratch()
  try {
    const etc = await runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws, argv: sh('touch /etc/x') })
    assert.notEqual(etc.exitCode, 0)
    assert.match(etc.stderr, /Read-only file system|Permission denied/)

    const system = await runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws, argv: sh('touch /usr/local/x') })
    assert.notEqual(system.exitCode, 0)
    assert.match(system.stderr, /Read-only file system|Permission denied/)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-D symlink in a writable temp dir cannot escape for writes', { skip }, async () => {
  const ws = scratch()
  try {
    const run = await runBridge({
      distro: DISTRO,
      mode: 'workspace-write',
      workspaceRoot: ws,
      argv: sh('ln -s /etc/passwd /tmp/link && echo through > /tmp/link'),
    })
    assert.notEqual(run.exitCode, 0)
    assert.match(run.stderr, /Read-only file system|Permission denied/)
    assert.equal(existsSync(join(ws, 'through')), false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-E Windows PE in the workspace cannot re-enter Windows', { skip }, async () => {
  const ws = scratch()
  const winWho = 'C:\\Windows\\System32\\whoami.exe'
  try {
    // A missing precondition is a missing test, not a pass: fail loudly instead of returning.
    assert.ok(existsSync(winWho), 'R-E requires C:\\Windows\\System32\\whoami.exe to exercise PE re-entry')
    copyFileSync(winWho, join(ws, 'whoami.exe'))
    const run = await runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws, argv: [join(ws, 'whoami.exe')] })
    assert.notEqual(run.exitCode, 0, 'PE execution must fail')
    assert.doesNotMatch(run.stdout, /weihao|LAPTOP/i, 'no Windows identity may be produced')
    assert.match(run.stderr, /UtilConnectUnix|UtilGetPpid|Permission denied|Exec format error/i)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-F /mnt is unreachable and other drives are not exposed', { skip }, async () => {
  const ws = scratch()
  try {
    // Assert the absence itself: a script that always prints a done-marker would make the old
    // /No such file or directory|MNT_DONE/ match vacuous.
    const run = await runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws,
      argv: sh('if ls /mnt/c >/dev/null 2>&1; then echo MNT_VISIBLE; else echo MNT_ABSENT; fi') })
    assert.equal(run.exitCode, 0)
    assert.match(run.stdout, /MNT_ABSENT/)
    assert.doesNotMatch(run.stdout, /MNT_VISIBLE|Windows/)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-G network namespace exposes only loopback', { skip }, async () => {
  const ws = scratch()
  try {
    const run = await runBridge({ distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: sh('cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " " | sort -u') })
    assert.equal(run.exitCode, 0, run.stderr)
    const interfaces = run.stdout.split(/\s+/).filter(Boolean)
    assert.deepEqual(interfaces, ['lo'])
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-H exit status is propagated exactly', { skip }, async () => {
  const ws = scratch()
  try {
    const run = await runBridge({ distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: sh('exit 7') })
    assert.equal(run.exitCode, 7)
    assert.equal(run.trailer.kind, 'exit')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-I timeout produces a non-zero, non-success outcome', { skip }, async () => {
  const ws = scratch()
  try {
    const started = Date.now()
    const run = await runBridge({ distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: sh('sleep 20'), timeoutMs: 1500 })
    assert.ok(Date.now() - started < 15000, 'timeout must fire early')
    assert.notEqual(run.exitCode, 0)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('R-J Windows paths outside the workspace are refused before bwrap starts', { skip }, async () => {
  const ws = scratch()
  try {
    await assert.rejects(
      async () => runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws, argv: ['sh', '-c', 'true'], env: { 'BAD KEY': 'x' } }),
      /BRIDGE_BAD_ENV/,
    )
    await assert.rejects(
      async () => runBridge({ distro: DISTRO, mode: 'workspace-write', workspaceRoot: ws, argv: ['cat', 'C:\\Windows\\win.ini'] }),
      /BRIDGE_PATH_OUTSIDE_WORKSPACE/,
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})