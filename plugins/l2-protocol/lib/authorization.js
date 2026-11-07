// Host-only project envelope. This module exports no tool or HTTP mutation path.
import { fail } from './errors.js'
import { budgetOf, usageTotals, DEFAULT_CLOSEOUT_REQUESTS, DEFAULT_CLOSEOUT_TIME_MS } from './runtime.js'

const INPUT_GUIDANCE = 'Enter only one /chain-authorize command and one JSON object; do not append code fences, explanations or another command.'

function validateAuthorizationArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args))
    fail('BAD_ARGS', `Authorization input must be a JSON object. ${INPUT_GUIDANCE}`)
  if (args.budget !== undefined && (args.budget === null || typeof args.budget !== 'object' || Array.isArray(args.budget)))
    fail('BAD_ARGS', `budget must be a JSON object when supplied. ${INPUT_GUIDANCE}`)
  return args
}

export function parseAuthorizationInput(rawInput) {
  if (typeof rawInput !== 'string') fail('BAD_ARGS', INPUT_GUIDANCE)
  const text = rawInput.trim().replace(/^\/chain-authorize(?:\s+|$)/u, '').trim()
  let args
  try { args = JSON.parse(text) }
  catch { fail('BAD_ARGS', `Invalid authorization JSON. ${INPUT_GUIDANCE}`) }
  return validateAuthorizationArgs(args)
}

export function projectUsage(state) {
  const values = Object.values(state.rounds).map(round => ({ ...usageTotals(round),
    // Only an in-flight/unknown-outcome receipt is uncertainty. A terminal failure
    // without usage is charged at its reservation upper bound by usageTotals.
    incompleteReceipt: Object.values(round.usage?.requests ?? {}).some(request => request.status === 'pending' && request.endedAt) }))
  return values.reduce((sum, value) => ({ requests: sum.requests + value.requests,
    totalTokens: sum.totalTokens + value.totalTokens,
    pendingReserved: sum.pendingReserved + value.pendingReserved,
    uncertain: sum.uncertain || value.incompleteReceipt || value.attributionUnknown || value.unknownReservations > 0 }),
  { requests: 0, totalTokens: 0, pendingReserved: 0, uncertain: false })
}

export function assertProjectAdmission(state, now = Date.now(), reservation = null) {
  const grant = state.authorization
  if (!grant || grant.version !== 1 || !grant.id || !Number.isFinite(Date.parse(grant.deadlineAt)))
    fail('AUTHORIZATION_REQUIRED', 'Use the genuine /chain-authorize command before the first model request.')
  const normalized = budgetOf({ budget: grant.budget ?? {} })
  // Compare only the keys the durable grant actually recorded: a grant written by an older
  // version predates newer normalized limits (for example the closeout reserve) and must keep
  // working instead of becoming AUTHORIZATION_CORRUPT on upgrade.
  if (!grant.budget || Object.entries(grant.budget).some(([key, value]) => key in normalized && normalized[key] !== value) || grant.budget.tokens < 1 || !Number.isFinite(Date.parse(grant.authorizedAt)))
    fail('AUTHORIZATION_CORRUPT', 'The durable authorization must retain every explicit normalized limit and original timestamp.')
  if (now >= Date.parse(grant.deadlineAt)) fail('PROJECT_DEADLINE_REACHED', 'The original project authorization expired.')
  const total = projectUsage(state)
  if (total.requests >= grant.budget.requests) fail('PROJECT_REQUEST_BUDGET_REACHED', 'The cumulative project attempt limit is exhausted.')
  if (total.uncertain || total.totalTokens + total.pendingReserved >= grant.budget.tokens || total.totalTokens + total.pendingReserved + (reservation ?? 0) > grant.budget.tokens)
    fail('PROJECT_TOKEN_BUDGET_REACHED', 'Cumulative project usage/reservations or uncertainty prevent admission.')
  return grant
}

// Called only from the Host Commands handler. The handler is NOT a model tool.
export async function authorizeProject(store, exec, args, commandId, now = Date.now()) {
  if (!exec.bindingValid || exec.role !== 'plan' || !exec.isRoot || !commandId)
    fail('ROLE_DENIED', `A genuine human command targeting the live root plan is required; actual preset=${String(exec.preset ?? 'unknown')}, role=${String(exec.role ?? 'none')}, root=${Boolean(exec.isRoot)}, bindingValid=${Boolean(exec.bindingValid)}, commandIdPresent=${Boolean(commandId)}. Select the actual root plan session with matching live preset and projection, then submit the Host command there.`)
  if (!store.requiresAuthorization) fail('AUTHORITY_LOCATION_REQUIRED', 'Production authorization requires a protected profile ledger.')
  validateAuthorizationArgs(args)
  const id = String(args.authorizationId ?? '').trim()
  if (!id || !String(args.goal ?? '').trim()) fail('BAD_ARGS', 'authorizationId and goal are required.')
  const budget = budgetOf({ budget: args.budget ?? {} })
  if (!Number.isSafeInteger(budget.tokens) || budget.tokens < 1) fail('BAD_BUDGET', 'A positive total token limit is mandatory.')
  // Match openRound before persisting an immutable grant, so a rejected reserve
  // cannot leave a project authorized with a budget that can never open a round.
  if (budget.closeoutRequests < DEFAULT_CLOSEOUT_REQUESTS)
    fail('BAD_BUDGET', `An authorized project cannot lower the closeout request reserve below ${DEFAULT_CLOSEOUT_REQUESTS}.`)
  if (budget.closeoutTimeMs < DEFAULT_CLOSEOUT_TIME_MS)
    fail('BAD_BUDGET', `An authorized project cannot lower the closeout time reserve below ${DEFAULT_CLOSEOUT_TIME_MS} ms.`)
  return store.mutate(state => {
    if (state.authorization) {
      if (state.authorization.sessionId !== exec.sessionId)
        fail('AUTHORIZATION_OWNER_MISMATCH', 'Existing project authorization belongs to another root plan session; return to that original session without replacing its grant.')
      if (state.authorization.id !== id || JSON.stringify(state.authorization.budget) !== JSON.stringify(budget) || state.authorization.goal !== args.goal)
        fail('AUTHORIZATION_IMMUTABLE', 'Existing project authorization cannot be reset, replaced or extended.')
      return { duplicate: true, authorization: state.authorization }
    }
    if (Object.keys(state.rounds).length) fail('AUTHORIZATION_MIGRATION_REQUIRED', 'Existing rounds require explicit external migration, not silent adoption.')
    const grant = { version: 1, id, commandId, sessionId: exec.sessionId, goal: args.goal,
      authorizedAt: new Date(now).toISOString(), deadlineAt: new Date(now + budget.wallMinutes * 60000).toISOString(), budget }
    state.authorization = grant
    return { duplicate: false, authorization: grant }
  })
}
