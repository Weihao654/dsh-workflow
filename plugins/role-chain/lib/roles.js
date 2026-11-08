// Authority requires live Host membership plus agreeing mount and formal projection.
// Creation headers are historical evidence only; they never grant a role.
import { serviceOf } from './host.js'
export const ROLES = ['plan', 'work', 'code', 'review']
export const ROLE_LABEL = Object.fromEntries(ROLES.map(role => [role, role]))

export function resolveBinding(ctx, { agent, sessionId } = {}) {
  const agents = serviceOf(ctx, 'agents'), sessions = serviceOf(ctx, 'sessions')
  const id = sessionId ?? agent?.id
  const live = id == null ? undefined : agents?.get?.(String(id))
  const session = id == null ? undefined : sessions?.get?.(String(id))
  const denied = reason => ({ valid: false, role: null, preset: null, reason, agent: live ?? null, session })
  if (!live || (agent && live !== agent) || !live.ctx) return denied('LIVE_AGENT_REQUIRED')
  if (!session || String(session.id) !== String(id) || String(session.header?.id) !== String(id)) return denied('LIVE_SESSION_REQUIRED')
  let mounted, projected
  try {
    mounted = serviceOf(ctx, 'agentPresets')?.composedPreset?.(live.ctx)
    projected = serviceOf(ctx, 'sessionProjections')?.stateOf?.(session, 'agentPreset')
  } catch { return denied('BINDING_QUERY_FAILED') }
  if (typeof mounted !== 'string' || !mounted || typeof projected !== 'string' || !projected) return denied('BINDING_MISSING')
  if (mounted !== projected) return denied('BINDING_CONFLICT')
  return { valid: true, role: ROLES.includes(mounted) ? mounted : null, preset: mounted,
    mounted, projected, reason: null, agent: live, session }
}
export function resolveSessionRole(ctx, sessionId, agent) {
  return resolveBinding(ctx, { sessionId, agent })
}
export function resolveExec(ctx, exec) {
  const binding = resolveBinding(ctx, { agent: exec?.agent, sessionId: exec?.agent?.id ?? exec?.sessionId })
  const { session } = binding, header = session?.header ?? {}
  let cwd = header.cwd
  const working = serviceOf(ctx, 'workingDirectory')
  try { if (session && working?.get) cwd = working.get(session) ?? cwd } catch {}
  cwd ??= working?.defaultDirectory ?? process.cwd()
  return {
    agent: binding.agent, role: binding.role, preset: binding.preset, bindingValid: binding.valid,
    bindingError: binding.reason,
    isRoot: binding.valid && Boolean(session?.header) && !header.parentSession && header.origin !== 'subagent',
    sessionId: String(session?.id ?? exec?.agent?.id ?? exec?.sessionId ?? 'unknown-session'),
    parentSession: header.parentSession ?? null, delegationDepth: header.delegationDepth ?? null,
    cwd, signal: exec?.signal, callId: exec?.callId,
  }
}
