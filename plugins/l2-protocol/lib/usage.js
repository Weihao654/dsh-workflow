// One row per observable llm/stream attempt, including retries/interruption.
// Context-pressure tokenMeter is not a spend counter; no invoice is invented.
import { assertAdmissible, budgetOf, bindingOf, closeoutReady, closeoutReserveOf, closeoutSpentOf, DEFAULT_OUTPUT_CAP, iso, newId, noteEstimate, usageTotals } from './runtime.js'
import { fail } from './errors.js'
import { resolveExec } from './roles.js'
import { forCwd } from './store.js'
import { serviceOf } from './host.js'
import { assertProjectAdmission } from './authorization.js'

export function inputReservation(options) {
  // Byte-size plus overhead is an estimate, not a tokenizer or an absolute ceiling.
  return Buffer.byteLength(JSON.stringify({ messages: options.messages, system: options.system, tools: options.tools }), 'utf8') + 1024
}
export function normalizeUsage(value) {
  if (!value) return null
  const usage = {}
  for (const name of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const count = value[name] ?? (name.startsWith('cache') ? 0 : undefined)
    if (!Number.isSafeInteger(count) || count < 0) return null
    usage[name] = count
  }
  // Host buckets are disjoint; reasoning is already part of output.
  const sum = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
  if (!Number.isSafeInteger(sum)) return null
  if (value.totalTokens !== undefined && value.totalTokens !== sum) return null
  if (value.reasoningTokens !== undefined) {
    if (!Number.isSafeInteger(value.reasoningTokens) || value.reasoningTokens < 0 || value.reasoningTokens > usage.outputTokens) return null
    usage.reasoningTokens = value.reasoningTokens
  }
  usage.totalTokens = value.totalTokens ?? sum
  return usage
}
function receipt(request, usage, outcome, now) {
  const normalized = normalizeUsage(usage)
  if (request.status === 'settled') {
    if (JSON.stringify(request.usage) !== JSON.stringify(normalized) || request.outcome !== outcome) fail('REQUEST_ID_CONFLICT', 'A settled request cannot receive a different final receipt.')
    return true
  }
  if (request.status === 'failed') {
    if (JSON.stringify(request.usage) !== JSON.stringify(normalized) || request.outcome !== outcome) fail('REQUEST_ID_CONFLICT', 'A failed request cannot receive a different final receipt.')
    return true
  }
  request.usage = normalized
  request.outcome = outcome
  request.endedAt = iso(now)
  if (outcome === 'failed' && !normalized) {
    // A terminal provider failure never produced a usage receipt. Charge the
    // reservation upper bound so the attempt is not counted as zero and does not
    // poison every later request as open-ended uncertainty.
    if (Number.isSafeInteger(request.reservedTokens) && request.reservedTokens >= 0) {
      request.status = 'failed'
      request.chargeTokens = request.reservedTokens
      request.pendingReason = null
      request.uncertainty = 'terminal-failure-charged-upper-bound'
    } else {
      request.status = 'pending'
      request.pendingReason = 'Terminal failure without a bounded reservation.'
    }
    return false
  }
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
    const limits = budgetOf(round)
    // Every reserved attempt remains a row, including failure, interruption and retry. The ceiling
    // adds the closeout reserve because those slots are held for the closing sequence and are
    // charged there (see closeoutSpentOf); ordinary work is kept below limits.requests below.
    const reserve = closeoutReserveOf(round)
    if (Object.keys(round.usage.requests).length >= limits.requests + reserve.requests)
      fail('REQUEST_BUDGET_REACHED', 'No observable model attempt slots remain.')
    if (options.maxTokens > limits.outputCap) fail('OUTPUT_CAP_EXCEEDED', 'The frozen stream request exceeds its authorized output cap.')
    const totals = usageTotals(round), limit = limits.tokens
    const reservedTokens = options.inputTokens + options.maxTokens
    if (!Number.isSafeInteger(reservedTokens)) fail('BAD_RESERVATION', 'Reservation overflow.')
    // The closing sequence must stay affordable once ordinary room is gone: the review run, the
    // evidence write and the closing call may draw on the reserve, while ordinary work must leave it
    // untouched. Since .34 a plan holding command evidence may dispatch the missing review, so a round
    // that ran out after work closed can still finish; before that evidence the old limit stands.
    // Nothing here bypasses the grant: the project envelope is asserted either way.
    const spent = closeoutSpentOf(round)
    const hasCommandEvidence = round.evidence.some(row => row.layer === 'command')
    const closingRole = execution.role === 'review' || (execution.role === 'plan' && hasCommandEvidence)
    // A closing request's own input estimate is written into round.usage.estimates by noteEstimate
    // at the end of this same transaction. Judge the draw against a hold that includes it, so a
    // request larger than the pre-draw hold cannot slip through and leave the rest of the closing
    // turn uncovered (the P1 failure shape: four draws averaged above the per-request estimate).
    const closingReserve = closingRole ? closeoutReserveOf(round, options.inputTokens) : reserve
    const remainingMs = round.time ? Math.max(0, Date.parse(round.time.deadlineAt) - now) : Number.POSITIVE_INFINITY
    const windowOpen = remainingMs === Number.POSITIVE_INFINITY || remainingMs > reserve.timeMs
    const slotsFree = limits.requests - Object.keys(round.usage.requests).length
    const ordinarySlots = slotsFree - 1 - reserve.requests >= 0
    const projected = totals.totalTokens + totals.pendingReserved + reservedTokens
    const ordinaryTokens = !limit || (!totals.attributionUnknown && !totals.unknownReservations && projected + reserve.tokens <= limit)
    let closing = false
    if (!(ordinarySlots && windowOpen && ordinaryTokens)) {
      if (closingRole) {
        if (spent.requests + 1 > closingReserve.requests)
          fail('CLOSEOUT_RESERVE_PROTECTED', 'The closeout reserve has no request left; report the real state instead of looping.')
        if (spent.tokens + reservedTokens > closingReserve.tokens)
          fail('CLOSEOUT_RESERVE_PROTECTED', 'The closeout reserve cannot cover another request of this size.')
        closing = true
      } else {
        // Report the genuine limit first: the reserve codes only describe a round that still has
        // room for its closing sequence but not for more ordinary work.
        if (projected > limit || totals.attributionUnknown || totals.unknownReservations)
          fail('TOKEN_BUDGET_REACHED', 'Known usage, uncertainty or pending reservations leaves no room for this request.')
        if (slotsFree < 1) fail('REQUEST_BUDGET_REACHED', 'No observable model attempt slots remain.')
        if (!windowOpen) fail('CLOSEOUT_WINDOW_TOO_SMALL', 'The remaining round time is inside the closeout reserve; close or stop instead of starting new work.')
        fail('CLOSEOUT_RESERVE_PROTECTED', 'This request would eat the closeout reserve; if command evidence already exists the plan may dispatch review and close from the reserve. An empty round (nothing dispatched) can still be closed as abortedEmpty; a dispatched round without command and review rows cannot close.')
      }
    }
    if (store.requiresAuthorization) {
      assertProjectAdmission(state, now, reservedTokens)
      if (!closing) {
        try { assertProjectAdmission(state, now, reservedTokens + reserve.tokens) }
        catch (error) {
          if (error.code === 'PROJECT_TOKEN_BUDGET_REACHED')
            fail('CLOSEOUT_RESERVE_PROTECTED', 'The project token envelope has no room left above the closeout reserve; close instead of starting new work.')
          throw error
        }
      }
    }
    if (limit && projected > limit)
      fail('TOKEN_BUDGET_REACHED', 'Known usage, uncertainty or pending reservations leaves no room for this request.')
    const request = { id: requestId, ...identity, role: execution.role, phase: execution.phase,
      provider: options.provider, model: options.model, purpose: options.purpose ?? 'agent',
      reservedTokens, inputEstimate: options.inputTokens, outputCap: options.maxTokens,
      estimate: true, fingerprint, status: 'pending', startedAt: iso(now), usage: null }
    round.usage.requests[requestId] = request
    if (closing) round.usage.closeout = { requests: spent.requests + 1, tokens: spent.tokens + reservedTokens }
    noteEstimate(round, execution.role, options.inputTokens)
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
    if (!sessionId) { await unknownAttribution(controller); fail('ATTRIBUTION_REQUIRED', 'Cannot admit an unattributed model attempt.') }
    const exec = resolveExec(ctx, { sessionId })
    if (!exec.bindingValid) fail('ROLE_BINDING_INVALID', exec.bindingError)
    const admission = await controller.forSession(sessionId), requestId = newId('Q')
    if (!admission) {
      const store = controller.storeForCwd(exec.cwd)
      // Match request/tool scope; authorityRoot alone does not enroll an ordinary session.
      const protectedScope = await store.read(state => Boolean(state.authorization || (state.activeRoundId && !state.rounds[state.activeRoundId]?.closedAt)))
      if (exec.role || protectedScope) fail('MANAGED_ROUND_REQUIRED', 'Unbound role/standard cannot bypass a protected round. Pre-round model bootstrap requires trusted external admission.')
      yield* next(); return
    } else {
      try {
        await reserveRequest(admission.store, admission.identity, requestId, { provider: options.provider, model: options.model,
          maxTokens: options.maxTokens, inputTokens: inputReservation(options), purpose: options.purpose }, controller.now())
      } catch (error) {
        if (error.code === 'TOKEN_BUDGET_REACHED') await controller.autoStop(admission.store, admission.identity.roundId, 'token-budget')
        throw error
      }
    }
    let usage = null, outcome = 'interrupted', terminalFailure = false
    try {
      for await (const chunk of next()) {
        if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') terminalFailure = true
        if (chunk && chunk.type === 'error') terminalFailure = true
        if (chunk.type === 'usage' || chunk.usage) usage = normalizeUsage(chunk.usage)
        yield chunk
      }
      outcome = terminalFailure ? 'failed' : 'completed'
    } catch (error) {
      outcome = 'failed'
      throw error
    } finally {
      // Latest receipt per attempt, not sum-of-usage-snapshots.
      await settleRequest(admission.store, admission.identity, requestId, usage, outcome, controller.now())
      await stopIfBudgetHeld(controller, admission.store, admission.identity.roundId)
    }
  }))
  return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }
}
