// Deterministic tests for the WSL/bwrap bridge translation layer.
// These never start WSL, never touch the network, and never call a model.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toWslPath, isInside, translateArg, translateArgv, buildBwrapArgs, buildWslArgs, parseTrailer, exitCodeOf,
  stripWslNoise, WORKSPACE_MOUNT, childEnv,
} from '../bridge/wsl-bwrap.mjs'

const WS = 'C:\\Users\\Weihao Chen\\Desktop\\DSH\\r4h-20261103T1933\\work'

test('toWslPath maps drive paths and rejects UNC/relative', () => {
  assert.equal(toWslPath('C:\\Users\\X\\work'), '/mnt/c/Users/X/work')
  assert.equal(toWslPath('D:/data/ws/'), '/mnt/d/data/ws')
  assert.throws(() => toWslPath('\\\\server\\share'), /BRIDGE_UNC_UNSUPPORTED/)
  assert.throws(() => toWslPath('relative\\path'), /BRIDGE_ABSOLUTE_REQUIRED/)
  assert.throws(() => toWslPath(''), /BRIDGE_BAD_PATH/)
})

test('isInside is case-insensitive and boundary-aware', () => {
  assert.equal(isInside(WS, WS + '\\src\\sum.mjs'), true)
  assert.equal(isInside(WS, WS.replace(/\\work$/, '\\work2\\x')), false)
  assert.equal(isInside(WS, 'C:\\Windows\\System32\\cmd.exe'), false)
})

test('translateArg maps workspace paths to /srv and refuses outside paths', () => {
  assert.equal(translateArg(WS + '\\src\\sum.mjs', WS), '/srv/src/sum.mjs')
  assert.equal(translateArg(WS, WS), '/srv')
  assert.equal(translateArg('--flag', WS), '--flag')
  assert.throws(() => translateArg('C:\\Windows\\System32\\cmd.exe', WS), /BRIDGE_PATH_OUTSIDE_WORKSPACE/)
  assert.throws(() => translateArg('D:\\other\\x', WS), /BRIDGE_PATH_OUTSIDE_WORKSPACE/)
  // Dot-dot segments must not smuggle a path past the prefix test.
  assert.throws(() => translateArg(WS + '\\..\\..\\usr\\bin\\perl', WS), /BRIDGE_PATH_OUTSIDE_WORKSPACE/)
})

test('translateArgv keeps workspace executables inside /srv and rejects Windows system binaries', () => {
  const mapped = translateArgv([WS + '\\node_modules\\.bin\\run.mjs', WS + '\\src\\a.json'], WS)
  assert.equal(mapped[0], '/srv/node_modules/.bin/run.mjs')
  assert.equal(mapped[1], '/srv/src/a.json')

  assert.equal(translateArgv(['node', '--test'], WS)[0], '/usr/bin/node')
  assert.throws(() => translateArgv(['C:\\Windows\\System32\\cmd.exe'], WS), /BRIDGE_(BAD_EXECUTABLE|WINDOWS_BINARY)/)
  assert.throws(() => translateArgv(['powershell.exe'], WS), /BRIDGE_(BAD_EXECUTABLE|WINDOWS_BINARY)/)
  assert.throws(() => translateArgv(['tool.exe'], WS), /BRIDGE_WINDOWS_BINARY/)
  assert.throws(() => translateArgv([], WS), /BRIDGE_BAD_ARGV/)
})

test('buildBwrapArgs hides /mnt and /run, binds the workspace at /srv, and keeps mode flags distinct', () => {
  const ro = buildBwrapArgs({ mode: 'read-only', workspaceRoot: WS, argv: ['node', '--test'] })
  const rw = buildBwrapArgs({ mode: 'workspace-write', workspaceRoot: WS, argv: ['node', '--test'] })
  assert.ok(ro.includes('--unshare-all'))
  assert.ok(ro.includes('--die-with-parent'))
  assert.ok(ro.includes('--clearenv'))
  assert.ok(ro.includes('--ro-bind'))

  const tmpfs = (args, path) => args.some((v, i) => v === '--tmpfs' && args[i + 1] === path)
  assert.ok(tmpfs(ro, '/mnt'), '/mnt must be hidden behind a tmpfs')
  assert.ok(tmpfs(ro, '/run'), '/run must be hidden to block WSL interop')
  assert.ok(!ro.includes('/mnt/c'), 'no /mnt/c access may remain')

  const srvBind = (args, flag) => args.some((v, i) => v === flag && args[i + 2] === WORKSPACE_MOUNT)
  assert.ok(srvBind(ro, '--ro-bind'), 'read-only run must bind the workspace read-only')
  assert.ok(srvBind(rw, '--bind'), 'workspace-write run must bind the workspace read-write')
  assert.equal(ro[ro.indexOf('--') + 1], '/usr/bin/node')
  assert.throws(() => buildBwrapArgs({ mode: 'read-write', workspaceRoot: WS, argv: ['node'] }), /BRIDGE_BAD_MODE/)
  assert.throws(
    () => buildBwrapArgs({ mode: 'read-only', workspaceRoot: WS, argv: ['node'], env: { 'BAD KEY': 'x' } }),
    /BRIDGE_BAD_ENV/,
  )
})

test('stripWslNoise drops the WSL localhost-proxy notice and keeps real child output', () => {
  const nulSpaced = 'w\u0000s\u0000l\u0000:\u0000 \u0000检\u0000测\u0000到\u0000 l\u0000o\u0000c\u0000a\u0000l\u0000h\u0000o\u0000s\u0000t'
  const spaced = 'w s l :  检 测 到 l o c a l h o s t 代 理 配 置'
  const text = [
    nulSpaced,
    spaced,
    'wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。',
    'touch: cannot touch \'/etc/x\': Read-only file system',
    'BRIDGE_EXIT child=0 signal=0 at=2026-11-03T00:00:00Z',
  ].join('\n')
  const kept = stripWslNoise(text).split('\n')
  assert.equal(kept.length, 2)
  assert.match(kept[0], /Read-only file system/)
  assert.match(kept[1], /^BRIDGE_EXIT /)
  assert.equal(stripWslNoise(''), '')
})

test('trailer parsing distinguishes exit, runner failure and unknown', () => {
  const ok = parseTrailer('noise\nBRIDGE_EXIT child=0 signal=0 at=2026-11-03T00:00:00Z\n')
  assert.deepEqual(ok, { kind: 'exit', child: 0, signal: 0, at: '2026-11-03T00:00:00Z' })
  assert.equal(exitCodeOf(ok), 0)

  const killed = parseTrailer('BRIDGE_EXIT child=0 signal=9 at=t')
  assert.equal(exitCodeOf(killed), 137)

  const failed = parseTrailer('BRIDGE_FAIL reason=bwrap-missing at=t')
  assert.deepEqual(failed, { kind: 'fail', reason: 'bwrap-missing', at: 't' })
  assert.equal(exitCodeOf(failed), null)

  assert.deepEqual(parseTrailer('nothing structured'), { kind: 'unknown' })
  assert.equal(exitCodeOf({ kind: 'unknown' }), null)

  const last = parseTrailer('BRIDGE_EXIT child=1 signal=0 at=a\nBRIDGE_EXIT child=0 signal=0 at=b\n')
  assert.equal(last.at, 'b')
})
test('launcher environment strips provider credentials before any child process', () => {
  const env = childEnv({ PATH: 'C:\\Windows', DEEPSEEK_API_KEY: 'secret', MY_TOKEN: 'x', PASSWORD: 'y', HOME: 'C:\\Users\\X' })
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.MY_TOKEN, undefined)
  assert.equal(env.PASSWORD, undefined)
  assert.equal(env.PATH, 'C:\\Windows')
  assert.equal(env.HOME, 'C:\\Users\\X')
})
test('wsl.exe is invoked with --exec so argv reaches bwrap without a shell', () => {
  const wsl = buildWslArgs({ distro: 'Ubuntu', mode: 'read-only', workspaceRoot: WS, argv: ['sh', '-c', 'printf A2_OK; exit 0'] })
  assert.deepEqual(wsl.slice(0, 4), ['-d', 'Ubuntu', '--exec', '/usr/bin/bwrap'])
  assert.equal(wsl.at(-1), 'printf A2_OK; exit 0')
})

test('metacharacters are literal guest argv now that no shell re-parses them', () => {
  // Under the legacy separator these bytes were interpreted by the distro shell outside
  // bwrap (probes created files); --exec passes them through untouched.
  const argv = ['/bin/echo', 'A;touch /tmp/x', 'a|b', 'c&&d', 'e>f', 'g"h']
  const args = buildBwrapArgs({ mode: 'read-only', workspaceRoot: WS, argv })
  assert.deepEqual(args.slice(-6), argv)
})

test('the guard refuses substitution forms before any spawn (guard check)', () => {
  // This asserts our own refusal rule, not wsl.exe behaviour. Substitution under --exec is
  // unproven: a 25-shape argv dump on wsl.exe 3.0.3.0 showed no expansion, an earlier
  // one-off probe suggested otherwise. The guard therefore refuses $, backticks, CR/LF and
  // NUL as deliberate over-rejection. Live transport evidence: test/guest-boundaries.mjs.
  const ok = buildBwrapArgs({ mode: 'read-only', workspaceRoot: WS, argv: ['sh', '-c', 'printf A2_OK; exit 0'] })
  assert.equal(ok[ok.length - 1], 'printf A2_OK; exit 0')
  for (const bad of [['sh', '-c', 'echo $HOME'], ['sh', '-c', 'echo `id`'], ['sh', '-c', 'echo ${PATH}'],
    ['sh', '-c', 'echo $(id)'], ['sh', '-c', 'echo a' + String.fromCharCode(10) + 'b'],
    ['sh', '-c', 'echo a' + String.fromCharCode(0) + 'b']]) {
    assert.throws(() => buildBwrapArgs({ mode: 'read-only', workspaceRoot: WS, argv: bad }), /BRIDGE_UNSAFE_ARGV/)
  }
  // Non-string arguments are stringified by translateArg first, so 7 becomes '7' and passes;
  // the guard only has to stop expansion, not type errors.
  assert.equal(buildBwrapArgs({ mode: 'read-only', workspaceRoot: WS, argv: ['sh', '-c', 7] }).at(-1), '7')
})
