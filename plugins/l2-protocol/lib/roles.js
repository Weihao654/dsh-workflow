// Roles and authority come from frozen session facts, never tool arguments.
import { serviceOf } from './host.js'
export const ROLES = ['plan', 'work', 'code', 'review']
export const ROLE_LABEL = Object.fromEntries(ROLES.map(role => [role, role]))

export function resolveExec(ctx, exec) {
  const agent = exec?.agent
  const agentCtx = agent?.ctx ?? exec?.ctx
  const sessions = serviceOf(ctx, 'sessions')
  const session = (agent?.id ? sessions?.get?.(agent.id) : undefined) ?? agent?.session ?? agentCtx?.session
  const header = session?.header ?? {}
  let preset = header.agentPreset
  if (!preset) {
    try { preset = serviceOf(ctx, 'agentPresets')?.composedPreset?.(agentCtx ?? ctx) } catch {}
  }
  let cwd = header.cwd
  const working = serviceOf(ctx, 'workingDirectory')
  try { if (session && working?.get) cwd = working.get(session) ?? cwd } catch {}
  cwd ??= working?.defaultDirectory ?? process.cwd()
  return {
    agent: agent ?? null,
    role: ROLES.includes(preset) ? preset : null,
    preset: preset ?? null,
    // Unknown lineage must not acquire root authority.
    isRoot: Boolean(session?.header) && !header.parentSession && header.origin !== 'subagent',
    sessionId: String(header.id ?? agent?.id ?? exec?.sessionId ?? 'unknown-session'),
    parentSession: header.parentSession ?? null,
    delegationDepth: header.delegationDepth ?? null,
    cwd,
    signal: exec?.signal,
    callId: exec?.callId,
  }
}
