// Receipt trust boundary.
//
// A Windows Job-empty receipt is only evidence when it is the very file the supervisor wrote
// for THIS round and THIS job, it is still a regular file at that trusted location, and its
// contents still agree with the ledger record. A path-shaped string, a decoy file that merely
// ends with the same tail, a directory, a symbolic link or a tampered file all prove nothing,
// so they are refused instead of being accepted as "a receipt that exists".
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

export const RECEIPT_PREFIX = 'windows-job-empty:'
const WIN = process.platform === 'win32'
const fold = path => (WIN ? path.toLowerCase() : path)

function realOrNull(path) {
  try { return realpathSync(path) } catch { return null }
}

// The only trusted location for a job receipt: what the supervisor is given as its working
// directory, i.e. <store>/executions/<roundId>/<executionId>/receipt.json.
export function receiptPath(storeDir, roundId, executionId) {
  return join(storeDir, 'executions', roundId, executionId, 'receipt.json')
}

// expected: { storeDir, roundId, executionId, nonce, generation, exitCode?, deadlineAt?, signalDueAt? }
// exitCode is optional so the same validator can derive it when reading a fresh proof.
export function readJobReceipt(ref, expected) {
  if (typeof ref !== 'string' || !ref.startsWith(RECEIPT_PREFIX))
    return { ok: false, code: 'JOB_PROOF_MISSING', reason: 'the reference is not a native Job-empty receipt' }
  const file = ref.slice(RECEIPT_PREFIX.length)
  const trusted = receiptPath(expected.storeDir, expected.roundId, expected.executionId)
  // A bare prefix names no file at all; a path elsewhere is a different - and therefore
  // untrusted - file even when its name ends in receipt.json.
  if (!file.trim())
    return { ok: false, code: 'JOB_PROOF_MISSING', reason: 'the reference names no receipt file' }
  if (fold(resolve(file)) !== fold(resolve(trusted)))
    return { ok: false, code: 'JOB_PROOF_UNTRUSTED', reason: 'the reference does not name this job\'s own receipt file' }
  let stat
  try { stat = lstatSync(trusted) }
  catch { return { ok: false, code: 'JOB_PROOF_MISSING', reason: 'the receipt file is gone' } }
  if (stat.isSymbolicLink() || !stat.isFile())
    return { ok: false, code: 'JOB_PROOF_UNTRUSTED', reason: 'the receipt is not a regular file' }
  const real = realOrNull(trusted)
  if (!real || fold(real) !== fold(resolve(trusted)))
    return { ok: false, code: 'JOB_PROOF_UNTRUSTED', reason: 'the receipt resolves outside the trusted location' }
  let raw, receipt
  try { raw = readFileSync(trusted); receipt = JSON.parse(raw.toString('utf8')) }
  catch { return { ok: false, code: 'JOB_PROOF_CORRUPT', reason: 'the receipt is not readable JSON' } }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    return { ok: false, code: 'JOB_PROOF_CORRUPT', reason: 'the receipt is not a JSON object' }
  const identity = { backend: 'windows-job-list-v1', roundId: expected.roundId,
    executionId: expected.executionId, nonce: expected.nonce, generation: expected.generation }
  for (const [key, value] of Object.entries(identity)) {
    if (receipt[key] !== value)
      return { ok: false, code: 'JOB_PROOF_INVALID', reason: `receipt.${key} does not match this job` }
  }
  // A supervisor that never started the child still writes jobEmpty=true (ps1:183-184), so the
  // launched flag is what separates a real exit from a creation failure.
  if (expected.requireLaunched === true && receipt.launched !== true)
    return { ok: false, code: 'JOB_PROOF_INVALID', reason: 'the receipt does not record a launched process; a supervisor error proves no exit' }
  if (receipt.jobEmpty !== true)
    return { ok: false, code: 'JOB_PROOF_INVALID', reason: 'the receipt does not record an empty Windows Job' }
  if (!Number.isInteger(receipt.exitCode))
    return { ok: false, code: 'JOB_PROOF_INVALID', reason: 'the receipt has no integer exit code' }
  if (Number.isInteger(expected.exitCode) && receipt.exitCode !== expected.exitCode)
    return { ok: false, code: 'JOB_PROOF_INVALID', reason: 'receipt.exitCode disagrees with the recorded exit' }
  if (!Number.isFinite(Date.parse(receipt.checkedAt)) || !Number.isFinite(Date.parse(receipt.exitAt)))
    return { ok: false, code: 'JOB_PROOF_INVALID', reason: 'the receipt has no checked/exit timestamps' }
  if (expected.deadlineAt && Date.parse(receipt.deadlineAt) !== Date.parse(expected.deadlineAt))
    return { ok: false, code: 'JOB_PROOF_INVALID', reason: 'the receipt changed the T0 deadline' }
  if (expected.signalDueAt && Date.parse(receipt.signalDueAt) !== Date.parse(expected.signalDueAt))
    return { ok: false, code: 'JOB_PROOF_INVALID', reason: 'the receipt changed the T0 signal deadline' }
  return { ok: true, receipt, path: trusted, ref: RECEIPT_PREFIX + trusted,
    digest: createHash('sha256').update(raw).digest('hex'),
    exitCode: receipt.exitCode, checkedAt: receipt.checkedAt, exitAt: receipt.exitAt,
    reason: receipt.reason ?? null }
}
