// Controller-backed tests replace the old send-error -> duplicate-spawn expectations.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './helpers.mjs'
import { dispatch, normalizeReuse, DEFAULT_REUSE } from '../lib/dispatch.js'
test('reuse configuration keeps work persistent, code family/persistent, review fresh', () => {
  assert.deepEqual(DEFAULT_REUSE, { work: 'persistent', code: 'family', review: 'fresh' })
  assert.equal(normalizeReuse({ work: 'fresh' }).errors.length, 1)
  assert.equal(normalizeReuse({ code: 'fresh' }).errors.length, 1)
  assert.equal(normalizeReuse({ review: 'persistent' }).errors.length, 1)
  assert.equal(normalizeReuse({ code: null }, { allowClear: true }).errors.length, 0)
})
test('public dispatch requires controller and exact chain authority', async t => {
  const h = await harness(); t.after(() => h.close())
  assert.equal((await dispatch(h.ctx, h.store, { ...h.plan, controller: null }, { role: 'work', task: 'no bare transport' })).code, 'NO_CONTROLLER')
  const { work } = await h.spawnWork()
  await assert.rejects(h.controller.dispatch(h.store, h.plan, { role: 'code', task: 'skip work' }), e => e.code === 'DISPATCH_DENIED')
  await assert.rejects(h.controller.dispatch(h.store, work, { role: 'work', task: 'skip parent' }), e => e.code === 'DISPATCH_DENIED')
})
test('failed continuation never falls back to a replacement spawn', async t => {
  const options = {}, h = await harness(options); t.after(() => h.close())
  const { result } = await h.spawnWork(); await h.complete(result.childId)
  const before = h.calls.spawn.length
  options.sendError = Object.assign(new Error('provider cancelled continuation'), { code: 'CANCELLED' })
  await assert.rejects(h.controller.dispatch(h.store, h.plan, { role: 'work', task: 'do not duplicate' }))
  assert.equal(h.calls.spawn.length, before); assert.equal(h.calls.send.length, 1)
})
