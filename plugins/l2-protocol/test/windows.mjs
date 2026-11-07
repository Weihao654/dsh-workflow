// Real native Windows Job tests. Host APIs and the full sandbox contract are
// explicit stand-ins. This verifies containment, NOT file isolation or live DSH integration.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harness, deferred } from './helpers.mjs'
import { executionDir, readJobProof, signalManagedJob } from '../lib/managed-jobs.js'
import { acquireAdmissionLock } from '../lib/admission.js'
import { requestStopIntent } from '../lib/runtime.js'
import { atomicJson } from '../lib/store.js'
const results = []
let casesRun = 0
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, timeout = 8000) {
  const untilAt = Date.now() + timeout
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() >= untilAt) throw new Error('Timed out waiting for controlled stand-in'); await pause(25) }
}
async function jsonIfPresent(path) { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; return null } }
function actualSubprocess(h) {
  const wrappers = new Set(), baselineSpawn = h.services.subprocess.spawn
  h.services.subprocess = {
    terminalEnvironment: async () => ({ platform: process.platform === 'win32' ? 'windows' : 'posix' }),
    resolveExecutable: async value => value,
    spawn(spec) {
      if (spec.argv[0] === 'git') return baselineSpawn(spec)
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      wrappers.add(child)
      const abort = () => child.kill()
      spec.signal?.addEventListener('abort', abort, { once: true })
      child.once('close', () => spec.signal?.removeEventListener('abort', abort))
      let stdout = '', stderr = ''
      child.stdout.on('data', value => { stdout += value.toString('utf8') }); child.stderr.on('data', value => { stderr += value.toString('utf8') })
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => { wrappers.delete(child); resolve({ exitCode, signal }) }) })
      return { done, waitForExit: async () => { await done; return true }, terminate: () => child.kill(),
        collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } } }
    },
  }
  return async () => { for (const child of wrappers) child.kill(); await pause(40) }
}
async function run(name, body, budget = { wallMinutes: 0.25 }) {
  casesRun += 1
  const h = await harness({ budget }), cleanup = actualSubprocess(h)
  // Deliberate trusted test double, never a production fallback or OS-isolation proof.
  h.services.sandbox = { confine: async argv => ({ argv, enforcement: 'full' }) }
  try { const value = await body(h); results.push({ name, pass: true, isolation: 'fake-full contract; OS isolation NOT verified', ...value }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, pass: false, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); throw error }
  finally { await cleanup(); await h.close() }
}
if (process.platform !== 'win32') {
  console.log('UNCOVERED: this acceptance file requires Windows; no POSIX fallback is claimed.')
  process.exitCode = 2
} else {
  try {
    await run('native Job contains root and descendant; durable cancel joins both', async h => {
      const { work } = await h.spawnWork()
      const started = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e',
        "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"], label: 'short cancellation stand-in' })
      const e = await h.store.read(s => s.rounds[started.roundId].executions[started.executionId]), dir = executionDir(h.store, e)
      await until(async () => {
        const ready = await jsonIfPresent(join(dir, 'ready.json'))
        const receipt = await jsonIfPresent(join(dir, 'receipt.json'))
        if (receipt && !ready) throw new Error(JSON.stringify(receipt))
        return ready
      })
      const requested = Date.now()
      await h.controller.stop(h.store, work, { roundId: e.roundId, executionId: e.id, generation: e.generation, requestId: 'native-stop-1', reason: 'short acceptance only', waitMs: 500 })
      await until(async () => (await readJobProof(h.store, e))?.jobsQuiescent === true)
      await h.calls.jobs[0].done
      await h.controller.refresh(h.store, e.roundId)
      const proof = await h.store.read(s => s.rounds[e.roundId].executions[e.id])
      assert.equal(proof.jobsQuiescent, true); assert.equal(proof.outcome, 'cancelled'); assert.equal(proof.deadlineMet, true)
      return { backend: proof.backend, signalAt: proof.signalAt, exitAt: proof.jobExitAt, stopLatencyMs: proof.stopLatencyMs,
        requestToObservedMs: Date.now() - requested, hostAdapter: 'stand-in', nativeProof: 'Job ActiveProcesses == 0, root plus descendant' }
    })
    await run('independent supervisor obeys original deadline with Host timer removed', async h => {
      const { work } = await h.spawnWork()
      const original = await h.store.read(s => s.rounds[h.opened.roundId].time)
      const started = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], label: 'short deadline stand-in' })
      for (const timer of h.controller.timers.values()) clearTimeout(timer)
      h.controller.timers.clear() // Deliberately remove the Host timer; this is not a crash-of-DSH claim.
      const e = await h.store.read(s => s.rounds[started.roundId].executions[started.executionId])
      const receipt = await until(async () => {
        const value = await jsonIfPresent(join(executionDir(h.store, e), 'receipt.json'))
        return value?.jobEmpty ? value : null
      }, 15000)
      await h.calls.jobs[0].done
      assert.equal(receipt.reason, 'deadline'); assert.equal(Date.parse(receipt.deadlineAt), Date.parse(original.deadlineAt))
      assert.ok(Date.parse(receipt.exitAt) <= Date.parse(original.deadlineAt), JSON.stringify(receipt))
      return { backend: 'windows-job-list-v1', deadlineAt: original.deadlineAt, signalAt: receipt.signalAt, exitAt: receipt.exitAt,
        stopLatencyMs: Date.parse(receipt.exitAt) - Date.parse(receipt.signalAt), hostTimer: 'removed, no deadline reset' }
    }, { wallMinutes: 0.12 })
    await run('stop committed under the shared admission lock prevents native Create after preparation', async h => {
      const { work } = await h.spawnWork(), gate = deferred(), entered = deferred()
      h.services.sandbox.confine = async argv => { entered.resolve(); await gate.promise; return { argv, enforcement: 'full' } }
      const starting = h.controller.compute(h.store, work, { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] })
      await entered.promise
      const e = await h.store.read(s => Object.values(s.rounds[h.opened.roundId].executions).find(e => e.kind === 'job'))
      const dir = executionDir(h.store, e), release = await acquireAdmissionLock(dir)
      try {
        gate.resolve(); await starting
        await until(() => jsonIfPresent(join(dir, 'prepared.json')))
        const intent = await h.store.mutate(s => requestStopIntent(s, s.rounds[e.roundId], {
          executionId: e.id, generation: 1, requestId: 'native-admission-stop', reason: 'trusted fixture commits stop while holding admission' }))
        await signalManagedJob(h.store, e, intent.stop, Date.now(), { admissionLocked: true })
      } finally { await release() }
      await h.calls.jobs[0].done
      const receipt = await jsonIfPresent(join(dir, 'receipt.json'))
      assert.equal(receipt.launched, false); assert.equal(receipt.jobEmpty, true)
      assert.equal(receipt.reason, 'cancelled-before-create')
      return { backend: receipt.backend, reason: receipt.reason, launched: false, nativeEmpty: true }
    })
    await run('natural completion preserves argument quoting and non-cancel outcome', async h => {
      const { work } = await h.spawnWork(), argv = ['space value', 'quote"inside', 'tail\\', '中文']
      const started = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...argv] })
      const e = await h.store.read(s => s.rounds[started.roundId].executions[started.executionId])
      const outcome = await h.calls.jobs[0].done
      const proof = await readJobProof(h.store, e)
      assert.equal(outcome.status, 'completed'); assert.equal(proof.jobsQuiescent, true); assert.equal(proof.outcome, 'natural-completion')
      assert.deepEqual(JSON.parse(await readFile(started.stdoutPath, 'utf8')), argv)
      await h.controller.stop(h.store, work, { roundId: e.roundId, executionId: e.id, generation: e.generation, requestId: 'late-after-natural', reason: 'late cancellation' })
      const current = await h.store.read(s => s.rounds[e.roundId].executions[e.id])
      assert.equal(current.state, 'completed')
      const receiptPath = join(executionDir(h.store, e), 'receipt.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      await atomicJson(receiptPath, { ...receipt, nonce: 'incorrect-identity' })
      const mismatched = await readJobProof(h.store, e)
      assert.equal(mismatched.jobsQuiescent, null); assert.match(mismatched.proofError, /JOB_PROOF_INVALID/)
      return { backend: 'windows-job-list-v1', exitAt: proof.jobExitAt, argvRoundTrip: true, lateStopPreservedNaturalCompletion: true, mismatchedReceipt: 'unknown' }
    })
    await run('same-call bounded wait returns the real exit code instead of relying on a later status turn', async h => {
      const { work } = await h.spawnWork()
      const started = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e',
        'process.stdout.write("WAIT_OK");process.exit(7)'], label: 'bounded wait stand-in', waitMs: 30000 })
      assert.equal(started.wait.settled, true, JSON.stringify(started.wait))
      assert.equal(started.wait.exitCode, 7)
      assert.equal(started.wait.jobsQuiescent, true)
      const e = await h.store.read(s => s.rounds[started.roundId].executions[started.executionId])
      assert.equal(e.jobsQuiescent, true); assert.equal(e.exitCode, 7); assert.equal(e.state, 'completed')
      assert.match(await readFile(e.stdoutPath, 'utf8'), /WAIT_OK/)
      return { backend: 'windows-job-list-v1', settledInCall: true, exitCode: 7, jobEmpty: true,
        proof: 'receipt + collected stdout', boundary: 'stand-in Host job adapter, fake-full sandbox' }
    })
    await run('bounded wait timeout reports unsettled and leaves the job under supervision until cancelled', async h => {
      const { work } = await h.spawnWork()
      const started = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        label: 'slow stand-in', waitMs: 400 })
      assert.equal(started.wait.settled, false, JSON.stringify(started.wait))
      const before = await h.store.read(s => s.rounds[started.roundId].executions[started.executionId])
      assert.equal(before.jobsQuiescent, null)
      await h.controller.stop(h.store, work, { roundId: before.roundId, executionId: before.id, generation: before.generation,
        requestId: 'timeout-then-cancel', reason: 'bounded wait timed out', waitMs: 500 })
      await until(async () => (await readJobProof(h.store, before))?.jobsQuiescent === true)
      await h.calls.jobs[0].done
      await h.controller.refresh(h.store, before.roundId)
      const after = await h.store.read(s => s.rounds[before.roundId].executions[before.id])
      assert.equal(after.jobsQuiescent, true); assert.match(String(after.outcome), /^cancelled/)
      return { backend: 'windows-job-list-v1', timeoutReportedSettled: false, cancelledAfterTimeout: true,
        boundary: 'stand-in Host job adapter, fake-full sandbox' }
    })
  } finally {
    await mkdir(new URL('./results/', import.meta.url), { recursive: true })
    await writeFile(new URL('./results/windows.json', import.meta.url), `${JSON.stringify({ sampledAt: new Date().toISOString(), platform: process.platform, results }, null, 2)}\n`, 'utf8')
  }
}

// Without this, "node --test" reports only a file-level pass: deleting every case above
// would still look green. The expected count lives in the same file it checks.
test('all six native containment cases executed and passed', () => {
  assert.equal(casesRun, 6, 'all six native cases must run')
  assert.equal(results.length, 6)
  assert.ok(results.every(row => row.pass === true), 'every native case must pass')
})
