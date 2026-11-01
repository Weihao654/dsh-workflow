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

export const API_PATH = '/role-chain/api/table'
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
    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const cwd = list[index]?.header?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    }
  } catch {
    // fall through to the harness default
  }
  try {
    const working = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
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

/** The model catalog behind the dropdowns, with the same source the tool uses. */
async function modelCatalog(ctx) {
  const llm = ctx.get?.('llm') ?? ctx.llm
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
      providers.push({
        provider: id,
        name: String(provider?.displayName ?? provider?.name ?? id),
        models: (models ?? []).map((model) => ({ id: String(model.id), name: String(model.name ?? model.id) })),
      })
    } catch (error) {
      errors.push(`${id}: ${error.message}`)
      providers.push({ provider: id, name: id, models: [] })
    }
  }
  return { providers, errors }
}

/**
 * Register the table API. Absent a webServer (host-free tests, `dsh` without the
 * web page) this is inert, never a crash.
 */
export function registerApi(ctx, state = {}) {
  const server = ctx.get?.('webServer') ?? ctx.webServer
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
