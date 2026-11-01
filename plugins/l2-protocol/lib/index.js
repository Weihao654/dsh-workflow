// Plugin entry: one global row, no services, ten tools plus the settings API.
//
// Why a single global row in P0: ctx.storageDomain rejects a second open() for
// the same domain name, so per-preset copies cannot each own state. Registering
// once and checking the caller's role in code keeps the instance singular. P1
// splits registration into per-preset rows after §10.B/C are verified.
//
// Second job: role → model routing (see role-models.js). It is a host-side
// `agent/request` listener, so it works for every agent the chain spawns without
// touching any preset.
//
// Third job: the HTTP table API behind the settings card (see api.js). Its write
// path is the same saveRoleModels() the `chain_role_models` tool calls.

import { registerTools } from './tools.js'
import { installRouting } from './role-models.js'
import { registerApi } from './api.js'

export const name = 'role-chain-protocol'

// The tools service must exist before we can register anything. `sessions`,
// `webServer` and `llm` are read opportunistically (ctx.get) so routing and the
// settings card degrade to no-ops rather than hanging on a missing service.
export const inject = ['tools']

export function apply(ctx) {
  const routing = installRouting(ctx)
  const dispose = registerTools(ctx, { tracker: routing.tracker })
  const api = registerApi(ctx, { tracker: routing.tracker })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const candidate of [dispose, routing.dispose, api.dispose]) {
        try {
          candidate()
        } catch {
          // best effort on unload
        }
      }
    })
  }

  try {
    const where = api.registered ? `；设置页 API ${api.path}` : '；设置页 API 未注册（没有 webServer）'
    ctx.logger?.info?.(`[role-chain] 10 个 chain_* 工具已注册；角色→模型路由已监听 agent/request${where}`)
  } catch {
    // logging is optional
  }
}
