import { randomUUID } from 'node:crypto'
import { fail } from './errors.js'

export const DEFAULT_WALL_MINUTES = 90
export const DEFAULT_OUTPUT_CAP = 2048
export const iso = (at = Date.now()) => new Date(at).toISOString()
export const newId = prefix => `${prefix}-${randomUUID()}`
export const unknown = value => value === true || value === false ? value : 'unknown'

export function roundOf(state, id) {
  const round = state.rounds[id ?? state.activeRoundId]
  if (!round) fail('NO_ROUND', 'No such round; open a round before dispatch or compute.')
  return round
}

export function budgetOf(round) {
  const source = round.budget ?? {}
  const number = (name, fallback, min, max = Number.MAX_SAFE_INTEGER, integer = true) => {
    const value = source[name] ?? fallback
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
      fail('BAD_BUDGET', `${name} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}].`)
    return value
  }
  return {
    tokens: number('tokens', 0, 0), testFailures: number('testFailures', 3, 1),
    fixes: number('fixes', 2, 1), reruns: number('reruns', 2, 1), restarts: number('restarts', 3, 1),
    wallMinutes: number('wallMinutes', DEFAULT_WALL_MINUTES, 0.001, DEFAULT_WALL_MINUTES, false),
    outputCap: number('outputCap', DEFAULT_OUTPUT_CAP, 1),
  }
}

export function initRuntime(state, round, exec, now = Date.now()) {
  const id = newId('E')
  round.control = { version: 1, managed: true, phase: 'planning', resumeBlocked: false,
    state: 'running', checkedAt: iso(now), stops: {}, blockers: [] }
  round.executions = {
    [id]: { id, roundId: round.id, kind: 'agent', role: 'plan', root: true,
      childSessionId: exec.sessionId, parentSessionId: null, generation: 1, phase: 'planning',
      state: 'running', createdAt: iso(now), agentQuiescent: false, jobsQuiescent: true,
      resumeBlocked: false, evidenceRefs: [] },
  }
  round.usage = { requests: {} }
  state.sessionBindings ??= {}
  const prev = state.sessionBindings[exec.sessionId]
  round.executions[id].generation = (prev?.generation ?? 0) + 1
  state.sessionBindings[exec.sessionId] = { roundId: round.id, executionId: id,
    generation: round.executions[id].generation }
  for (const request of Object.values(state.planningUsage ?? {})) {
    if (request.sessionId !== exec.sessionId || request.adoptedTo) continue
    const identity = { sessionId: exec.sessionId, roundId: round.id, executionId: id, generation: round.executions[id].generation }
    round.usage.requests[request.id] = { ...request, ...identity }
    request.adoptedTo = identity
  }
  return id
}

export function freezeDeadline(round) {
  if (round.time) return round.time
  if (!round.baseline) fail('NO_BASELINE', 'Freeze the original T0 first.')
  const started = Date.parse(round.baseline.frozenAt)
  const durationMs = Math.round(budgetOf(round).wallMinutes * 60_000)
  const shutdownGraceMs = Math.min(2000, Math.max(10, Math.floor(durationMs / 4)))
  round.time = { t0: round.baseline.frozenAt, durationMs, shutdownGraceMs,
    deadlineAt: iso(started + durationMs), signalDueAt: iso(started + durationMs - shutdownGraceMs) }
  return round.time
}

export function assertAdmissible(round, now = Date.now(), { baseline = false, phase } = {}) {
  if (round.closedAt) fail('ROUND_CLOSED', 'This round is closed.')
  if (round.control?.managed !== true) fail('UNMANAGED_ROUND', 'Legacy work is not adopted as controlled or stopped; its exit remains unknown.')
  if (round.control.resumeBlocked) fail('RESUME_BLOCKED', 'A durable stop intent forbids further execution in this round.')
  if (round.control.limitHold) fail('LIMIT_REACHED', 'A failure/retry limit is on hold; no additional work is admitted.')
  if (phase && round.control.pausedPhases?.[phase]) fail('STEP_BLOCKED', `This step is paused: ${round.control.pausedPhases[phase]}`)
  if (baseline && !round.baseline) fail('NO_BASELINE', 'Compute requires the original frozen T0.')
  if (round.time && now >= Date.parse(round.time.signalDueAt)) fail('DEADLINE_REACHED', 'The fixed T0 deadline is in shutdown grace; no new work is admitted.')
}

export function bindingOf(state, sessionId) {
  const binding = state.sessionBindings?.[sessionId]
  if (!binding) return null
  const round = state.rounds[binding.roundId]
  const execution = round?.executions?.[binding.executionId]
  if (!round || !execution || execution.generation !== binding.generation || execution.childSessionId !== sessionId)
    fail('IDENTITY_MISMATCH', 'Session binding does not match its execution generation.')
  return { binding, round, execution }
}

export function assertMember(state, round, exec, { allowStopped = false } = {}) {
  const found = bindingOf(state, exec.sessionId)
  if (!found || found.round.id !== round.id) fail('NOT_ROUND_MEMBER', 'The actual caller is not a member of this round.')
  if (!allowStopped && found.execution.resumeBlocked) fail('RESUME_BLOCKED', 'This execution generation cannot be resumed.')
  return found.execution
}

export function currentFence(state, execution) {
  if (execution.kind === 'job') return true
  const binding = state.sessionBindings?.[execution.childSessionId]
  return Boolean(binding && binding.roundId === execution.roundId && binding.executionId === execution.id &&
    binding.generation === execution.generation)
}

export function activeExecutions(round) {
  return Object.values(round.executions ?? {})
}

export function executionScope(round, executionId) {
  const selected = new Set([executionId]), all = activeExecutions(round)
  let changed = true
  while (changed) {
    changed = false
    for (const e of all) if (selected.has(e.parentExecutionId) && !selected.has(e.id)) { selected.add(e.id); changed = true }
  }
  return all.filter(e => selected.has(e.id))
}

export function aggregate(round, now = Date.now()) {
  const executions = activeExecutions(round)
  const combine = values => values.some(value => value === false) ? false : values.every(value => value === true) ? true : null
  const agents = executions.filter(e => e.kind === 'agent')
  const jobs = executions.filter(e => e.kind === 'job')
  // Legacy and identity/inventory failures are unknown, never an empty successful scope.
  const inventoryKnown = round.control?.managed === true && round.control?.inventoryUnknown !== true
  const agentQuiescent = inventoryKnown ? combine(agents.map(e => e.agentQuiescent)) : null
  const jobsQuiescent = inventoryKnown ? combine(jobs.map(e => e.jobsQuiescent)) : null
  const stopped = agentQuiescent === true && jobsQuiescent === true
  const naturallyDone = executions.length > 0 && executions.every(e => e.state === 'completed')
  const state = naturallyDone ? 'completed' : round.control?.resumeBlocked ? (stopped ? 'stopped' : 'stop-pending') : 'running'
  return { state, agentQuiescent: unknown(agentQuiescent), jobsQuiescent: unknown(jobsQuiescent),
    resumeBlocked: round.control?.resumeBlocked === true, checkedAt: iso(now),
    evidenceRefs: [...new Set(executions.flatMap(e => e.evidenceRefs ?? []))].slice(-8) }
}

export function requestStopIntent(state, round, args, now = Date.now()) {
  const reason = String(args.reason ?? '').trim()
  const requestId = String(args.requestId ?? '').trim()
  if (!reason || !requestId) fail('BAD_ARGS', 'Stop requires a reason and stable requestId.')
  if (!round.control?.managed) fail('UNMANAGED_ROUND', 'Unknown historical work cannot be reported as controlled or stopped.')
  const scope = args.executionId ? 'execution' : 'round'
  const target = args.executionId ? round.executions?.[args.executionId] : null
  if (scope === 'execution' && (!target || target.generation !== args.generation))
    fail('STALE_EXECUTION', 'Execution id and exact generation are required; no current session is cancelled by a stale request.')
  round.control.stops ??= {}
  const previous = round.control.stops[requestId]
  const identity = JSON.stringify([scope, target?.id ?? null, target?.generation ?? null, reason])
  if (previous) {
    if (previous.identity !== identity) fail('REQUEST_ID_CONFLICT', 'This requestId already identifies a different stop.')
    return { duplicate: true, stop: previous, targets: previous.targets }
  }
  // An old round/generation never gains authority over a reused child.
  const all = activeExecutions(round)
  const selected = new Set(target ? [target.id] : all.map(e => e.id))
  // Cancelling a coordinator covers its registered Agent/job descendants as well.
  if (target) {
    let changed = true
    while (changed) {
      changed = false
      for (const e of all) if (selected.has(e.parentExecutionId) && !selected.has(e.id)) { selected.add(e.id); changed = true }
    }
  }
  const targets = all.filter(e => selected.has(e.id))
  for (const e of targets) {
    if (!currentFence(state, e) && e.agentQuiescent !== true)
      fail('STALE_EXECUTION', 'Unconfirmed old execution no longer owns this session; not signalling a new generation.')
    e.resumeBlocked = true
    e.stopRequestedAt ??= iso(now)
    // Natural completion is not retroactively relabelled a successful cancellation.
    if (e.state !== 'completed' && e.state !== 'stopped') e.state = 'stopping'
  }
  if (scope === 'round') { round.control.resumeBlocked = true; round.control.state = 'stop-pending' }
  const stop = { requestId, scope, reason, identity, requestedAt: iso(now),
    source: args.source, targets: targets.map(e => e.id), admission: 'persisted' }
  round.control.stops[requestId] = stop
  round.control.checkedAt = iso(now)
  return { duplicate: false, stop, targets: stop.targets }
}

export function usageTotals(round) {
  const requests = Object.values(round.usage?.requests ?? {})
  const settled = requests.filter(r => r.status === 'settled')
  const pending = requests.filter(r => r.status !== 'settled')
  // An interrupted request may still have a known lower-bound receipt. Keep it,
  // while reserving the unconfirmed remainder rather than charging it twice.
  const sums = requests.filter(r => r.usage).reduce((sum, r) => ({ inputTokens: sum.inputTokens + r.usage.inputTokens,
    outputTokens: sum.outputTokens + r.usage.outputTokens, totalTokens: sum.totalTokens + r.usage.totalTokens,
    cacheReadTokens: sum.cacheReadTokens + (r.usage.cacheReadTokens ?? 0),
    cacheWriteTokens: sum.cacheWriteTokens + (r.usage.cacheWriteTokens ?? 0),
    reasoningTokens: sum.reasoningTokens + (r.usage.reasoningTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
  return { ...sums, requests: requests.length, settledRequests: settled.length, pendingRequests: pending.length,
    pendingReserved: pending.reduce((sum, r) => sum + Math.max(0, (r.reservedTokens ?? 0) - (r.usage?.totalTokens ?? 0)), 0),
    unknownReservations: pending.filter(r => !Number.isSafeInteger(r.reservedTokens)).length,
    attributionUnknown: round.usage?.attributionUnknown === true,
    unattributedAttempts: round.usage?.unattributedAttempts ?? 0,
    knownUsageIsLowerBound: pending.length > 0 || round.usage?.attributionUnknown === true,
    cost: { amount: null, currency: null, status: 'unknown', note: 'Token usage is not a billed invoice; no price was supplied.' } }
}

export function briefStatus(round, now = Date.now()) {
  const status = aggregate(round, now), usage = usageTotals(round), limits = budgetOf(round)
  const executions = activeExecutions(round)
  return {
    goal: { roundId: round.id, target: round.goal, scope: round.scope ?? round.goal,
      t0: round.baseline ? { id: round.baseline.t0Id, commit: round.baseline.commit, at: round.baseline.frozenAt } : null },
    execution: { phase: round.control?.phase ?? 'legacy', active: executions.filter(e => e.agentQuiescent !== true || e.jobsQuiescent !== true)
      .map(e => ({ id: e.id, generation: e.generation, role: e.role ?? 'compute', kind: e.kind, state: e.state })).slice(0, 8), ...status },
    budget: { deadlineAt: round.time?.deadlineAt ?? null, signalDueAt: round.time?.signalDueAt ?? null,
      remainingMs: round.time ? Math.max(0, Date.parse(round.time.deadlineAt) - now) : null,
      tokens: { limit: limits.tokens, ...usage }, failures: round.counters,
      failedTests: Object.values(round.failures ?? {}).reduce((sum, row) => sum + row.count, 0) },
    artifact: { version: round.closeout?.version ?? null,
      key: (round.evidence ?? []).filter(e => e.layer === 'artifact').slice(-2).map(e => ({ id: e.id, path: e.payload.path })) },
    blockers: [...(round.control?.blockers ?? []), ...(status.agentQuiescent === 'unknown' || status.jobsQuiescent === 'unknown'
      ? ['Exit proof is incomplete; do not label this scope stopped.'] : []),
      ...(executions.some(e => e.nativeAdmissionPending && e.jobsQuiescent !== true && !e.nativeAdmissionConfirmedAt)
        ? ['Stop intent is durable, but native admission closure is still unconfirmed.'] : []), ...(usage.attributionUnknown ? ['Provider attribution is unknown; budget admission is blocked.'] : []),
      ...(usage.pendingRequests ? ['Some provider usage remains pending.'] : [])].slice(0, 6),
    next: { action: round.closedAt ? 'Closed; use a new root plan session for a new objective. No automatic resume.' : status.resumeBlocked ? 'Confirm outstanding exits; do not resume this round.' : 'Continue the authorized stage with the same work coordinator.',
      owner: round.control?.resumeBlocked ? 'control-owner' : 'work', details: 'chain_status({detail:"full"})' },
  }
}
