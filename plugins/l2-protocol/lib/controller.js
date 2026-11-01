// Host-owned capabilities, not roster ids, authorize cancellation.
import { randomUUID } from 'node:crypto'
import { forCwd, canonicalCwd } from './store.js'
import { resolve, relative, dirname, basename } from 'node:path'
import { resolveExec } from './roles.js'
import { serviceOf, bounded } from './host.js'
import { fail } from './errors.js'
import { aggregate, assertAdmissible, assertMember, bindingOf, budgetOf, currentFence,
  iso, newId, requestStopIntent, roundOf, usageTotals, executionScope } from './runtime.js'
import { DISPATCH_AUTHORITY, pickProvider, policyFor, rosterKey } from './dispatch.js'
import { executionDir, launchManagedJob, readJobProof, signalManagedJob } from './managed-jobs.js'
import { acquireAdmissionLock } from './admission.js'

const USER = Symbol('genuine-human-command')
const OWNER = Symbol('preauthorized-controller')
const SAFE_PARAMETERS = { read: ['file_path'], read_image: ['file_path'], glob: ['pattern'], grep: ['pattern'],
  write: ['file_path', 'content'], edit: ['file_path', 'old_string', 'new_string'], todo_write: ['todos'],
  web_fetch: ['url'], web_search: ['queries'] }
const STOP_SAFE = new Set(['chain_status', 'chain_stop', 'chain_export_audit', 'chain_record_evidence', 'chain_close_round',
  'read', 'read_image', 'glob', 'grep'])

export class ChainController {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.now = options.now ?? Date.now
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
  }
  log(error) { try { this.ctx.logger?.warn?.(`[role-chain] ${error?.message ?? error}`) } catch {} }
  track(promise) {
    const task = Promise.resolve(promise).catch(error => { this.log(error); return undefined }).finally(() => this.pending.delete(task))
    this.pending.add(task)
    return task
  }
  barrierKey(store, roundId, executionId = '*') { return `${store.rootDir}\0${roundId}\0${executionId}` }
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
    const e = round.executions?.[execution.id]
    assertAdmissible(round, this.now(), { phase: e?.phase })
    if (!e || e.generation !== execution.generation || e.resumeBlocked || !currentFence(state, e))
      fail('STALE_EXECUTION', 'This exact execution generation no longer has admission.')
  }
  registerDefinition(definition) { this.allowedDefinitions.add(definition); this.allowedExecutors.add(definition.execute) }
  async attach(store, exec) {
    this.stores.set(store.rootDir, store)
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
    let known = this.sessions.get(id)
    if (!known) {
      const sessions = serviceOf(this.ctx, 'sessions'), session = sessions?.get?.(id)
      if (!session) return null
      const exec = resolveExec(this.ctx, { agent: { id } })
      known = await this.attach(forCwd(exec.cwd), exec)
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
    const exec = resolveExec(this.ctx, { agent, signal }), store = forCwd(exec.cwd)
    const admission = await this.attach(store, exec)
    if (!admission) {
      if (exec.role && exec.role !== 'plan') fail('MANAGED_ROUND_REQUIRED', 'Role workers must be dispatched through chain_dispatch.')
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
    if (!round.time || round.closedAt || round.control?.resumeBlocked) return
    const key = this.barrierKey(store, round.id)
    if (this.timers.has(key)) return
    const delay = Math.max(0, Date.parse(round.time.signalDueAt) - this.now())
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
    if (!(DISPATCH_AUTHORITY[exec.role] ?? []).includes(role)) fail('DISPATCH_DENIED', 'plan dispatches work; work dispatches code/review.')
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
      return { ok: true, action: previous ? 'reuse' : 'spawn', role, policy, family,
        roundId: execution.roundId, executionId: execution.id, generation: execution.generation,
        childId: execution.childSessionId, messageId: live.messageId }
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
        if (!held || held.store.rootDir !== store.rootDir || held.execution.nonce !== target.nonce)
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
      const executable = await subprocess.resolveExecutable(args.argv[0], undefined, exec.signal)
      const policy = { mode: 'read-only', workspaceRoot: store.rootDir, sessionId: exec.sessionId }
      const confined = await sandbox.confine([executable, ...args.argv.slice(1)], policy, exec.signal)
      if (confined?.enforcement !== 'full' || !Array.isArray(confined.argv) || !confined.argv.length ||
        confined.argv.some(v => typeof v !== 'string' || v.includes('\0')))
        fail('COMPUTE_ISOLATION_UNAVAILABLE', 'The sandbox did not supply full file-effect enforcement. Partial Windows ACL confinement is refused; nothing is launched.')
      const isolation = { mode: policy.mode, enforcement: confined.enforcement, source: 'host-sandbox-contract' }
      await store.mutate(state => { state.rounds[execution.roundId].executions[execution.id].isolation = isolation })
      const result = await launchManagedJob(this.ctx, store, execution, { argv: confined.argv, isolation,
        cwd: exec.cwd, label: String(args.label ?? args.argv[0]) }, this)
      try { this.assertLiveAdmission(store, execution) } catch {
        await this.stopWithAuthority(store, { roundId: execution.roundId, executionId: execution.id, generation: 1,
          requestId: `late-job:${execution.id}`, reason: 'launch-cancel-race' }, { token: OWNER, source: 'late-job-reap' })
        return { ok: false, code: 'STOP_PENDING', ...result }
      }
      return { ok: true, ...result }
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
      if (live?.execution.nonce !== execution.nonce || live.providerJoined !== true) continue
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
      const exec = resolveExec(this.ctx, execution), store = forCwd(exec.cwd), state = store.snapshot()
      const found = bindingOf(state, exec.sessionId)
      if (!found && !exec.role) return undefined
      if (!found && !state.activeRoundId && exec.role === 'plan') return undefined
      const stopped = found && (found.round.control?.resumeBlocked || found.execution.resumeBlocked || this.blocked(store, found.execution))
      if (stopped && !STOP_SAFE.has(execution.name)) return 'RESUME_BLOCKED: only status, exit confirmation and closeout are allowed.'
      if (found && !STOP_SAFE.has(execution.name)) this.assertLiveAdmission(store, found.execution)
      if (['write', 'edit'].includes(execution.name)) {
        const path = resolve(exec.cwd, String(execution.arguments?.file_path ?? ''))
        const resolved = canonicalCwd(path)
        const canonicalParent = resolve(canonicalCwd(dirname(path)), basename(path))
        for (const current of [store, ...this.stores.values()]) {
          for (const target of [resolved, canonicalParent]) {
            const rel = relative(current.rootDir, target).replaceAll('\\', '/').toLowerCase()
            if (rel === '.dsh' || rel.startsWith('.dsh/') || rel === '.git' || rel.startsWith('.git/'))
              return 'CONTROL_STATE_PROTECTED: direct writes to .dsh and .git metadata are not allowed in a controlled round.'
          }
        }
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
      this.disposers.push(commands.register({ name: 'chain-stop', description: 'Persist a round stop and confirm Agent/job exits without model reasoning.',
        input: { hint: '<roundId> <requestId> <reason>' }, recordInput: true,
        handler: async invocation => {
          try {
            const raw = invocation.rawInput.replace(/^\/chain-stop\s*/, '').trim()
            const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(raw)
            if (!match) fail('BAD_ARGS', 'Use /chain-stop <roundId> <requestId> <reason>.')
            const exec = resolveExec(this.ctx, invocation), store = forCwd(exec.cwd)
            const result = await this.stopWithAuthority(store, { roundId: match[1], requestId: match[2], reason: match[3] },
              { token: USER, source: 'human-command' })
            return { kind: 'success', text: JSON.stringify(result) }
          } catch (error) { return { kind: 'error', text: `${error.code ?? 'STOP_FAILED'}: ${error.message}` } }
        } }))
    }
    if (typeof this.ctx.on === 'function') {
      this.disposers.push(this.ctx.on('agent/disposed', ({ agent }) => {
        // Events prove only the exact held Agent instance. A cold-resumed Agent
        // may share its session id with an already-disposed older instance.
        if (!agent) return
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
    await bounded(Promise.all([...this.pending]), 1500)
    for (const dispose of this.disposers.reverse()) if (typeof dispose === 'function') dispose()
  }
}
