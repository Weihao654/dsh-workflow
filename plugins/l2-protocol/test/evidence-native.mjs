// Native-layer regression for the command-evidence interface.
//
// Evidence level: NATIVE LAYER. Real Windows Job Object, real supervisor script, real
// Job-empty receipt and real exit codes. The Host APIs, the sandbox contract and the
// model are stand-ins (no model request is issued by this file). It proves the fixed
// interface works on the native path a live Host uses; it does not prove Host wiring.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harness } from './helpers.mjs'
import { executionDir } from '../lib/managed-jobs.js'
import * as svc from '../lib/service.js'

const results = []
let casesRun = 0
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, timeout = 20000) {
  const untilAt = Date.now() + timeout
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() >= untilAt) throw new Error('Timed out waiting for native proof'); await pause(25) }
}
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
async function run(name, body, budget = { wallMinutes: 0.5 }) {
  const h = await harness({ budget }), cleanup = actualSubprocess(h)
  // Deliberate trusted test double: it advertises full enforcement so the native Job path
  // runs; it is NOT an OS file-isolation claim.
  h.services.sandbox = { confine: async argv => ({ argv, enforcement: 'full' }) }
  try {
    casesRun += 1
    const value = await body(h)
    results.push({ name, pass: true, isolation: 'fake-full sandbox contract; OS file isolation NOT verified', ...value })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, pass: false, error: error.stack })
    console.error(`FAIL ${name}: ${error.stack}`)
    throw error
  } finally { await cleanup(); await h.close() }
}

if (process.platform !== 'win32') {
  console.log('UNCOVERED: this file requires Windows native Job Objects; no POSIX fallback is claimed.')
  process.exitCode = 2
} else {
  try {
    await run('native receipt binds evidence by the jobId that chain_compute returned', async h => {
      const { work } = await h.spawnWork()
      const zero = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e', 'console.log("A2_OK")'],
        label: 'evidence-interface native zero', waitMs: 20000 })
      assert.equal(zero.ok, true)
      assert.equal(zero.wait.settled, true)
      assert.equal(zero.wait.exitCode, 0)
      assert.equal(zero.wait.jobsQuiescent, true)
      const recorded = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: zero.jobId } })
      const payload = recorded.evidence.payload
      assert.equal(payload.jobId, zero.executionId)
      assert.equal(payload.hostJobId, zero.jobId)
      assert.equal(payload.exitCode, 0)
      assert.equal(payload.outcome, 'natural-completion')
      assert.ok(payload.command.includes('console.log("A2_OK")'), payload.command)
      assert.match(payload.evidenceRef, /receipt\.json$/)
      const receipt = JSON.parse(await readFile(join(executionDir(h.store, await h.store.read(s => s.rounds[zero.roundId].executions[zero.executionId])), 'receipt.json'), 'utf8'))
      assert.equal(receipt.jobEmpty, true)
      // The recorded digest is over the very bytes on disk, so a later edit of that file is detectable.
      assert.match(payload.receiptDigest, /^[0-9a-f]{64}$/)
      assert.equal(payload.receiptDigest, createHash('sha256').update(await readFile(payload.evidenceRef.slice('windows-job-empty:'.length))).digest('hex'))

      const seven = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e', 'process.exit(7)'],
        label: 'evidence-interface native seven', waitMs: 20000 })
      assert.equal(seven.wait.exitCode, 7)
      const byExecutionId = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: seven.executionId } })
      assert.equal(byExecutionId.evidence.payload.exitCode, 7)

      await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: zero.jobId, exitCode: 7 } }),
        e => e.code === 'EVIDENCE_MISMATCH')
      await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: seven.jobId, command: 'sh -c exit 0' } }),
        e => e.code === 'EVIDENCE_MISMATCH')
      return { jobs: [zero.jobId, seven.jobId], evidence: [recorded.evidence.id, byExecutionId.evidence.id] }
    })

    await run('a still-running native job is refused instead of guessed', async h => {
      const { work } = await h.spawnWork()
      const running = await h.controller.compute(h.store, work, { argv: [process.execPath, '-e', 'setTimeout(()=>{},4000)'],
        label: 'evidence-interface native still running', waitMs: 0 })
      await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: running.jobId } }),
        e => e.code === 'JOB_NOT_SETTLED')
      return { job: running.jobId }
    })
    // node:test only registers a file-level pass for top-level code, so a deleted case would pass
    // silently. This guard makes the native receipt proof part of the counted gate.
    test('both native receipt cases executed and passed', () => {
      assert.equal(casesRun, 2, 'expected two native receipt cases to execute')
      assert.equal(results.length, 2, 'expected two recorded results')
      assert.ok(results.every(r => r.pass === true), JSON.stringify(results.map(r => ({ name: r.name, pass: r.pass }))))
    })
  } finally {
    console.log('RESULTS ' + JSON.stringify(results.map(r => ({ name: r.name, pass: r.pass }))))
  }
}
