// Policy and public dispatch facade. All live work goes through the controller.
export const REUSE_POLICIES = ['persistent', 'family', 'fresh']
export const DEFAULT_REUSE = { work: 'persistent', code: 'family', review: 'fresh' }
// plan -> work is the normal flow. The controller adds one closing exception: a plan that already
// holds command evidence may dispatch review, so a round that ran out of ordinary room can still be
// finished. That exception never applies before the command evidence exists.
export const DISPATCH_AUTHORITY = { plan: ['work'], work: ['code', 'review'] }
const ROLES = ['work', 'code', 'review']

export function normalizeReuse(input, { allowClear = false } = {}) {
  const reuse = {}, errors = []
  if (input === undefined || input === null) return { reuse, errors }
  if (typeof input !== 'object' || Array.isArray(input)) return { reuse, errors: ['reuse 必须是对象'] }
  for (const [key, value] of Object.entries(input)) {
    const role = key.trim().toLowerCase()
    if (!ROLES.includes(role)) { errors.push(`未知角色 ${key}（reuse 只认 work / code / review）`); continue }
    if (value === null && allowClear) { reuse[role] = null; continue }
    const policy = String(value ?? '').trim().toLowerCase()
    if (role === 'review' && policy !== 'fresh') { errors.push('review must remain fresh for independent review'); continue }
    if (role === 'work' && policy !== 'persistent') { errors.push('work must remain persistent; another policy cannot bypass the coordinator slot'); continue }
    if (role === 'code' && policy === 'fresh') { errors.push('code must reuse its same-round slot; fresh cannot bypass busy/stopped work'); continue }
    if (!REUSE_POLICIES.includes(policy)) errors.push(`${role} 的 reuse 只能是 persistent / family / fresh，收到 "${value}"`)
    else reuse[role] = policy
  }
  return { reuse, errors }
}
export function policyFor(reuse, role) { return REUSE_POLICIES.includes(reuse?.[role]) ? reuse[role] : DEFAULT_REUSE[role] ?? 'fresh' }
export function rosterKey(role, family, policy = role === 'code' ? 'family' : 'persistent') {
  return policy === 'family' ? `${role}:${String(family ?? '').trim() || 'default'}` : role
}
export async function rosterEntry(store, key) { return store.read(state => state.agents?.[key] ?? null) }
export async function readRoster(store) { return store.read(state => state.agents ?? {}) }
export function pickProvider(subagents) {
  // Remote/external providers need their own cancellation and exit-proof adapter.
  const provider = subagents?.getProvider?.('spawn')
  return subagents?.list?.().includes('spawn') && provider?.capabilities?.agentPreset === true ? 'spawn' : undefined
}
export async function dispatch(ctx, store, exec, args = {}) {
  if (!exec.controller) return { ok: false, code: 'NO_CONTROLLER', message: 'Controlled dispatch requires the Host controller.' }
  return exec.controller.dispatch(store, exec, args)
}
export async function release(ctx, store, exec, args = {}) {
  if (!exec.controller) return { ok: false, code: 'NO_CONTROLLER', message: 'Controlled release requires the Host controller.' }
  return exec.controller.release(store, exec, args)
}
