// Who is calling? Runtime facts only — never the model's self-description.
//
// Role comes from the agent's frozen preset revision (SessionHeader.agentPreset,
// falling back to agentPresets.composedPreset). Root-ness comes from the session
// header: a spawned subagent carries parentSession / origin, a session the user
// opened does not. That distinction is what makes D1 (gate on the root only)
// enforceable, because ctx.userQuestions throws DELEGATED_CALLER for an agent
// owned by another agent.

export const ROLES = ['plan', 'work', 'code', 'review']

export const ROLE_LABEL = {
  plan: 'plan',
  work: 'work',
  code: 'code',
  review: 'review',
}

function safeCwd() {
  try {
    return process.cwd()
  } catch {
    return '.'
  }
}

export function resolveExec(ctx, exec) {
  const agent = exec?.agent
  const agentCtx = agent?.ctx ?? exec?.ctx
  const header = agent?.session?.header ?? agentCtx?.session?.header ?? {}

  let preset = header.agentPreset
  if (!preset) {
    try {
      preset = ctx.agentPresets?.composedPreset?.(agentCtx ?? ctx)
    } catch {
      preset = undefined
    }
  }

  const role = ROLES.includes(preset) ? preset : null
  const isRoot = !header.parentSession && header.origin !== 'subagent'
  const sessionId = header.id ?? agent?.id ?? exec?.sessionId ?? 'unknown-session'

  return {
    agent: agent ?? null, // chain_gate needs the live Agent handle
    role,
    preset: preset ?? null,
    isRoot,
    sessionId: String(sessionId),
    parentSession: header.parentSession ?? null,
    delegationDepth: header.delegationDepth ?? null,
    cwd: header.cwd ?? safeCwd(),
  }
}
