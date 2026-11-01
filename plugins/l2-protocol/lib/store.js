// Authoritative, fail-closed project state. No malformed/unreadable file is reset.
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ChainError } from './errors.js'

const EMPTY = () => ({ version: 2, activeRoundId: null, rounds: {}, agents: {}, sessionBindings: {} })
const queues = new Map()
const seen = new Set()

export function canonicalCwd(cwd) {
  const path = resolve(String(cwd ?? '.'))
  try { return realpathSync.native(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return path
  }
}

function keyOf(path) { return process.platform === 'win32' ? path.toLowerCase() : path }
function decode(raw, path) {
  try {
    const state = JSON.parse(raw)
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        !state.rounds || typeof state.rounds !== 'object' || Array.isArray(state.rounds) ||
        ![1, 2].includes(state.version) ||
        (state.activeRoundId !== null && typeof state.activeRoundId !== 'string') ||
        (state.activeRoundId && !state.rounds[state.activeRoundId])) throw new Error('invalid state envelope')
    seen.add(keyOf(path))
    return state
  } catch (error) {
    throw new ChainError('STATE_UNREADABLE', `Refusing to reset ${path}: ${error.message}`)
  }
}
function missingOrThrow(error, path) {
  if (error.code === 'ENOENT' && !seen.has(keyOf(path))) return EMPTY()
  if (error instanceof ChainError) throw error
  throw new ChainError('STATE_UNREADABLE', `Cannot establish control state at ${path}: ${error.message}`)
}

export async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`
  const file = await open(tmp, 'wx')
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await file.sync() }
  finally { await file.close() }
  await rename(tmp, path)
}

export class RoundStore {
  constructor(rootDir) { this.rootDir = canonicalCwd(rootDir); this.key = keyOf(this.rootDir) }
  get dir() { return join(this.rootDir, '.dsh', 'rounds') }
  get statePath() { return join(this.dir, 'state.json') }
  get queue() { return queues.get(this.key) ?? Promise.resolve() }
  roundPath(id) {
    if (!/^R-[a-zA-Z0-9-]+$/.test(id)) throw new ChainError('BAD_ARGS', 'Invalid round id')
    return join(this.dir, `${id}.json`)
  }
  async load() {
    try { return decode(await readFile(this.statePath, 'utf8'), this.statePath) }
    catch (error) { return missingOrThrow(error, this.statePath) }
  }
  snapshot() {
    try { return decode(readFileSync(this.statePath, 'utf8'), this.statePath) }
    catch (error) { return missingOrThrow(error, this.statePath) }
  }
  async persist(state) {
    await mkdir(this.dir, { recursive: true })
    await atomicJson(this.statePath, state)
    seen.add(keyOf(this.statePath))
  }
  mutate(fn) {
    const run = async () => {
      const state = await this.load()
      const result = await fn(state)
      await this.persist(state)
      return result
    }
    const next = this.queue.then(run, run)
    queues.set(this.key, next.then(() => undefined, () => undefined))
    return next
  }
  async read(fn) { await this.queue; return fn(await this.load()) }
  async exportRound(round) {
    await mkdir(this.dir, { recursive: true })
    const path = this.roundPath(round.id)
    await atomicJson(path, round)
    return path
  }
}

const registry = new Map()
export function forCwd(cwd) {
  const path = canonicalCwd(cwd), key = keyOf(path)
  if (!registry.has(key)) registry.set(key, new RoundStore(path))
  return registry.get(key)
}
