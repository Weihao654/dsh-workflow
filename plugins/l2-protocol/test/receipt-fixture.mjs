// Shared fixture helper: a receipt file in the trusted location for a fixture round/job.
// Command evidence only accepts the file at <store>/executions/<roundId>/<executionId>/receipt.json
// whose contents still agree with the ledger record, so fixtures write that exact file with the
// identity fields the supervisor would write.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { RECEIPT_PREFIX, receiptPath } from '../lib/receipt-proof.js'

// Body for a settled job: identity plus the fields readJobReceipt validates.
export function receiptBody(round, job, overrides = {}) {
  const now = new Date().toISOString()
  return Object.assign({
    version: 1,
    backend: 'windows-job-list-v1',
    nonce: job.nonce,
    roundId: round.id,
    executionId: job.id,
    generation: job.generation ?? 1,
    deadlineAt: round.time?.deadlineAt ?? null,
    signalDueAt: round.time?.signalDueAt ?? null,
    jobEmpty: true,
    launched: true,
    resumed: true,
    startedAt: now,
    checkedAt: now,
    exitAt: now,
    reason: 'natural-completion',
    exitCode: job.exitCode ?? 0,
  }, overrides)
}

export function writeReceipt(store, round, job, overrides = {}) {
  const file = receiptPath(store.dir, round.id, job.id)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(receiptBody(round, job, overrides)))
  return { file, ref: RECEIPT_PREFIX + file }
}

export function receiptFor(store, round, job, overrides = {}) {
  return writeReceipt(store, round, job, overrides).ref
}
