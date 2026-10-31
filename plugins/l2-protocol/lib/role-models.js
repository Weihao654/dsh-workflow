// Role → model routing.
//
// The chain's four roles normally share one model, because a spawned subagent
// inherits its parent's AgentOptions. That is the wrong shape for cost: plan
// benefits from a strong model, code and review rarely do.
//
// The table lives in the project, not in the plugin: <cwd>/.dsh/role-chain.json
// travels with the repo and is editable without touching the profile. A host
// listener on `agent/request` (waterfall, runs once per step) rewrites the call
// configuration, so no preset, no YAML, and no restart is needed after an edit.
//
// Manual selection wins. The user's model picker writes a new request header;
// seeing a base config that differs from what we last applied means the human
// took over, and from then on we stay out of that session's way. This keeps the
// feature from fighting the composer.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROLES } from './roles.js'

export const CONFIG_DIR = '.dsh'
export const CONFIG_FILE = 'role-chain.json'

export function configPath(cwd) {
  return join(cwd || '.', CONFIG_DIR, CONFIG_FILE)
}

/**
 * Keep only well-formed role routes. Anything else is reported, not applied:
 * a typo must never silently route a whole role to a model that cannot answer.
 */
export function normalizeRoleModels(input) {
  const roleModels = {}
  const errors = []

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { roleModels, errors: ['roleModels 必须是对象'] }
  }

  for (const [key, value] of Object.entries(input)) {
    const role = String(key).trim().toLowerCase()
    if (!ROLES.includes(role)) {
      errors.push(`未知角色 ${key}（只认 ${ROLES.join(' / ')}）`)
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${role} 必须是 { provider, model }`)
      continue
    }
    const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
    const model = typeof value.model === 'string' ? value.model.trim() : ''
    if (!provider || !model) {
      errors.push(`${role} 缺少 provider 或 model`)
      continue
    }
    const route = { provider, model }
    if (typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()) {
      route.reasoningEffort = value.reasoningEffort.trim()
    }
    roleModels[role] = route
  }

  return { roleModels, errors }
}

const cache = new Map()

/**
 * Read the project table. Cached by mtime+size so an edit is picked up on the
 * next request without a restart, and a missing file costs one failed stat.
 */
export function loadRoutes(cwd) {
  const path = configPath(cwd)
  let stamp
  try {
    const stat = statSync(path)
    stamp = `${stat.mtimeMs}:${stat.size}`
  } catch {
    cache.delete(path)
    return { path, exists: false, enabled: false, roleModels: {}, errors: [] }
  }

  const hit = cache.get(path)
  if (hit && hit.stamp === stamp) return hit.value

  let value
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const { roleModels, errors } = normalizeRoleModels(parsed?.roleModels ?? parsed)
    value = { path, exists: true, enabled: parsed?.enabled !== false, roleModels, errors }
  } catch (error) {
    value = {
      path,
      exists: true,
      enabled: false,
      roleModels: {},
      errors: [`解析失败：${error.message}`],
    }
  }
  cache.set(path, { stamp, value })
  return value
}

/**
 * Decide what to actually send. Pure: no I/O, so the precedence rules are
 * testable without a harness.
 *
 * Rules, in order:
 *  1. a base config that differs from the last one we applied means the human
 *     picked something — that session is theirs from now on;
 *  2. no route for the role, no override;
 *  3. otherwise replay the route, dropping a stale reasoningEffort whenever the
 *     model actually changes (effort ids are model-specific).
 */
export class RouteTracker {
  constructor() {
    this.applied = new Map()
    this.manual = new Set()
  }

  isManual(sessionId) {
    return this.manual.has(sessionId)
  }

  appliedRoute(sessionId) {
    return this.applied.get(String(sessionId)) ?? null
  }

  decide(sessionId, base, route) {
    const id = String(sessionId)
    const prev = this.applied.get(id)

    if (prev && (base.provider !== prev.provider || base.model !== prev.model)) {
      this.manual.add(id)
    }
    if (this.manual.has(id)) return null
    if (!route || !route.provider || !route.model) return null

    const changedModel = base.provider !== route.provider || base.model !== route.model
    const next = { ...base, provider: route.provider, model: route.model }
    if (route.reasoningEffort) {
      next.reasoningEffort = route.reasoningEffort
    } else if (changedModel) {
      delete next.reasoningEffort
    }

    this.applied.set(id, { provider: route.provider, model: route.model })
    return next
  }
}

function headerOf(ctx, sessionId) {
  try {
    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    return sessions?.get?.(sessionId)?.header ?? null
  } catch {
    return null
  }
}

function safeCwd() {
  try {
    return process.cwd()
  } catch {
    return '.'
  }
}

/**
 * Install the `agent/request` listener. Returns a disposer and the tracker, so
 * callers (and chain_status) can read what a session is actually sending.
 */
export function installRouting(ctx) {
  const tracker = new RouteTracker()
  const logged = new Map()

  const listener = async (payload, next) => {
    const base = await next()
    try {
      const sessionId = payload?.agent?.id ? String(payload.agent.id) : ''
      if (!sessionId) return base

      const header = headerOf(ctx, sessionId)
      const preset = header?.agentPreset
      if (!ROLES.includes(preset)) return base

      const table = loadRoutes(header?.cwd ?? safeCwd())
      if (!table.exists || !table.enabled) return base

      const route = table.roleModels[preset]
      const decided = tracker.decide(sessionId, base, route)
      if (!decided) return base

      const key = `${sessionId}:${preset}:${route.provider}/${route.model}`
      if (!logged.has(key)) {
        logged.set(key, true)
        try {
          ctx.logger?.info?.(
            `[role-chain] ${preset} → ${route.provider}/${route.model}（${table.path}）`,
          )
        } catch {
          // logging is optional
        }
      }
      return decided
    } catch {
      // A routing failure must never break the step.
      return base
    }
  }

  let dispose = () => {}
  try {
    const ret = ctx.on('agent/request', listener)
    if (typeof ret === 'function') dispose = ret
  } catch {
    // No event bus (host-free tests): routing stays inert.
  }

  return { dispose, tracker }
}

/**
 * What `chain_status` reports: the table on disk plus this session's reality.
 */
export function describeRoutes(ctx, exec, tracker) {
  const table = loadRoutes(exec?.cwd ?? safeCwd())
  const applied = tracker?.appliedRoute?.(exec?.sessionId) ?? null
  return {
    configPath: table.path,
    exists: table.exists,
    enabled: table.enabled,
    roles: table.roleModels,
    errors: table.errors,
    thisSession: {
      role: exec?.role ?? null,
      applied,
      manual: tracker?.isManual?.(exec?.sessionId) ?? false,
    },
  }
}
