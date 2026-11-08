// Presentation through the Host's public scoped registry only. Execution and
// durable controlled-task admission remain the controller's responsibility.
import { serviceOf } from './host.js'

export class WorkflowToolVisibility {
  constructor(controller, { enabled = true, logger } = {}) {
    this.ctx = controller?.ctx ?? controller
    this.logger = logger
    this.enabled = enabled === true
    this.records = new Map()
  }

  warn(error) {
    try { (this.logger ?? this.ctx?.logger)?.warn?.(`[role-chain] Workflow tool visibility unavailable: ${error?.message ?? error}`) } catch {}
  }

  sync(exec, workflow, toolNames = []) {
    const agent = exec?.agent
    if (!this.enabled || workflow !== true) { this.release(agent); return false }
    try {
      // A copied/stale Agent or a historical session id cannot install a
      // restriction into a live Agent's scope.
      if (!agent?.ctx || exec.bindingValid !== true || typeof exec.sessionId !== 'string' ||
          String(agent.id) !== exec.sessionId || serviceOf(this.ctx, 'agents')?.get?.(exec.sessionId) !== agent) return false
      const names = [...new Set(Array.isArray(toolNames) ? toolNames : [])]
        .filter(name => typeof name === 'string' && name.startsWith('chain_') && name !== 'chain_role_models').sort()
      const signature = names.join('\0')
      const tools = serviceOf(agent.ctx, 'tools')
      const existing = this.records.get(exec.sessionId)
      if (existing?.agent === agent && existing.tools === tools && existing.signature === signature &&
          !names.some(name => !existing.denied.has(name) && tools.get(name, agent) !== undefined)) return true
      // Teardown belongs to the exact old Agent instance, even if the Host
      // has cold-resumed another Agent under the same durable session id.
      if (existing) this.release(existing.agent)
      if (typeof tools?.get !== 'function' || typeof tools?.restrict !== 'function') return false
      const deny = names.filter(name => tools.get(name, agent) !== undefined)
      if (!deny.length) return false
      const dispose = tools.restrict({ deny })
      if (typeof dispose !== 'function') throw new Error('Scoped tools.restrict did not return its disposer.')
      this.records.set(exec.sessionId, { agent, tools, signature, denied: new Set(deny), dispose })
      return true
    } catch (error) { this.warn(error); return false }
  }

  release(agent) {
    if (!agent) return false
    const record = this.records.get(String(agent.id))
    if (!record || record.agent !== agent) return false
    this.records.delete(String(agent.id))
    try { record.dispose() } catch (error) { this.warn(error) }
    return true
  }

  dispose() {
    for (const { agent } of [...this.records.values()]) this.release(agent)
  }
}
