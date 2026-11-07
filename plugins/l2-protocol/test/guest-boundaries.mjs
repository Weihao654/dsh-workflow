// Guest read/hardlink boundary tests for the WSL/bwrap bridge.
//
// Native + live: they start the local WSL distro, so they are not part of the
// deterministic suite. Run explicitly with:
//
//   node --test test/guest-boundaries.mjs                     (Windows + WSL distro)
//   DSH_BRIDGE_LIVE=0 node --test test/guest-boundaries.mjs    (skip)
//
// What they can and cannot prove:
//   G-A a hardlink created inside the workspace stays there and is visible on the host;
//       a hardlink target outside the workspace fails
//   G-B no Windows filesystem outside the workspace is reachable (empty /mnt)
//   G-C symlinks/traversal to Windows paths do not become a read channel, and a Windows
//       absolute path argument is refused before bwrap starts
//   G-D read-only mode refuses hardlink creation and leaves the host tree unchanged
//   G-E argv containing the forms wsl.exe still substitutes (`$VAR`, `$(...)`, backticks)
//       is refused before bwrap starts. Plain shell metacharacters (`; | & ( ) < >`) are
//       NOT refused: since `.19` the bridge uses `wsl.exe --exec`, so they arrive as
//       literal guest argv (see G-G, which proves they cannot create files outside bwrap).
//   G-F plain argv (spaces, semicolons, quotes inside a script) reaches the guest intact,
//       which is the level the real compute path relies on.
//   G-H an option-shaped environment value (`a --chdir /`) cannot shift bwrap flags, and a
//       newline inside an environment value is refused by the guard instead of reaching wsl.exe.
//
// They exercise the confinement/transport layer only; they say nothing about the
// plugin's admission logic or about a real Host/model turn.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { runBridge } from '../bridge/wsl-bwrap.mjs'

const DISTRO = process.env.DSH_BRIDGE_DISTRO ?? 'Ubuntu'
const skip = process.env.DSH_BRIDGE_LIVE === '0' ? 'live bridge tests disabled' : false
const sh = (script) => ['sh', '-c', script]
const run = (mode, ws, argv) => runBridge({ distro: DISTRO, mode, workspaceRoot: ws, argv })

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-guest-'))
  writeFileSync(join(root, 'seed.txt'), 'seed\n')
  return root
}

test('G-A hardlink inside the workspace stays inside it', { skip }, async () => {
  const ws = scratch()
  try {
    // The workspace is a writable bind mount, so a hardlink inside it must succeed and be
    // visible on the host; a silent refusal would hide a broken mount, so this is an
    // equality assertion rather than an either/or branch.
    const link = await run('workspace-write', ws, sh('ln seed.txt hard.txt'))
    assert.equal(link.exitCode, 0, 'a hardlink inside the writable workspace must succeed: ' + String(link.stderr))
    assert.equal(existsSync(join(ws, 'hard.txt')), true, 'a hardlink made in the workspace must be visible on the host')
    assert.equal(readFileSync(join(ws, 'hard.txt'), 'utf8'), 'seed\n')
    assert.equal(readFileSync(join(ws, 'seed.txt'), 'utf8'), 'seed\n')
    const escape = await run('workspace-write', ws, sh('ln seed.txt /mnt/c/dsh-hardlink-escape'))
    assert.notEqual(escape.exitCode, 0, 'a hardlink target outside the workspace must fail')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('G-B no Windows filesystem outside the workspace is reachable', { skip }, async () => {
  const ws = scratch()
  try {
    const mnt = await run('read-only', ws, sh('ls -A /mnt'))
    assert.equal(mnt.exitCode, 0, mnt.stderr)
    assert.equal(String(mnt.stdout).trim(), '', 'expected an empty /mnt tmpfs')

    const read = await run('read-only', ws, sh('cat /mnt/c/Windows/win.ini'))
    assert.notEqual(read.exitCode, 0, 'a host file outside the workspace must not be readable')
    // The Linux root stays readable by design (ro-bind / /); only the Windows side is fenced.
    const rootRead = await run('read-only', ws, sh('cat /etc/hostname'))
    assert.equal(rootRead.exitCode, 0, rootRead.stderr)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('G-C symlinks and traversal to Windows paths are not a read channel', { skip }, async () => {
  const ws = scratch()
  try {
    try { symlinkSync('C:\\Windows\\win.ini', join(ws, 'win-link')) } catch { /* filesystem may refuse; the rest still holds */ }
    const viaLink = await run('read-only', ws, sh('cat win-link'))
    assert.notEqual(viaLink.exitCode, 0, 'a symlink to a Windows path must not resolve')

    const traversal = await run('read-only', ws, sh('cat /srv/../../mnt/c/Windows/win.ini'))
    assert.notEqual(traversal.exitCode, 0, 'traversal outside the workspace must fail')

    await assert.rejects(
      async () => runBridge({ distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: ['cat', 'C:\\Windows\\win.ini'] }),
      /BRIDGE_PATH_OUTSIDE_WORKSPACE/,
    )
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('G-D read-only mode refuses hardlink creation and leaves the host tree unchanged', { skip }, async () => {
  const ws = scratch()
  try {
    const before = statSync(join(ws, 'seed.txt'))
    const r = await run('read-only', ws, sh('ln seed.txt hard2.txt'))
    assert.notEqual(r.exitCode, 0, 'read-only mode must refuse hardlink creation')
    assert.equal(existsSync(join(ws, 'hard2.txt')), false)
    assert.equal(readFileSync(join(ws, 'seed.txt'), 'utf8'), 'seed\n')
    assert.equal(statSync(join(ws, 'seed.txt')).mtimeMs, before.mtimeMs)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('G-E argv with wsl.exe substitution forms is refused before bwrap starts', { skip }, async () => {
  const ws = scratch()
  try {
    // Observed on this host before the guard: `wsl.exe -d Ubuntu -- sh -c 'echo literal RC=$?'`
    // printed `literal RC=0` and `$0` was `/bin/bash`, i.e. the joined argv was expanded by
    // the distro's default shell outside bwrap (WSL login env, /mnt and network included).
    for (const argv of [sh('echo $HOME'), sh('echo `id`'), sh('echo $(id)'), sh('echo $((1+1))')]) {
      await assert.rejects(async () => runBridge({ distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv }),
        /BRIDGE_UNSAFE_ARGV/)
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('G-G literal metacharacters cannot inject outside bwrap', { skip }, async () => {
  const ws = scratch()
  const marker = '/tmp/r5_inject_probe'
  try {
    // Under the legacy separator this argv became "echo A;touch <marker>" in the distro
    // shell and created the file *outside* bwrap (observed on this host). With --exec the
    // same vector is one literal argument; the probe must therefore find no file. The
    // check runs with a plain `wsl.exe --exec` (outside the sandbox), because /tmp inside
    // bwrap is a tmpfs and would hide an injection that happened on the distro side.
    spawnSync('wsl.exe', ['-d', DISTRO, '--exec', '/bin/rm', '-f', marker], { encoding: 'utf8' })
    const r = await run('read-only', ws, ['/bin/echo', 'A;touch', marker])
    assert.equal(r.exitCode, 0, r.stderr)
    assert.match(String(r.stdout), /A;touch \/tmp\/r5_inject_probe/)
    const probe = spawnSync('wsl.exe', ['-d', DISTRO, '--exec', '/bin/ls', marker], { encoding: 'utf8' })
    assert.notEqual(probe.status, 0, 'a literal argv must not create a file in the distro')
  } finally {
    spawnSync('wsl.exe', ['-d', DISTRO, '--exec', '/bin/rm', '-f', marker], { encoding: 'utf8' })
    rmSync(ws, { recursive: true, force: true })
  }
})

test('G-H option-shaped env values cannot shift bwrap flags', { skip }, async () => {
  const ws = scratch()
  try {
    // If the transport re-split an environment value on spaces, the trailing
    // "--chdir /" would become a bwrap option and the guest cwd would change.
    const shifted = await runBridge({
      distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: sh('pwd'), env: { R5P: 'a --chdir /' },
    })
    assert.equal(shifted.exitCode, 0, shifted.stderr)
    assert.equal(String(shifted.stdout).trim(), '/srv', 'an env value must not become a bwrap option')

    // A newline inside an environment value is refused before any spawn: an env value is its own
    // argv word, so it gets the same guard as guest argv instead of being trusted.
    const LF = String.fromCharCode(10)
    await assert.rejects(
      Promise.resolve().then(() => runBridge({
        distro: DISTRO, mode: 'read-only', workspaceRoot: ws, argv: sh('true'), env: { R5P: 'a' + LF + 'b' },
      })),
      /BRIDGE_UNSAFE_ARGV/)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('G-F plain argv reaches the guest intact', { skip }, async () => {
  const ws = scratch()
  try {
    const r = await run('read-only', ws, sh('printf "[%s]" "a b;c"'))
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(String(r.stdout), '[a b;c]')
    const exit7 = await run('read-only', ws, sh('exit 7'))
    assert.equal(exit7.exitCode, 7)
    assert.equal(exit7.trailer?.kind, 'exit')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
