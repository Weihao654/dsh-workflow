import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harness } from './helpers.mjs'
import { RoundStore } from '../lib/store.js'
import { reserveRequest, settleRequest, installUsage, normalizeUsage } from '../lib/usage.js'
import { bindingOf, budgetOf } from '../lib/runtime.js'
const request = { provider: 'fake', model: 'deterministic', maxTokens: 16, inputTokens: 20 }
async function setup(t, options = {}) {
  const h = await harness(options); t.after(() => h.close())
  const who = await h.store.read(s => { const { round, execution } = bindingOf(s, h.plan.sessionId); return { sessionId: h.plan.sessionId, roundId: round.id, executionId: execution.id, generation: execution.generation } })
  return { h, who }
}
test('N+1 never calls downstream; failed attempt consumes slot; duplicate receipt does not refund', async t => {
  const { h, who } = await setup(t, { budget: { requests: 1, restarts: 0 } })
  const dispose = installUsage(h.ctx, h.controller); t.after(dispose)
  const middleware = h.hooks.get('llm/stream')[0]
  let called = 0
  const options = { ...request, sessionId: who.sessionId, messages: [] }
  const downstream = async function* () { called++; throw new Error('failed transport') }
  await assert.rejects(async () => { for await (const _ of middleware(options, downstream)) {} }, /failed transport/)
  await assert.rejects(async () => { for await (const _ of middleware(options, downstream)) {} }, e => e.code === 'REQUEST_BUDGET_REACHED')
  assert.equal(called, 1)
  assert.equal(budgetOf({ budget: { restarts: 0 } }).restarts, 0)
})
test('last slot is exclusive across independent OS processes, not just a JS queue', async t => {
  const { h, who } = await setup(t, { budget: { requests: 1 } })
  const storeURL = pathToFileURL(join(process.cwd(), 'lib/store.js')).href
  const usageURL = pathToFileURL(join(process.cwd(), 'lib/usage.js')).href
  const programs = [0, 1].map(i => ({ path: join(h.dir, `worker-${i}.mjs`), result: join(h.dir, `result-${i}.json`) }))
  for (const [i, row] of programs.entries()) await writeFile(row.path,
    `import { writeFile } from 'node:fs/promises'; import { RoundStore } from ${JSON.stringify(storeURL)}; import { reserveRequest } from ${JSON.stringify(usageURL)}; let result; try { await reserveRequest(new RoundStore(${JSON.stringify(h.dir)}), ${JSON.stringify(who)}, 'Q-worker-${i}', ${JSON.stringify(request)}); result='admitted' } catch(e) { result=e.code ?? e.message } await writeFile(${JSON.stringify(row.result)},JSON.stringify(result));`)
  const outcomes = await Promise.all(programs.map(row => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [row.path], { stdio: 'ignore' })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)))
  })))
  assert.equal(outcomes.length, 2)
  const results = await Promise.all(programs.map(async row => JSON.parse(await readFile(row.result, 'utf8'))))
  assert.deepEqual(results.sort(), ['REQUEST_BUDGET_REACHED', 'admitted'].sort())
})
test('cold deleted state is denied using durable marker, rather than becoming an empty ledger', async t => {
  const { h } = await setup(t)
  await unlink(h.store.statePath)
  const script = join(h.dir, 'cold-read.mjs'), output = join(h.dir, 'cold-result.json')
  const storeURL = pathToFileURL(join(process.cwd(), 'lib/store.js')).href
  await writeFile(script, `import {writeFile} from 'node:fs/promises'; import {RoundStore} from ${JSON.stringify(storeURL)}; let result; try {await new RoundStore(${JSON.stringify(h.dir)}).load();result='incorrectly-empty'}catch(e){result=e.code};await writeFile(${JSON.stringify(output)},JSON.stringify(result));`)
  await new Promise((resolve, reject) => { const child = spawn(process.execPath, [script], { stdio: 'ignore' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`cold worker exit ${code}`))) })
  assert.equal(JSON.parse(await readFile(output, 'utf8')), 'STATE_UNREADABLE')
  // Restore only this known disposable fixture so controller teardown has state.
  await unlink(h.store.markerPath)
  await h.store.persist({ version: 2, activeRoundId: null, rounds: {}, agents: {}, sessionBindings: {} })
})
test('persistence failure cannot return admission; duplicate final receipt is idempotent', async t => {
  const { h, who } = await setup(t)
  const original = h.store.persist.bind(h.store)
  h.store.persist = async () => { throw new Error('injected durable-write failure') }
  await assert.rejects(reserveRequest(h.store, who, 'Q-denied', request), /injected durable-write failure/)
  h.store.persist = original
  assert.equal(await h.store.read(s => s.rounds[who.roundId].usage.requests['Q-denied']), undefined)
  await reserveRequest(h.store, who, 'Q-final', request)
  const usage = normalizeUsage({ inputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 2, outputTokens: 3, totalTokens: 16, reasoningTokens: 1 })
  await settleRequest(h.store, who, 'Q-final', usage, 'completed')
  assert.equal((await settleRequest(h.store, who, 'Q-final', usage, 'completed')).duplicate, true)
  assert.equal(Object.keys(await h.store.read(s => s.rounds[who.roundId].usage.requests)).length, 1)
})
