// The settings-card API, tested without a harness.
//
// The handler is ordinary code: a fake webServer captures the route, and a fake
// request/response pair drives it. What matters is that the HTTP face and the
// `chain_role_models` tool cannot diverge — both write through saveRoleModels()
// and both refuse a route the LLM registry does not know.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerApi, resolveCwd, API_PATH } from '../lib/api.js'

const DIR = join(process.cwd(), '.api-test')
let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function section(name) {
  console.log(`\n[${name}]`)
}

const MODEL_CATALOG = {
  'deepseek-account': [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
  openai: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }],
}

function fakeCtx(overrides = {}) {
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        }
      }
      if (name === 'llm') {
        return {
          listProviders: () => [
            { provider: 'deepseek-account', displayName: 'DeepSeek Account' },
            { provider: 'openai', displayName: 'openai' },
          ],
          listModels: async (provider) => MODEL_CATALOG[provider] ?? [],
          resolveModelInfo: async (provider, model) => {
            if (!(MODEL_CATALOG[provider] ?? []).some((entry) => entry.id === model)) {
              throw new Error(`unknown model ${provider}/${model}`)
            }
            return { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }
          },
        }
      }
      if (name === 'sessions') {
        return { list: () => [{ header: { cwd: DIR } }] }
      }
      return undefined
    },
    ...overrides,
  }
  return { ctx, routes }
}

function fakeRequest({ method = 'GET', url = API_PATH, headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

function fakeResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.statusCode = status
      response.headers = headers ?? {}
      return response
    },
    end(chunk) {
      response.body = chunk === undefined ? '' : String(chunk)
    },
  }
  return response
}

async function call(route, options) {
  const response = fakeResponse()
  await route.handler(fakeRequest(options), response)
  let json
  try {
    json = JSON.parse(response.body)
  } catch {
    json = undefined
  }
  return { status: response.statusCode, headers: response.headers, json, raw: response.body }
}

function tablePath() {
  return join(DIR, '.dsh', 'role-chain.json')
}

function writeTable(document) {
  mkdirSync(join(DIR, '.dsh'), { recursive: true })
  writeFileSync(tablePath(), JSON.stringify(document, null, 2), 'utf8')
}

async function main() {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(join(DIR, '.dsh'), { recursive: true })

  section('registration')
  {
    const { ctx, routes } = fakeCtx()
    const api = registerApi(ctx, {})
    check('registers one exact route', routes.length === 1)
    check('route path', routes[0]?.path === API_PATH, routes[0]?.path)
    check('route kind', routes[0]?.kind === 'exact')
    check('reports itself registered', api.registered === true)
    api.dispose()
    check('dispose removes the route', routes.length === 0)

    const bare = registerApi({ get: () => undefined }, {})
    check('no webServer is inert, not a crash', bare.registered === false)
    check('inert dispose is callable', typeof bare.dispose === 'function')
    bare.dispose()

    // The regression that shipped once: Cordis throws `cannot get property
    // "webServer" without inject` on the PROPERTY, which used to abort the whole
    // plugin fiber. Reading it defensively must fall back to ctx.get().
    const throwing = {
      get webServer() {
        throw new Error('cannot get property "webServer" without inject')
      },
      get(name) {
        if (name !== 'webServer') return undefined
        return {
          register(route) {
            return () => {
              void route
            }
          },
        }
      },
    }
    const rescued = registerApi(throwing, {})
    check('a throwing webServer property is survivable', rescued.registered === true)
    rescued.dispose()

    const hostile = {
      get webServer() {
        throw new Error('cannot get property "webServer" without inject')
      },
      get() {
        throw new Error('no such service')
      },
    }
    const inert = registerApi(hostile, {})
    check('both lookups failing is inert, not a throw', inert.registered === false)
    inert.dispose()
  }

  section('resolveCwd')
  {
    const { ctx } = fakeCtx()
    check('explicit cwd wins', resolveCwd(ctx, 'C:/somewhere') === 'C:/somewhere')
    check('blank cwd falls back to the last session', resolveCwd(ctx, '  ') === DIR, resolveCwd(ctx, '  '))
    check('missing argument falls back too', resolveCwd(ctx, undefined) === DIR)
  }

  section('GET')
  {
    const { ctx, routes } = fakeCtx()
    registerApi(ctx, {})
    writeTable({ enabled: true, roleModels: { plan: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } })
    const answer = await call(routes[0])
    check('200', answer.status === 200, answer.raw)
    check('reports the resolved project', answer.json.cwd === DIR, answer.json.cwd)
    check('reports the file path', answer.json.configPath === tablePath())
    check('echoes the table', answer.json.roles?.plan?.model === 'deepseek-flash')
    check('enabled flag', answer.json.enabled === true)
    check('provider catalog is present', answer.json.providers?.length === 2)
    check(
      'models come from llm.listModels',
      answer.json.providers?.[0]?.models?.length === 2,
      JSON.stringify(answer.json.providers?.[0]),
    )
    check('no catalog errors', (answer.json.catalogErrors ?? []).length === 0)

    writeTable({ enabled: true, roleModels: '{broken' })
    const broken = await call(routes[0])
    check('a broken file still answers 200', broken.status === 200)
    check('and reports the parse failure', (broken.json.errors ?? []).length === 1, JSON.stringify(broken.json.errors))
  }

  section('POST')
  {
    const { ctx, routes } = fakeCtx()
    registerApi(ctx, {})
    const route = routes[0]

    const noHeader = await call(route, {
      method: 'POST',
      body: { set: { plan: { provider: 'deepseek-account', model: 'deepseek-flash' } } },
    })
    check('missing x-role-chain is refused', noHeader.status === 403, noHeader.status)

    const empty = await call(route, { method: 'POST', headers: { 'x-role-chain': '1' }, body: {} })
    check('an empty change is a 400', empty.status === 400, empty.status)

    const saved = await call(route, {
      method: 'POST',
      headers: { 'x-role-chain': '1' },
      body: {
        set: {
          plan: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
          code: { provider: 'openai', model: 'gpt-6-luna' },
        },
      },
    })
    check('200 on a valid write', saved.status === 200, saved.raw)
    check('reports the written path', saved.json.path === tablePath())
    const written = JSON.parse(readFileSync(tablePath(), 'utf8'))
    check('file has both roles', Boolean(written.roleModels.plan && written.roleModels.code))
    check('effort survived', written.roleModels.plan.reasoningEffort === 'high')

    const unknown = await call(route, {
      method: 'POST',
      headers: { 'x-role-chain': '1' },
      body: { set: { plan: { provider: 'deepseek-account', model: 'no-such-model' } } },
    })
    check('an unknown model is a 409', unknown.status === 409, unknown.status)
    check('with ROUTE_UNKNOWN', unknown.json.code === 'ROUTE_UNKNOWN', unknown.json.code)
    const afterRefusal = JSON.parse(readFileSync(tablePath(), 'utf8'))
    check('a refused write leaves the file alone', afterRefusal.roleModels.plan.model === 'deepseek-flash')

    const skipped = await call(route, {
      method: 'POST',
      headers: { 'x-role-chain': '1' },
      body: { skipValidation: true, set: { plan: { provider: 'x', model: 'y' } } },
    })
    check('skipValidation writes anyway', skipped.status === 200, skipped.raw)

    const toggled = await call(route, {
      method: 'POST',
      headers: { 'x-role-chain': '1' },
      body: { enabled: false },
    })
    check('enabled alone is a write', toggled.status === 200, toggled.status)
    check('and lands in the file', JSON.parse(readFileSync(tablePath(), 'utf8')).enabled === false)

    const cleared = await call(route, {
      method: 'POST',
      headers: { 'x-role-chain': '1' },
      body: { clear: ['plan'] },
    })
    check('clear removes one role', cleared.status === 200 && !cleared.json.document.roleModels.plan)
  }

  section('other methods')
  {
    const { ctx, routes } = fakeCtx()
    registerApi(ctx, {})
    const answer = await call(routes[0], { method: 'PUT' })
    check('405 for anything but GET/POST', answer.status === 405, answer.status)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  rmSync(DIR, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  rmSync(DIR, { recursive: true, force: true })
  process.exit(1)
})
