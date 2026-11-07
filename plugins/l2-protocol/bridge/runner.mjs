// WSL/bwrap runner executable for `@deepseek-ai/dsh-sandbox-local` `runnerCommand`.
//
// The provider appends the bwrap-compatible profile and the caller argv, so this
// script receives:
//
//   node runner.mjs --distro <name> [--workspace <win-path>] <profile args...> -- <command argv...>
//
// It rebuilds a hardened bwrap invocation (workspace at /srv, /mnt and /run
// hidden) from `bridge/wsl-bwrap.mjs`, reports the child's real exit status in a
// structured trailer, and never reports success when that status is unknown.

import { argv as processArgv } from 'node:process'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import {
  buildBwrapArgs,
  buildWslArgs,
  stripWslNoise,
} from './wsl-bwrap.mjs'

export const TRAILER_EXIT = /^BRIDGE_EXIT child=(-?\d+) signal=(\d+) at=(\S+)$/gm
export const TRAILER_FAIL = /^BRIDGE_FAIL reason=(\S+) at=(\S+)$/gm

const WINDOWS_BIND = /^[A-Za-z]:[\\/]/

/** Split argv into `{distro, workspace, profile, command}`. */
export function splitInvocation(args) {
  const rest = [...args]
  let distro = process.env.DSH_BRIDGE_DISTRO ?? 'Ubuntu'
  let workspace = process.env.DSH_BRIDGE_WORKSPACE ?? null
  while (rest.length > 0 && rest[0].startsWith('--')) {
    const flag = rest[0]
    if (flag === '--distro') {
      rest.shift()
      const value = rest.shift()
      if (!value) throw new Error('BRIDGE_BAD_DISTRO')
      distro = value
    } else if (flag === '--workspace') {
      rest.shift()
      const value = rest.shift()
      if (!value) throw new Error('BRIDGE_BAD_WORKSPACE')
      workspace = value
    } else {
      break
    }
  }
  const sep = rest.indexOf('--')
  if (sep < 0) throw new Error('BRIDGE_NO_SEPARATOR')
  const profile = rest.slice(0, sep)
  const command = rest.slice(sep + 1)
  if (command.length === 0) throw new Error('BRIDGE_NO_COMMAND')
  return { distro, workspace, profile, command }
}

/**
 * Recover the workspace bind the provider emitted (`--bind <ws> <ws>` for
 * workspace-write) and decide the mode.
 */
export function workspaceBinding(profile) {
  for (let i = 0; i < profile.length; i += 1) {
    if (profile[i] !== '--bind' && profile[i] !== '--rbind') continue
    const src = profile[i + 1]
    const dst = profile[i + 2]
    if (typeof src !== 'string' || typeof dst !== 'string') throw new Error('BRIDGE_BAD_BIND')
    if (!WINDOWS_BIND.test(src)) throw new Error('BRIDGE_BAD_BIND')
    return src
  }
  return null
}

/** Decide mode + workspace from the provider profile and our own option. */
export function resolveTarget({ workspace, profile }) {
  const bound = workspaceBinding(profile)
  if (bound !== null) {
    if (workspace !== null && workspace.toLowerCase() !== bound.toLowerCase()) {
      throw new Error('BRIDGE_WORKSPACE_MISMATCH')
    }
    return { mode: 'workspace-write', workspaceRoot: bound }
  }
  if (workspace === null) throw new Error('BRIDGE_WORKSPACE_REQUIRED_FOR_READ_ONLY')
  return { mode: 'read-only', workspaceRoot: workspace }
}

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i

/**
 * Environment for the Windows-side launcher. The guest already runs with `--clearenv`,
 * so inherited provider credentials must not reach even the `wsl.exe` launcher.
 */
export function childEnv(source = process.env) {
  const out = {}
  for (const [key, value] of Object.entries(source)) if (!SECRET_ENV.test(key)) out[key] = value
  return out
}

/** Spawn bwrap inside the distro and forward output. */
export function runConfined({ distro, guestArgs, stdio = ['ignore', 'inherit', 'pipe'], onStderr, signal }) {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', buildWslArgs({ distro, guestArgs }), {
      windowsHide: true,
      stdio,
      env: childEnv(),
    })
    let stderr = ''
    const forward = (chunk) => {
      stderr += chunk.toString()
      if (onStderr) onStderr(chunk)
    }
    child.stderr?.on('data', forward)
    const kill = () => { try { child.kill('SIGTERM') } catch { /* gone */ } }
    if (signal) signal.addEventListener?.('abort', kill, { once: true })
    child.on('error', (error) => {
      if (signal) signal.removeEventListener?.('abort', kill)
      resolve({ code: null, signal: null, stderr, error })
    })
    child.on('close', (code, sig) => {
      if (signal) signal.removeEventListener?.('abort', kill)
      resolve({ code, signal: sig, stderr, error: null })
    })
  })
}

async function main() {
  const { distro, workspace, profile, command } = splitInvocation(processArgv.slice(2))
  const { mode, workspaceRoot } = resolveTarget({ workspace, profile })
  const guestArgs = buildBwrapArgs({ mode, workspaceRoot, argv: command })
  const result = await runConfined({
    distro,
    guestArgs,
    stdio: ['ignore', 'inherit', 'pipe'],
  })
  const at = new Date().toISOString()
  const filtered = stripWslNoise(result.stderr)
  if (filtered) process.stderr.write(filtered + '\n')
  if (result.error) {
    process.stderr.write(`BRIDGE_FAIL reason=spawn-error at=${at}\n`)
    process.exitCode = 126
    return
  }
  const signalNumber = typeof result.signal === 'number' ? result.signal : (result.signal ? 15 : 0)
  process.stderr.write(`BRIDGE_EXIT child=${result.code ?? 124} signal=${signalNumber} at=${at}\n`)
  process.exitCode = result.code === null ? 124 : (signalNumber ? 128 + signalNumber : result.code)
}

const invokedDirectly = processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`BRIDGE_FAIL reason=${error?.message ?? 'unknown'} at=${new Date().toISOString()}\n`)
    process.exitCode = 126
  })
}