// Round state store (P0): one authoritative JSON file per project.
//
// Why not ctx.storageDomain: the profile ships zod 3.25.76 while
// @deepseek-ai/dsh-storage-domain requires zod 4.4.3 for its value schemas.
// A P0 that depends on a version-matched zod would fail to load, so the
// authoritative copy is a plain file under <cwd>/.dsh/rounds/. That also makes
// the audit artifact and the state identical, which is what D2 asked for.
// P1 can migrate to storageDomain once the bundle ships its own zod 4.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EMPTY = () => ({ version: 1, activeRoundId: null, rounds: {} })

export class RoundStore {
  constructor(rootDir) {
    this.rootDir = rootDir
    this.queue = Promise.resolve()
  }

  get dir() {
    return join(this.rootDir, '.dsh', 'rounds')
  }

  get statePath() {
    return join(this.dir, 'state.json')
  }

  roundPath(id) {
    return join(this.dir, `${id}.json`)
  }

  async load() {
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || !parsed.rounds) return EMPTY()
      return parsed
    } catch {
      return EMPTY()
    }
  }

  async persist(state) {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.statePath}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, this.statePath)
  }

  // Serialised read-modify-write: one mutation at a time per store instance.
  mutate(fn) {
    const run = async () => {
      const state = await this.load()
      const result = await fn(state)
      await this.persist(state)
      return result
    }
    const next = this.queue.then(run, run)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async read(fn) {
    return fn(await this.load())
  }

  // D2: a human-readable copy next to the authoritative state.
  async exportRound(round) {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.roundPath(round.id), JSON.stringify(round, null, 2), 'utf8')
    return this.roundPath(round.id)
  }
}

// One store per project root, so two projects never share a queue or a file.
const registry = new Map()

export function forCwd(cwd) {
  const key = String(cwd ?? '.')
  if (!registry.has(key)) registry.set(key, new RoundStore(key))
  return registry.get(key)
}
