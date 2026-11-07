// Opt-in fixture: a symbolic link at the trusted receipt path must be refused.
//
// Windows denies link creation to an unprivileged session, so this file reports `skipped` instead
// of passing silently. Run it directly:
//   node --test test/receipt-symlink.mjs
// It is deliberately not part of run.mjs's selected suites: a skipped file there would make the
// whole gate incomplete on every host without the link privilege.
//
// Evidence level: FIXTURE (the store layout and receipt writer are real; the Host, sandbox and
// native supervisor are stand-ins).
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness } from './helpers.mjs'
import * as svc from '../lib/service.js'
import { receiptBody, writeReceipt } from './receipt-fixture.mjs'
import { receiptPath } from '../lib/receipt-proof.js'

test("a symbolic link at a job's trusted receipt path is refused", async (t) => {
  const h = await harness()
  const { work, result } = await h.spawnWork()
  try {
    const roundId = await h.store.mutate(state => {
      const round = Object.values(state.rounds).find(r => Object.values(r.executions ?? {})
        .some(e => e.role === 'work' && (e.childSessionId === work.sessionId || e.ownerSessionId === work.sessionId)))
      assert.ok(round, 'fixture work execution must be bound to a round')
      round.executions['J-link-1'] = {
        id: 'J-link-1', roundId: round.id, role: 'work', generation: 1, kind: 'job', childSessionId: work.sessionId,
        state: 'completed', jobsQuiescent: true, agentQuiescent: true, outcome: 'natural-completion',
        exitCode: 0, spec: { requested: ['sh', '-c', 'exit 0'], argv: ['node', 'runner.mjs'] },
        nonce: 'nonce-J-link-1', evidenceRefs: [],
      }
      return round.id
    })
    const round = await h.store.read(state => state.rounds[roundId])
    const job = round.executions['J-link-1']
    const { file } = writeReceipt(h.store, round, job)
    const trusted = receiptPath(h.store.dir, round.id, 'J-link-1')
    assert.equal(trusted, file, 'the fixture must write where the trusted path expects it')
    const outside = join(h.dir, 'outside-link-receipt.json')
    writeFileSync(outside, JSON.stringify(receiptBody(round, job)))
    rmSync(trusted, { force: true })
    try {
      symlinkSync(outside, trusted, 'file')
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error
      t.skip('this Windows session refuses link creation (' + error.code + '); the refusal is untested here')
      return
    }
    await assert.rejects(
      svc.recordEvidence(h.store, work, { layer: 'command', payload: { jobId: 'J-link-1' } }),
      e => e.code === 'JOB_PROOF_UNTRUSTED',
      'a symlink at the trusted path must be refused as untrusted')
  } finally {
    await h.store.mutate(state => {
      for (const round of Object.values(state.rounds)) if (round.executions?.['J-link-1']) delete round.executions['J-link-1']
    })
    await h.complete(result.childId)
    await h.close()
  }
})
