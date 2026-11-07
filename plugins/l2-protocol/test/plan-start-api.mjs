// Read-only HTTP state with the real controller and deterministic Host stand-ins.
// No provider, browser, installed profile or genuine human command is contacted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { harness } from './helpers.mjs'
import { resolveExec } from '../lib/roles.js'
import { registerPlanStartApi, PLAN_START_API_PATH } from '../lib/api.js'

async function fixture(t) {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-plan-api-'))
  let h
  t.after(async () => {
    try { if (h) await h.close() }
    finally {
      const target = resolve(authorityRoot)
      assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`) && target.includes('role-chain-plan-api-'))
      await rm(target, { recursive: true, force: true })
    }
  })
  h = await harness({ noOpen: true, authorityRoot })
  const routes = []
  const ctx = { ...h.ctx, get: name => name === 'webServer' ? { register: route => {
    routes.push(route); return () => routes.splice(routes.indexOf(route), 1)
  } } : h.ctx.get(name) }
  const api = registerPlanStartApi(ctx, h.controller)
  t.after(() => api.dispose())
  const call = async (method, query = '') => {
    let status, headers, text = ''
    await routes[0].handler({ method, url: PLAN_START_API_PATH + query }, {
      writeHead(code, value) { status = code; headers = value },
      end(value) { text = value ?? '' },
    })
    return { status, headers, body: text ? JSON.parse(text) : null }
  }
  return { h, routes, api, call }
}

test('plan startup HTTP reports the exact live session without opening or authorizing a round', async t => {
  const { h, api, routes, call } = await fixture(t)
  assert.equal(api.registered, true)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, PLAN_START_API_PATH)
  let writes = 0
  const store = h.controller.storeForExec(resolveExec(h.ctx, { agent: h.plan.agent }))
  store.mutate = async () => { writes++; throw new Error('status must not mutate') }
  const result = await call('GET', '?sessionId=' + encodeURIComponent(h.plan.sessionId))
  assert.equal(result.status, 200)
  assert.equal(result.body.state, 'ready')
  assert.equal(result.body.sessionId, h.plan.sessionId)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(writes, 0)
})

test('plan startup HTTP rejects all mutation methods and invalid session identities', async t => {
  const { call } = await fixture(t)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await call(method, '?sessionId=root-plan')
    assert.equal(result.status, 405)
    assert.equal(result.headers.allow, 'GET')
  }
  assert.equal((await call('GET')).status, 400)
  const absent = await call('GET', '?sessionId=does-not-exist')
  assert.equal(absent.status, 409)
  assert.equal(absent.body.ok, false)
  assert.equal(absent.body.code, 'ROLE_BINDING_INVALID')
})

test('plan startup route is inert without the web service and unregisters cleanly', async t => {
  const missing = registerPlanStartApi({ get() {} }, {})
  assert.equal(missing.registered, false)
  missing.dispose()
  const { api, routes } = await fixture(t)
  api.dispose()
  assert.equal(routes.length, 0)
})
