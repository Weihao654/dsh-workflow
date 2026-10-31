// Plugin entry: one global row, no services, nine tools.
//
// Why a single global row in P0: ctx.storageDomain rejects a second open() for
// the same domain name, so per-preset copies cannot each own state. Registering
// once and checking the caller's role in code keeps the instance singular. P1
// splits registration into per-preset rows after §10.B/C are verified.

import { registerTools } from './tools.js'

export const name = 'role-chain-protocol'

// The tools service must exist before we can register anything.
export const inject = ['tools']

export function apply(ctx) {
  const dispose = registerTools(ctx)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        dispose()
      } catch {
        // best effort on unload
      }
    })
  }

  try {
    ctx.logger?.info?.('[role-chain] 9 个 chain_* 工具已注册')
  } catch {
    // logging is optional
  }
}
