import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { RoundStore } from '../lib/store.js'
import { ChainController } from '../lib/controller.js'
import * as svc from '../lib/service.js'
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
export async function harness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'role-chain-safe-')), store = new RoundStore(dir)
  const sessions = new Map(), agents = new Map(), records = new Map(), definitions = new Map(), commands = new Map(), hooks = new Map()
  const calls = { spawn: [], send: [], drain: [], interrupt: [], cancelled: [], jobs: [] }, extraControllers = []
  let jobsController = 0
  function agent(id, role, parent = null) {
    const record = { idle: deferred(), result: deferred(), dispose: deferred() }
    const value = { id, cancel() { calls.cancelled.push(id); if (!options.holdCancel) record.idle.resolve() }, whenIdle() { return record.idle.promise } }
    sessions.set(id, { id, header: { id, agentPreset: role, cwd: dir, ...(parent ? { parentSession: parent, origin: 'subagent' } : {}) } })
    records.set(id, record); agents.set(id, value)
    return value
  }
  const root = agent('root-plan', 'plan')
  const subagents = {
    list: () => ['spawn'], getProvider: () => ({ capabilities: { agentPreset: true, agentOptions: true } }), resolveMaxDepth: value => value,
    async startActivation(spec) {
      calls.spawn.push(spec)
      if (options.beforeSpawn) await options.beforeSpawn(spec)
      if (options.spawnError) throw options.spawnError
      const child = agent(spec.childId, spec.request.agentPreset, spec.request.parent.id)
      const record = records.get(child.id)
      return { childId: child.id, messageId: `message-${calls.spawn.length}`, result: record.result.promise,
        async dispose() { if (options.holdDispose) await record.dispose.promise; record.idle.resolve(); record.result.resolve({}); return undefined } }
    },
    async sendMessage(parent, target, content, config) {
      calls.send.push({ parent, target, content, config })
      if (options.sendError) throw options.sendError
      const record = records.get(target); record.idle = deferred()
      return `message-reuse-${calls.send.length}`
    },
    async drainChildren(parent, ids) { calls.drain.push({ parent, ids }); if (options.holdDrain) await records.get(ids[0]).dispose.promise; for (const id of ids) records.get(id)?.idle.resolve() },
    interrupt(id, authority) { calls.interrupt.push({ id, authority }) },
  }
  const noGit = () => ({ done: Promise.resolve({ exitCode: 128, signal: null }), waitForExit: async () => true,
    collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: 'fatal: not a git repository', lossy: false }) } } })
  const jobs = {
    attachController() { jobsController++; return () => { jobsController-- } },
    start(spec) {
      if (!jobsController || options.jobsRefuse) throw new Error('No attached controller/capacity')
      const id = `stand-in-job-${calls.jobs.length + 1}`, row = { id, spec, state: 'running' }
      calls.jobs.push(row)
      row.handle = spec.run({ id, append() {}, updateProgress() {} })
      row.done = row.handle.done.then(outcome => { row.state = outcome.status; return outcome })
      return id
    },
  }
  const services = { subagents, jobs, sessions: { get: id => sessions.get(String(id)), list: () => [...sessions.values()] },
    agents: { get: id => agents.get(String(id)), isOwnedBy: (id, owner) => sessions.get(id)?.header.parentSession === owner.id },
    workingDirectory: { defaultDirectory: dir, get: () => dir },
    subprocess: { spawn: noGit, terminalEnvironment: async () => ({ platform: 'windows' }), resolveExecutable: async value => value },
    userQuestions: { ask: async () => ({ answers: [{ id: 'gate', selected: ['批准'] }] }) },
    commands: { register(spec) { commands.set(spec.name, spec); return () => commands.delete(spec.name) } },
  }
  const ctx = { ...services, get: name => services[name], logger: { warn() {}, info() {} },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
      get: name => definitions.get(name), guard(fn) { ctx.guard = fn; return () => { delete ctx.guard } } },
    on(name, fn) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); return () => { hooks.set(name, hooks.get(name).filter(value => value !== fn)) } },
  }
  const controller = new ChainController(ctx, options).install()
  function exec(id = root.id) {
    const session = sessions.get(id), header = session.header
    return { agent: agents.get(id), role: header.agentPreset, preset: header.agentPreset, isRoot: !header.parentSession,
      sessionId: id, cwd: dir, controller, reuse: options.reuse ?? {}, signal: new AbortController().signal }
  }
  const plan = exec()
  const opened = options.noOpen ? null : await svc.openRound(store, plan, { goal: 'Short controllable stand-in; not v15', budget: options.budget })
  await controller.attach(store, plan)
  async function spawnWork({ freeze = true } = {}) {
    const result = await controller.dispatch(store, plan, { role: 'work', task: 'Stand-in coordinator' })
    const work = exec(result.childId)
    if (freeze) await svc.freezeBaseline(ctx, store, work)
    return { work, result }
  }
  async function complete(id) {
    const record = records.get(id); record.result.resolve({}); record.idle.resolve(); record.dispose.resolve()
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
    await store.queue
  }
  async function close() {
    options.holdCancel = false; options.holdDispose = false; options.holdDrain = false
    for (const record of records.values()) { record.idle.resolve(); record.result.resolve({}); record.dispose.resolve() }
    for (const extra of extraControllers) await extra.dispose()
    await controller.dispose()
    await Promise.all(calls.jobs.map(row => row.done))
    const absolute = resolve(dir)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !absolute.includes('role-chain-safe-')) throw new Error('Refusing unexpected cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
  return { dir, store, ctx, services, options, controller, plan, opened, calls, commands, sessions, agents, records, hooks, extraControllers,
    definitions, exec, spawnWork, complete, close }
}
