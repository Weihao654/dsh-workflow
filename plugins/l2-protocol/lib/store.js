// Atomic cross-process transactions. Unknown/corrupt state is never silently reset.
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { ChainError } from './errors.js'
import { acquireAdmissionLock } from './admission.js'
const EMPTY = () => ({ version: 2, activeRoundId: null, rounds: {}, agents: {}, sessionBindings: {} })
const queues = new Map(), seen = new Set()
export function canonicalCwd(cwd) {
  let path = resolve(String(cwd ?? '.'))
  const missing = []
  for (;;) {
    try { return resolve(realpathSync.native(path), ...missing) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(path)
      if (parent === path) throw error
      missing.unshift(basename(path)); path = parent
    }
  }
}
function keyOf(path) { return process.platform === 'win32' ? path.toLowerCase() : path }
function decode(raw, path) {
  try {
    const state = JSON.parse(raw)
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.rounds || typeof state.rounds !== 'object' ||
        Array.isArray(state.rounds) || ![1, 2].includes(state.version) ||
        (state.activeRoundId !== null && typeof state.activeRoundId !== 'string') ||
        (state.activeRoundId && !state.rounds[state.activeRoundId])) throw new Error('invalid state envelope')
    seen.add(keyOf(path)); return state
  } catch (error) { throw new ChainError('STATE_UNREADABLE', `Refusing to reset ${path}: ${error.message}`) }
}
function missingOrThrow(error, path, marker) {
  if (error.code === 'ENOENT' && !seen.has(keyOf(path)) && !existsSync(marker)) return EMPTY()
  if (error instanceof ChainError) throw error
  throw new ChainError('STATE_UNREADABLE', `Cannot establish control state at ${path}: ${error.message}`)
}
export async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`, file = await open(tmp, 'wx')
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await file.sync() }
  finally { await file.close() }
  await rename(tmp, path)
}
export class RoundStore {
  constructor(rootDir, { authorityRoot } = {}) {
    this.rootDir = canonicalCwd(rootDir)
    this.authorityRoot = authorityRoot ? canonicalCwd(authorityRoot) : null
    if (this.authorityRoot) {
      const rel = relative(this.rootDir, this.authorityRoot)
      if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
        throw new ChainError('AUTHORITY_LOCATION_UNSAFE', 'Profile authority must be outside the controlled project.')
    }
    this.requiresAuthorization = Boolean(this.authorityRoot)
    this.key = keyOf(this.dir)
  }
  get dir() {
    return this.authorityRoot ? join(this.authorityRoot, createHash('sha256').update(keyOf(this.rootDir)).digest('hex'))
      : join(this.rootDir, '.dsh', 'rounds')
  }
  get statePath() { return join(this.dir, 'state.json') }
  get markerPath() { return join(this.dir, 'initialized') }
  assertSessionLocation(sessionId) {
    if (!this.authorityRoot) return
    let entries
    try { entries = readdirSync(this.authorityRoot, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    // Membership survives a cwd/preset change and a cold controller rebuild.
    // No negative cache: a later genuine authorization must be visible immediately.
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue
      const dir = join(this.authorityRoot, entry.name)
      if (keyOf(dir) === this.key) continue
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new ChainError('STATE_UNREADABLE', 'Cannot establish session ownership through a non-directory authority entry.')
      const path = join(dir, 'state.json'), marker = join(dir, 'initialized')
      let state
      try { state = decode(readFileSync(path, 'utf8'), path) }
      catch (error) { state = missingOrThrow(error, path, marker) }
      if (Object.hasOwn(state.sessionBindings ?? {}, sessionId) || state.authorization?.sessionId === sessionId)
        throw new ChainError('EXECUTION_SCOPE_CHANGED', 'A protected session cannot leave its original project ledger by changing cwd.')
    }
  }
  get queue() { return queues.get(this.key) ?? Promise.resolve() }
  roundPath(id) {
    if (!/^R-[a-zA-Z0-9-]+$/.test(id)) throw new ChainError('BAD_ARGS', 'Invalid round id')
    return join(this.dir, `${id}.json`)
  }
  async load() {
    try { return decode(await readFile(this.statePath, 'utf8'), this.statePath) }
    catch (error) { return missingOrThrow(error, this.statePath, this.markerPath) }
  }
  snapshot() {
    try { return decode(readFileSync(this.statePath, 'utf8'), this.statePath) }
    catch (error) { return missingOrThrow(error, this.statePath, this.markerPath) }
  }
  async persist(state) {
    await mkdir(this.dir, { recursive: true })
    // Marker precedes initial state: a crash between them leaves a refusal, not a reset.
    try {
      const marker = await open(this.markerPath, 'wx')
      try { await marker.writeFile('role-chain-state-v2\n'); await marker.sync() } finally { await marker.close() }
    } catch (error) { if (error.code !== 'EEXIST') throw error }
    await atomicJson(this.statePath, state); seen.add(keyOf(this.statePath))
  }
  mutate(fn) {
    const run = async () => {
      // Exclusive filesystem creation coordinates processes. Stale locks are never stolen.
      const release = await acquireAdmissionLock(join(this.dir, 'state-lock'), 5000)
      try {
        const state = await this.load(), result = await fn(state)
        await this.persist(state); return result
      } finally { await release() }
    }
    const next = this.queue.then(run, run)
    queues.set(this.key, next.then(() => undefined, () => undefined)); return next
  }
  async read(fn) { await this.queue; return fn(await this.load()) }
  async exportRound(round) { await mkdir(this.dir, { recursive: true }); const path = this.roundPath(round.id); await atomicJson(path, round); return path }
}
const registry = new Map()
export function forCwd(cwd, options = {}) {
  const store = new RoundStore(cwd, options), key = store.key
  if (!registry.has(key)) registry.set(key, store)
  return registry.get(key)
}
