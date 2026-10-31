// Plugin entry: one global row, no services, nine tools.
//
// Why a single global row in P0: ctx.storageDomain rejects a second open() for
// the same domain name, so per-preset copies cannot each own state. Registering
// once and checking the caller's role in code keeps the instance singular. P1
// splits registration into per-preset rows after §10.B/C are verified.
//
// Second job: role → model routing (see role-models.js). It is a host-side
// `agent/request` listener, so it works for every agent the chain spawns without
// touching any preset.

import { registerTools } from './tools.js'
import { installRouting } from './role-models.js'

export const name = 'role-chain-protocol'

// The tools service must exist before we can register anything. `sessions` is
// read opportunistically (ctx.get) so routing degrades to a no-op if absent.
export const inject = ['tools']

export function apply(ctx) {
  const routing = installRouting(ctx)
  const dispose = registerTools(ctx, { tracker: routing.tracker })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        dispose()
      } catch {
        // best effort on unload
      }
      try {
        routing.dispose()
      } catch {
        // best effort on unload
      }
    })
  }

  try {
    ctx.logger?.info?.('[role-chain] 10 个 chain_* 工具已注册；角色→模型路由已监听 agent/request')
  } catch {
    // logging is optional
  }
}
