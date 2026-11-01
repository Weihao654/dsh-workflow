// Role reuse: dispatch reuses a role's child instead of spawning one per task.
//
// Runs without a harness: the `subagents` service is faked, so what is asserted is
// the bookkeeping contract (spawn vs steer, roster keys, authority, fallback,
// release) rather than the host's transport.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RoundStore } from '../lib/store.js'
import {
  DEFAULT_REUSE,
  DISPATCH_AUTHORITY,
  dispatch,
  normalizeReuse,
  pickProvider,
  policyFor,
  readRoster,
  release,
  rosterKey,
} from '../lib/dispatch.js'

const DIR = mkdtempSync(join(tmpdir(), 'role-chain-dispatch-'))
const store = new RoundStore(DIR)

let pass = 0
let fail = 0

function check(label, condition, detail) {
  if (condition) {
    pass += 1
  } else {
    fail += 1
    console.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function mkExec(role, options = {}) {
  return {
    agent: { id: `agent-${role}` },
    role,
    isRoot: options.isRoot ?? role === 'plan',
    preset: role,
    sessionId: options.sessionId ?? `s-${role}`,
    cwd: DIR,
    reuse: options.reuse,
  }
}

function fakeSubagents() {
  const calls = { spawn: [], send: [], drain: [] }
  let seq = 0
  return {
    calls,
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn', capabilities: { agentPreset: true, agentOptions: true } }),
    resolveMaxDepth: (value) => value,
    async startActivation(spec) {
      calls.spawn.push(spec)
      seq += 1
      return { childId: `child-${seq}` }
    },
    async sendMessage(sender, targetId, content, options) {
      calls.send.push({ sender, targetId, content, signal: options?.signal })
      return `msg-${calls.send.length}`
    },
    async drainChildren(parent, ids) {
      calls.drain.push({ parent, ids })
    },
  }
}

function mkCtx(subagents) {
  return { subagents, get: (name) => (name === 'subagents' ? subagents : undefined) }
}

async function main() {
  // ---- policy normalisation -------------------------------------------------
  console.log('policy')
  {
    const { reuse, errors } = normalizeReuse({ work: 'persistent', code: 'family', review: 'nope', plan: 'fresh' })
    check('valid policies kept', reuse.work === 'persistent' && reuse.code === 'family')
    check('unknown policy reported', errors.some((line) => line.includes('review')), errors)
    check('plan is not dispatchable', errors.some((line) => line.includes('plan')), errors)
    check('defaults are the user-chosen ones', policyFor({}, 'work') === 'persistent' && policyFor({}, 'review') === 'fresh')
    check('DEFAULT_REUSE matches', DEFAULT_REUSE.work === 'persistent' && DEFAULT_REUSE.code === 'family')
    check('roster key for code names the family', rosterKey('code', 'auth') === 'code:auth' && rosterKey('code', '') === 'code:default')
    check('work key is the role', rosterKey('work', '') === 'work')
    check('authority map', DISPATCH_AUTHORITY.plan.includes('work') && DISPATCH_AUTHORITY.work.includes('review'))
  }

  // ---- first dispatch spawns ------------------------------------------------
  console.log('spawn')
  const subagents = fakeSubagents()
  const ctx = mkCtx(subagents)
  {
    const result = await dispatch(ctx, store, mkExec('plan'), { role: 'work', task: '实现登录' })
    check('first dispatch spawns', result.ok && result.action === 'spawn', result)
    check('spawn passes the role preset', subagents.calls.spawn[0]?.request?.agentPreset === 'work', subagents.calls.spawn[0])
    check('spawn passes the parent agent', subagents.calls.spawn[0]?.request?.parent?.id === 'agent-plan')
    check('spawn carries the task text', subagents.calls.spawn[0]?.request?.prompt?.[0]?.text === '实现登录')
    check('spawn uses delivery parent', subagents.calls.spawn[0]?.delivery === 'parent')
    const roster = await readRoster(store)
    check('roster records the child', roster.work?.childId === 'child-1', roster)
    check('roster records the policy', roster.work?.policy === 'persistent')
    check('roster records the parent session', roster.work?.parentSessionId === 's-plan')
    check('pickProvider prefers spawn', pickProvider(subagents) === 'spawn')
  }

  // ---- second dispatch reuses ----------------------------------------------
  console.log('reuse')
  {
    const result = await dispatch(ctx, store, mkExec('plan'), { role: 'work', task: '补测试' })
    check('second dispatch reuses', result.ok && result.action === 'reuse', result)
    check('reuse steers the same child', subagents.calls.send[0]?.targetId === 'child-1', subagents.calls.send[0])
    check('reuse sends the new task', subagents.calls.send[0]?.content?.[0]?.text === '补测试')
    check('reuse does not spawn again', subagents.calls.spawn.length === 1, subagents.calls.spawn.length)
    const roster = await readRoster(store)
    check('roster counts uses', roster.work?.uses === 2, roster.work)
  }

  // ---- code is per family ---------------------------------------------------
  console.log('family')
  {
    const first = await dispatch(ctx, store, mkExec('work'), { role: 'code', task: '写登录接口', family: 'auth' })
    const again = await dispatch(ctx, store, mkExec('work'), { role: 'code', task: '补登录测试', family: 'auth' })
    const other = await dispatch(ctx, store, mkExec('work'), { role: 'code', task: '写设置页', family: 'ui' })
    check('new family spawns', first.action === 'spawn' && first.family === 'auth', first)
    check('same family reuses', again.action === 'reuse' && again.childId === first.childId, again)
    check('other family spawns', other.action === 'spawn' && other.childId !== first.childId, other)
    const roster = await readRoster(store)
    check('two code entries', Boolean(roster['code:auth']) && Boolean(roster['code:ui']), Object.keys(roster))
    check('default family when omitted', (await dispatch(ctx, store, mkExec('work'), { role: 'code', task: 'x' })).family === 'default')
  }

  // ---- review is fresh every round -----------------------------------------
  console.log('fresh')
  {
    const a = await dispatch(ctx, store, mkExec('work'), { role: 'review', task: '审第一轮' })
    const b = await dispatch(ctx, store, mkExec('work'), { role: 'review', task: '审第二轮' })
    check('review spawns each time', a.action === 'spawn' && b.action === 'spawn', { a, b })
    check('review children differ', a.childId !== b.childId)
    const forced = await dispatch(ctx, store, mkExec('plan'), { role: 'work', task: '强制新建', fresh: true })
    check('fresh:true overrides the policy', forced.action === 'spawn', forced)
    check('review never reuses even with a roster entry', (await readRoster(store)).review?.childId === b.childId)
  }

  // ---- authority ------------------------------------------------------------
  console.log('authority')
  {
    const denied = await dispatch(ctx, store, mkExec('work'), { role: 'work', task: 'x' })
    check('work cannot dispatch work', denied.code === 'DISPATCH_DENIED', denied)
    const skip = await dispatch(ctx, store, mkExec('plan'), { role: 'code', task: 'x' })
    check('plan cannot dispatch code directly', skip.code === 'DISPATCH_DENIED', skip)
    const code = await dispatch(ctx, store, mkExec('code'), { role: 'review', task: 'x' })
    check('code dispatches nothing', code.code === 'DISPATCH_DENIED', code)
    const bogus = await dispatch(ctx, store, mkExec('plan'), { role: 'plan', task: 'x' })
    check('plan is not a target', bogus.code === 'BAD_ARGS', bogus)
    const empty = await dispatch(ctx, store, mkExec('plan'), { role: 'work', task: '  ' })
    check('empty task refused', empty.code === 'BAD_ARGS', empty)
  }

  // ---- fallback when the child cannot be steered ---------------------------
  console.log('fallback')
  {
    const flaky = fakeSubagents()
    flaky.sendMessage = async () => {
      throw new Error('adjacency rejected')
    }
    const before = (await readRoster(store)).work?.childId
    const result = await dispatch(mkCtx(flaky), store, mkExec('plan'), { role: 'work', task: '重试' })
    check('failed reuse falls back to spawn', result.ok && result.action === 'spawn', result)
    check('fallback spawned a new child', result.childId !== before, { before, after: result.childId })
    const roster = await readRoster(store)
    check('roster replaced', roster.work?.childId === result.childId && roster.work?.uses === 1, roster.work)
  }

  // ---- no service -----------------------------------------------------------
  console.log('no service')
  {
    const missing = await dispatch({ get: () => undefined }, store, mkExec('plan'), { role: 'work', task: 'x' })
    check('missing subagents is reported', missing.code === 'NO_SUBAGENTS', missing)
  }

  // ---- release --------------------------------------------------------------
  console.log('release')
  {
    const rosterBefore = await readRoster(store)
    const released = await release(ctx, store, mkExec('plan'), { role: 'work' })
    check('release reports the child', released.released?.[0]?.childId === rosterBefore.work.childId, released)
    check('release drains the child', subagents.calls.drain[0]?.ids?.[0] === rosterBefore.work.childId, subagents.calls.drain[0])
    const roster = await readRoster(store)
    check('release removed the entry', roster.work === undefined, roster)
    const again = await release(ctx, store, mkExec('plan'), { role: 'work' })
    check('second release is a no-op', again.ok && again.released.length === 0, again)
    const spawned = await dispatch(ctx, store, mkExec('plan'), { role: 'work', task: '重新开始' })
    check('dispatch after release spawns', spawned.action === 'spawn', spawned)
  }

  // ---- only the spawning session may release -------------------------------
  console.log('ownership')
  {
    const outsider = mkExec('plan', { sessionId: 's-other' })
    const refused = await release(ctx, store, outsider, { role: 'work' })
    check('foreign session cannot release', refused.released.length === 0 && refused.refused?.length === 1, refused)
    const roster = await readRoster(store)
    check('entry survives the refusal', Boolean(roster.work), roster)
    const all = await release(ctx, store, mkExec('plan'), {})
    check('release all covers only this session\u2019s children', all.released.length === 1 && all.released[0].key === 'work', all)
    check('children dispatched by work are refused to plan', (all.refused ?? []).length >= 1, all.refused)
    // work owns the code/review children, so work's own session is the one that can retire them.
    const fromWork = await release(ctx, store, mkExec('work'), {})
    check('work can retire its own code/review children', fromWork.released.length >= 2, fromWork)
    const finalRoster = await readRoster(store)
    check('roster is empty at the end', Object.keys(finalRoster).length === 0, finalRoster)
  }

  rmSync(DIR, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  rmSync(DIR, { recursive: true, force: true })
  process.exit(1)
})
