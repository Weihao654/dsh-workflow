// Round facts and admission rules. Runtime evidence never expands a role's claim.
import { randomUUID } from 'node:crypto'
import { readJobReceipt } from './receipt-proof.js'
import { ChainError, fail } from './errors.js'
import { assertProjectAdmission } from './authorization.js'
import { serviceOf } from './host.js'
import { aggregate, assertAdmissible, assertMember, briefStatus, budgetOf, closeoutReserveOf, DEFAULT_CLOSEOUT_REQUESTS,
  DEFAULT_CLOSEOUT_TIME_MS, freezeDeadline, initRuntime, iso, roundOf, usageTotals } from './runtime.js'
export { ChainError, budgetOf }
export const LIMITS = { testFailures: 3, fixes: 2, reruns: 2, restarts: 3 }
export const DEFAULT_BUDGET = { tokens: 0, fixes: 2, reruns: 2, restarts: 3, wallMinutes: 90, outputCap: 2048 }
export const LAYER_ROLES = { command: ['work', 'code'], artifact: ['work', 'code'],
  'self-report': ['plan', 'work', 'code', 'review'], review: ['review'] }
export const GATE_KINDS = ['scope', 'budget', 'rule', 'accept', 'force']
const shortId = prefix => `${prefix}-${randomUUID().slice(0, 8)}`
function assertOpen(round) { if (round.closedAt) fail('ROUND_CLOSED', 'This round is closed; open a new one for a new objective.') }
function member(state, round, exec, allowStopped = false) { return assertMember(state, round, exec, { allowStopped }) }
function validatePayload(layer, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('BAD_ARGS', 'Evidence needs an object payload.')
  if (layer === 'command' && (!String(payload.command ?? '').trim() || !Number.isInteger(payload.exitCode)))
    fail('BAD_ARGS', 'Command evidence requires the actual command and integer exitCode, or a settled jobId to derive them.')
  if (layer === 'artifact' && !String(payload.path ?? '').trim()) fail('BAD_ARGS', 'Artifact evidence requires a path.')
  if (layer === 'self-report' && !String(payload.text ?? '').trim()) fail('BAD_ARGS', 'Self-report requires text.')
  if (layer === 'review' && (!['pass', 'fail', 'partial'].includes(payload.verdict) || !Array.isArray(payload.scope) ||
      !Array.isArray(payload.uncovered) || !payload.uncovered.length)) fail('BAD_ARGS', 'Review requires verdict, scope and non-empty uncovered.')
}
// Command evidence may bind a compute job that already settled. Every recorded fact
// (command, exit code, outcome, receipt) is derived from the ledger job record and its
// native proof; a caller-supplied value is only accepted when it agrees with that record.
// Unknown, cross-round, unsettled or unproven jobs are refused instead of guessed.
function normalizeFact(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  return String(value).trim().replace(/\s+/g, ' ')
}
function resolveComputeJob(state, round, key) {
  const direct = round.executions?.[key]
  if (direct?.kind === 'job') return direct
  const byHostJobId = Object.values(round.executions ?? {}).find(e => e.kind === 'job' && e.jobId === key)
  if (byHostJobId) return byHostJobId
  const elsewhere = Object.values(state?.rounds ?? {}).some(other => other.id !== round.id &&
    (other.executions?.[key]?.kind === 'job' ||
      Object.values(other.executions ?? {}).some(e => e.kind === 'job' && e.jobId === key)))
  if (elsewhere) fail('JOB_WRONG_ROUND', `Job ${key} belongs to another round; command evidence must cite this round's own execution.`)
  return null
}
function commandEvidencePayload(state, round, payload, store) {
  const key = String(payload.jobId ?? '').trim()
  // A caller-typed command/exitCode has no native receipt behind it. Letting it through would
  // let a self-report satisfy the close-round "command evidence" gate, so binding is required.
  if (!key) fail('COMMAND_BINDING_REQUIRED', 'Command evidence must bind the settled compute job that produced it: pass jobId (the executionId or the jobId returned by chain_compute). A caller-typed command has no receipt and cannot stand in for one.')
  const job = resolveComputeJob(state, round, key)
  if (!job) fail('BAD_ARGS', 'jobId must name a compute job in this round (use the executionId or the jobId returned by chain_compute).')
  const label = job.id
  if (job.state !== 'completed') fail('JOB_NOT_SETTLED', `Compute job ${label} is ${job.state}; command evidence needs a settled exit.`)
  if (job.jobsQuiescent !== true) fail('JOB_NOT_SETTLED', `Compute job ${label} has no quiescent native proof yet.`)
  if (!Number.isInteger(job.exitCode)) fail('JOB_EXIT_UNKNOWN', `Compute job ${label} has no integer exit code; refusing to invent one.`)
  // Only a Job-empty receipt proves the supervisor observed an empty job; any other ref
  // (e.g. admission-rejected-before-start) proves nothing about a real exit. The receipt must be
  // the file this job was launched with (trusted location), a regular file rather than a link or
  // directory, and its recorded identity/exit must still agree with the ledger record. A decoy
  // file elsewhere, a tampered file or a bare prefix is refused instead of trusted.
  const expected = { requireLaunched: true, storeDir: store.dir, roundId: round.id, executionId: label, nonce: job.nonce,
    generation: job.generation, exitCode: job.exitCode,
    deadlineAt: round.time?.deadlineAt ?? null, signalDueAt: round.time?.signalDueAt ?? null }
  const refs = Array.isArray(job.evidenceRefs) ? job.evidenceRefs : []
  let proof = null
  let firstError = null
  for (const ref of refs) {
    const attempt = readJobReceipt(ref, expected)
    if (attempt.ok) { proof = attempt; break }
    firstError ??= attempt
  }
  if (!proof) fail(firstError?.code ?? 'JOB_PROOF_MISSING',
    `Compute job ${label} has no verifiable native Job-empty receipt (${firstError?.reason ?? 'no receipt reference'}); refusing to record unproven evidence.`)
  // `requested` is the caller's argv, `argv` is what confinement actually scheduled.
  // Record both strings so intent and execution fact stay distinguishable instead of
  // one silently standing in for the other.
  // "completed" is a record-settling label; whether a process actually ran is a separate fact.
  const launched = typeof job.launched === 'boolean' ? job.launched : null
  const requested = Array.isArray(job.spec?.requested) && job.spec.requested.length ? job.spec.requested.join(' ') : ''
  const executed = Array.isArray(job.spec?.argv) && job.spec.argv.length ? job.spec.argv.join(' ') : ''
  const argv = requested || executed
  if (!argv) fail('BAD_ARGS', 'The job record carries no argv; a caller-typed command is not the executed fact.')
  const derived = { command: argv, exitCode: job.exitCode, outcome: job.outcome ?? null }
  for (const field of ['command', 'exitCode', 'outcome']) {
    if (payload[field] === undefined) continue
    if (normalizeFact(payload[field]) !== normalizeFact(derived[field]))
      fail('EVIDENCE_MISMATCH', `payload.${field} disagrees with job ${label}: recorded ${JSON.stringify(derived[field])}. Omit ${field} to let the record supply it.`)
  }
  return { command: derived.command, exitCode: derived.exitCode, jobId: label, hostJobId: job.jobId ?? null,
    outcome: derived.outcome, launched, evidenceRef: proof.ref, receiptDigest: proof.digest,
    receiptCheckedAt: proof.checkedAt, receiptExitAt: proof.exitAt,
    // Raw argv arrays are the verifiable execution fact; the joined strings are display only.
    argv: Array.isArray(job.spec?.requested) ? [...job.spec.requested] : null,
    executedArgv: Array.isArray(job.spec?.argv) ? [...job.spec.argv] : null,
    executedCommand: executed || null,
    // Provenance: which execution owned the job and which execution recorded the evidence are
    // both kept, so a same-round citation from another session stays visible in the audit.
    ownerSessionId: job.ownerSessionId ?? null, parentExecutionId: job.parentExecutionId ?? null }
}
// Fixed local Git queries only. Disable command-capable callbacks, optional
// index writes and paging; never evaluate repository filter command strings.
const GIT_READ_FLAGS = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'core.untrackedCache=false']
async function gitOutput(ctx, cwd, args, exec) {
  const subprocess = serviceOf(ctx, 'subprocess')
  if (!subprocess?.spawn) fail('BASELINE_UNAVAILABLE', 'No inspected subprocess provider; missing Git facts are not a no-git baseline.')
  const timeout = AbortSignal.timeout(5000)
  const signal = exec?.signal ? AbortSignal.any([timeout, exec.signal]) : timeout
  signal.throwIfAborted()
  if (exec?.controller) {
    const found = await exec.controller.forSession(exec.sessionId)
    if (!found) fail('BASELINE_UNAVAILABLE', 'Git query has no controlled execution binding.')
    const execution = found.store.snapshot().rounds[found.identity.roundId]?.executions[found.identity.executionId]
    if (!execution) fail('BASELINE_UNAVAILABLE', 'Git query lost its exact execution binding.')
    exec.controller.assertLiveAdmission(found.store, execution)
  }
  const handle = subprocess.spawn({ argv: ['git', ...GIT_READ_FLAGS, ...args], cwd, signal, graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1_048_576 }, stderr: { maxBytes: 65536 } } })
  const result = await handle.done
  if (await handle.waitForExit() !== true) fail('BASELINE_UNAVAILABLE', 'Git process-range exit proof unavailable.')
  const stdout = handle.collected.stdout.readFrom(0), stderr = handle.collected.stderr.readFrom(0)
  if (stdout.lossy || stderr.lossy) fail('BASELINE_UNAVAILABLE', 'Git output was truncated.')
  return { exitCode: result.exitCode, stdout: String(stdout.text ?? ''), stderr: String(stderr.text ?? '') }
}
async function gitFacts(ctx, cwd, exec) {
  try {
    const head = await gitOutput(ctx, cwd, ['rev-parse', 'HEAD'], exec)
    if (head.exitCode !== 0) {
      if (/not a git repository/i.test(head.stderr)) return { mode: 'no-git', commit: null, dirty: null }
      fail('BASELINE_UNAVAILABLE', `Git baseline failed: ${head.stderr.slice(0, 500)}`)
    }
    const config = await gitOutput(ctx, cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|smudge|required)$'], exec)
    if (![0, 1].includes(config.exitCode)) fail('BASELINE_UNAVAILABLE', 'Cannot inspect Git filter callbacks safely.')
    const filterFlags = []
    for (const key of config.stdout.split('\0').filter(Boolean)) {
      if (!/^filter\..*\.(clean|process|smudge|required)$/i.test(key)) fail('BASELINE_UNAVAILABLE', 'Unexpected Git filter configuration key.')
      filterFlags.push('-c', `${key}=${/\.required$/i.test(key) ? 'false' : ''}`)
    }
    const status = await gitOutput(ctx, cwd, [...filterFlags, 'status', '--porcelain', '--ignore-submodules=all'], exec)
    if (status.exitCode !== 0 || !head.stdout.trim()) fail('BASELINE_UNAVAILABLE', 'Git did not return complete baseline facts.')
    return { mode: 'git', commit: head.stdout.trim(), dirty: status.stdout.trim().length > 0,
      callbacksDisabled: true, filterOverrides: filterFlags.length / 2, dirtyCoverage: 'superproject-only; filters disabled' }
  } catch (error) {
    if (error instanceof ChainError) throw error
    fail('BASELINE_UNAVAILABLE', `Cannot establish T0: ${error.message}`)
  }
}
export async function openRound(store, exec, args = {}) {
  const goal = String(args.goal ?? '').trim()
  if (!goal) fail('BAD_ARGS', 'A round needs an acceptance objective.')
  if (exec.role !== 'plan' || !exec.isRoot || !exec.sessionId) fail('ROLE_DENIED', 'Only the actual root plan may open a round.')
  const budget = budgetOf({ budget: args.budget ?? {} })
  if (store.requiresAuthorization && args.budget?.closeoutRequests !== undefined &&
    args.budget.closeoutRequests < DEFAULT_CLOSEOUT_REQUESTS)
    fail('BAD_BUDGET', `An authorized project cannot lower the closeout request reserve below ${DEFAULT_CLOSEOUT_REQUESTS}.`)
  if (store.requiresAuthorization && args.budget?.closeoutTimeMs !== undefined &&
    args.budget.closeoutTimeMs < DEFAULT_CLOSEOUT_TIME_MS)
    fail('BAD_BUDGET', `An authorized project cannot lower the closeout time reserve below ${DEFAULT_CLOSEOUT_TIME_MS} ms.`)
  return store.mutate(state => {
    if (state.activeRoundId && !state.rounds[state.activeRoundId]?.closedAt) fail('ROUND_ALREADY_OPEN', 'Close the existing round; do not reset its deadline or usage.')
    let authorization = null
    if (store.requiresAuthorization) {
      const grant = assertProjectAdmission(state)
      for (const key of ['requests', 'tokens', 'outputCap', 'wallMinutes', 'testFailures', 'fixes', 'reruns', 'restarts']) {
        if (args.budget?.[key] !== undefined && (budget[key] > grant.budget[key] || (key === 'tokens' && budget[key] === 0)))
          fail('AUTHORIZATION_EXCEEDED', `Round ${key} exceeds the immutable project grant.`)
        budget[key] = args.budget?.[key] === undefined ? grant.budget[key] : budget[key]
      }
      authorization = { id: grant.id, authorizedAt: grant.authorizedAt, deadlineAt: grant.deadlineAt }
    }
    const id = shortId('R'), round = { id, goal, authorization, scope: String(args.scope ?? goal), openedAt: iso(),
      openedBy: { sessionId: exec.sessionId, agentPreset: exec.preset }, budget,
      counters: { fixes: 0, reruns: 0, restarts: 0 }, failures: {}, evidence: [], gates: [], baseline: null, closeout: null, closedAt: null }
    initRuntime(state, round, exec)
    state.rounds[id] = round; state.activeRoundId = id
    return { roundId: id, goal, budget, limits: LIMITS,
      next: 'Dispatch the existing work coordinator; freeze one T0 before code, review or compute.' }
  })
}
export async function freezeBaseline(ctx, store, exec, args = {}) {
  await store.read(state => {
    const round = roundOf(state, args.roundId); member(state, round, exec); assertAdmissible(round)
    if (round.baseline) fail('BASELINE_ALREADY_FROZEN', 'The original T0 is immutable.')
  })
  const facts = await gitFacts(ctx, exec.cwd, exec)
  const result = await store.mutate(state => {
    const round = roundOf(state, args.roundId); member(state, round, exec); assertAdmissible(round)
    if (round.baseline) fail('BASELINE_ALREADY_FROZEN', 'The original T0 is immutable.')
    round.baseline = { t0Id: shortId('T0'), ...facts, frozenAt: iso(), frozenBySession: exec.sessionId }
    round.control.phase = 'implementation'
    freezeDeadline(round)
    return { roundId: round.id, baseline: round.baseline, time: round.time }
  })
  if (exec.controller) await exec.controller.attach(store, exec)
  return result
}
export async function checkBaseline(ctx, store, exec, args = {}) {
  const facts = await gitFacts(ctx, exec.cwd, exec)
  return store.read(state => {
    const round = roundOf(state, args.roundId)
    if (!round.baseline) fail('NO_BASELINE', 'Freeze the original T0 first.')
    const commitChanged = facts.commit !== round.baseline.commit
    return { roundId: round.id, t0: round.baseline, now: facts, commitChanged, dirty: facts.dirty,
      verdict: commitChanged ? 'baseline-moved' : facts.dirty ? 'baseline-dirty' : 'clean' }
  })
}
export function exceededList(round) {
  const limits = budgetOf(round), out = []
  for (const row of Object.values(round.failures ?? {})) if (row.count >= limits.testFailures) out.push(`test:${row.signature} ${row.count}/${limits.testFailures}`)
  for (const [kind, key] of Object.entries({ fix: 'fixes', rerun: 'reruns', restart: 'restarts' }))
    if (round.counters[key] >= limits[key]) out.push(`${kind} ${round.counters[key]}/${limits[key]}`)
  return out
}
export async function recordFailure(store, exec, args = {}) {
  const kind = String(args.kind ?? ''), key = { fix: 'fixes', rerun: 'reruns', restart: 'restarts' }[kind]
  if (kind !== 'test' && !key) fail('BAD_ARGS', 'kind must be test/fix/rerun/restart.')
  const signature = String(args.signature ?? (kind === 'test' ? '' : 'full')).trim()
  if (!signature) fail('BAD_ARGS', 'A test failure needs a stable signature.')
  return store.mutate(state => {
    const round = roundOf(state, args.roundId); assertOpen(round); member(state, round, exec)
    let signatureCount = null
    if (kind === 'test') {
      const row = round.failures[signature] ?? { signature, count: 0, firstAt: iso() }
      row.count++; row.lastAt = iso(); row.lastDetail = String(args.detail ?? '').slice(0, 500)
      round.failures[signature] = row; signatureCount = row.count
    } else {
      if (store.requiresAuthorization) {
        const used = Object.values(state.rounds).reduce((sum, row) => sum + (row.counters?.[key] ?? 0), 0)
        if (used >= state.authorization.budget[key]) fail('PROJECT_OPERATION_BUDGET_REACHED', `Cumulative ${key} allowance is exhausted.`)
      }
      round.counters[key]++
    }
    const exceeded = exceededList(round).length ? (signatureCount >= budgetOf(round).testFailures ? 'test' : kind) : null
    if (exceeded) round.control.limitHold = true
    return { roundId: round.id, kind, signature, signatureCount, exceeded, counters: round.counters, limits: budgetOf(round) }
  })
}
export async function recordEvidence(store, exec, args = {}) {
  const layer = String(args.layer ?? '')
  if (!LAYER_ROLES[layer]) fail('BAD_ARGS', 'Unknown evidence layer.')
  if (!LAYER_ROLES[layer].includes(exec.role)) fail('EVIDENCE_LAYER_MISMATCH', `Only ${LAYER_ROLES[layer].join('/')} can record ${layer}.`)
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) fail('BAD_ARGS', 'Evidence needs an object payload.')
  return store.mutate(state => {
    const round = roundOf(state, args.roundId); assertOpen(round); const author = member(state, round, exec, true)
    if (!round.baseline) fail('NO_BASELINE', 'Evidence needs the original T0.')
    const payload = layer === 'command' ? commandEvidencePayload(state, round, args.payload, store) : args.payload
    validatePayload(layer, payload)
    const evidence = { id: `${round.id}#e${round.evidence.length + 1}`, roundId: round.id, t0Id: round.baseline.t0Id,
      layer, authorRole: exec.role, authorSession: exec.sessionId, executionId: author.id, generation: author.generation,
      at: iso(), payload }
    round.evidence.push(evidence)
    return { roundId: round.id, evidence, evidenceCount: round.evidence.length,
      byLayer: round.evidence.reduce((out, e) => ({ ...out, [e.layer]: (out[e.layer] ?? 0) + 1 }), {}) }
  })
}
export function gateAdmission(round, args) {
  const classification = args.classification ?? 'unspecified'
  if (classification === 'closeout' && args.kind === 'accept') {
    if (args.stage !== 'closeout') return { admitted: false, disposition: 'Only final closeout may request acceptance.' }
    if (!round.evidence.some(e => e.layer === 'review')) return { admitted: false, disposition: 'Obtain the independent review first; do not substitute user approval.' }
    return { admitted: true }
  }
  if (['unchanged-premise', 'authorized-technical', 'blocker'].includes(classification)) return {
    admitted: false, blocker: classification === 'blocker', disposition: classification === 'unchanged-premise'
      ? 'Cite the still-valid original authorization/premise; NOT_GATED is not new approval.'
      : classification === 'authorized-technical' ? 'work handles this within existing authority.'
        : 'Pause the affected step, preserve its evidence, continue independent authorized work.' }
  if (!['scope', 'budget', 'business-rule', 'new-authority'].includes(classification))
    return { admitted: false, disposition: 'No new user decision was established; assess the issue, do not ignore it or treat it as safe.' }
  if (args.kind === 'accept') return { admitted: false, disposition: 'accept is reserved for final closeout, not a development checkpoint.' }
  for (const name of ['change', 'originalAuthorization', 'whyNotCovered']) if (!String(args[name] ?? '').trim())
    return { admitted: false, disposition: `Supply the specific ${name}; do not make the user re-review unchanged premises.` }
  return { admitted: true }
}
function forceCovers(round, gate) {
  if (!gate.approved || gate.kind !== 'force' || !gate.authorizedCounts) return false
  const limits = budgetOf(round), snapshot = gate.authorizedCounts
  for (const key of ['fixes', 'reruns', 'restarts'])
    if (round.counters[key] >= limits[key] && (snapshot.counters?.[key] ?? -1) < round.counters[key]) return false
  for (const row of Object.values(round.failures))
    if (row.count >= limits.testFailures && (snapshot.failures?.[row.signature] ?? -1) < row.count) return false
  return true
}
export async function askGate(ctx, store, exec, args = {}) {
  const question = String(args.question ?? '').trim(), kind = String(args.kind ?? 'rule')
  if (!question || !GATE_KINDS.includes(kind)) fail('BAD_ARGS', 'Gate needs question and a valid kind.')
  const preparation = await store.mutate(state => {
    const round = roundOf(state, args.roundId); assertOpen(round); member(state, round, exec, true)
    const admission = gateAdmission(round, { ...args, kind })
    if (admission.blocker) {
      round.control.blockers.push(`${String(args.affectedStep ?? args.stage ?? 'affected-step')}: ${question}`)
      round.control.pausedPhases ??= {}
      round.control.pausedPhases[String(args.affectedStep ?? args.stage ?? round.control.phase)] = question
    }
    return { roundId: round.id, admission, authorizedCounts: { counters: { ...round.counters },
      failures: Object.fromEntries(Object.values(round.failures).map(row => [row.signature, row.count])) } }
  })
  if (!preparation.admission.admitted) return { ok: false, code: 'NOT_GATED', roundId: preparation.roundId, ...preparation.admission }
  if (!exec.isRoot || exec.role !== 'plan') return { ok: false, code: 'ESCALATE_TO_PARENT', roundId: preparation.roundId,
    disposition: 'Send only the concrete new decision and its evidence through the existing work to plan.' }
  const questions = serviceOf(ctx, 'userQuestions')
  if (!questions?.ask) fail('NO_USER_QUESTIONS', 'No user question service; no approval was recorded.')
  const snapshotText = kind === 'force' ? JSON.stringify(preparation.authorizedCounts) : null
  if (snapshotText?.length > 4000) fail('GATE_SNAPSHOT_TOO_LARGE', 'Force counts exceed the bounded approval prompt; no approval was requested or recorded.')
  const displayedQuestion = snapshotText ? `${question}\n\n本次仅授权以下不可变计数快照；不重置停止、期限或token预算，后续新增失败不在此授权内：\n${snapshotText}` : question
  const item = { id: 'gate', question: displayedQuestion, options: args.options?.length ? args.options : [{ label: '批准' }, { label: '拒绝' }] }
  if (args.header) item.header = String(args.header)
  let response
  try { response = await questions.ask({ agent: exec.agent, questions: [item], items: [item] }) }
  catch (error) { fail('GATE_FAILED', `No user decision: ${error.message}`) }
  const answers = Array.isArray(response?.answers) ? response.answers : []
  const first = answers.find(a => a.id === 'gate') ?? answers[0] ?? {}
  const selected = Array.isArray(first.selected) ? first.selected : []
  const decision = String(first.custom ?? '').trim() || selected.join(' / ') || '无回答'
  // Ambiguous/free-form or missing answers are not an affirmative authority grant.
  const approved = /^(批准|同意|允许|approve|approved|yes)$/i.test(decision.trim())
  return store.mutate(state => {
    const round = roundOf(state, preparation.roundId); assertOpen(round)
    const gate = { id: `${round.id}#g${round.gates.length + 1}`, roundId: round.id, kind, question: displayedQuestion, originalQuestion: question,
      classification: args.classification, change: args.change, originalAuthorization: args.originalAuthorization,
      whyNotCovered: args.whyNotCovered, authorizedCounts: kind === 'force' ? preparation.authorizedCounts : undefined,
      askedByRole: exec.role, askedBySession: exec.sessionId, at: iso(), decision, approved }
    round.gates.push(gate)
    if (approved && kind === 'force') round.control.limitHold = !forceCovers(round, gate)
    if (args.classification === 'closeout') round.control.phase = 'closeout'
    return { ok: true, roundId: round.id, gate, disposition: approved ? 'Only the explicitly approved change is authorized; stops/deadlines are not reset.' : 'No affirmative approval; do not bypass.' }
  })
}
export async function closeRound(store, exec, args = {}) {
  const closeout = args.closeout ?? {}
  return store.mutate(async state => {
    const round = roundOf(state, args.roundId); assertOpen(round); const caller = member(state, round, exec, true)
    if (!caller.root || exec.role !== 'plan') fail('ROLE_DENIED', 'Only the owning root plan closes the round.')
    const problems = [], exceeded = exceededList(round)
    const allExecutions = Object.values(round.executions ?? {})
    const others = allExecutions.filter(e => e.id !== caller.id)
    // A round opened by the /chain-authorize bootstrap may legitimately end before any
    // protected step ran (no T0, no evidence, no other executions). Closing it is pure
    // bookkeeping: it must not require T0/command/review evidence it never had, and it must
    // not silently relax those requirements for a round that actually executed anything.
    const emptyPlanning = others.length === 0 && !round.baseline && round.evidence.length === 0
    if (!emptyPlanning) {
      if (!round.baseline) problems.push('No original T0.')
      if (exceeded.length && !round.gates.some(g => forceCovers(round, g))) problems.push('Failure limits exceeded without a force decision covering the current counts.')
      if (!round.evidence.some(e => e.layer === 'command')) problems.push('Missing command evidence.')
      if (!round.evidence.some(e => e.layer === 'review')) problems.push('Missing independent review evidence.')
    }
    if (!emptyPlanning) {
      // Recording a command re-reads the native receipt once. Closing is the second moment the
      // record can be trusted, so every command row's receipt is verified again and compared with
      // the digest captured at recording time: a receipt edited in between (same user, writable
      // store directory) must not silently back a closeout.
      const broken = []
      for (const row of round.evidence.filter(e => e.layer === 'command')) {
        const jobId = String(row.payload?.jobId ?? '')
        const recordedDigest = row.payload?.receiptDigest
        // A row that cannot name its job or its recorded digest cannot be re-verified. Skipping it
        // would let such a row satisfy the "command evidence" gate without any receipt behind it.
        if (!jobId || !recordedDigest) {
          broken.push('a command row does not record both the bound jobId and the receipt digest, so it cannot be re-verified')
          continue
        }
        const job = round.executions?.[jobId]
        if (!job) { broken.push(jobId + ': the bound job record is gone'); continue }
        const expected = { requireLaunched: true, storeDir: store.dir, roundId: round.id, executionId: job.id,
          nonce: job.nonce, generation: job.generation, exitCode: job.exitCode,
          deadlineAt: round.time?.deadlineAt ?? null, signalDueAt: round.time?.signalDueAt ?? null }
        let verified = null
        for (const ref of Array.isArray(job.evidenceRefs) ? job.evidenceRefs : []) {
          const attempt = readJobReceipt(ref, expected)
          if (attempt.ok) { verified = attempt; break }
        }
        if (!verified) { broken.push(jobId + ': its receipt no longer verifies'); continue }
        if (verified.digest !== recordedDigest) broken.push(jobId + ': its receipt changed after the command evidence was recorded')
      }
      if (broken.length) problems.push('Command evidence receipts changed after recording: ' + broken.join('; '))
    }
    if (others.some(e => e.agentQuiescent !== true || e.jobsQuiescent !== true) || round.control.inventoryUnknown)
      problems.push('Agent/job exits remain unconfirmed; servicesStopped is not process proof.')
    const commit = String(closeout.version?.commit ?? '').trim()
    if (!commit) problems.push('version.commit is required (or "(no-git)").')
    else if (!/^(\(no-git\)|[0-9a-f]{7,64})$/i.test(commit)) problems.push('version.commit must be a 7+ hex commit or the literal "(no-git)".')
    if (!['delivered', 'partial', 'blocked'].includes(closeout.result)) problems.push('Invalid result.')
    if (!Array.isArray(closeout.uncovered) || !closeout.uncovered.length) problems.push('Non-empty uncovered is required.')
    else if (closeout.uncovered.some(u => !String(u).trim())) problems.push('uncovered entries must not be blank.')
    // A delivered result is a claim that the work passed. Recording a review verdict of
    // "fail" and then closing as delivered contradicts the record, so it is refused here
    // rather than left to the reader. partial/blocked may carry a failing verdict.
    if (!emptyPlanning && closeout.result === 'delivered' &&
      round.evidence.filter(e => e.layer === 'review').some(e => String(e.payload?.verdict ?? '') !== 'pass'))
      problems.push('A delivered round requires every independent review verdict to be "pass"; report partial or blocked instead.')
    if (closeout.servicesStopped !== true) problems.push('servicesStopped must be true in addition to actual exit proof.')
    // A round closed before any protected step ran has no evidence at all; it must not be
    // able to report delivered on an empty record.
    if (emptyPlanning && closeout.result === 'delivered') problems.push('An empty planning round cannot claim delivered; report partial or blocked.')
    if (problems.length) fail('CLOSEOUT_REJECTED', `Cannot close:\n- ${problems.join('\n- ')}`, { problems, exceeded })
    const usage = usageTotals(round)
    const final = { version: closeout.version, result: closeout.result, uncovered: closeout.uncovered.map(String),
      servicesStopped: closeout.servicesStopped === true,
      servicesStoppedMeans: 'declaration by the closing agent; the machine gate proves only that controlled executions and managed jobs are quiescent, not that any Host process exited',
      usage, cost: usage.cost }
    if (emptyPlanning) final.abortedEmpty = true
    round.closeout = final; round.closedAt = iso(); round.control.resumeBlocked = true
    if (state.activeRoundId === round.id) state.activeRoundId = null
    const auditPath = await store.exportRound(round)
    return { ok: true, roundId: round.id, auditPath, closeout: final,
      summary: `版本：${final.version.commit}\n结果：${final.result}\n未覆盖项：${final.uncovered.join('；')}\n费用：${usage.totalTokens} known tokens; ${usage.pendingRequests} pending requests; billed cost unknown.${emptyPlanning ? '\n本轮在受保护步骤执行前关闭（abortedEmpty）：无 T0、无命令/复审证据，额度未被重置。' : ''}` }
  })
}
export async function status(store, args = {}) {
  return store.read(state => {
    const id = args.roundId ?? state.activeRoundId
    if (!id) return { activeRoundId: null, rounds: Object.keys(state.rounds).length, note: 'No active round.' }
    const round = roundOf(state, id)
    if (args.detail !== 'full') return briefStatus(round)
    return { roundId: id, activeRoundId: state.activeRoundId, goal: round.goal, scope: round.scope, openedAt: round.openedAt,
      openedBy: round.openedBy, closedAt: round.closedAt, baseline: round.baseline, time: round.time, budget: budgetOf(round),
      counters: round.counters, failures: round.failures, gates: round.gates, evidence: round.evidence,
      control: { ...round.control, ...aggregate(round) }, executions: round.executions, usage: { ...usageTotals(round), ledger: round.usage },
      agents: state.agents ?? {}, closeout: round.closeout, exceeded: exceededList(round) }
  })
}
export async function exportAudit(store, args = {}) {
  return store.read(async state => {
    const round = roundOf(state, args.roundId), auditPath = await store.exportRound(round)
    return { roundId: round.id, auditPath, bytes: Buffer.byteLength(JSON.stringify(round)) }
  })
}
