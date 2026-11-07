// Host-owned capabilities, not roster ids, authorize cancellation.
import { randomUUID } from 'node:crypto'
import { forCwd, forSession, forRound, canonicalCwd } from './store.js'
import { resolve, relative, dirname, basename, sep, isAbsolute } from 'node:path'
import { resolveExec } from './roles.js'
import { serviceOf, bounded } from './host.js'
import { fail } from './errors.js'
import { aggregate, assertAdmissible, assertMember, bindingOf, budgetOf, currentFence,
  iso, newId, requestStopIntent, roundOf, usageTotals, executionScope } from './runtime.js'
import { DISPATCH_AUTHORITY, pickProvider, policyFor, rosterKey } from './dispatch.js'
import { executionDir, launchManagedJob, readJobProof, signalManagedJob } from './managed-jobs.js'
import { acquireAdmissionLock } from './admission.js'
import { authorizeProject, assertProjectAdmission, parseAuthorizationInput } from './authorization.js'
import { openRound } from './service.js'
import { WorkflowToolVisibility } from './workflow-tools.js'

const USER = Symbol('genuine-human-command')
const OWNER = Symbol('preauthorized-controller')

/**
 * A configured custom runner (`sandbox.runnerCommand`) is an operator assertion
 * that executes the command inside its own guest. The host must then NOT resolve
 * `argv[0]` against the Windows PATH: a guest command such as `sh` does not exist
 * on the host and must be resolved inside the guest by the runner profile.
 */
export function hasGuestRunner(sandbox) {
  try {
    const rules = sandbox?.configuredRunnerFailureSignatures
    if (Array.isArray(rules) && rules.length > 0) return true
    const runner = sandbox?.runnerCommand
    if (Array.isArray(runner) && runner.length > 0) return true
  } catch { /* a service proxy may hide internals; fall back to host resolution */ }
  return false
}
const SAFE_PARAMETERS = { read: ['file_path'], read_image: ['file_path'], glob: ['pattern'], grep: ['pattern'],
  write: ['file_path', 'content'], edit: ['file_path', 'old_string', 'new_string'], todo_write: ['todos'],
  web_fetch: ['url'], web_search: ['queries'] }
const STOP_SAFE = new Set(['chain_status', 'chain_stop', 'chain_export_audit', 'chain_record_evidence', 'chain_close_round',
  'read', 'read_image', 'glob', 'grep'])

/**
 * Bounded in-call wait for an execution to settle. It polls the durable ledger
 * only (never the model), so a tool call can wait for a real job/child exit
 * while its owner session is still alive instead of returning early and letting
 * the Host dispose the owned job. No state is fabricated: on timeout the caller
 * receives `settled:false` and the execution stays as it is.
 */
async function raceSettled(promise, timeoutMs, signal) {
  if (!promise) return false
  if (signal?.aborted) return false
  let timer
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(0, Number(timeoutMs) || 0)) })
  const aborted = new Promise(resolve => { if (signal) signal.addEventListener('abort', () => resolve('aborted'), { once: true }) })
  try { const outcome = await Promise.race([promise.then(() => 'settled', () => 'settled'), timeout, aborted]); return outcome === 'settled' }
  finally { clearTimeout(timer) }
}

async function waitForSettled(store, roundId, executionId, timeoutMs, signal) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  const isJob = String(executionId).startsWith('J-')
  let last = null
  while (Date.now() < deadline) {
    if (signal?.aborted) return { settled: false, aborted: true, execution: last }
    last = await store.read(state => state.rounds?.[roundId]?.executions?.[executionId] ?? null)
    if (last) {
      if (isJob && last.jobsQuiescent !== null && last.jobsQuiescent !== undefined)
        return { settled: true, execution: last }
      if (!isJob && ['completed', 'stopped', 'failed'].includes(last.state))
        return { settled: true, execution: last }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { settled: false, execution: last }
}

export class ChainController {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.now = options.now ?? Date.now
    // The installed default is a normal Host session with role collaboration.
    // Existing durable controlled tasks always retain their original policy.
    this.workflowByDefault = options.workflowByDefault === true
    // Trusted apply-time configuration only, never model tool arguments.
    this.storeOptions = options.authorityRoot ? { authorityRoot: options.authorityRoot } : {}
    this.hostId = randomUUID()
    this.stores = new Map()
    this.sessions = new Map()
    this.live = new Map()
    this.barriers = new Set()
    this.timers = new Map()
    this.observations = new Map()
    this.allowedDefinitions = new Set()
    this.allowedExecutors = new Set()
    this.safeDefinitions = new Map()
    this.disposers = []
    this.pending = new Set()
    this.closed = false
    this.workflowTools = new WorkflowToolVisibility(this, { enabled: this.workflowByDefault })
  }
  storeForCwd(cwd) { return forCwd(cwd, this.storeOptions) }
  storeForExec(exec) {
    if (!this.storeOptions.authorityRoot) return this.storeForCwd(exec.cwd)
    const lineage = this.sessionLineage(exec)
    let rootSessionId = exec.role === 'plan' && exec.isRoot ? exec.sessionId : null
    if (this.workflowByDefault && !lineage.incomplete && !rootSessionId) {
      const root = resolveExec(this.ctx, { sessionId: lineage.ids.at(-1) })
      if (root.bindingValid && root.role === 'plan' && root.isRoot) rootSessionId = root.sessionId
    }
    return forSession(exec.cwd, lineage.ids, {
      ...this.storeOptions,
      ...(rootSessionId ? { rootSessionId } : {}),
    })
  }
  sessionLineage(exec) {
    const sessions = serviceOf(this.ctx, 'sessions'), ids = [], seen = new Set()
    let id = exec.sessionId
    while (id) {
      if (seen.has(id) || ids.length >= 128) fail('SESSION_LINEAGE_INVALID', 'Session ancestry is cyclic or exceeds the supported depth.')
      seen.add(id); ids.push(id)
      const session = sessions?.get?.(id)
      // Include the missing parent's id so its durable membership still wins.
      if (!session) return { ids, incomplete: true }
      if (String(session.id) !== id || String(session.header?.id) !== id)
        fail('SESSION_LINEAGE_INVALID', 'Session ancestry does not match the Host session identity.')
      // User-created forks are independent chats, like a new ordinary root.
      // Only Host-created subagents inherit delegated execution membership.
      if (session.header.origin !== 'subagent') return { ids, incomplete: false }
      const parent = session.header.parentSession
      if (parent == null) {
        if (session.header.origin === 'subagent') fail('SESSION_LINEAGE_INVALID', 'A subagent is missing its Host parent session.')
        return { ids, incomplete: false }
      }
      if (typeof parent !== 'string' || !parent.trim()) fail('SESSION_LINEAGE_INVALID', 'Session ancestry contains an invalid parent id.')
      id = parent
    }
    return { ids, incomplete: false }
  }
  protectsSession(state, exec) {
    const { ids, incomplete } = this.sessionLineage(exec)
    // Enrollment belongs to sessions and delegated subagents, never every chat sharing a cwd.
    if (ids.some(id => Object.hasOwn(state.sessionBindings ?? {}, id) || state.authorization?.sessionId === id)) return true
    if (incomplete) fail('SESSION_LINEAGE_UNAVAILABLE', 'The source session is not loaded; reopen it before using this derived session so controlled ancestry can be checked.')
    return false
  }
  isWorkflowSession(exec, store, state) {
    if (!this.workflowByDefault || !exec.bindingValid || !exec.role || this.closed) return false
    store ??= this.storeForExec(exec)
    this.assertSessionLocation(store, exec)
    state ??= store.snapshot()
    if (this.protectsSession(state, exec) || state.authorization || Object.keys(state.rounds ?? {}).length) return false
    const lineage = this.sessionLineage(exec)
    if (lineage.incomplete) fail('SESSION_LINEAGE_UNAVAILABLE', 'Reopen the source plan session before continuing this delegated task.')
    const rootId = lineage.ids.at(-1)
    const root = rootId === exec.sessionId ? exec : resolveExec(this.ctx, { sessionId: rootId })
    return root.bindingValid && root.role === 'plan' && root.isRoot === true
  }
  assertSessionLocation(store, exec) {
    const known = this.sessions.get(exec.sessionId)
    if (known && known.store.key !== store.key)
      fail('EXECUTION_SCOPE_CHANGED', 'A protected session cannot leave its original project ledger by changing cwd.')
    for (const id of this.sessionLineage(exec).ids) store.assertSessionLocation(id)
  }
  log(error) { try { this.ctx.logger?.warn?.(`[role-chain] ${error?.message ?? error}`) } catch {} }
  track(promise) {
    const task = Promise.resolve(promise).catch(error => { this.log(error); return undefined }).finally(() => this.pending.delete(task))
    this.pending.add(task)
    return task
  }
  barrierKey(store, roundId, executionId = '*') { return `${store.key}\0${roundId}\0${executionId}` }
  blocked(store, execution) {
    if (this.closed || this.barriers.has(this.barrierKey(store, execution.roundId))) return true
    const round = store.snapshot().rounds[execution.roundId], seen = new Set()
    for (let e = execution; e && !seen.has(e.id); e = round?.executions?.[e.parentExecutionId]) {
      if (this.barriers.has(this.barrierKey(store, e.roundId, e.id))) return true
      seen.add(e.id)
    }
    return false
  }
  assertLiveAdmission(store, execution) {
    if (this.blocked(store, execution)) fail('RESUME_BLOCKED', 'Stop admission is closed before any signal is sent.')
    const state = store.snapshot(), round = roundOf(state, execution.roundId)
    if (store.requiresAuthorization) assertProjectAdmission(state, this.now())
    const e = round.executions?.[execution.id]
    assertAdmissible(round, this.now(), { phase: e?.phase })
    if (!e || e.generation !== execution.generation || e.resumeBlocked || !currentFence(state, e))
      fail('STALE_EXECUTION', 'This exact execution generation no longer has admission.')
  }
  registerDefinition(definition) { this.allowedDefinitions.add(definition); this.allowedExecutors.add(definition.execute) }
  async attach(store, exec) {
    this.stores.set(store.key, store)
    const found = await store.read(state => bindingOf(state, exec.sessionId))
    if (!found) return null
    const identity = { sessionId: exec.sessionId, roundId: found.round.id,
      executionId: found.execution.id, generation: found.execution.generation }
    this.sessions.set(exec.sessionId, { store, identity })
    if (exec.agent && found.execution.root && serviceOf(this.ctx, 'agents')?.get?.(exec.sessionId) === exec.agent) {
      const previous = this.live.get(found.execution.id)
      this.live.set(found.execution.id, { ...previous, store, execution: found.execution, agent: exec.agent, root: true })
    }
    this.arm(store, found.round)
    return { store, identity }
  }
  async forSession(sessionId) {
    if (!sessionId) return null
    const id = String(sessionId)
    const exec = resolveExec(this.ctx, { sessionId: id })
    if (!exec.bindingValid) fail('ROLE_BINDING_INVALID', exec.bindingError)
    const store = this.storeForExec(exec)
    this.assertSessionLocation(store, exec)
    if (this.isWorkflowSession(exec, store)) return null
    let known = this.sessions.get(id)
    if (!known) {
      const sessions = serviceOf(this.ctx, 'sessions'), session = sessions?.get?.(id)
      if (!session) return null
      known = await this.attach(store, exec)
    }
    if (!known) return null
    return known.store.read(state => {
      const found = bindingOf(state, id)
      if (!found) return null
      return { store: known.store, identity: { sessionId: id, roundId: found.round.id,
        executionId: found.execution.id, generation: found.execution.generation } }
    })
  }
  async beforeRequest(agent, signal) {
    if (signal?.aborted) fail('CANCELLED', 'The request was cancelled before admission.')
    const exec = resolveExec(this.ctx, { agent, signal }), store = this.storeForExec(exec)
    if (!exec.bindingValid) fail('ROLE_BINDING_INVALID', exec.bindingError)
    this.assertSessionLocation(store, exec)
    const workflow = this.isWorkflowSession(exec, store)
    this.workflowTools.sync(exec, workflow, [...this.allowedDefinitions].map(tool => tool.name))
    if (workflow) return null
    const admission = await this.attach(store, exec)
    if (!admission) {
      const protectedScope = await store.read(state => this.protectsSession(state, exec))
      if (exec.role || protectedScope) fail('MANAGED_ROUND_REQUIRED', exec.role === 'plan' && exec.isRoot
        ? '请先在本会话下方的「启动 plan」卡片中确认新任务目标和额度，再发送消息。新 plan 使用独立授权，不会占用或重置其他会话。'
        : 'A trusted preauthorized round binding is required before protected model I/O.')
      return null
    }
    const execution = await store.read(state => roundOf(state, admission.identity.roundId).executions[admission.identity.executionId])
    try { this.assertLiveAdmission(store, execution) } catch (error) {
      if (error.code === 'DEADLINE_REACHED') await this.autoStop(store, execution.roundId, 'deadline')
      throw error
    }
    await store.mutate(state => {
      const e = roundOf(state, execution.roundId).executions[execution.id]
      if (!currentFence(state, e) || e.resumeBlocked) fail('STALE_EXECUTION', 'Request fence changed.')
      e.agentQuiescent = false; e.state = 'running'
    })
    this.watchIdle(store, execution, agent)
    return admission
  }
  watchIdle(store, execution, agent) {
    if (!agent || typeof agent.whenIdle !== 'function') return
    const epoch = (this.observations.get(execution.id) ?? 0) + 1
    this.observations.set(execution.id, epoch)
    // Never await one's own whenIdle inside a tool or an agent/created callback.
    this.track(Promise.resolve().then(() => agent.whenIdle()).then(() => {
      if (this.observations.get(execution.id) === epoch) return this.proveAgent(store, execution, 'Agent.whenIdle')
    }))
  }
  arm(store, round) {
    const dueAt = round.time?.signalDueAt ?? round.authorization?.deadlineAt
    if (!dueAt || round.closedAt || round.control?.resumeBlocked) return
    const key = this.barrierKey(store, round.id)
    if (this.timers.has(key)) return
    const delay = Math.max(0, Date.parse(dueAt) - this.now())
    const timer = setTimeout(() => {
      this.timers.delete(key)
      this.track(this.autoStop(store, round.id, 'deadline'))
    }, Math.min(delay, 2_147_483_647))
    timer.unref?.()
    this.timers.set(key, timer)
  }
  async autoStop(store, roundId, reason) {
    return this.stopWithAuthority(store, { roundId, reason,
      requestId: `automatic:${roundId}:${reason}` }, { token: OWNER, source: reason })
  }
  async proveAgent(store, execution, method) {
    return store.mutate(state => {
      const round = state.rounds[execution.roundId], e = round?.executions?.[execution.id]
      if (!e || e.generation !== execution.generation) return
      // A late callback updates only its original record, never the new binding.
      e.agentQuiescent = true
      e.agentExitAt = iso(this.now())
      e.checkedAt = e.agentExitAt
      e.state = e.resumeBlocked ? (e.state === 'completed' ? 'completed' : 'stopped') : 'completed'
      e.evidenceRefs = [...new Set([...(e.evidenceRefs ?? []), `${method}:${e.id}:${e.generation}`])]
      if (e.signalAt) e.stopLatencyMs = Math.max(0, Date.parse(e.agentExitAt) - Date.parse(e.signalAt))
      round.control.checkedAt = e.checkedAt
      round.control.state = aggregate(round, this.now()).state
    })
  }
  async markNeverStarted(store, execution, reason) {
    await store.mutate(state => {
      const e = state.rounds[execution.roundId]?.executions?.[execution.id]
      if (!e || e.generation !== execution.generation) return
      e.agentQuiescent = true; e.jobsQuiescent = true
      e.state = e.resumeBlocked ? 'stopped' : 'completed'
      e.outcome = 'not-started'; e.checkedAt = iso(this.now()); e.error = reason
      e.evidenceRefs.push(`admission-rejected-before-start:${e.id}`)
    })
  }
  async observeActivation(store, execution, activation) {
    let result
    try { result = await activation.result } catch (error) { this.log(error) }
    // result may retain its original outcome after cleanup failure. dispose is the join receipt.
    await activation.dispose()
    await this.proveAgent(store, execution, 'activation.dispose-after-result')
    return result
  }
  async dispatch(store, exec, args) {
    const role = String(args.role ?? '').trim(), task = String(args.task ?? '').trim()
    // Closing exception: a plan that already holds command evidence may dispatch the independent
    // review that finishes the round. Without it a round whose ordinary room ran out before work
    // dispatched review would have no legal terminal state. Before that evidence exists the old
    // rule stands (plan -> work only), so this cannot be used to start a review out of nowhere.
    const closesWithReview = exec.role === 'plan' && exec.isRoot === true && role === 'review'
    if (!(DISPATCH_AUTHORITY[exec.role] ?? []).includes(role) && !closesWithReview) fail('DISPATCH_DENIED', 'plan dispatches work; work dispatches code/review.')
    if (!task) fail('BAD_ARGS', 'A dispatch needs a task.')
    if (exec.signal?.aborted) fail('CANCELLED', 'The caller was cancelled.')
    const subagents = serviceOf(this.ctx, 'subagents'), provider = pickProvider(subagents)
    if (!provider) fail('UNSUPPORTED_BACKEND', 'Only the inspected local spawn provider is controlled; no remote fallback is attempted.')
    const maxDepth = subagents.resolveMaxDepth(args.maxDepth ?? 2)
    if (args.fresh && role !== 'review') fail('REUSE_POLICY_CONFLICT', 'fresh is only for independent review, not a replacement for busy/stopped work or code.')
    const policy = role === 'review' ? 'fresh' : policyFor(exec.reuse, role)
    if ((role === 'work' && policy !== 'persistent') || (role === 'code' && policy === 'fresh')) fail('REUSE_POLICY_CONFLICT', 'The configured policy cannot bypass the same-round coordinator/code slot.')
    const family = role === 'code' ? String(args.family ?? 'default').trim() || 'default' : null
    const intent = await store.mutate(state => {
      const round = roundOf(state, args.roundId), parent = assertMember(state, round, exec)
      if (closesWithReview && !round.evidence.some(row => row.layer === 'command'))
        fail('DISPATCH_DENIED', 'A plan may dispatch review only to finish a round that already holds command evidence; the first review is dispatched by work.')
      if (this.blocked(store, parent)) fail('RESUME_BLOCKED', 'An ancestor stop has already closed admission.')
      assertAdmissible(round, this.now(), { phase: args.phase ?? round.control.phase })
      if (role !== 'work' && !round.baseline) fail('NO_BASELINE', 'Only the coordinator may bootstrap before T0.')
      const stableKey = `${exec.sessionId}::${rosterKey(role, family, policy)}`
      // The round's immutable history is authoritative, not a removable roster row.
      // A policy change or release cannot manufacture another same-round slot.
      const sameSlot = role === 'review' ? [] : Object.values(round.executions).filter(e =>
        e.kind === 'agent' && e.role === role && e.parentSessionId === exec.sessionId &&
        (role !== 'code' || e.family === family || e.policy === 'persistent' || policy === 'persistent'))
      for (const prior of sameSlot) {
        if (prior.resumeBlocked) fail('RESUME_BLOCKED', 'This same-round role/family was stopped; a replacement is forbidden.')
        if (executionScope(round, prior.id).some(e => e.agentQuiescent !== true || e.jobsQuiescent !== true))
          fail('CHILD_BUSY', 'The same-round role/family still has unconfirmed work; do not replace it.')
      }
      const latest = sameSlot.at(-1)
      const entry = latest ? Object.values(state.agents ?? {}).find(e => e.executionId === latest.id) : null
      const previous = latest ? { ...(entry ?? {}), childId: latest.childSessionId, lastRoundId: round.id,
        executionId: latest.id, generation: latest.generation, createdAt: latest.createdAt } :
        policy !== 'fresh' ? state.agents?.[stableKey] : null
      if (previous) {
        const priorRound = state.rounds[previous.lastRoundId]
        const prior = priorRound?.executions?.[previous.executionId]
        const scope = prior ? executionScope(priorRound, prior.id) : []
        if (!prior || !scope.length || scope.some(e => e.agentQuiescent !== true || e.jobsQuiescent !== true))
          fail('CHILD_BUSY', 'The previous activation is not confirmed quiescent; do not spawn a duplicate coordinator.')
        if (prior.resumeBlocked && previous.lastRoundId === round.id) fail('RESUME_BLOCKED', 'A stopped activation cannot be woken in the same round.')
      }
      const childSessionId = previous?.childId ?? randomUUID(), id = newId('E')
      const generation = (state.sessionBindings?.[childSessionId]?.generation ?? 0) + 1
      const key = policy === 'fresh' ? `${stableKey}::${id}` : stableKey
      const execution = { id, roundId: round.id, kind: 'agent', role, parentExecutionId: parent.id,
        childSessionId, parentSessionId: exec.sessionId, generation, provider, policy, family,
        phase: String(args.phase ?? round.control.phase), state: 'launching', agentQuiescent: null,
        jobsQuiescent: true, resumeBlocked: false, createdAt: iso(this.now()), evidenceRefs: [], rosterKey: key }
      round.executions[id] = execution
      state.sessionBindings ??= {}
      state.sessionBindings[childSessionId] = { roundId: round.id, executionId: id, generation }
      state.agents ??= {}
      state.agents[key] = { role, family, childId: childSessionId, parentSessionId: exec.sessionId,
        policy, executionId: id, generation, lastRoundId: round.id, pending: true,
        uses: previous?.uses ?? 0, createdAt: previous?.createdAt ?? iso(this.now()) }
      if (args.phase) round.control.phase = String(args.phase)
      return { execution, previous, key }
    })
    const { execution, previous, key } = intent
    const abort = new AbortController()
    const live = { store, execution, parent: exec.agent, abort, provider }
    this.live.set(execution.id, live)
    this.sessions.set(execution.childSessionId, { store, identity: { sessionId: execution.childSessionId,
      roundId: execution.roundId, executionId: execution.id, generation: execution.generation } })
    const onAbort = () => this.track(this.stopWithAuthority(store, { roundId: execution.roundId,
      executionId: execution.id, generation: execution.generation, reason: 'caller-abort',
      requestId: `caller-abort:${execution.id}` }, { token: OWNER, source: 'caller-abort' }))
    exec.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (exec.signal?.aborted) { await onAbort(); this.assertLiveAdmission(store, execution) }
      this.assertLiveAdmission(store, execution)
      const content = [{ type: 'text', text: `[${execution.roundId}; ${execution.id}; generation ${execution.generation}]\n${task}` }]
      live.entered = true
      if (previous) {
        live.messageId = String(await subagents.sendMessage(exec.agent, execution.childSessionId, content, { signal: abort.signal }))
      } else {
        live.activation = await subagents.startActivation({ provider, childId: execution.childSessionId,
          label: `${role}: ${task.slice(0, 60)}`, request: { prompt: content, parent: exec.agent,
            agentPreset: role, cwd: exec.cwd, maxDepth }, signal: abort.signal, delivery: 'parent' })
        if (String(live.activation.childId) !== execution.childSessionId) fail('IDENTITY_MISMATCH', 'Provider returned a different reserved child id.')
        live.messageId = live.activation.messageId ? String(live.activation.messageId) : null
        this.track(this.observeActivation(store, execution, live.activation))
      }
      live.accepted = true
      await store.mutate(state => {
        const e = state.rounds[execution.roundId].executions[execution.id]
        e.acceptedAt = iso(this.now()); e.messageId = live.messageId
        if (e.agentQuiescent !== true) { e.agentQuiescent = false; if (!e.resumeBlocked) e.state = 'running' }
        const entry = state.agents[key]
        if (entry?.executionId === execution.id) { entry.pending = false; entry.uses += 1; entry.lastUsedAt = e.acceptedAt }
      })
      if (previous) {
        const agent = serviceOf(this.ctx, 'agents')?.get?.(execution.childSessionId)
        if (agent) { live.agent = agent; this.watchIdle(store, execution, agent) }
      }
      // A stop racing startup must reap the late handle before acknowledging success.
      try { this.assertLiveAdmission(store, execution) } catch (error) {
        await this.signalAgent(store, execution, { token: OWNER, source: 'late-start-reap' })
        return { ok: false, code: 'STOP_PENDING', roundId: execution.roundId, executionId: execution.id,
          childId: execution.childSessionId, generation: execution.generation, state: 'stop-pending' }
      }
      const dispatched = { ok: true, action: previous ? 'reuse' : 'spawn', role, policy, family,
        roundId: execution.roundId, executionId: execution.id, generation: execution.generation,
        childId: execution.childSessionId, messageId: live.messageId }
      // A bounded wait keeps the parent turn (and thus the child owner) alive
      // without spending extra model requests on status polling.
      const waitMs = Math.max(0, Math.min(Number(args.waitMs) || 0, 600000))
      if (!waitMs) return dispatched
      const waited = await waitForSettled(store, execution.roundId, execution.id, waitMs, exec.signal)
      if (waited.settled) await this.refresh(store, execution.roundId)
      const settled = waited.execution
      return { ...dispatched, wait: { settled: Boolean(waited.settled), aborted: Boolean(waited.aborted),
        state: settled?.state ?? null, agentQuiescent: settled?.agentQuiescent ?? null,
        jobsQuiescent: settled?.jobsQuiescent ?? null, exitCode: settled?.exitCode ?? null } }
    } catch (error) {
      if (live.entered) this.track(this.stopWithAuthority(store, { roundId: execution.roundId,
        executionId: execution.id, generation: execution.generation, reason: 'launch-failure',
        requestId: `launch-failure:${execution.id}` }, { token: OWNER, source: 'launch-failure-reap' }))
      else if (!previous && !live.acceptanceUncertain) {
        // Only known pre-start failures prove no resource. A provider rejection after entry is uncertain.
        const beforeEntry = !live.entered
        if (beforeEntry) await this.markNeverStarted(store, execution, error.message)
      }
      throw error
    } finally { exec.signal?.removeEventListener('abort', onAbort) }
  }
  async stop(store, exec, args) {
    const state = await store.read(state => state), round = roundOf(state, args.roundId)
    const caller = assertMember(state, round, exec, { allowStopped: true })
    if (!exec.agent || serviceOf(this.ctx, 'agents')?.get?.(exec.sessionId) !== exec.agent)
      fail('UNAUTHORIZED', 'Cancellation needs the exact live caller, not a session id or an obsolete Agent.')
    if (args.executionId) {
      const target = round.executions?.[args.executionId]
      const descendant = target && executionScope(round, caller.id).some(e => e.id === target.id)
      if (!target || (!caller.root && !descendant))
        fail('UNAUTHORIZED', 'Only the actual owner/ancestor may cancel this execution.')
      if (target.kind === 'job' && !caller.root) {
        const held = this.live.get(target.id)
        if (!held || held.store.key !== store.key || held.execution.nonce !== target.nonce)
          fail('UNAUTHORIZED', 'An ancestor also needs the held capability for this exact controlled job.')
      }
    } else if (!caller.root || exec.isRoot !== true || round.openedBy.sessionId !== exec.sessionId)
      fail('UNAUTHORIZED', 'Only the actual root may stop the whole round.')
    return this.stopWithAuthority(store, args, { agent: exec.agent, source: 'model-owner' })
  }
  async stopWithAuthority(store, args, authority) {
    if (authority.token !== USER && authority.token !== OWNER && !authority.agent) fail('UNAUTHORIZED', 'No cancellation capability.')
    const roundId = await store.read(state => roundOf(state, args.roundId).id)
    const key = this.barrierKey(store, roundId, args.executionId ?? '*')
    this.barriers.add(key) // Admission closes synchronously, before the durable write and before signals.
    let intent
    const locks = new Map(), lockErrors = new Map(), lockUntil = Date.now() + 750
    try {
      const before = await store.read(state => roundOf(state, roundId))
      const scope = args.executionId ? executionScope(before, args.executionId) : Object.values(before.executions ?? {})
      for (const e of scope.filter(e => e.kind === 'job' && e.jobsQuiescent !== true).sort((a, b) => a.id.localeCompare(b.id))) {
        try { locks.set(e.id, await acquireAdmissionLock(executionDir(store, e), Math.max(0, lockUntil - Date.now()))) }
        catch (error) { lockErrors.set(e.id, error.message) }
      }
      // This write is stop INTENT, not confirmation of the native admission fence.
      // Only a held lock + marker, or a joined empty range, confirms that fence.
      // On timeout an already admitted Create/Resume may still be in flight.
      intent = await store.mutate(state => requestStopIntent(state, roundOf(state, roundId), { ...args, source: authority.source }, this.now()))
      const committed = await store.read(state => roundOf(state, roundId))
      for (const id of intent.targets) if (locks.has(id)) {
        try {
          await signalManagedJob(store, committed.executions[id], intent.stop, this.now(), { admissionLocked: true })
          await store.mutate(state => {
            const e = state.rounds[roundId].executions[id]
            e.nativeAdmissionConfirmedAt ??= iso(this.now())
            e.nativeAdmissionPending = false
          })
        } catch (error) { lockErrors.set(id, error.message) }
      }
      if (lockErrors.size) await store.mutate(state => {
        for (const [id, message] of lockErrors) {
          const e = state.rounds[roundId].executions[id]
          if (e) { e.admissionError = message; e.nativeAdmissionPending = true }
        }
      })
    } catch (error) { if (!intent && error.code !== 'STATE_UNREADABLE') this.barriers.delete(key); throw error }
    finally { for (const release of [...locks.values()].reverse()) { try { await release() } catch (error) { this.log(error) } } }
    for (const id of lockErrors.keys()) this.live.get(id)?.processAbort?.abort(new Error('durable stop; admission lock unavailable'))
    const round = await store.read(state => roundOf(state, roundId))
    const tasks = []
    for (const id of intent.targets) {
      const execution = round.executions[id]
      tasks.push(this.track(execution.kind === 'job' ? this.signalJob(store, execution, intent.stop) : this.signalAgent(store, execution, authority)))
    }
    await bounded(Promise.all(tasks), Math.min(1000, Math.max(10, args.waitMs ?? 500)))
    await this.refresh(store, roundId)
    return store.read(state => {
      const current = roundOf(state, roundId)
      const scoped = intent.stop.scope === 'round' ? current : { ...current,
        executions: Object.fromEntries(intent.targets.map(id => [id, current.executions[id]])),
        control: { ...current.control, resumeBlocked: true } }
      const pendingNative = intent.targets.filter(id => {
        const e = current.executions[id]
        return e.kind === 'job' && e.jobsQuiescent !== true && !e.nativeAdmissionConfirmedAt
      })
      return { ok: true, roundId, requestId: intent.stop.requestId, scope: intent.stop.scope,
        duplicate: intent.duplicate, admission: 'persisted', nativeAdmission: pendingNative.length ? 'pending' : 'confirmed',
        pendingNativeExecutions: pendingNative, ...aggregate(scoped, this.now()) }
    })
  }
  async signalAgent(store, execution, authority) {
    const state = await store.read(state => state), e = state.rounds[execution.roundId]?.executions?.[execution.id]
    if (!e || e.generation !== execution.generation || e.agentQuiescent === true) return
    if (!currentFence(state, e)) return // Never signal the session's new activation.
    const live = this.live.get(e.id)
    await store.mutate(state => {
      const target = state.rounds[e.roundId].executions[e.id]
      target.signalAt ??= iso(this.now()); target.checkedAt = iso(this.now())
    })
    if (live?.abort) live.abort.abort(new Error('durable chain stop'))
    if (live?.activation) {
      await live.activation.dispose()
      await this.proveAgent(store, e, 'activation.dispose')
      return
    }
    // An absent drain target is not proof while a start/send is still awaiting admission.
    if (live?.entered && !live.accepted) return
    const subagents = serviceOf(this.ctx, 'subagents'), agents = serviceOf(this.ctx, 'agents')
    if (e.root) {
      const agent = live?.agent
      if (!agent || typeof agent.cancel !== 'function') return
      agent.cancel() // Only this exact held root; never a forged user authority object.
      if (typeof agent.whenIdle === 'function') { await agent.whenIdle(); await this.proveAgent(store, e, 'Agent.whenIdle-after-cancel') }
      return
    }
    if (live?.parent && typeof subagents?.drainChildren === 'function') {
      await subagents.drainChildren(live.parent, [e.childSessionId])
      await this.proveAgent(store, e, 'subagents.drainChildren')
      return
    }
    if (authority.token === USER && typeof subagents?.interrupt === 'function') {
      // Only the registered human command can enter this branch, including when the parent is offline.
      subagents.interrupt(e.childSessionId, { kind: 'user', parentSessionId: e.parentSessionId })
    } else if (authority.agent && typeof subagents?.interrupt === 'function') {
      subagents.interrupt(e.childSessionId, { kind: 'ancestor', agent: authority.agent })
    } else return
    const agent = agents?.get?.(e.childSessionId)
    if (agent && typeof agent.whenIdle === 'function') { await agent.whenIdle(); await this.proveAgent(store, e, 'Agent.whenIdle-after-interrupt') }
    // Missing/unreachable/accepted is not an exit receipt. Leave it unknown.
  }
  async stopWithAuthorityForJob(store, execution, reason) {
    const live = this.live.get(execution.id)
    if (!live || live.execution.nonce !== execution.nonce) fail('UNAUTHORIZED', 'No held capability for this controlled job.')
    return this.stopWithAuthority(store, { roundId: execution.roundId, executionId: execution.id,
      generation: execution.generation, requestId: `job-controller:${execution.id}`, reason: String(reason) },
    { token: OWNER, source: 'host-job-controller' })
  }
  async signalJob(store, execution, stop) {
    const current = await store.read(state => state.rounds[execution.roundId]?.executions?.[execution.id])
    if (!current || current.nonce !== execution.nonce || current.jobsQuiescent === true) return
    const live = this.live.get(execution.id)
    try { if (!current.signalAt) await signalManagedJob(store, execution, stop, this.now()) }
    catch (error) {
      live?.processAbort?.abort(new Error('durable stop; supervisor marker unavailable'))
      this.log(error)
    }
    if (live?.process) {
      const wait = await bounded(live.settlement, 800)
      if (!wait.settled) return
    }
    await this.refresh(store, execution.roundId)
  }
  async compute(store, exec, args) {
    if (!['work', 'code'].includes(exec.role)) fail('ROLE_DENIED', 'Only work/code may launch controlled compute.')
    if (!Array.isArray(args.argv) || !args.argv.length || args.argv.some(v => typeof v !== 'string' || v.includes('\0')))
      fail('BAD_ARGS', 'argv must be a non-empty string array.')
    const execution = await store.mutate(state => {
      const round = roundOf(state, args.roundId), parent = assertMember(state, round, exec)
      if (this.blocked(store, parent)) fail('RESUME_BLOCKED', 'An ancestor stop has already closed admission.')
      assertAdmissible(round, this.now(), { baseline: true, phase: args.phase ?? round.control.phase })
      const totals = usageTotals(round), limit = budgetOf(round).tokens
      if (limit && (totals.attributionUnknown || totals.unknownReservations || totals.totalTokens + totals.pendingReserved >= limit)) fail('TOKEN_BUDGET_REACHED', 'Round token budget is unavailable or uncertain.')
      const id = newId('J')
      const e = { id, roundId: round.id, kind: 'job', role: exec.role, parentExecutionId: parent.id,
        ownerSessionId: exec.sessionId, generation: 1, nonce: randomUUID(), state: 'launching',
        phase: String(args.phase ?? round.control.phase), agentQuiescent: true, jobsQuiescent: null,
        resumeBlocked: false, createdAt: iso(this.now()), evidenceRefs: [], backend: 'windows-job-list-v1' }
      round.executions[id] = e
      return e
    })
    this.live.set(execution.id, { store, execution })
    try {
      const subprocess = serviceOf(this.ctx, 'subprocess'), sandbox = serviceOf(this.ctx, 'sandbox')
      if (!subprocess) fail('NO_SUBPROCESS', 'No subprocess provider; no unmanaged fallback is allowed.')
      if (typeof sandbox?.confine !== 'function') fail('COMPUTE_ISOLATION_UNAVAILABLE', 'Controlled compute requires full read-only process confinement; no same-user unconfined fallback.')
      const platform = await subprocess.terminalEnvironment(exec.signal)
      if (platform.platform !== 'windows') fail('UNSUPPORTED_BACKEND', 'This adapter controls Windows Job objects only; remote/POSIX are uncovered.')
      const policy = { mode: 'read-only', workspaceRoot: store.rootDir, sessionId: exec.sessionId }
      let guestRunner = hasGuestRunner(sandbox)
      let executable = String(args.argv[0])
      if (!guestRunner) {
        try { executable = await subprocess.resolveExecutable(args.argv[0], undefined, exec.signal) }
        catch (error) {
          // A hidden custom-runner configuration still advertises full enforcement
          // for a guest-only command; the default rung stays partial and rethrows.
          const probe = await sandbox.confine([String(args.argv[0])], policy, exec.signal)
          if (probe?.enforcement !== 'full') throw error
          guestRunner = true
        }
      }
      const confined = await sandbox.confine([executable, ...args.argv.slice(1)], policy, exec.signal)
      if (confined?.enforcement !== 'full' || !Array.isArray(confined.argv) || !confined.argv.length ||
        confined.argv.some(v => typeof v !== 'string' || v.includes('\0')))
        fail('COMPUTE_ISOLATION_UNAVAILABLE', 'The sandbox did not supply full file-effect enforcement. Partial Windows ACL confinement is refused; nothing is launched.')
      const isolation = { mode: policy.mode, enforcement: confined.enforcement,
        source: guestRunner ? 'configured-guest-runner' : 'host-sandbox-contract' }
      await store.mutate(state => { state.rounds[execution.roundId].executions[execution.id].isolation = isolation })
      const result = await launchManagedJob(this.ctx, store, execution, { argv: confined.argv, requested: [...args.argv], isolation,
        cwd: exec.cwd, label: String(args.label ?? args.argv[0]) }, this)
      try { this.assertLiveAdmission(store, execution) } catch {
        await this.stopWithAuthority(store, { roundId: execution.roundId, executionId: execution.id, generation: 1,
          requestId: `late-job:${execution.id}`, reason: 'launch-cancel-race' }, { token: OWNER, source: 'late-job-reap' })
        return { ok: false, code: 'STOP_PENDING', ...result }
      }
      const computed = { ok: true, ...result }
      // Wait inside the same tool call: the owner session stays alive, so the
      // Host cannot dispose the job before it settles, and the caller receives
      // the real exit code without a status-polling turn. A guest-runner job is
      // waited for by default (bounded), because the owner session is released
      // at the end of this completion; args.waitMs === 0 restores fire-and-forget.
      const requested = args.waitMs === undefined ? (hasGuestRunner(sandbox) ? 45000 : 0) : Number(args.waitMs)
      const waitMs = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 0, 600000))
      if (!waitMs) return computed
      // Prefer the Host job settlement notification (live.settlement resolves
      // after the supervisor exit and the native Job-empty receipt); the ledger
      // poll is only a fallback for a controller without the live handle.
      const held = this.live.get(execution.id)
      const notified = held?.settlement ? await raceSettled(held.settlement, waitMs, exec.signal) : false
      const waited = notified
        ? { settled: true, execution: await store.read(state => state.rounds?.[execution.roundId]?.executions?.[execution.id] ?? null) }
        : await waitForSettled(store, execution.roundId, execution.id, waitMs, exec.signal)
      if (waited.settled) await this.refresh(store, execution.roundId)
      const done = waited.execution
      return { ...computed, wait: { settled: Boolean(waited.settled), aborted: Boolean(waited.aborted),
        state: done?.state ?? null, outcome: done?.outcome ?? null, exitCode: done?.exitCode ?? null,
        jobsQuiescent: done?.jobsQuiescent ?? null, deadlineMet: done?.deadlineMet ?? null,
        stdoutPath: done?.stdoutPath ?? null, stderrPath: done?.stderrPath ?? null,
        evidenceRefs: done?.evidenceRefs ?? [] } }
    } catch (error) {
      const live = this.live.get(execution.id)
      if (!live?.process) await this.markNeverStarted(store, execution, error.message)
      else this.track(this.stopWithAuthority(store, { roundId: execution.roundId, executionId: execution.id, generation: 1,
        requestId: `failed-job:${execution.id}`, reason: 'registration-failure' }, { token: OWNER, source: 'launch-failure-reap' }))
      throw error
    }
  }
  async refresh(store, roundId) {
    const round = await store.read(state => roundOf(state, roundId))
    for (const execution of Object.values(round.executions ?? {}).filter(e => e.kind === 'job' && e.jobsQuiescent !== true)) {
      const live = this.live.get(execution.id)
      // A readable nonce/receipt is correlation, not authority or a supervisor join.
      // After a host restart, absence of this exact capability remains unknown.
      if (live?.execution?.nonce !== execution.nonce || live.providerJoined !== true) continue
      const proof = await readJobProof(store, execution)
      if (!proof) continue
      await store.mutate(state => {
        const e = state.rounds[round.id]?.executions?.[execution.id]
        if (!e || e.nonce !== execution.nonce) return
        Object.assign(e, proof)
        if (e.providerExitError) e.jobsQuiescent = null
      })
    }
    await store.mutate(state => {
      const current = roundOf(state, roundId)
      if (current.control) Object.assign(current.control, { state: aggregate(current, this.now()).state, checkedAt: iso(this.now()) })
    })
  }
  async release(store, exec, args) {
    const entries = await store.read(state => Object.entries(state.agents ?? {}).filter(([, e]) =>
      e.parentSessionId === exec.sessionId && (!args.role || e.role === args.role) && (!args.family || e.family === args.family)))
    const released = [], pending = []
    for (const [key, entry] of entries) {
      const result = await this.stop(store, exec, { roundId: entry.lastRoundId, executionId: entry.executionId,
        generation: entry.generation, reason: 'release', requestId: `release:${entry.executionId}` })
      const confirmed = await store.read(state => executionScope(state.rounds[entry.lastRoundId], entry.executionId)
        .every(e => e.agentQuiescent === true && e.jobsQuiescent === true))
      if (!confirmed) { pending.push({ childId: entry.childId, ...result }); continue }
      await store.mutate(state => { if (state.agents[key]?.executionId === entry.executionId) delete state.agents[key] })
      released.push({ key, childId: entry.childId })
    }
    return { ok: pending.length === 0, released, pending }
  }
  guard(execution) {
    try {
      const exec = resolveExec(this.ctx, execution), store = this.storeForExec(exec)
      if (!exec.bindingValid) return `ROLE_BINDING_INVALID: ${exec.bindingError}`
      this.assertSessionLocation(store, exec)
      const state = store.snapshot()
      const found = bindingOf(state, exec.sessionId)
      if (!found && this.isWorkflowSession(exec, store, state)) return undefined
      const protectedScope = this.protectsSession(state, exec)
      if (!found && !exec.role && !protectedScope) return undefined
      if (!found && !store.requiresAuthorization && !state.activeRoundId && exec.role === 'plan') return undefined
      const stopped = found && (found.round.control?.resumeBlocked || found.execution.resumeBlocked || this.blocked(store, found.execution))
      if (stopped && !STOP_SAFE.has(execution.name)) return 'RESUME_BLOCKED: only status, exit confirmation and closeout are allowed.'
      if (found && !STOP_SAFE.has(execution.name)) this.assertLiveAdmission(store, found.execution)
      if (['write', 'edit'].includes(execution.name)) {
        const path = resolve(exec.cwd, String(execution.arguments?.file_path ?? ''))
        const resolved = canonicalCwd(path)
        const canonicalParent = resolve(canonicalCwd(dirname(path)), basename(path))
        for (const target of [resolved, canonicalParent]) {
          const rel = relative(store.rootDir, target)
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            return 'CONTROL_STATE_PROTECTED: controlled writes cannot leave their canonical project root or reach profile authority.'
        }
        for (const current of [store, ...this.stores.values()]) {
          for (const target of [resolved, canonicalParent]) {
            const rel = relative(current.rootDir, target).replaceAll('\\', '/').toLowerCase()
            if (rel === '.dsh' || rel.startsWith('.dsh/') || rel === '.git' || rel.startsWith('.git/'))
              return 'CONTROL_STATE_PROTECTED: direct writes to .dsh and .git metadata are not allowed in a controlled round.'
          }
        }
        if (exec.role !== 'code') return 'ROLE_WRITE_DENIED: only the bound code writer may edit project source; review is read-only.'
      }
      const definition = this.ctx.tools.get(execution.name, execution.agent)
      if (this.allowedDefinitions.has(definition) || this.allowedExecutors.has(definition?.execute)) return undefined
      const required = SAFE_PARAMETERS[execution.name]
      if (required && required.every(name => definition?.parameters?.properties?.[name])) {
        const key = `${exec.sessionId}:${execution.name}`
        if (!this.safeDefinitions.has(key)) this.safeDefinitions.set(key, definition)
        if (this.safeDefinitions.get(key) === definition) return undefined
      }
      return 'CONTROLLED_ROUND: native shell, raw dispatch/wake/cancel and unknown tools are fenced; use chain_compute / chain_dispatch / chain_stop.'
    } catch (error) { return `CONTROL_STATE_UNAVAILABLE: ${error.message}` }
  }
  install() {
    if (typeof this.ctx.tools?.guard === 'function') this.disposers.push(this.ctx.tools.guard(exec => this.guard(exec)))
    const commands = serviceOf(this.ctx, 'commands')
    if (commands?.register) {
      this.disposers.push(commands.register({ name: 'chain-authorize', description: '人工确认本 plan 任务授权并绑定首轮；无模型调用，不替换或延长既有授权。',
        input: { hint: '<JSON: authorizationId, goal, budget>' }, recordInput: true,
        handler: async invocation => {
          try {
            const args = parseAuthorizationInput(invocation.rawInput)
            const exec = resolveExec(this.ctx, invocation), store = this.storeForExec(exec)
            this.assertSessionLocation(store, exec)
            const granted = await authorizeProject(store, exec, args, invocation.commandId, this.now())
            this.workflowTools.sync(exec, false, [...this.allowedDefinitions].map(tool => tool.name))
            const prior = await store.read(state => ({ active: state.activeRoundId && !state.rounds[state.activeRoundId]?.closedAt ? state.activeRoundId : null, everOpened: Object.keys(state.rounds).length > 0 }))
            // Recover grant-persisted/open-failed bootstrap, never reset a previously opened project.
            const round = granted.duplicate && prior.everOpened ? { roundId: prior.active, duplicate: true } : await openRound(store, exec, args)
            await this.attach(store, exec)
            return { kind: 'success', text: JSON.stringify({ ...granted, ...round }) }
          } catch (error) { return { kind: 'error', text: `${error.code ?? 'AUTHORIZATION_FAILED'}: ${error.message}` } }
        } }))
      this.disposers.push(commands.register({ name: 'chain-stop', description: 'Persist a round stop and confirm Agent/job exits without model reasoning.',
        input: { hint: '<roundId> <requestId> <reason>' }, recordInput: true,
        handler: async invocation => {
          try {
            const raw = invocation.rawInput.replace(/^\/chain-stop\s*/, '').trim()
            const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(raw)
            if (!match) fail('BAD_ARGS', 'Use /chain-stop <roundId> <requestId> <reason>.')
            const exec = resolveExec(this.ctx, invocation), sessionStore = this.storeForExec(exec)
            this.assertSessionLocation(sessionStore, exec)
            // A genuine human may stop an exact task from another local chat,
            // including when its owner is unloaded. Model tools never use this lookup.
            const store = forRound(exec.cwd, match[1], this.storeOptions)
            const result = await this.stopWithAuthority(store, { roundId: match[1], requestId: match[2], reason: match[3] },
              { token: USER, source: 'human-command' })
            return { kind: 'success', text: JSON.stringify(result) }
          } catch (error) { return { kind: 'error', text: `${error.code ?? 'STOP_FAILED'}: ${error.message}` } }
        } }))
    }
    if (typeof this.ctx.on === 'function') {
      this.disposers.push(this.ctx.on('agent/created', ({ agent }) => {
        // This lifecycle runs before the first system-prompt/schema assembly.
        // Request hooks alone are too late to hide the initial controlled catalog.
        try {
          const exec = resolveExec(this.ctx, { agent })
          if (exec.bindingValid) this.workflowTools.sync(exec, this.isWorkflowSession(exec),
            [...this.allowedDefinitions].map(tool => tool.name))
        } catch (error) { this.log(error) }
      }))
      this.disposers.push(this.ctx.on('agent-preset/selected', (sessionId) => {
        // Selecting plan in an existing blank chat recomposes its Agent
        // without another created event. Refresh before the first assembly.
        try {
          const agent = serviceOf(this.ctx, 'agents')?.get?.(String(sessionId))
          if (!agent) return
          const exec = resolveExec(this.ctx, { agent })
          if (exec.bindingValid) this.workflowTools.sync(exec, this.isWorkflowSession(exec),
            [...this.allowedDefinitions].map(tool => tool.name))
        } catch (error) { this.log(error) }
      }))
      this.disposers.push(this.ctx.on('agent/disposed', ({ agent }) => {
        // Events prove only the exact held Agent instance. A cold-resumed Agent
        // may share its session id with an already-disposed older instance.
        if (!agent) return
        this.workflowTools.release(agent)
        for (const live of this.live.values()) if (live.agent === agent && !live.activation)
          this.track(this.proveAgent(live.store, live.execution, 'agent/disposed:exact-instance'))
      }))
    }
    return this
  }
  async dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const store of this.stores.values()) {
      const ids = await store.read(state => Object.values(state.rounds).filter(r => !r.closedAt && r.control?.managed).map(r => r.id))
      for (const roundId of ids) await this.autoStop(store, roundId, 'controller-unload')
    }
    this.closed = true
    this.workflowTools.dispose()
    await bounded(Promise.all([...this.pending]), 1500)
    for (const dispose of this.disposers.reverse()) if (typeof dispose === 'function') dispose()
  }
}
