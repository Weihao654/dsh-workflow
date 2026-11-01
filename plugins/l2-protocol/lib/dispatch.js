// Role reuse: one child agent per role (or per task family) instead of one per task.
//
// Why this file exists: a chain that spawns a fresh child for every task pays the
// same briefing cost on every hop, and the roles never accumulate anything — the
// "team" is rebuilt from scratch each round. The subagents service already has the
// two primitives we need:
//
//   startActivation({ provider, label, request, signal, delivery })  → new child
//   sendMessage(sender, targetId, content, { signal })              → steer an
//                                                                     existing child
//                                                                     (idle children
//                                                                     start a turn,
//                                                                     absent ones cold-
//                                                                     resume)
//
// So reuse is a bookkeeping problem, not a transport problem: remember which child
// belongs to which role, and send a message instead of spawning when the policy
// says this role is reusable.
//
// The policy is per role and lives in the same project file as the model table:
//
//   "reuse": { "work": "persistent", "code": "family", "review": "fresh" }
//
//   persistent → one child per role, reused across rounds
//   family     → one child per (role, family); the caller names the family
//   fresh      → always spawn (review defaults here: an independent check must
//                not inherit last round's conclusions)
//
// Reuse is only ever attempted for a child this exact session spawned: sendMessage
// authorizes by live adjacency, so a roster entry written by another parent would
// be refused. When the send fails (child gone, adjacency lost, capacity) we fall
// back to spawning — reuse is an optimisation, never a correctness requirement.

export const REUSE_POLICIES = ['persistent', 'family', 'fresh']

export const DEFAULT_REUSE = {
  work: 'persistent',
  code: 'family',
  review: 'fresh',
}

// Who may dispatch whom. plan is the root orchestrator; work coordinates code and
// review. code and review dispatch nothing — they report back.
export const DISPATCH_AUTHORITY = {
  plan: ['work'],
  work: ['code', 'review'],
}

const DISPATCHABLE = ['work', 'code', 'review']

/** Keep only well-formed reuse policies; report the rest instead of guessing. */
export function normalizeReuse(input) {
  const reuse = {}
  const errors = []
  if (input === undefined || input === null) return { reuse, errors }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { reuse, errors: ['reuse 必须是对象，例如 { "work": "persistent" }'] }
  }
  for (const [key, value] of Object.entries(input)) {
    const role = String(key).trim().toLowerCase()
    if (!DISPATCHABLE.includes(role)) {
      errors.push(`未知角色 ${key}（reuse 只认 ${DISPATCHABLE.join(' / ')}；plan 是根，不被派发）`)
      continue
    }
    const policy = String(value ?? '').trim().toLowerCase()
    if (!REUSE_POLICIES.includes(policy)) {
      errors.push(`${role} 的 reuse 只能是 ${REUSE_POLICIES.join(' / ')}，收到 "${value}"`)
      continue
    }
    reuse[role] = policy
  }
  return { reuse, errors }
}

export function policyFor(reuse, role) {
  const explicit = reuse && typeof reuse === 'object' ? reuse[role] : undefined
  if (REUSE_POLICIES.includes(explicit)) return explicit
  return DEFAULT_REUSE[role] ?? 'fresh'
}

/** roster key: work/review are singletons, code is per family. */
export function rosterKey(role, family) {
  if (role !== 'code') return role
  const name = String(family ?? '').trim()
  return `code:${name || 'default'}`
}

function text(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

/** Read one roster entry. */
export async function rosterEntry(store, key) {
  return store.read((state) => state.agents?.[key] ?? null)
}

/** The whole roster, for chain_status. */
export async function readRoster(store) {
  return store.read((state) => state.agents ?? {})
}

function subagentsOf(ctx) {
  try {
    const viaGet = ctx.get?.('subagents')
    if (viaGet) return viaGet
  } catch {
    // get() unavailable — fall through
  }
  try {
    return ctx.subagents
  } catch {
    return undefined
  }
}

/**
 * Pick a provider that can honour an agent preset. `spawn` is the in-process
 * backend this profile ships; anything the user configured first is a fallback.
 */
export function pickProvider(subagents) {
  const names = typeof subagents?.list === 'function' ? subagents.list() : []
  const order = ['spawn', ...names.filter((name) => name !== 'spawn')]
  for (const name of order) {
    if (!names.includes(name)) continue
    const provider = typeof subagents?.getProvider === 'function' ? subagents.getProvider(name) : undefined
    if (provider && provider.capabilities?.agentPreset !== false) return name
  }
  return undefined
}

async function spawn(ctx, exec, role, task, options = {}) {
  const subagents = subagentsOf(ctx)
  if (!subagents || typeof subagents.startActivation !== 'function') {
    return { ok: false, code: 'NO_SUBAGENTS', message: 'subagents 服务不可用，无法派发子代理。' }
  }
  const provider = pickProvider(subagents)
  if (!provider) {
    return {
      ok: false,
      code: 'NO_PRESET_PROVIDER',
      message: '没有支持 agentPreset 的子代理 provider，角色链无法按角色派发。',
    }
  }
  const request = {
    prompt: [{ type: 'text', text: task }],
    parent: exec.agent,
    agentPreset: role,
    cwd: exec.cwd,
  }
  try {
    const maxDepth = typeof subagents.resolveMaxDepth === 'function' ? subagents.resolveMaxDepth(options.maxDepth ?? 2) : undefined
    if (maxDepth !== undefined) request.maxDepth = maxDepth
  } catch {
    // depth policy unavailable — let the host decide
  }
  try {
    const activation = await subagents.startActivation({
      provider,
      label: `${role}: ${task.slice(0, 60)}`,
      request,
      signal: options.signal,
      delivery: 'parent',
    })
    return { ok: true, action: 'spawn', provider, childId: String(activation.childId) }
  } catch (error) {
    return { ok: false, code: 'SPAWN_FAILED', message: error?.message ?? String(error) }
  }
}

async function reuse(ctx, exec, childId, task, options = {}) {
  const subagents = subagentsOf(ctx)
  if (!subagents || typeof subagents.sendMessage !== 'function') {
    return { ok: false, code: 'NO_SUBAGENTS', message: 'subagents 服务不可用，无法复用子代理。' }
  }
  try {
    const messageId = await subagents.sendMessage(
      exec.agent,
      childId,
      [{ type: 'text', text: task }],
      { signal: options.signal },
    )
    return { ok: true, action: 'reuse', childId, messageId: String(messageId) }
  } catch (error) {
    return { ok: false, code: 'REUSE_FAILED', message: error?.message ?? String(error) }
  }
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * Dispatch a task to a role, reusing that role's child when the policy allows it.
 *
 * Returns which path was taken (`action: 'spawn' | 'reuse'`) plus the child id, so
 * the caller can see that reuse happened instead of assuming it.
 */
export async function dispatch(ctx, store, exec, args = {}) {
  const role = text(args.role).trim().toLowerCase()
  const task = text(args.task).trim()
  if (!DISPATCHABLE.includes(role)) {
    return {
      ok: false,
      code: 'BAD_ARGS',
      message: `role 必须是 ${DISPATCHABLE.join(' / ')}；plan 是根会话，不被派发。`,
    }
  }
  const allowed = DISPATCH_AUTHORITY[exec.role] ?? []
  if (!allowed.includes(role)) {
    return {
      ok: false,
      code: 'DISPATCH_DENIED',
      message: `当前角色 ${exec.role} 只能派发 ${allowed.length > 0 ? allowed.join(' / ') : '（无）'}，不能派发 ${role}。`,
    }
  }
  if (!task) {
    return { ok: false, code: 'BAD_ARGS', message: 'task 不能为空：复用时要送的就是这条任务说明。' }
  }

  const family = role === 'code' ? text(args.family).trim() || 'default' : ''
  const key = rosterKey(role, family)
  const policy = args.fresh === true ? 'fresh' : policyFor(exec.reuse, role)
  const entry = await rosterEntry(store, key)

  const signal = args.signal
  let result
  let reused = false

  if (policy !== 'fresh' && entry?.childId) {
    const attempt = await reuse(ctx, exec, entry.childId, task, { signal })
    if (attempt.ok) {
      result = attempt
      reused = true
    } else if (attempt.code === 'NO_SUBAGENTS') {
      return attempt
    }
    // A failed reuse falls through to a fresh child; the roster is replaced below.
  }

  if (!reused) {
    const spawned = await spawn(ctx, exec, role, task, { signal, maxDepth: args.maxDepth })
    if (!spawned.ok) return spawned
    result = spawned
  }

  const stamp = nowIso()
  const roundId = await store.read((state) => state.activeRoundId ?? null)
  await store.mutate((state) => {
    if (!state.agents || typeof state.agents !== 'object') state.agents = {}
    const previous = state.agents[key]
    state.agents[key] = {
      role,
      family: family || null,
      childId: result.childId,
      parentSessionId: exec.sessionId ?? null,
      policy,
      createdAt: previous?.childId === result.childId ? previous.createdAt : stamp,
      lastUsedAt: stamp,
      uses: (previous?.childId === result.childId ? previous.uses ?? 0 : 0) + 1,
      lastRoundId: roundId,
    }
    return state.agents
  })

  return {
    ok: true,
    action: result.action,
    role,
    ...(family ? { family } : {}),
    childId: result.childId,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    policy,
    note:
      result.action === 'reuse'
        ? '已把任务发给这个角色已有的子代理（同一会话继续，不重建上下文）。'
        : '已新建一个子代理。之后同一角色的任务会按 reuse 策略复用这个。',
  }
}

/**
 * Retire one roster entry (or every entry) and release the resident child.
 * Draining is the only way to get memory back: a persistent child otherwise stays
 * resident for the life of the parent.
 */
export async function release(ctx, store, exec, args = {}) {
  const role = text(args.role).trim().toLowerCase() || ''
  if (role && !DISPATCHABLE.includes(role)) {
    return { ok: false, code: 'BAD_ARGS', message: `role 必须是 ${DISPATCHABLE.join(' / ')}，或省略表示全部。` }
  }
  const family = role === 'code' ? text(args.family).trim() || '' : ''
  const entries = await readRoster(store)
  const keys = role ? [family ? rosterKey(role, family) : role].filter((key) => entries[key]) : Object.keys(entries)
  if (keys.length === 0) return { ok: true, released: [], note: '没有可释放的子代理。' }

  const subagents = subagentsOf(ctx)
  const released = []
  const refused = []
  for (const key of keys) {
    const entry = entries[key]
    if (entry?.parentSessionId && exec.sessionId && entry.parentSessionId !== exec.sessionId) {
      refused.push({ key, childId: entry.childId, reason: '不是本会话派发的子代理，只有它的父会话能释放' })
      continue
    }
    if (subagents && typeof subagents.drainChildren === 'function' && entry?.childId) {
      try {
        await subagents.drainChildren(exec.agent, [entry.childId])
      } catch (error) {
        refused.push({ key, childId: entry.childId, reason: error?.message ?? String(error) })
        continue
      }
    }
    released.push({ key, childId: entry?.childId ?? null })
  }

  if (released.length > 0) {
    await store.mutate((state) => {
      if (!state.agents) return state.agents
      for (const item of released) delete state.agents[item.key]
      return state.agents
    })
  }

  return {
    ok: true,
    released,
    ...(refused.length > 0 ? { refused } : {}),
    note: '已释放并从名册移除。下次派发会新建。',
  }
}
