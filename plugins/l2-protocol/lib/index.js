import { registerTools } from './tools.js'
import { installRouting } from './role-models.js'
import { installUsage } from './usage.js'
import { registerApi, registerPlanStartApi } from './api.js'
import { ChainController } from './controller.js'
import { resolveProfileDir } from './profile-dir.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'role-chain-protocol'
export const inject = ['tools']
function say(ctx, text) { try { ctx.logger?.info?.(`[role-chain] ${text}`) } catch {} }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')) }
export function apply(ctx) {
  // The launcher's profile path stays authoritative; an installed copy on a desktop
  // Host (which exports no DSH_PROFILE_DIR) derives the profile from its own module
  // location. Anything else fails closed instead of guessing a ledger location.
  const { dir: profileDir, source } = resolveProfileDir({
    envDir: process.env.DSH_PROFILE_DIR,
    moduleUrl: import.meta.url,
    exists: existsSync,
    readJson,
  })
  const controller = new ChainController(ctx, { authorityRoot: join(profileDir, 'role-chain-authority'), workflowByDefault: true })
  say(ctx, `authority root ${join(profileDir, 'role-chain-authority')} (profile dir from ${source})`)
  say(ctx, 'Default plan uses native collaboration without enrollment or plugin budget gates; existing controlled grants retain their original limits.')
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
    const planStart = registerPlanStartApi(child, controller)
    if (typeof child.effect === 'function') child.effect(() => () => { planStart.dispose(); api.dispose() })
    say(child, api.registered ? `Settings API ${api.path}` : 'Settings API unavailable')
    say(child, planStart.registered ? `Plan startup status API ${planStart.path}` : 'Plan startup status API unavailable')
  })
}
