import { registerTools } from './tools.js'
import { installRouting } from './role-models.js'
import { installUsage } from './usage.js'
import { registerApi } from './api.js'
import { ChainController } from './controller.js'
export const name = 'role-chain-protocol'
export const inject = ['tools']
function say(ctx, text) { try { ctx.logger?.info?.(`[role-chain] ${text}`) } catch {} }
export function apply(ctx) {
  const controller = new ChainController(ctx)
  const routing = installRouting(ctx)
  const usageDispose = installUsage(ctx, controller)
  const toolsDispose = registerTools(ctx, { tracker: routing.tracker, controller })
  controller.install()
  if (typeof ctx.effect === 'function') ctx.effect(() => async () => {
    // Durable stop precedes signal and resource/controller release on a normal unload.
    await controller.dispose()
    toolsDispose(); usageDispose(); routing.dispose()
  })
  say(ctx, '14 chain tools registered; controlled stop/Windows compute/fixed T0 deadline/request usage ledger enabled. Historical v15 is not adopted.')
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], child => {
    const api = registerApi(child, { tracker: routing.tracker })
    if (typeof child.effect === 'function') child.effect(() => () => api.dispose())
    say(child, api.registered ? `Settings API ${api.path}` : 'Settings API unavailable')
  })
}
