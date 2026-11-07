// Deterministic fixture tests for the command-evidence interface.
//
// Evidence level: FIXTURE. The Host job adapter, sandbox and receipts are stand-ins, so
// this file proves argument/derivation/rejection logic only. It does not prove native
// Job semantics, a live Host, or a real model turn (see evidence-native.mjs for the
// native layer and A-SEGMENT-RESULT for the real model round).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { harness } from './helpers.mjs'
import * as svc from '../lib/service.js'
import { receiptBody, writeReceipt } from './receipt-fixture.mjs'
import { receiptPath } from '../lib/receipt-proof.js'

// Fixture receipts are real files under a temp dir, because command evidence now requires the
// referenced receipt to exist on disk (a string that merely looks like a path proves nothing).

const FIXTURE_IDS = ['J-fix-a1', 'J-fix-a2', 'J-fix-a3', 'J-fix-a4', 'J-fix-a5', 'J-fix-a6', 'J-fix-a7', 'J-fix-a8',
  'J-fix-c1', 'J-fix-c2', 'J-fix-r1', 'J-fix-r2', 'J-fix-r3', 'J-fix-r4', 'J-fix-r5', 'J-fix-r6', 'J-fix-r7',
  'J-fix-r8', 'J-fix-r9', 'J-fix-r10']

async function withRound(fn) {
  const h = await harness()
  const { work, result } = await h.spawnWork()
  try { await fn(h, work) }
  finally {
    await h.store.mutate(state => {
      for (const round of Object.values(state.rounds)) for (const id of FIXTURE_IDS) if (round.executions?.[id]) delete round.executions[id]
      delete state.rounds['R-fixture-elsewhere']
    })
    await h.complete(result.childId)
    await h.close()
  }
}

async function addJobs(h, work, rows) {
  const roundId = await h.store.mutate(state => {
    const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {})
      .some(e => e.role === 'work' && (e.childSessionId === work.sessionId || e.ownerSessionId === work.sessionId)))
    assert.ok(round, 'fixture work execution must be bound to a round')
    for (const row of rows) round.executions[row.id] = { roundId: round.id, role: 'work', generation: 1, kind: 'job',
      childSessionId: work.sessionId, state: 'completed', jobsQuiescent: true, agentQuiescent: true,
      outcome: 'natural-completion', exitCode: 0, spec: { requested: ['sh', '-c', 'printf OK; exit 0'], argv: ['node', 'runner.mjs'] },
      nonce: 'nonce-' + row.id, evidenceRefs: [], ...row }
    state.rounds['R-fixture-elsewhere'] = { id: 'R-fixture-elsewhere',
      executions: { 'J-fix-a8': { id: 'J-fix-a8', roundId: 'R-fixture-elsewhere', kind: 'job', role: 'work',
        state: 'completed', jobsQuiescent: true, exitCode: 0, spec: { requested: ['sh', '-c', 'exit 0'] },
        evidenceRefs: [] } } }
    return round.id
  })
  const round = await h.store.read(state => state.rounds[roundId])
  // A row that brings its own reference is testing a refusal, so only rows without one get a real
  // receipt written where the trusted path expects it.
  for (const row of rows) {
    if (Array.isArray(row.evidenceRefs)) continue
    const { ref } = writeReceipt(h.store, round, round.executions[row.id])
    await h.store.mutate(state => { state.rounds[roundId].executions[row.id].evidenceRefs = [ref] })
  }
  return roundId
}

test('evidence accepts both the executionId and the jobId returned by chain_compute', async () => withRound(async (h, work) => {
  await addJobs(h, work, [{ id: 'J-fix-a1', jobId: 'role-chain-compute-fixture0001', exitCode: 0 },
    { id: 'J-fix-a3', exitCode: 7, spec: { requested: ['sh', '-c', 'exit 7'], argv: ['node', 'runner.mjs'] } }])
  const byExecution = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a1' } })
  assert.equal(byExecution.evidence.payload.exitCode, 0)
  assert.equal(byExecution.evidence.payload.command, 'sh -c printf OK; exit 0')
  assert.equal(byExecution.evidence.payload.jobId, 'J-fix-a1')
  assert.equal(byExecution.evidence.payload.hostJobId, 'role-chain-compute-fixture0001')
  assert.match(byExecution.evidence.payload.evidenceRef, /receipt\.json$/)
  // Intent and execution fact are both recorded: command is what the caller asked for,
  // executedCommand is the argv confinement actually scheduled.
  assert.equal(byExecution.evidence.payload.executedCommand, 'node runner.mjs')
  // The decorated Host job id from chain_compute resolves to the same ledger job.
  const byHost = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'role-chain-compute-fixture0001' } })
  assert.equal(byHost.evidence.payload.jobId, 'J-fix-a1')
  assert.equal(byHost.evidence.payload.exitCode, 0)
  const second = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a3' } })
  assert.equal(second.evidence.payload.exitCode, 7)
  assert.equal(second.evidence.payload.command, 'sh -c exit 7')
}))

test('a caller-supplied command, exit code or outcome must match the recorded job', async () => withRound(async (h, work) => {
  await addJobs(h, work, [{ id: 'J-fix-a2', exitCode: 7, spec: { requested: ['sh', '-c', 'exit 7'], argv: [] } }])
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command',
    payload: { jobId: 'J-fix-a2', command: 'sh -c "exit 0"' } }), e => e.code === 'EVIDENCE_MISMATCH')
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command',
    payload: { jobId: 'J-fix-a2', exitCode: 0 } }), e => e.code === 'EVIDENCE_MISMATCH')
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command',
    payload: { jobId: 'J-fix-a2', outcome: 'cancelled-deadline' } }), e => e.code === 'EVIDENCE_MISMATCH')
  // Matching values (whitespace-normalised) are accepted; the record still wins.
  const ok = await svc.recordEvidence(h.store, work, { layer: 'command',
    payload: { jobId: 'J-fix-a2', command: ' sh   -c  exit 7 ', exitCode: 7, outcome: 'natural-completion' } })
  assert.equal(ok.evidence.payload.command, 'sh -c exit 7')
  assert.equal(ok.evidence.payload.exitCode, 7)
  // A caller-typed command with no job binding can no longer satisfy the command gate: it has
  // no receipt, so it is refused instead of being recorded as execution evidence.
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command',
    payload: { command: 'sh -c exit 7', exitCode: 7 } }),
  e => e.code === 'COMMAND_BINDING_REQUIRED' && /must bind the settled compute job/.test(e.message))
}))

test('raw argv arrays preserve quoting and tampering is rejected', async () => withRound(async (h, work) => {
  await addJobs(h, work, [{ id: 'J-fix-c1', exitCode: 0,
    spec: { requested: ['sh', '-c', 'printf "a b"'], argv: ['node', 'runner.mjs', '--', 'sh', '-c', 'printf "a b"'] } }])
  const recorded = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-c1' } })
  const p = recorded.evidence.payload
  // The array is the execution fact; the joined string is only for display.
  assert.deepEqual(p.argv, ['sh', '-c', 'printf "a b"'])
  assert.deepEqual(p.executedArgv, ['node', 'runner.mjs', '--', 'sh', '-c', 'printf "a b"'])
  assert.equal(p.command, 'sh -c printf "a b"')
  // A caller string with the quotes flattened disagrees with the record and is refused.
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command',
    payload: { jobId: 'J-fix-c1', command: 'sh -c printf a b' } }), e => e.code === 'EVIDENCE_MISMATCH')
  // The same round may cite a job launched by another execution, but provenance stays visible.
  await addJobs(h, work, [{ id: 'J-fix-c2', exitCode: 0, ownerSessionId: 'session-other-work',
    parentExecutionId: 'E-other', spec: { requested: ['sh', '-c', 'exit 0'], argv: ['node', 'runner.mjs'] } }])
  const cross = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-c2' } })
  assert.equal(cross.evidence.payload.ownerSessionId, 'session-other-work')
  assert.equal(cross.evidence.payload.parentExecutionId, 'E-other')
  assert.equal(cross.evidence.authorSession, work.sessionId)
  assert.notEqual(cross.evidence.payload.ownerSessionId, cross.evidence.authorSession)
  // A job from another round is still refused even though the citation is same-session.
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a8' } }),
    e => e.code === 'JOB_WRONG_ROUND')
}))

test('unknown, cross-round, unsettled, unproven and argv-less jobs are refused', async () => withRound(async (h, work) => {
  await addJobs(h, work, [
    { id: 'J-fix-a4', state: 'running', jobsQuiescent: false },
    { id: 'J-fix-a5', exitCode: undefined, jobsQuiescent: true },
    { id: 'J-fix-a6', evidenceRefs: [] },
    { id: 'J-fix-a7', spec: { requested: null, argv: [] } },
  ])
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-does-not-exist' } }),
    e => e.code === 'BAD_ARGS' && /must name a compute job/.test(e.message))
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a8' } }),
    e => e.code === 'JOB_WRONG_ROUND')
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a4' } }),
    e => e.code === 'JOB_NOT_SETTLED' && /is running/.test(e.message))
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a5' } }),
    e => e.code === 'JOB_EXIT_UNKNOWN')
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a6' } }),
    e => e.code === 'JOB_PROOF_MISSING')
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-a7' } }),
    e => e.code === 'BAD_ARGS' && /no argv/.test(e.message))
  // Role layer stays enforced: only work/code may record command evidence.
  await assert.rejects(svc.recordEvidence(h.store, h.plan, { layer: 'command', payload: { jobId: 'J-fix-a1' } }),
    e => e.code === 'EVIDENCE_LAYER_MISMATCH')
}))

test('receipt trust: only this job\'s own regular file with matching content counts', async () => withRound(async (h, work) => {
  const round = await h.store.read(state => Object.values(state.rounds)
    .find(r => Object.values(r.executions ?? {}).some(e => e.role === 'work' && e.childSessionId === work.sessionId)))
  const jobOf = async id => (await h.store.read(state => state.rounds[round.id].executions[id]))
  const trusted = id => receiptPath(h.store.dir, round.id, id)
  const refuse = (jobId, code) => assert.rejects(
    svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId } }),
    e => e.code === code, 'expected ' + code + ' for ' + jobId)

  // Baseline: a real receipt in the trusted location is accepted, and the digest is recorded so
  // the accepted bytes can be compared later instead of being taken on trust.
  await addJobs(h, work, [{ id: 'J-fix-r4', exitCode: 3 }])
  const ok = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-r4' } })
  assert.equal(ok.evidence.payload.exitCode, 3)
  assert.match(ok.evidence.payload.evidenceRef, /receipt\.json$/)
  assert.match(ok.evidence.payload.receiptDigest, /^[0-9a-f]{64}$/)
  assert.equal(ok.evidence.payload.receiptExitAt.length > 0, true)

  // A string that merely looks like a receipt reference proves nothing.
  await addJobs(h, work, [
    { id: 'J-fix-r1', evidenceRefs: ['windows-job-empty:'] },
    { id: 'J-fix-r2', evidenceRefs: ['windows-job-empty:C:/does/not/exist/receipt.json'] },
  ])
  await refuse('J-fix-r1', 'JOB_PROOF_MISSING')
  await refuse('J-fix-r2', 'JOB_PROOF_UNTRUSTED')

  // A real, well-formed receipt file outside the trusted location (same tail, different tree) is
  // refused: identity of the file matters, not whether its name ends with receipt.json.
  await addJobs(h, work, [{ id: 'J-fix-r5' }])
  const decoy = join(h.dir, 'decoy', round.id, 'J-fix-r5', 'receipt.json')
  mkdirSync(dirname(decoy), { recursive: true })
  writeFileSync(decoy, JSON.stringify(receiptBody(round, await jobOf('J-fix-r5'))))
  await h.store.mutate(state => { state.rounds[round.id].executions['J-fix-r5'].evidenceRefs = ['windows-job-empty:' + decoy] })
  await refuse('J-fix-r5', 'JOB_PROOF_UNTRUSTED')

  // The trusted path must hold a regular file: a directory is not a receipt.
  await addJobs(h, work, [{ id: 'J-fix-r6', evidenceRefs: ['windows-job-empty:' + join(h.dir, 'placeholder.json')] }])
  mkdirSync(trusted('J-fix-r6'), { recursive: true })
  await h.store.mutate(state => {
    state.rounds[round.id].executions['J-fix-r6'].evidenceRefs = ['windows-job-empty:' + trusted('J-fix-r6')]
  })
  await refuse('J-fix-r6', 'JOB_PROOF_UNTRUSTED')
  rmSync(trusted('J-fix-r6'), { recursive: true, force: true })

  // Missing and unreadable receipts are distinguished instead of being accepted or guessed.
  await addJobs(h, work, [{ id: 'J-fix-r7' }])
  rmSync(trusted('J-fix-r7'), { force: true })
  await refuse('J-fix-r7', 'JOB_PROOF_MISSING')
  await addJobs(h, work, [{ id: 'J-fix-r8' }])
  writeFileSync(trusted('J-fix-r8'), 'not json at all')
  await refuse('J-fix-r8', 'JOB_PROOF_CORRUPT')

  // Content must still agree with the ledger record: a file whose identity, empty-job flag or
  // exit code was changed is refused, even though it parses and sits in the right place.
  await addJobs(h, work, [{ id: 'J-fix-r9', exitCode: 0 }])
  const tamper = async overrides => {
    writeReceipt(h.store, round, await jobOf('J-fix-r9'), overrides)
    await refuse('J-fix-r9', 'JOB_PROOF_INVALID')
  }
  await tamper({ jobEmpty: false })
  // A supervisor that could not create the process writes jobEmpty=true with launched=false;
  // that proves no exit, so it must never stand in for command evidence.
  await tamper({ launched: false })
  await tamper({ exitCode: 5 })
  await tamper({ nonce: 'nonce-from-another-job' })
  await tamper({ roundId: 'R-somewhere-else' })
  await tamper({ executionId: 'J-somewhere-else' })
  // Repairing the file restores acceptance, which shows the refusal tracked the content and not
  // some sticky flag on the record.
  writeReceipt(h.store, round, await jobOf('J-fix-r9'))
  const repaired = await svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-fix-r9' } })
  assert.equal(repaired.evidence.payload.exitCode, 0)

  // The symbolic-link subcase lives in test/receipt-symlink.mjs. Keeping it here meant an EPERM
  // from the OS became a console line while the file still reported every test passing, i.e. the
  // refusal was silently unevidenced. That suite is opt-in and reports skipped instead.
}))
test('the ledger record of a launched compute carries the scheduled argv (production-shape regression)', async () => withRound(async (h, work) => {
  // Fixture Host job adapter + fake-full sandbox: this asserts the record SHAPE that the
  // real Host writes, not native execution. Before the fix this record had no argv at all,
  // which is exactly why a real round could not bind evidence by id.
  h.services.sandbox = { confine: async argv => ({ argv, enforcement: 'full' }) }
  const started = await h.controller.compute(h.store, work, { argv: ['sh', '-c', 'exit 0'], label: 'fixture compute' })
  assert.equal(started.ok, true)
  const execution = await h.store.read(state => state.rounds[started.roundId].executions[started.executionId])
  assert.deepEqual(execution.spec.requested, ['sh', '-c', 'exit 0'])
  assert.ok(Array.isArray(execution.spec.argv) && execution.spec.argv.length, 'confined argv is recorded too')
  assert.equal(execution.jobId, started.jobId)
  // Without a native receipt the fixture job is not quiescent, so evidence is refused,
  // never invented.
  await assert.rejects(svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: started.jobId } }),
    e => e.code === 'JOB_NOT_SETTLED' || e.code === 'JOB_PROOF_MISSING')
}))
