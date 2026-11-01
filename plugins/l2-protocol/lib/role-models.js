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

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROLES } from './roles.js'
import { normalizeReuse, policyFor } from './dispatch.js'

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
    return { path, exists: false, enabled: false, roleModels: {}, reuse: {}, errors: [] }
  }

  const hit = cache.get(path)
  if (hit && hit.stamp === stamp) return hit.value

  let value
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const { roleModels, errors } = normalizeRoleModels(parsed?.roleModels ?? parsed)
    const { reuse, errors: reuseErrors } = normalizeReuse(parsed?.reuse)
    value = { path, exists: true, enabled: parsed?.enabled !== false, roleModels, reuse, errors: [...errors, ...reuseErrors] }
  } catch (error) {
    value = {
      path,
      exists: true,
      enabled: false,
      roleModels: {},
      reuse: {},
      errors: [`解析失败：${error.message}`],
    }
  }
  cache.set(path, { stamp, value })
  return value
}

/**
 * Write the project table. Used by the `chain_role_models` tool so a user can
 * change models from the conversation instead of hand-editing JSON.
 *
 * The file is the source of truth (it travels with the repo), so this is a
 * read-modify-write of the whole document: unknown keys are preserved, `enabled`
 * is kept unless explicitly changed, and the write is atomic (temp file inside
 * the same directory, then rename) with UTF-8 and no BOM.
 */
export function saveRoleModels(cwd, change = {}) {
  const path = configPath(cwd)
  let document = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) document = parsed
  } catch {
    // A missing or unreadable file is simply replaced.
  }
  if (!document.roleModels || typeof document.roleModels !== 'object') document.roleModels = {}

  const errors = []

  if (typeof change.enabled === 'boolean') document.enabled = change.enabled

  // reuse: merge per role, so switching code to "persistent" does not silently
  // reset work's policy. A null value removes that role's override.
  if (change.reuse !== undefined) {
    const { reuse, errors: reuseErrors } = normalizeReuse(change.reuse)
    errors.push(...reuseErrors)
    if (!document.reuse || typeof document.reuse !== 'object') document.reuse = {}
    for (const [role, policy] of Object.entries(reuse)) document.reuse[role] = policy
    for (const [role, value] of Object.entries(change.reuse ?? {})) {
      if (value === null) delete document.reuse[String(role).trim().toLowerCase()]
    }
  }

  for (const key of Array.isArray(change.clear) ? change.clear : []) {
    const role = String(key).trim().toLowerCase()
    if (!ROLES.includes(role)) errors.push(`未知角色 ${key}（只认 ${ROLES.join(' / ')}）`)
    else delete document.roleModels[role]
  }

  const patch = change.set && typeof change.set === 'object' ? change.set : {}
  for (const [key, value] of Object.entries(patch)) {
    const role = String(key).trim().toLowerCase()
    if (!ROLES.includes(role)) {
      errors.push(`未知角色 ${key}（只认 ${ROLES.join(' / ')}）`)
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${role} 必须是 { provider, model, reasoningEffort? }`)
      continue
    }
    const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
    const model = typeof value.model === 'string' ? value.model.trim() : ''
    if (!provider || !model) {
      errors.push(`${role} 缺少 provider 或 model`)
      continue
    }
    const route = { provider, model }
    const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
    if (effort) route.reasoningEffort = effort
    document.roleModels[role] = route
  }

  if (errors.length > 0) return { ok: false, path, errors }

  const { roleModels, errors: invalid } = normalizeRoleModels(document.roleModels)
  if (invalid.length > 0) return { ok: false, path, errors: invalid }

  const payload = { enabled: document.enabled !== false, roleModels }
  const keptReuse = {}
  for (const role of ['work', 'code', 'review']) {
    const policy = document.reuse?.[role]
    if (typeof policy === 'string' && policy) keptReuse[role] = policy
  }
  if (Object.keys(keptReuse).length > 0) payload.reuse = keptReuse
  const directory = join(cwd || '.', CONFIG_DIR)
  const temp = `${path}.tmp`
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    return { ok: false, path, errors: [`写入失败：${error.message}`] }
  }

  cache.delete(path)
  return { ok: true, path, document: payload, errors: [] }
}

function sameRoute(a, b) {
  return Boolean(a && b) && a.provider === b.provider && a.model === b.model
}

/**
 * Decide what to actually send. Pure: no I/O, so the precedence rules are
 * testable without a harness.
 *
 * Rules, in order:
 *  1. a base config that differs from the last one we applied means the human
 *     picked something — that session is theirs from now on;
 *  2. a root session whose very first base is neither the profile default nor
 *     the table's route was already picked by the human before we ran;
 *  3. no route for the role, no override;
 *  4. otherwise replay the route, dropping a stale reasoningEffort whenever the
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

  decide(sessionId, base, route, options = {}) {
    const id = String(sessionId)
    const prev = this.applied.get(id)

    if (prev && (base.provider !== prev.provider || base.model !== prev.model)) {
      this.manual.add(id)
    }
    // First sight of a root session: a base that is neither the profile default
    // nor the table's route is a picker choice the human made before we ever ran,
    // so the session is already theirs.
    if (
      !prev &&
      options.isRoot === true &&
      options.defaults &&
      !sameRoute(base, options.defaults) &&
      !sameRoute(base, route)
    ) {
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

/** The profile's default route, i.e. what a brand-new session sends before any pick. */
function defaultSelection(ctx) {
  try {
    const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
    const current = service?.currentSelection?.()
    if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
      return { provider: current.provider, model: current.model }
    }
  } catch {
    // No default-model service: fall back to "cannot tell", which keeps rule 2 inert.
  }
  return null
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
      const decided = tracker.decide(sessionId, base, route, {
        isRoot: !header?.parentSession && header?.origin !== 'subagent',
        defaults: defaultSelection(ctx),
      })
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
  const effectiveReuse = {}
  for (const role of ['work', 'code', 'review']) effectiveReuse[role] = policyFor(table.reuse, role)
  return {
    configPath: table.path,
    exists: table.exists,
    enabled: table.enabled,
    roles: table.roleModels,
    reuse: table.reuse,
    effectiveReuse,
    errors: table.errors,
    thisSession: {
      role: exec?.role ?? null,
      applied,
      manual: tracker?.isManual?.(exec?.sessionId) ?? false,
    },
  }
}
