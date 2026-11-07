// WSL/bwrap bridge for the controlled-compute path (B1 design, step 2 material).
//
// Purpose: translate a Windows-side confinement request into a bwrap invocation
// inside a dedicated WSL distro, and keep the exit/termination bookkeeping honest.
//
// Hardened layout (validated by direct probes, see test/bridge-live.mjs):
//   * the whole Linux root is read-only (`--ro-bind / /`),
//   * the workspace is re-bound at `/srv` (read-only for read-only mode),
//   * `/mnt` is replaced by an empty tmpfs so no Windows drive is reachable,
//   * `/run` is replaced by an empty tmpfs, which removes the AF_UNIX socket the
//     WSL interop helper needs, so a Windows PE placed in the workspace cannot
//     re-enter Windows (verified: exec fails with `UtilConnectUnix: connect failed`),
//   * `/tmp` and `/root` are tmpfs, `/proc` and `/dev` are fresh, one pid/net/ipc
//     namespace via `--unshare-all`, `--die-with-parent` kills descendants.
//
// Windows path arguments are translated into `/srv/...`; any Windows path outside
// the workspace is refused rather than silently exposed through `/mnt`.
//
// This module is prepared but NOT active: nothing here runs unless a profile
// explicitly adds it as `sandbox-local.runnerCommand`. It never claims that
// isolation holds; `full` remains an operator assertion that must be proven by
// the denial matrix (see _reports/B1-WSL-BWRAP-PLAN-20261103.md).
//
// Pure helpers are exported for deterministic tests (test/bridge.mjs).

import { spawn } from 'node:child_process'

/** Executables allowed to run inside the distro, by basename. */
export const EXEC_ALLOWLIST = new Map([
  ['node', '/usr/bin/node'],
  ['nodejs', '/usr/bin/node'],
  ['npm', '/usr/bin/npm'],
  ['npx', '/usr/bin/npx'],
  ['git', '/usr/bin/git'],
  ['sh', '/bin/sh'],
  ['bash', '/bin/bash'],
  ['dash', '/bin/dash'],
  ['python3', '/usr/bin/python3'],
  ['cat', '/bin/cat'],
  ['ls', '/bin/ls'],
  ['pwd', '/bin/pwd'],
  ['true', '/bin/true'],
  ['false', '/bin/false'],
  ['echo', '/bin/echo'],
  ['sleep', '/bin/sleep'],
  ['env', '/usr/bin/env'],
  ['make', '/usr/bin/make'],
])

/** Collapse "." and ".." segments of an absolute Windows path before any containment check. */
function normalizeWinPath(value) {
  const drive = value.slice(0, 2)
  const out = []
  for (const seg of value.slice(2).split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return drive + '/' + out.join('/')
}

/** Windows workspace path -> distro path under /mnt/<drive> (bind source only). */
export function toWslPath(winPath) {
  if (typeof winPath !== 'string' || !winPath) throw new Error('BRIDGE_BAD_PATH')
  if (winPath.startsWith('\\\\') || winPath.startsWith('//')) throw new Error('BRIDGE_UNC_UNSUPPORTED')
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) throw new Error('BRIDGE_ABSOLUTE_REQUIRED')
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '')
  return '/mnt/' + m[1].toLowerCase() + '/' + rest
}

/** True when `p` is inside `root` (both Windows paths, case-insensitive). */
export function isInside(root, p) {
  const norm = s => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const r = norm(root), q = norm(p)
  return q === r || q.startsWith(r + '\\')
}

/** Workspace-relative part of a Windows path, with forward slashes. */
function relativeInside(workspaceRoot, winPath) {
  const rel = winPath.slice(workspaceRoot.replace(/[\\/]+$/, '').length)
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/')
  return rel
}

/** Where the workspace appears inside the confinement. */
export const WORKSPACE_MOUNT = '/srv'

/**
 * Map one argument onto the confined filesystem.
 * - Windows path inside the workspace -> /srv/<relative>
 * - Windows path outside the workspace -> refused (it is not mounted at all)
 * - anything else -> passed through untouched
 */
export function translateArg(arg, workspaceRoot) {
  const raw = String(arg)
  if (!/^[A-Za-z]:[\\/]/.test(raw)) return raw
  // "C:/ws/../..//usr/bin/perl" would otherwise pass the prefix test and land outside /srv.
  const value = normalizeWinPath(raw)
  if (!isInside(workspaceRoot, value)) throw new Error('BRIDGE_PATH_OUTSIDE_WORKSPACE')
  const rel = relativeInside(workspaceRoot, value)
  return rel ? WORKSPACE_MOUNT + '/' + rel : WORKSPACE_MOUNT
}

/**
 * Map the requested argv onto distro paths.
 * - executable inside the workspace -> /srv/<relative>
 * - executable basename allowlisted -> fixed distro binary
 * - anything else -> reject (never execute Windows binaries)
 */
export function translateArgv(argv, workspaceRoot) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('BRIDGE_BAD_ARGV')
  const [exe, ...rest] = argv
  const normalizedExe = typeof exe === 'string' && /^[A-Za-z]:[\\/]/.test(exe) ? normalizeWinPath(exe) : exe
  let mapped
  if (typeof normalizedExe === 'string' && /^[A-Za-z]:[\\/]/.test(normalizedExe) && isInside(workspaceRoot, normalizedExe)) {
    const rel = relativeInside(workspaceRoot, normalizedExe)
    if (!rel) throw new Error('BRIDGE_BAD_EXECUTABLE')
    mapped = WORKSPACE_MOUNT + '/' + rel
  } else {
    const base = String(exe ?? '').split(/[\\/]/).pop().toLowerCase()
    // Windows binaries are refused by name when they sit outside the workspace. A PE that lives
    // inside the workspace is deliberately passed through, so the guest can demonstrate that it
    // cannot re-enter Windows (test/bridge-live.mjs R-E); refusing it here would erase that
    // evidence without adding isolation.
    if (/\.(exe|bat|cmd|ps1|vbs|msi)$/i.test(String(exe ?? ''))) throw new Error('BRIDGE_WINDOWS_BINARY')
    mapped = EXEC_ALLOWLIST.get(base)
    if (!mapped) throw new Error('BRIDGE_BAD_EXECUTABLE')
  }
  return [mapped, ...rest.map((arg) => translateArg(arg, workspaceRoot))]
}

/**
 * Reject argv elements that wsl.exe would expand or re-parse before bwrap starts.
 *
 * History: the bridge used wsl.exe -d <distro> -- <argv...>, which joins the arguments and
 * runs the joined line through the distro's default shell. Probes on this host showed that
 * ; | && inside space-free arguments executed commands *outside* bwrap (marker files were
 * created) and that sh -c 'echo literal RC=$?' arrived as 'literal RC=0'. .19 switched to
 * wsl.exe --exec, which passes the vector through without a shell (verified: the same
 * metacharacter argv prints literally and creates nothing).
 *
 * Substitution under --exec is UNPROVEN, not observed: wsl.exe 3.0.3.0 passed a 25-shape
 * argv dump ($HOME, $(id), backticks, ;|&&><*?, quotes, backslashes, TAB/LF/CR/NUL, empty,
 * leading -d) through byte-identically, while an earlier one-off probe seemed to show
 * substitution. Because the behaviour cannot be proven stable (and older/inbox WSL builds
 * were never tested), those forms plus CR/LF and NUL stay refused. That is deliberate
 * over-rejection: a legitimate argument containing $ or a backtick is refused rather than
 * being claimed as contained.
 */
export const UNSAFE_ARGV_CHARS = /[$\u0060\u0000]/

export function assertSafeArgv(argv) {
  for (const a of argv) {
    if (typeof a !== 'string') throw new Error('BRIDGE_UNSAFE_ARGV')
    if (UNSAFE_ARGV_CHARS.test(a) || /[\r\n]/.test(a)) {
      // Kept as a bare code: runner.mjs writes BRIDGE_FAIL reason=<token> and the host
      // classifies by the first token, so the reason must stay a single word.
      throw new Error('BRIDGE_UNSAFE_ARGV')
    }
  }
}

/** Distro names go straight into the wsl.exe vector; refuse anything shell-shaped. */
export const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Build the wsl.exe argument vector for one run.
 *
 * --exec instead of --: see the note above UNSAFE_ARGV_CHARS. Quotes and shell
 * metacharacters are literal guest argv now; only the wsl.exe substitutions stay refused.
 */
export function buildWslArgs({ distro, mode, workspaceRoot, argv, env, guestArgs }) {
  if (typeof distro !== 'string' || !DISTRO_PATTERN.test(distro)) throw new Error('BRIDGE_BAD_DISTRO')
  const payload = guestArgs ?? buildBwrapArgs({ mode, workspaceRoot, argv, env })
  // guestArgs is a public parameter: assert the part that becomes the guest command even
  // when the caller prebuilt the bwrap vector, so no path can skip the substitution guard.
  // Validate the guest command even when the caller prebuilt the vector. If there is no
  // separator, validate the whole payload: a prebuilt vector without '--' has no guest
  // command, so nothing in it may carry a substitution form either.
  // Guard EVERY element, not just the guest slice after the first '--': a prebuilt vector can
  // also carry a substitution form in an option value (or in an env value, which becomes
  // '--setenv KEY VALUE' before the separator). Over-rejecting is the accepted side here.
  assertSafeArgv(payload)
  return ['-d', distro, '--exec', '/usr/bin/bwrap', ...payload]
}

/** Build the bwrap argv for a read-only or workspace-write run. */
export function buildBwrapArgs({ mode, workspaceRoot, argv, env = {} }) {
  if (mode !== 'read-only' && mode !== 'workspace-write') throw new Error('BRIDGE_BAD_MODE')
  const args = [
    '--ro-bind', '/', '/',
    // Bind the workspace before /mnt is hidden; the source path must stay
    // reachable at bind time.
    mode === 'read-only' ? '--ro-bind' : '--bind',
    toWslPath(workspaceRoot), WORKSPACE_MOUNT,
    '--tmpfs', '/mnt',
    '--tmpfs', '/run',
    '--tmpfs', '/tmp',
    '--tmpfs', '/root',
    '--proc', '/proc',
    '--dev', '/dev',
    '--chdir', WORKSPACE_MOUNT,
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
  ]
  const passEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    ...env,
  }
  for (const [k, v] of Object.entries(passEnv)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) throw new Error('BRIDGE_BAD_ENV')
    // Values become their own argv words ('--setenv KEY VALUE'), so they get the same refusal
    // as guest argv instead of being trusted because they are "only" environment variables.
    assertSafeArgv([String(v)])
    args.push('--setenv', k, String(v))
  }
  const guestArgv = translateArgv(argv, workspaceRoot)
  assertSafeArgv(guestArgv)
  args.push('--', ...guestArgv)
  return args
}

/** Parse the structured trailer the runner writes after the child ends. */
export function parseTrailer(stderr) {
  const text = String(stderr ?? '')
  const last = (re) => {
    let found = null
    for (const m of text.matchAll(re)) found = m
    return found
  }
  const exit = last(/^BRIDGE_EXIT child=(-?\d+) signal=(\d+) at=(\S+)$/gm)
  if (exit) return { kind: 'exit', child: Number(exit[1]), signal: Number(exit[2]), at: exit[3] }
  const fail = last(/^BRIDGE_FAIL reason=(\S+) at=(\S+)$/gm)
  if (fail) return { kind: 'fail', reason: fail[1], at: fail[2] }
  return { kind: 'unknown' }
}

/** Exit code the bridge should expose, or null when the outcome is unknown. */
export function exitCodeOf(trailer) {
  if (trailer.kind !== 'exit') return null
  if (trailer.signal !== 0) return 128 + trailer.signal
  return trailer.child
}

/**
 * Drop WSL's own localhost-proxy notice. It is emitted on every invocation and,
 * under Windows output redirection, arrives mis-decoded as spaced characters;
 * it is noise, never a child message, and must not look like a denial.
 */
export function stripWslNoise(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      // WSL emits UTF-16 bytes; mis-decoded they contain NUL separators.
      const compact = line.replace(/[\s\u0000]/g, '')
      if (!compact) return false
      if (/localhost/i.test(compact)) return false
      if (/^wsl[:：]/i.test(compact)) return false
      return true
    })
    .map((line) => line.replace(/^[\s\u0000]+|[\s\u0000]+$/g, ''))
    .filter((line) => line.length > 0)
    .join('\n')
}

/** Denial signatures that mean the confinement refused something, not a crash. */
export const DENIAL_SIGNATURES = [
  'Read-only file system',
  'Permission denied',
  'UtilConnectUnix',
  'UtilGetPpid',
]

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i

/** Strip provider credentials from the environment of the Windows-side launcher. */
export function childEnv(source = process.env) {
  const out = {}
  for (const [key, value] of Object.entries(source)) if (!SECRET_ENV.test(key)) out[key] = value
  return out
}

/**
 * Run one command. Returns {ok, exitCode, trailer, stderr, stdout}.
 * `unknown` outcomes deliberately return exitCode null: callers must not treat
 * a crashed or unparsed run as success.
 */
export async function runBridge({ distro, mode, workspaceRoot, argv, env = {}, timeoutMs = 0, signal }) {
  const args = buildWslArgs({ distro, mode, workspaceRoot, argv, env })
  return await new Promise((resolve) => {
    const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    let stdout = '', stderr = ''
    const timer = timeoutMs > 0 ? setTimeout(() => { try { child.kill() } catch {} }, timeoutMs) : null
    const onAbort = () => { try { child.kill() } catch {} }
    if (signal) signal.addEventListener?.('abort', onAbort, { once: true })
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', () => {
      if (timer) clearTimeout(timer)
      resolve({ ok: false, exitCode: null, trailer: { kind: 'unknown' }, stderr, stdout })
    })
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
      stderr += `\nBRIDGE_EXIT child=${code ?? 124} signal=${sig ?? 0} at=${new Date().toISOString()}\n`
      const trailer = parseTrailer(stderr)
      resolve({
        ok: exitCodeOf(trailer) === 0,
        exitCode: exitCodeOf(trailer),
        trailer,
        stderr,
        stdout,
        denied: DENIAL_SIGNATURES.some((s) => stderr.includes(s)),
      })
    })
  })
}