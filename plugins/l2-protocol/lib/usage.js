// One row per observable llm/stream attempt, including retries/interruption.
// Context-pressure tokenMeter is not a spend counter; no invoice is invented.
import { assertAdmissible, budgetOf, bindingOf, DEFAULT_OUTPUT_CAP, iso, newId, usageTotals } from './runtime.js'
import { fail } from './errors.js'
import { resolveExec } from './roles.js'
import { forCwd } from './store.js'
import { serviceOf } from './host.js'

export function inputReservation(options) {
  // Byte-size plus overhead is an estimate, not a tokenizer or an absolute ceiling.
  return Buffer.byteLength(JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools }), 'utf8') + 1024
}
export function normalizeUsage(value) {
  if (!value || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens) || value.inputTokens < 0 || value.outputTokens < 0) return null
  const totalTokens = value.totalTokens ?? value.inputTokens + value.outputTokens
  if (!Number.isSafeInteger(totalTokens) || totalTokens < value.inputTokens + value.outputTokens) return null
  const usage = { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens }
  for (const name of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (Number.isSafeInteger(value[name]) && value[name] >= 0) usage[name] = value[name]
  return usage
}
function receipt(request, usage, outcome, now) {
  const normalized = normalizeUsage(usage)
  if (request.status === 'settled') {
    if (JSON.stringify(request.usage) !== JSON.stringify(normalized) || request.outcome !== outcome) fail('REQUEST_ID_CONFLICT', 'A settled request cannot receive a different final receipt.')
    return true
  }
  request.usage = normalized
  request.outcome = outcome
  request.endedAt = iso(now)
  request.status = normalized && outcome === 'completed' ? 'settled' : 'pending'
  request.pendingReason = request.status === 'pending' ? (normalized ? 'Interrupted; additional provider usage is unknown.' : 'No complete provider usage receipt.') : null
  return false
}
export async function reserveRequest(store, identity, requestId, options, now = Date.now()) {
  return store.mutate(state => {
    const found = bindingOf(state, identity.sessionId)
    if (!found || found.round.id !== identity.roundId || found.execution.id !== identity.executionId || found.execution.generation !== identity.generation) fail('STALE_EXECUTION', 'Request belongs to an obsolete execution generation.')
    const { round, execution } = found
    assertAdmissible(round, now, { phase: execution.phase })
    if (execution.resumeBlocked) fail('RESUME_BLOCKED', 'The execution is fenced.')
    round.usage ??= { requests: {} }
    const fingerprint = JSON.stringify([identity, options.provider, options.model, options.maxTokens, options.inputTokens])
    const prior = round.usage.requests[requestId]
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT', 'Request id already has another identity.')
      return { duplicate: true, request: prior }
    }
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || !Number.isSafeInteger(options.inputTokens) || options.inputTokens < 0) fail('BAD_RESERVATION', 'Reserve estimated input and capped output before provider I/O.')
    const totals = usageTotals(round), limit = budgetOf(round).tokens
    const reservedTokens = options.inputTokens + options.maxTokens
    if (limit && (totals.attributionUnknown || totals.unknownReservations || totals.totalTokens + totals.pendingReserved + reservedTokens > limit)) fail('TOKEN_BUDGET_REACHED', 'Known usage, uncertainty or pending reservations leaves no room for this request.')
    const request = { id: requestId, ...identity, role: execution.role, phase: execution.phase,
      provider: options.provider, model: options.model, purpose: options.purpose ?? 'agent',
      reservedTokens, inputEstimate: options.inputTokens, outputCap: options.maxTokens,
      estimate: true, fingerprint, status: 'pending', startedAt: iso(now), usage: null }
    round.usage.requests[requestId] = request
    return { duplicate: false, request }
  })
}
export async function settleRequest(store, identity, requestId, usage, outcome, now = Date.now()) {
  return store.mutate(state => {
    // Never follow a reused session binding when settling its old receipt.
    const request = state.rounds[identity.roundId]?.usage?.requests?.[requestId]
    if (!request || request.executionId !== identity.executionId || request.generation !== identity.generation) fail('STALE_EXECUTION', 'Usage receipt identity mismatch.')
    return { duplicate: receipt(request, usage, outcome, now), request }
  })
}

// The first planning request precedes chain_open_round. Journal it before I/O,
// then adopt it exactly once when that root opens its round, rather than losing it.
export async function startPlanningRequest(store, sessionId, requestId, options, now = Date.now()) {
  return store.mutate(state => {
    state.planningUsage ??= {}
    if (state.planningUsage[requestId]) fail('REQUEST_ID_CONFLICT', 'Planning request id is already present.')
    const inputEstimate = inputReservation(options)
    const outputCap = Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : null
    state.planningUsage[requestId] = { id: requestId, sessionId, role: 'plan', phase: 'planning-before-round',
      provider: options.provider, model: options.model, purpose: options.purpose ?? 'agent', inputEstimate, outputCap,
      reservedTokens: outputCap === null ? null : inputEstimate + outputCap, estimate: true,
      status: 'pending', startedAt: iso(now), usage: null, priorToRoundAuthorization: true }
  })
}
export async function settlePlanningRequest(store, requestId, usage, outcome, now = Date.now()) {
  return store.mutate(state => {
    const request = state.planningUsage?.[requestId]
    if (!request) fail('STALE_EXECUTION', 'Planning usage journal is missing.')
    receipt(request, usage, outcome, now)
    const to = request.adoptedTo
    if (to) {
      const adopted = state.rounds[to.roundId]?.usage?.requests?.[requestId]
      if (!adopted || adopted.executionId !== to.executionId || adopted.generation !== to.generation) fail('STALE_EXECUTION', 'Planning usage adoption identity mismatch.')
      receipt(adopted, usage, outcome, now)
    }
  })
}
function attributedSession(ctx, options) {
  // Explicit identity is authoritative. Initiator is only a local attribution fallback,
  // never permission to cancel, write authority, or invent ancestry.
  if (options.sessionId) return String(options.sessionId)
  return serviceOf(ctx, 'agents')?.currentInitiator?.()?.id ?? null
}
async function unknownAttribution(controller) {
  for (const store of controller.stores.values()) {
    const roundId = await store.mutate(state => {
      const round = state.rounds[state.activeRoundId]
      if (!round?.control?.managed || round.closedAt) return null
      round.usage.attributionUnknown = true
      round.usage.unattributedAttempts = (round.usage.unattributedAttempts ?? 0) + 1
      return round.id
    })
    if (roundId) await controller.autoStop(store, roundId, 'usage-attribution-unknown')
  }
}
async function stopIfBudgetHeld(controller, store, roundId) {
  const held = await store.read(state => {
    const round = state.rounds[roundId], totals = usageTotals(round)
    return budgetOf(round).tokens > 0 && (totals.attributionUnknown || totals.unknownReservations || totals.totalTokens + totals.pendingReserved >= budgetOf(round).tokens)
  })
  if (held) await controller.autoStop(store, roundId, 'token-budget')
}

export function installUsage(ctx, controller) {
  if (typeof ctx.on !== 'function') return () => {}
  const disposers = []
  disposers.push(ctx.on('agent/request', async (payload, next) => {
    const config = await next(), admission = await controller.beforeRequest(payload.agent, payload.signal)
    if (!admission) {
      const exec = resolveExec(ctx, { agent: payload.agent })
      return exec.role === 'plan' ? { ...config, maxTokens: Math.min(config.maxTokens ?? DEFAULT_OUTPUT_CAP, DEFAULT_OUTPUT_CAP) } : config
    }
    const { store, identity } = admission
    try {
      const cap = await store.read(state => {
        const round = state.rounds[identity.roundId], limits = budgetOf(round), totals = usageTotals(round)
        const available = limits.tokens ? limits.tokens - totals.totalTokens - totals.pendingReserved : Number.MAX_SAFE_INTEGER
        if (available < 1 || (limits.tokens && (totals.attributionUnknown || totals.unknownReservations))) fail('TOKEN_BUDGET_REACHED', 'No confirmed token budget remains.')
        return Math.min(limits.outputCap, available)
      })
      return { ...config, maxTokens: Math.min(config.maxTokens ?? cap, cap) }
    } catch (error) {
      if (error.code === 'TOKEN_BUDGET_REACHED') await controller.autoStop(store, identity.roundId, 'token-budget')
      throw error
    }
  }))
  disposers.push(ctx.on('llm/stream', async function* (options, next) {
    const sessionId = attributedSession(ctx, options)
    if (!sessionId) { await unknownAttribution(controller); yield* next(); return }
    const admission = await controller.forSession(sessionId), requestId = newId('Q')
    let planningStore = null
    if (!admission) {
      const exec = resolveExec(ctx, { agent: { id: sessionId } })
      if (exec.role === 'plan' && exec.isRoot) {
        planningStore = forCwd(exec.cwd)
        await startPlanningRequest(planningStore, sessionId, requestId, options, controller.now())
      } else { yield* next(); return }
    } else {
      try {
        await reserveRequest(admission.store, admission.identity, requestId, { provider: options.provider, model: options.model,
          maxTokens: options.maxTokens, inputTokens: inputReservation(options), purpose: options.purpose }, controller.now())
      } catch (error) {
        if (error.code === 'TOKEN_BUDGET_REACHED') await controller.autoStop(admission.store, admission.identity.roundId, 'token-budget')
        throw error
      }
    }
    let usage = null, outcome = 'interrupted'
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage' || chunk.usage) usage = normalizeUsage(chunk.usage) ?? usage
        yield chunk
      }
      outcome = 'completed'
    } finally {
      // Latest receipt per attempt, not sum-of-usage-snapshots.
      if (admission) {
        await settleRequest(admission.store, admission.identity, requestId, usage, outcome, controller.now())
        await stopIfBudgetHeld(controller, admission.store, admission.identity.roundId)
      } else {
        await settlePlanningRequest(planningStore, requestId, usage, outcome, controller.now())
        const adoptedTo = await planningStore.read(state => state.planningUsage[requestId].adoptedTo)
        if (adoptedTo) await stopIfBudgetHeld(controller, planningStore, adoptedTo.roundId)
      }
    }
  }))
  return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }
}
