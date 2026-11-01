// Role → model routing, tested without a harness.
//
// The listener itself is a thin wrapper around three pure pieces: parsing the
// project table, deciding whether to override, and reading the session header.
// Those are what this file exercises; `installRouting` is driven with a fake
// event bus so the wrapper's guards (unknown preset, missing file, manual
// override) are covered too.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { normalizeRoleModels, loadRoutes, saveRoleModels, RouteTracker, installRouting, describeRoutes } from '../lib/role-models.js'

const DIR = join(process.cwd(), '.routes-test')
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

function table(roleModels, extra = {}) {
  mkdirSync(join(DIR, '.dsh'), { recursive: true })
  writeFileSync(
    join(DIR, '.dsh', 'role-chain.json'),
    JSON.stringify({ ...extra, roleModels }, null, 2),
    'utf8',
  )
  return join(DIR, '.dsh', 'role-chain.json')
}

process.on('exit', () => {
  try {
    rmSync(DIR, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

// ---------------------------------------------------------------- parsing

section('normalizeRoleModels')
{
  const { roleModels, errors } = normalizeRoleModels({
    plan: { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Pro' },
    code: { provider: 'siliconflow', model: 'Qwen/Qwen3.8-27B', reasoningEffort: 'low' },
    boss: { provider: 'x', model: 'y' },
    review: { provider: 'x' },
  })
  check('keeps valid roles', Object.keys(roleModels).join(',') === 'plan,code', Object.keys(roleModels).join(','))
  check('keeps reasoningEffort', roleModels.code.reasoningEffort === 'low')
  check('reports unknown role', errors.some((e) => e.includes('boss')))
  check('reports missing model', errors.some((e) => e.includes('review')))
  check('rejects non-object', normalizeRoleModels('nope').errors.length === 1)
}

// ---------------------------------------------------------------- reading

section('loadRoutes')
{
  const path = table({ plan: { provider: 'p', model: 'm' } })
  const first = loadRoutes(DIR)
  check('finds the project file', first.exists && first.enabled, first.path)
  check('path is <cwd>/.dsh/role-chain.json', first.path === path)
  check('parses the route', first.roleModels.plan.model === 'm')

  table({ plan: { provider: 'p', model: 'm2' } })
  const second = loadRoutes(DIR)
  check('picks up an edit without restart', second.roleModels.plan.model === 'm2', second.roleModels.plan.model)

  table({ plan: { provider: 'p', model: 'm' } }, { enabled: false })
  const disabled = loadRoutes(DIR)
  check('honours enabled:false', disabled.enabled === false)

  rmSync(join(DIR, '.dsh', 'role-chain.json'))
  const missing = loadRoutes(DIR)
  check('missing file is inert, not an error', missing.exists === false && missing.errors.length === 0)

  writeFileSync(join(DIR, '.dsh', 'role-chain.json'), '{ oops', 'utf8')
  const broken = loadRoutes(DIR)
  check('broken JSON disables routing', broken.enabled === false && broken.errors.length === 1)
  check('broken JSON error is readable', /解析失败/.test(broken.errors[0]), broken.errors[0])
}

// ---------------------------------------------------------------- deciding

section('RouteTracker')
{
  const tracker = new RouteTracker()
  const base = { provider: 'default-provider', model: 'default-model', temperature: 0.2 }
  const route = { provider: 'strong', model: 'big' }

  const first = tracker.decide('s1', base, route)
  check('applies the route', first.provider === 'strong' && first.model === 'big')
  check('keeps unrelated knobs', first.temperature === 0.2)

  const again = tracker.decide('s1', { provider: 'strong', model: 'big' }, route)
  check('re-applies when the base already matches', again.model === 'big')
  check('records what it applied', tracker.appliedRoute('s1').model === 'big')

  const manualBase = { provider: 'user-choice', model: 'picked' }
  const afterManual = tracker.decide('s1', manualBase, route)
  check('manual selection wins', afterManual === null)
  check('session is marked manual', tracker.isManual('s1'))
  check('stays out afterwards', tracker.decide('s1', { provider: 'strong', model: 'big' }, route) === null)

  const other = new RouteTracker()
  check('no route means no change', other.decide('s2', base, undefined) === null)
  check('unknown session has nothing applied', other.appliedRoute('nope') === null)

  const effort = new RouteTracker()
  const withEffort = effort.decide('s3', { provider: 'a', model: 'b', reasoningEffort: 'high' }, { provider: 'c', model: 'd' })
  check('drops stale reasoningEffort on model change', withEffort.reasoningEffort === undefined)

  const keep = new RouteTracker()
  const kept = keep.decide('s4', { provider: 'a', model: 'b' }, { provider: 'c', model: 'd', reasoningEffort: 'low' })
  check('sets the route effort', kept.reasoningEffort === 'low')
}

section('RouteTracker · picker choices made before the first request')
{
  const defaults = { provider: 'default', model: 'std' }
  const route = { provider: 'strong', model: 'big' }

  const fresh = new RouteTracker()
  const applied = fresh.decide('r1', { provider: 'default', model: 'std' }, route, { isRoot: true, defaults })
  check('a root session on the profile default still gets routed', applied?.model === 'big')

  const picked = new RouteTracker()
  const before = picked.decide('r2', { provider: 'gpt-6-luna', model: 'luna' }, route, { isRoot: true, defaults })
  check('a pick made before the first request wins', before === null)
  check('and the session counts as manual', picked.isManual('r2') === true)

  const pickedRoute = new RouteTracker()
  const same = pickedRoute.decide('r3', { provider: 'strong', model: 'big' }, route, { isRoot: true, defaults })
  check('a pick equal to the route is not treated as manual', same !== null)

  const child = new RouteTracker()
  const inherited = child.decide('r4', { provider: 'strong', model: 'big' }, { provider: 'cheap', model: 'small' }, { isRoot: false, defaults })
  check('a child inheriting its parent route is not a manual pick', inherited?.model === 'small')

  const blind = new RouteTracker()
  const noDefaults = blind.decide('r5', { provider: 'anything', model: 'else' }, route)
  check('without a known default the old rule still applies', noDefaults?.model === 'big')
}

// ---------------------------------------------------------------- listener

section('installRouting')
{
  table({
    plan: { provider: 'strong', model: 'big' },
    code: { provider: 'cheap', model: 'small' },
  })

  const headers = {
    's-plan': { id: 's-plan', agentPreset: 'plan', cwd: DIR },
    's-code': { id: 's-code', agentPreset: 'code', cwd: DIR, parentSession: 's-plan' },
    's-standard': { id: 's-standard', agentPreset: 'standard', cwd: DIR },
  }

  let handler = null
  const ctx = {
    on(name, fn) {
      assert.equal(name, 'agent/request')
      handler = fn
      return () => {
        handler = null
      }
    },
    get(name) {
      if (name !== 'sessions') return undefined
      return { get: (id) => (headers[id] ? { header: headers[id] } : undefined) }
    },
  }

  const routing = installRouting(ctx)
  check('registers a listener', typeof handler === 'function')

  const base = { provider: 'default', model: 'default' }
  const plan = await handler({ agent: { id: 's-plan' } }, async () => base)
  check('plan gets the strong route', plan.provider === 'strong' && plan.model === 'big')
  check('the base config is untouched', base.provider === 'default')

  const code = await handler({ agent: { id: 's-code' } }, async () => base)
  check('code gets the cheap route', code.model === 'small')

  const standard = await handler({ agent: { id: 's-standard' } }, async () => base)
  check('a non-role session is not routed', standard.provider === 'default')

  const unknown = await handler({ agent: { id: 'ghost' } }, async () => base)
  check('a missing header is not routed', unknown.provider === 'default')

  const manual = await handler({ agent: { id: 's-plan' } }, async () => ({ provider: 'picked', model: 'by-user' }))
  check('a manual pick is respected', manual.provider === 'picked')

  const described = describeRoutes(ctx, { sessionId: 's-code', role: 'code', cwd: DIR }, routing.tracker)
  check('status shows the table', described.roles.plan.model === 'big')
  check('status shows this session', described.thisSession.applied.model === 'small', JSON.stringify(described.thisSession))

  routing.dispose()
  check('disposer removes the listener', handler === null)
}

section('writing the table from the conversation')
{
  // Start from a clean project directory: the tool is the only writer here.
  rmSync(join(DIR, '.dsh'), { recursive: true, force: true })

  const created = saveRoleModels(DIR, {
    set: { code: { provider: 'cheap', model: 'small', reasoningEffort: 'low' } },
  })
  check('a missing file is created', created.ok === true, JSON.stringify(created.errors))
  check('the write reports its path', created.path.endsWith('role-chain.json'))
  check('the written table round-trips', loadRoutes(DIR).roleModels.code.model === 'small')
  check('a second role can be added without losing the first', (() => {
    const next = saveRoleModels(DIR, { set: { plan: { provider: 'strong', model: 'big' } } })
    const table = loadRoutes(DIR).roleModels
    return next.ok && table.code.model === 'small' && table.plan.model === 'big'
  })())

  const cleared = saveRoleModels(DIR, { clear: ['code'] })
  check('clear removes exactly one role', cleared.ok && loadRoutes(DIR).roleModels.code === undefined)
  check('clear keeps the other roles', loadRoutes(DIR).roleModels.plan.model === 'big')

  const off = saveRoleModels(DIR, { enabled: false })
  check('the switch is persisted', off.ok && loadRoutes(DIR).enabled === false)

  const bad = saveRoleModels(DIR, { set: { nope: { provider: 'x', model: 'y' } } })
  check('an unknown role is refused', bad.ok === false && bad.errors[0].includes('未知角色'))
  check('a refused write leaves the file alone', loadRoutes(DIR).roleModels.plan.model === 'big')

  const half = saveRoleModels(DIR, { set: { plan: { provider: 'only-provider' } } })
  check('a missing model is refused', half.ok === false && half.errors[0].includes('缺少'))

  const reloaded = loadRoutes(DIR)
  check('the cache follows the written file', reloaded.exists === true && reloaded.enabled === false)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
