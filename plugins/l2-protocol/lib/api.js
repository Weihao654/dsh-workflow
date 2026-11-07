// HTTP face for the settings card.
//
// Why HTTP instead of the Remote gateway: no third-party plugin in this profile
// can own a Typert Remote namespace (the gateway discovers services that carry a
// `typertRemote` binding built by the compiler), while `webServer.register` is a
// plain route table that any host half may add to. The shipped market plugin
// serves its own API exactly this way, so it is the supported third-party path.
//
// One operation, two callers: the read/write logic here and the
// `chain_role_models` tool both end in loadRoutes()/saveRoleModels(), so the UI
// and the conversation can never disagree about what a write means.
//
// The table stays per project (`<cwd>/.dsh/role-chain.json`). A settings page has
// no session of its own, so the caller may name the project with `?cwd=`; absent
// that, the most recent session's cwd is used, which is the project the user was
// last looking at.

import { loadRoutes, saveRoleModels } from './role-models.js'
import { validateRoutes } from './tools.js'
import { planStartStatus } from './plan-start.js'

export const API_PATH = '/role-chain/api/table'
export const PLAN_START_API_PATH = '/role-chain/api/plan-start'
const MAX_BODY_BYTES = 64 * 1024
const CATALOG_TTL_MS = 60_000

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sessionCwd(ctx) {
  try {
    const sessions = serviceOf(ctx, 'sessions')
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const cwd = list[index]?.header?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    }
  } catch {
    // fall through to the harness default
  }
  try {
    const working = serviceOf(ctx, 'workingDirectory')
    const fallback = working?.defaultDirectory
    if (typeof fallback === 'string' && fallback) return fallback
  } catch {
    // fall through to the process cwd
  }
  try {
    return process.cwd()
  } catch {
    return '.'
  }
}

/** Which project a request touches: explicit `cwd`, else the last session's. */
export function resolveCwd(ctx, requested) {
  if (typeof requested === 'string' && requested.trim()) return requested.trim()
  return sessionCwd(ctx)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    request.on('error', reject)
  })
}

/** Read a service without tripping the inject guard (property access throws). */
function serviceOf(ctx, name) {
  try {
    const viaGet = ctx.get?.(name)
    if (viaGet) return viaGet
  } catch {
    // get() unavailable — fall through
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * The model catalog behind the dropdowns, with the same source the tool uses.
 *
 * Each model also carries the `reasoningEffort` ids it actually accepts, read
 * from the LLM registry. That is not cosmetic: the validator rejects an effort a
 * model does not advertise (`deepseek-flash` takes off/low/high/max, not medium),
 * so a hardcoded dropdown would let the user pick a value that always fails.
 */
async function modelCatalog(ctx) {
  const llm = serviceOf(ctx, 'llm')
  if (!llm) return { providers: [], errors: ['llm 服务不可用，读不到模型清单'] }
  const providers = []
  const errors = []
  let listed = []
  try {
    listed = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch (error) {
    errors.push(`listProviders 失败：${error.message}`)
  }
  for (const provider of listed) {
    const id = String(provider?.provider ?? provider?.id ?? '')
    if (!id) continue
    try {
      const models = await llm.listModels(id)
      const rows = []
      for (const model of models ?? []) {
        const row = { id: String(model.id), name: String(model.name ?? model.id) }
        if (typeof llm.resolveModelInfo === 'function') {
          try {
            const info = await llm.resolveModelInfo(id, row.id)
            const efforts = info?.reasoning?.efforts
            if (Array.isArray(efforts)) {
              row.efforts = efforts
                .map((effort) => String(effort?.id ?? effort))
                .filter((effort) => effort !== '')
            }
            if (info?.reasoning?.defaultEffort) row.defaultEffort = String(info.reasoning.defaultEffort)
          } catch (error) {
            errors.push(`${id}/${row.id}: ${error.message}`)
          }
        }
        rows.push(row)
      }
      providers.push({
        provider: id,
        name: String(provider?.displayName ?? provider?.name ?? id),
        models: rows,
      })
    } catch (error) {
      errors.push(`${id}: ${error.message}`)
      providers.push({ provider: id, name: id, models: [] })
    }
  }
  return { providers, errors }
}

/**
 * The web server, if this composition has one. Property access to a service the
 * fiber does not inject THROWS (`cannot get property "webServer" without
 * inject`), so every path here is defensive: when the host half registers this
 * through `ctx.inject(['webServer'], …)` the property is legal; anywhere else
 * the call degrades to "no server" instead of failing the plugin.
 */
function serverOf(ctx) {
  try {
    const viaProperty = ctx.webServer
    if (viaProperty) return viaProperty
  } catch {
    // not injected here — fall through to the lookup below
  }
  try {
    return ctx.get?.('webServer')
  } catch {
    return undefined
  }
}

// Read-only bootstrap state. Authorization itself still travels through the
// Host Commands service, which resolves the live Agent and records human input.
export function registerPlanStartApi(ctx, controller) {
  const server = serverOf(ctx)
  if (!server || typeof server.register !== 'function') return { registered: false, path: PLAN_START_API_PATH, dispose() {} }
  const handler = async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' }); response.end(); return
    }
    try {
      const url = new URL(request.url ?? PLAN_START_API_PATH, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId?.trim()) { sendJson(response, 400, { ok: false, code: 'BAD_ARGS', message: 'sessionId is required.' }); return }
      sendJson(response, 200, await planStartStatus(ctx, controller, sessionId))
    } catch (error) {
      const status = ['ROLE_DENIED', 'ROLE_BINDING_INVALID', 'EXECUTION_SCOPE_CHANGED'].includes(error.code) ? 409 : 503
      sendJson(response, status, { ok: false, code: error.code ?? 'PLAN_START_UNAVAILABLE', message: String(error.message ?? error) })
    }
  }
  try {
    const dispose = server.register({ kind: 'exact', path: PLAN_START_API_PATH, handler })
    return { registered: true, path: PLAN_START_API_PATH, dispose: typeof dispose === 'function' ? dispose : () => {} }
  } catch (error) { return { registered: false, path: PLAN_START_API_PATH, error: String(error.message ?? error), dispose() {} } }
}

/**
 * Register the table API. Absent a webServer (host-free tests, `dsh` without the
 * web page) this is inert, never a crash.
 */
export function registerApi(ctx, state = {}) {
  const server = serverOf(ctx)
  if (!server || typeof server.register !== 'function') {
    return { registered: false, path: API_PATH, dispose() {} }
  }

  let catalog = { value: null, at: 0 }
  const catalogOf = async () => {
    const now = Date.now()
    if (catalog.value && now - catalog.at < CATALOG_TTL_MS) return catalog.value
    catalog = { value: await modelCatalog(ctx), at: now }
    return catalog.value
  }

  const read = async (url) => {
    const cwd = resolveCwd(ctx, url?.searchParams?.get('cwd'))
    const table = loadRoutes(cwd)
    const models = await catalogOf()
    return {
      ok: true,
      cwd,
      configPath: table.path,
      exists: table.exists,
      enabled: table.enabled,
      roles: table.roleModels,
      errors: table.errors,
      providers: models.providers,
      catalogErrors: models.errors,
      applied: state.tracker?.appliedRoute?.(state.sessionId) ?? null,
    }
  }

  const write = async (body) => {
    const cwd = resolveCwd(ctx, body.cwd)
    const change = { set: body.set, clear: body.clear, enabled: body.enabled }
    const writes = Boolean(change.set || change.clear || typeof change.enabled === 'boolean')
    if (!writes) return { status: 400, payload: { ok: false, errors: ['没有要写入的内容'] } }

    if (!body.skipValidation) {
      const problems = await validateRoutes(ctx, change.set)
      if (problems.length > 0) {
        return {
          status: 409,
          payload: {
            ok: false,
            code: 'ROUTE_UNKNOWN',
            errors: problems,
            hint: '写错不会自动降级，那一环会直接失败，所以先拒写。',
          },
        }
      }
    }
    const saved = saveRoleModels(cwd, change)
    if (!saved.ok) return { status: 409, payload: { ok: false, path: saved.path, errors: saved.errors } }
    return {
      status: 200,
      payload: {
        ok: true,
        cwd,
        path: saved.path,
        document: saved.document,
        note: '已写入，下一次模型请求起生效；在浏览器里手动选过模型的会话保持手选。',
      },
    }
  }

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url ?? API_PATH, 'http://127.0.0.1')
      if (request.method === 'GET') {
        sendJson(response, 200, await read(url))
        return
      }
      if (request.method === 'POST') {
        // A custom header cannot be set cross-origin without CORS preflight, so
        // requiring it keeps a stray page from writing files through the loopback
        // listener.
        if (String(request.headers?.['x-role-chain'] ?? '') !== '1') {
          sendJson(response, 403, { ok: false, errors: ['缺少 x-role-chain 请求头'] })
          return
        }
        const body = await readBody(request)
        const result = await write(body)
        sendJson(response, result.status, result.payload)
        return
      }
      response.writeHead(405, { allow: 'GET, POST' })
      response.end()
    } catch (error) {
      sendJson(response, 500, { ok: false, errors: [String(error?.message ?? error)] })
    }
  }

  let dispose = () => {}
  try {
    const registered = server.register({ kind: 'exact', path: API_PATH, handler })
    if (typeof registered === 'function') dispose = registered
  } catch (error) {
    return { registered: false, path: API_PATH, error: String(error?.message ?? error), dispose() {} }
  }

  return { registered: true, path: API_PATH, dispose }
}
