// Windows-only execution adapter. A host Job id is not a process-exit receipt.
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicJson } from './store.js'
import { fail } from './errors.js'
import { serviceOf } from './host.js'
import { iso, roundOf } from './runtime.js'
import { acquireAdmissionLock } from './admission.js'
import { readJobReceipt } from './receipt-proof.js'

const SCRIPT = fileURLToPath(new URL('./windows-supervisor.ps1', import.meta.url))
export function executionDir(store, execution) {
  if (!/^J-[a-f0-9-]+$/i.test(execution.id)) fail('IDENTITY_MISMATCH', 'Invalid controlled job identity.')
  return join(store.dir, 'executions', execution.roundId, execution.id)
}
function identity(execution) {
  return { nonce: execution.nonce, roundId: execution.roundId, executionId: execution.id, generation: execution.generation }
}
export async function signalManagedJob(store, execution, stop, now = Date.now(), { admissionLocked = false } = {}) {
  const dir = executionDir(store, execution)
  const release = admissionLocked ? null : await acquireAdmissionLock(dir)
  try {
    // The caller committed stop intent first. The same admission lock protects
    // native Create+Resume, so a stopped launch cannot cross this commit point.
    await atomicJson(join(dir, 'stop.json'), { ...identity(execution), requestId: stop?.requestId ?? `stop:${execution.id}`,
      reason: stop?.reason ?? 'durable-stop', requestedAt: stop?.requestedAt ?? iso(now) })
    await store.mutate(state => {
      const e = state.rounds[execution.roundId]?.executions?.[execution.id]
      if (e?.nonce === execution.nonce) {
        e.signalAt ??= iso(now); e.checkedAt = iso(now)
        e.nativeAdmissionConfirmedAt ??= iso(now); e.nativeAdmissionPending = false
      }
    })
  } finally { if (release) await release() }
}
export async function readJobProof(store, execution) {
  const path = join(executionDir(store, execution), 'receipt.json')
  if (!existsSync(path)) return null
  const time = await store.read(state => state.rounds[execution.roundId]?.time)
  if (!time) return { jobsQuiescent: null, checkedAt: iso(), proofError: 'Receipt arrived without a fixed T0 deadline.' }
  // One validator for the receipt: location, regular-file shape, identity and content. A tampered,
  // moved or linked file is reported as unproven instead of being read as a completed job.
  const proof = readJobReceipt('windows-job-empty:' + path, { requireLaunched: false, storeDir: store.dir, roundId: execution.roundId,
    executionId: execution.id, nonce: execution.nonce, generation: execution.generation,
    deadlineAt: time.deadlineAt, signalDueAt: time.signalDueAt })
  if (!proof.ok) return { jobsQuiescent: null, checkedAt: iso(), proofError: proof.code + ': ' + proof.reason }
  const receipt = proof.receipt
  const checkedAt = Date.parse(receipt.checkedAt), exitAt = Date.parse(receipt.exitAt)
  if (!Number.isFinite(checkedAt) || !Number.isFinite(exitAt))
    return { jobsQuiescent: null, checkedAt: iso(), proofError: receipt.error ?? 'No Windows Job-empty exit proof.' }
  return { jobsQuiescent: true, launched: receipt.launched === true,
    state: receipt.reason?.startsWith('cancelled') || receipt.reason?.startsWith('deadline') ? 'stopped' : 'completed',
    checkedAt: receipt.checkedAt, jobExitAt: receipt.exitAt, signalAt: receipt.signalAt ?? execution.signalAt ?? null,
    stopLatencyMs: receipt.signalAt ? Math.max(0, exitAt - Date.parse(receipt.signalAt)) : null,
    deadlineMet: exitAt <= Date.parse(time.deadlineAt),
    outcome: receipt.reason, exitCode: receipt.exitCode, proofError: receipt.error ?? null,
    receiptDigest: proof.digest,
    evidenceRefs: [...new Set([...(execution.evidenceRefs ?? []), proof.ref])] }
}
export async function launchManagedJob(ctx, store, execution, spec, controller) {
  if (spec.isolation?.mode !== 'read-only' || spec.isolation?.enforcement !== 'full')
    fail('COMPUTE_ISOLATION_UNAVAILABLE', 'A Windows Job is containment, not file isolation; full read-only confinement is required.')
  const jobs = serviceOf(ctx, 'jobs'), subprocess = serviceOf(ctx, 'subprocess')
  if (!jobs || !subprocess || typeof jobs.start !== 'function' || typeof jobs.attachController !== 'function')
    fail('NO_JOB_CONTROLLER', 'Host jobs/subprocess control is unavailable; nothing is launched.')
  if (!controller.jobControllers) controller.jobControllers = new Set()
  if (!controller.jobControllers.has(jobs)) {
    const dispose = jobs.attachController('role-chain-controlled-compute')
    controller.disposers.push(dispose)
    controller.jobControllers.add(jobs)
  }
  const round = await store.read(state => roundOf(state, execution.roundId))
  if (!round.time) fail('NO_BASELINE', 'A fixed absolute T0 deadline is required.')
  const dir = executionDir(store, execution)
  await mkdir(dir, { recursive: true })
  const manifest = { version: 1, backend: 'windows-job-list-v1', ...identity(execution), ...spec,
    deadlineAt: round.time.deadlineAt, signalDueAt: round.time.signalDueAt, outputLimitBytes: 1_048_576 }
  await atomicJson(join(dir, 'spec.json'), manifest)
  await store.mutate(state => {
    const e = state.rounds[execution.roundId].executions[execution.id]
    e.deadlineAt = manifest.deadlineAt; e.signalDueAt = manifest.signalDueAt
    e.specPath = join(dir, 'spec.json'); e.stdoutPath = join(dir, 'stdout.txt'); e.stderrPath = join(dir, 'stderr.txt')
  })
  const powershell = await subprocess.resolveExecutable(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  controller.assertLiveAdmission(store, execution)
  const live = controller.live.get(execution.id)
  const jobId = jobs.start({ kind: 'role-chain-compute', label: spec.label, owner: execution.ownerSessionId,
    outputLimitBytes: 65536,
    run(job) {
      // No await separates the last admission check from synchronous resource start.
      controller.assertLiveAdmission(store, execution)
      live.processAbort = new AbortController()
      live.process = subprocess.spawn({ argv: [powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT, '-Spec', join(dir, 'spec.json')], cwd: spec.cwd, signal: live.processAbort.signal,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: round.time.shutdownGraceMs })
      live.jobId = job.id
      live.settlement = (async () => {
        let outcome
        const errors = []
        try { outcome = await live.process.done } catch (error) { errors.push(error.message) }
        try { if (await live.process.waitForExit() !== true) errors.push('Provider supplied no whole-range exit proof.') }
        catch (error) { errors.push(error.message) }
        const providerError = errors.length ? errors.join('; ') : null
        live.providerJoined = !providerError
        const proof = await readJobProof(store, execution)
        await store.mutate(state => {
          const e = state.rounds[execution.roundId]?.executions?.[execution.id]
          if (e?.nonce !== execution.nonce) return
          if (proof) Object.assign(e, proof)
          if (providerError) { e.providerExitError = providerError; e.jobsQuiescent = null }
          e.hostExit = outcome ?? null; e.hostExitAt = iso(controller.now())
          if (!proof) { e.jobsQuiescent = null; e.proofError = 'Supervisor exit is not a native Job-empty receipt.' }
        })
        const stdout = live.process.collected?.stdout?.readFrom?.(0)?.text ?? ''
        const stderr = live.process.collected?.stderr?.readFrom?.(0)?.text ?? ''
        if (stdout) job.append(stdout, 'stdout')
        if (stderr) job.append(stderr, 'stderr')
        if (!proof?.jobsQuiescent || providerError) return { status: 'failed', detail: providerError ?? proof?.proofError ?? 'Exit proof pending.', result: { executionId: execution.id } }
        return { status: proof.state === 'stopped' ? 'killed' : proof.exitCode === 0 ? 'completed' : 'failed',
          detail: proof.outcome, result: { executionId: execution.id, exitCode: proof.exitCode, stdoutPath: join(dir, 'stdout.txt'), stderrPath: join(dir, 'stderr.txt') } }
      })()
      return { done: live.settlement,
        cancel(reason) {
          // Native job_kill/controller teardown is also translated to durable intent first.
          controller.track(controller.stopWithAuthorityForJob(store, execution, reason ?? 'host-job-cancel'))
        } }
    } })
  live.jobId = jobId
  await store.mutate(state => {
    const e = state.rounds[execution.roundId].executions[execution.id]
    e.jobId = String(jobId); e.acceptedAt = iso(controller.now())
    // Persist the argv that was actually scheduled. Command evidence is derived from
    // this record (and its native receipt), never from a caller-typed string.
    e.spec = { requested: Array.isArray(spec.requested) ? [...spec.requested] : null,
      argv: Array.isArray(spec.argv) ? [...spec.argv] : [], cwd: spec.cwd ?? null, label: spec.label ?? null }
    if (!e.resumeBlocked && e.jobsQuiescent !== true) e.state = 'running'
  })
  return { jobId: String(jobId), roundId: execution.roundId, executionId: execution.id,
    generation: execution.generation, backend: manifest.backend, deadlineAt: manifest.deadlineAt,
    stdoutPath: join(dir, 'stdout.txt'), stderrPath: join(dir, 'stderr.txt') }
}
