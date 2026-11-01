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
//
// `webServer` is OPTIONAL, and that is not just a nicety: touching ctx.webServer
// outside an inject list throws `cannot get property "webServer" without inject`,
// which fails the whole plugin fiber. So the API waits for the service through
// ctx.inject() instead of probing it during apply(). A `dsh` without the web page
// never provides it, and then the card is simply absent.

import { registerTools } from './tools.js'
import { installRouting } from './role-models.js'
import { registerApi } from './api.js'

export const name = 'role-chain-protocol'

// The tools service must exist before we can register anything. `sessions` and
// `llm` are read through ctx.get() so routing and validation degrade to no-ops
// instead of hanging on a missing service.
export const inject = ['tools']

function say(ctx, text) {
  try {
    ctx.logger?.info?.(`[role-chain] ${text}`)
  } catch {
    // logging is optional
  }
}

export function apply(ctx) {
  const routing = installRouting(ctx)
  const dispose = registerTools(ctx, { tracker: routing.tracker })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const candidate of [dispose, routing.dispose]) {
        try {
          candidate()
        } catch {
          // best effort on unload
        }
      }
    })
  }

  say(ctx, '10 个 chain_* 工具已注册；角色→模型路由已监听 agent/request')

  if (typeof ctx.inject !== 'function') {
    say(ctx, '没有 ctx.inject，跳过设置页 API')
    return
  }

  ctx.inject(['webServer'], (child) => {
    let api
    try {
      api = registerApi(child, { tracker: routing.tracker })
    } catch (error) {
      say(child, `设置页 API 注册失败：${error?.message ?? error}`)
      return
    }
    if (typeof child.effect === 'function') child.effect(() => () => api.dispose())
    say(child, api.registered ? `设置页 API ${api.path}` : '设置页 API 未注册（webServer 不可用）')
  })
}
