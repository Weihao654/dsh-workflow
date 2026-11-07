// Atomic cross-process transactions. Unknown/corrupt state is never silently reset.
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs'
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
function ledgerHash(cwd, rootSessionId = null) {
  const identity = rootSessionId === null ? keyOf(cwd) : `${keyOf(cwd)}\0${rootSessionId}`
  return createHash('sha256').update(identity).digest('hex')
}
function validSessionId(id) { return typeof id === 'string' && id.trim() === id && id.length > 0 && !id.includes('\0') }
function sameScope(left, right) {
  return left?.version === right?.version && keyOf(left?.cwd ?? '') === keyOf(right?.cwd ?? '') &&
    left?.rootSessionId === right?.rootSessionId
}
function validateScope(scope, path) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || scope.version !== 1 ||
      typeof scope.cwd !== 'string' || !scope.cwd || !isAbsolute(scope.cwd) || !validSessionId(scope.rootSessionId) ||
      keyOf(canonicalCwd(scope.cwd)) !== keyOf(scope.cwd) ||
      basename(dirname(path)) !== ledgerHash(scope.cwd, scope.rootSessionId))
    throw new Error('invalid independent ledger scope')
}
function assertRegularFile(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing a non-regular ledger file: ${path}`)
}
function assertLedgerDirectory(dir) {
  try {
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing a non-directory ledger: ${dir}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ChainError('STATE_UNREADABLE', error.message)
  }
}
function markerScope(path) {
  const marker = join(dirname(path), 'initialized')
  let raw
  try { assertRegularFile(marker); raw = readFileSync(marker, 'utf8').trim() }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  if (raw === 'role-chain-state-v2') return null
  const value = JSON.parse(raw)
  if (!value || value.version !== 3) throw new Error('invalid ledger initialization marker')
  validateScope(value.ledgerScope, path)
  return value.ledgerScope
}
function decode(raw, path, expectedScope = undefined) {
  try {
    const state = JSON.parse(raw)
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.rounds || typeof state.rounds !== 'object' ||
        Array.isArray(state.rounds) || ![1, 2].includes(state.version) ||
        (state.activeRoundId !== null && typeof state.activeRoundId !== 'string') ||
        (state.activeRoundId && !state.rounds[state.activeRoundId])) throw new Error('invalid state envelope')
    const scope = state.ledgerScope ?? null, initializedScope = markerScope(path)
    if (Object.hasOwn(state, 'ledgerScope')) validateScope(state.ledgerScope, path)
    if (scope && (initializedScope === undefined || !sameScope(scope, initializedScope)))
      throw new Error('independent ledger scope does not match its initialization marker')
    if (!scope && initializedScope) throw new Error('independent ledger scope is missing from its state')
    if (scope && (!state.authorization || state.authorization.sessionId !== scope.rootSessionId))
      throw new Error('independent ledger authorization does not match its root plan session')
    if (expectedScope !== undefined && (expectedScope === null ? scope !== null : !sameScope(scope, expectedScope)))
      throw new Error('ledger scope does not match the requested root plan session')
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
  constructor(rootDir, { authorityRoot, rootSessionId } = {}) {
    this.rootDir = canonicalCwd(rootDir)
    this.authorityRoot = authorityRoot ? canonicalCwd(authorityRoot) : null
    if (this.authorityRoot) {
      const rel = relative(this.rootDir, this.authorityRoot)
      if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
        throw new ChainError('AUTHORITY_LOCATION_UNSAFE', 'Profile authority must be outside the controlled project.')
    }
    this.requiresAuthorization = Boolean(this.authorityRoot)
    if (rootSessionId !== undefined && rootSessionId !== null && !validSessionId(rootSessionId))
      throw new ChainError('BAD_ARGS', 'An independent ledger requires a valid rootSessionId.')
    this.rootSessionId = this.authorityRoot ? rootSessionId ?? null : null
    this.ledgerScope = this.rootSessionId === null ? null : Object.freeze({ version: 1, cwd: this.rootDir, rootSessionId: this.rootSessionId })
    this.key = keyOf(this.dir)
  }
  get dir() {
    return this.authorityRoot ? join(this.authorityRoot, ledgerHash(this.rootDir, this.rootSessionId))
      : join(this.rootDir, '.dsh', 'rounds')
  }
  get statePath() { return join(this.dir, 'state.json') }
  get markerPath() { return join(this.dir, 'initialized') }
  assertSessionLocation(sessionId) {
    if (!this.authorityRoot) return
    // Membership survives a cwd/preset change and a cold controller rebuild.
    // No negative cache: a later genuine authorization must be visible immediately.
    for (const { dir, state } of authorityLedgers(this.authorityRoot)) {
      if (keyOf(dir) === this.key) continue
      if (Object.hasOwn(state.sessionBindings ?? {}, sessionId) || state.authorization?.sessionId === sessionId || state.ledgerScope?.rootSessionId === sessionId)
        throw new ChainError('EXECUTION_SCOPE_CHANGED', 'A protected session cannot leave its original project ledger by changing cwd or root plan scope.')
    }
  }
  get queue() { return queues.get(this.key) ?? Promise.resolve() }
  roundPath(id) {
    if (!/^R-[a-zA-Z0-9-]+$/.test(id)) throw new ChainError('BAD_ARGS', 'Invalid round id')
    return join(this.dir, `${id}.json`)
  }
  async load() {
    try {
      assertLedgerDirectory(this.dir); assertRegularFile(this.statePath)
      return decode(await readFile(this.statePath, 'utf8'), this.statePath, this.ledgerScope)
    } catch (error) { return this.emptyOrThrow(error) }
  }
  snapshot() {
    try {
      assertLedgerDirectory(this.dir); assertRegularFile(this.statePath)
      return decode(readFileSync(this.statePath, 'utf8'), this.statePath, this.ledgerScope)
    } catch (error) { return this.emptyOrThrow(error) }
  }
  emptyOrThrow(error) {
    const state = missingOrThrow(error, this.statePath, this.markerPath)
    if (this.ledgerScope) state.ledgerScope = { ...this.ledgerScope }
    return state
  }
  async persist(state) {
    // The scope is created with an empty state, never retrofitted onto old data.
    if (this.ledgerScope ? !sameScope(state.ledgerScope, this.ledgerScope) : Object.hasOwn(state, 'ledgerScope'))
      throw new ChainError('STATE_UNREADABLE', 'Refusing to replace or remove a durable ledger scope.')
    if (this.ledgerScope && (!state.authorization || state.authorization.sessionId !== this.rootSessionId))
      throw new ChainError('STATE_UNREADABLE', 'Refusing to persist an independent ledger without its root plan authorization.')
    assertLedgerDirectory(this.dir)
    await mkdir(this.dir, { recursive: true })
    // Marker precedes initial state: a crash between them leaves a refusal, not a reset.
    try {
      const marker = await open(this.markerPath, 'wx')
      try {
        await marker.writeFile(this.ledgerScope ? `${JSON.stringify({ version: 3, ledgerScope: this.ledgerScope })}\n` : 'role-chain-state-v2\n')
        await marker.sync()
      } finally { await marker.close() }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const initializedScope = markerScope(this.statePath)
        if (this.ledgerScope ? !sameScope(initializedScope, this.ledgerScope) : initializedScope !== null)
          throw new Error('existing ledger initialization scope does not match')
      } catch (markerError) { throw new ChainError('STATE_UNREADABLE', markerError.message) }
    }
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
function authorityLedgers(authorityRoot) {
  let entries
  try { entries = readdirSync(authorityRoot, { withFileTypes: true }) }
  catch (error) {
    if (error.code === 'ENOENT') return []
    throw new ChainError('STATE_UNREADABLE', `Cannot inspect authority ledgers: ${error.message}`)
  }
  return entries.filter(entry => /^[a-f0-9]{64}$/.test(entry.name)).map(entry => {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new ChainError('STATE_UNREADABLE', 'Cannot establish session ownership through a non-directory authority entry.')
    const dir = join(authorityRoot, entry.name), path = join(dir, 'state.json'), marker = join(dir, 'initialized')
    let state
    try { assertRegularFile(path); state = decode(readFileSync(path, 'utf8'), path) }
    catch (error) { state = missingOrThrow(error, path, marker) }
    return { dir, state }
  })
}
const registry = new Map()
export function forCwd(cwd, options = {}) {
  const store = new RoundStore(cwd, options), key = store.key
  if (!registry.has(key)) registry.set(key, store)
  return registry.get(key)
}

function matchedStore(requested, { dir, state }, options) {
  const scope = state.ledgerScope
  const expectedDir = join(requested.authorityRoot, ledgerHash(requested.rootDir, scope?.rootSessionId ?? null))
  if ((scope && keyOf(scope.cwd) !== keyOf(requested.rootDir)) || keyOf(dir) !== keyOf(expectedDir))
    throw new ChainError('EXECUTION_SCOPE_CHANGED', 'A protected session cannot leave its original project ledger by changing cwd.')
  return forCwd(requested.rootDir, { ...options, rootSessionId: scope?.rootSessionId ?? null })
}

// Resolve durable membership before choosing a fresh root-plan scope. This is
// read-only, including on cold startup and for a never-authorized plan session.
export function forSession(cwd, sessionIds, options = {}) {
  if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.some(id => !validSessionId(id)))
    throw new ChainError('BAD_ARGS', 'Session ledger lookup requires actual session lineage ids.')
  const requested = new RoundStore(cwd, options)
  if (!requested.authorityRoot) return forCwd(cwd, options)
  const ids = new Set(sessionIds)
  const matches = authorityLedgers(requested.authorityRoot).filter(({ state }) =>
    ids.has(state.authorization?.sessionId) || ids.has(state.ledgerScope?.rootSessionId) ||
      [...ids].some(id => Object.hasOwn(state.sessionBindings ?? {}, id)))
  if (matches.length > 1)
    throw new ChainError('STATE_UNREADABLE', 'Session lineage belongs to multiple authority ledgers; refusing ambiguous ownership.')
  const store = matches.length ? matchedStore(requested, matches[0], options) : forCwd(requested.rootDir, options)
  // Also validate a pre-existing target with no remaining member entries;
  // missing or changed scope metadata never turns it into a fresh ledger.
  store.snapshot()
  return store
}

// Exact round lookup is reserved for the genuine human stop command. Model
// tools must continue resolving their own durable session membership instead.
export function forRound(cwd, roundId, options = {}) {
  if (typeof roundId !== 'string' || !/^R-[a-zA-Z0-9-]+$/.test(roundId))
    throw new ChainError('BAD_ARGS', 'An exact roundId is required for a human stop command.')
  const requested = new RoundStore(cwd, options)
  if (!requested.authorityRoot) {
    const store = forCwd(cwd, options)
    if (!Object.hasOwn(store.snapshot().rounds, roundId)) throw new ChainError('ROUND_NOT_FOUND', 'No such round in the current project.')
    return store
  }
  const matches = authorityLedgers(requested.authorityRoot).filter(({ state }) => Object.hasOwn(state.rounds, roundId))
  if (!matches.length) throw new ChainError('ROUND_NOT_FOUND', 'No such round in the profile authority ledgers.')
  if (matches.length > 1)
    throw new ChainError('STATE_UNREADABLE', 'Round id belongs to multiple authority ledgers; refusing ambiguous ownership.')
  if (matches[0].state.rounds[roundId]?.id !== roundId)
    throw new ChainError('STATE_UNREADABLE', 'The stored round identity does not match its ledger entry.')
  const store = matchedStore(requested, matches[0], options)
  store.snapshot()
  return store
}
