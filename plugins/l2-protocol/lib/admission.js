// Shared with the native supervisor's CreateNew lock. Only trusted Host /
// supervisor code may write this directory; process confinement is mandatory.
import { mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from './errors.js'

export async function acquireAdmissionLock(dir, timeoutMs = 750) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'admission.lock'), until = Date.now() + timeoutMs
  let handle
  for (;;) {
    try { handle = await open(path, 'wx', 0o600); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= until) fail('ADMISSION_LOCK_UNAVAILABLE', 'The launch/stop admission lock is unavailable; no stale owner is deleted or presumed exited.')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await handle.close()
    await unlink(path)
  }
}
