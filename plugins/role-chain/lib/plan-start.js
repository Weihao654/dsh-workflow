// Read-only enrollment preview for the human plan-start form. Authorization is
// still performed exclusively by the Host commands runtime, never this API.
import { fail } from './errors.js'
import { resolveExec } from './roles.js'
import { bindingOf, assertAdmissible } from './runtime.js'
import { assertProjectAdmission } from './authorization.js'

const ADMISSION_STOPS = new Set(['PROJECT_DEADLINE_REACHED', 'PROJECT_REQUEST_BUDGET_REACHED',
  'PROJECT_TOKEN_BUDGET_REACHED', 'RESUME_BLOCKED', 'LIMIT_REACHED', 'STEP_BLOCKED', 'DEADLINE_REACHED'])

export async function planStartStatus(ctx, controller, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) fail('BAD_ARGS', 'A live sessionId is required.')
  const exec = resolveExec(ctx, { sessionId })
  if (!exec.bindingValid) fail('ROLE_BINDING_INVALID', exec.bindingError)
  const store = controller.storeForExec(exec)
  controller.assertSessionLocation(store, exec)
  const base = { ok: true, sessionId: exec.sessionId, preset: exec.preset, role: exec.role, isRoot: exec.isRoot }
  const result = (state, message, authorization = null, roundId = null) =>
    ({ ...base, state, authorization, roundId, message })
  if (exec.role !== 'plan') return result('ordinary', '请在根 plan 会话中确认目标和预算后启动。')
  if (!exec.isRoot) fail('ROLE_DENIED', 'Only the actual root plan session can confirm a project authorization.')
  if (controller.isWorkflowSession(exec, store))
    return result('workflow', 'plan 已启用，直接发送任务即可。')

  return store.read(state => {
    const grant = state.authorization ?? null
    const authorization = grant ? { id: grant.id, goal: grant.goal, budget: { ...grant.budget }, sessionId: grant.sessionId } : null
    const rounds = Object.values(state.rounds)
    const found = bindingOf(state, exec.sessionId)
    if (grant && (!grant.sessionId || typeof grant.sessionId !== 'string'))
      fail('AUTHORIZATION_CORRUPT', 'The existing authorization has no valid owner session.')
    if (grant && grant.sessionId !== exec.sessionId)
      return result('other-owner', '该项目已有其他根 plan 会话的授权，请回到原会话继续。', authorization, state.activeRoundId ?? null)
    if (found?.round.closedAt)
      return result('closed', '该轮次已关闭，不能通过此入口重新授权或启动。', authorization, found.round.id)
    if (!found && rounds.length > 0 && rounds.every(round => round.closedAt))
      return result('closed', '项目已有关闭的轮次，不能通过此入口重新授权或启动。', authorization)
    if (!grant) {
      if (rounds.length || Object.keys(state.sessionBindings ?? {}).length)
        fail('AUTHORIZATION_REQUIRED', 'Existing execution state cannot be replaced with a new authorization.')
      return result('ready', '这是一个独立的新任务。确认本轮目标和额度后启动 plan，其他会话的授权和记录继续保留。')
    }

    const admission = () => {
      try {
        assertProjectAdmission(state, controller.now())
        if (found) assertAdmissible(found.round, controller.now(), { phase: found.execution.phase })
      } catch (error) {
        if (!ADMISSION_STOPS.has(error.code)) throw error
        return result('stopped', '已有授权已停止或达到额度、时间限制，不能重新授权或自动继续。', authorization,
          found?.round.id ?? state.activeRoundId ?? null)
      }
      return null
    }
    if (found) {
      if (state.activeRoundId !== found.round.id || found.execution.root !== true || found.execution.role !== 'plan')
        fail('IDENTITY_MISMATCH', 'The root plan binding does not match the active root execution.')
      if (found.execution.resumeBlocked || controller.blocked(store, found.execution))
        return result('stopped', '该轮次已停止，不能重新授权或自动继续。', authorization, found.round.id)
      const stopped = admission()
      if (stopped) return stopped
      return result('bound', '该 plan 已绑定现有授权和轮次，可以继续既有目标。', authorization, found.round.id)
    }
    if (rounds.length || Object.keys(state.sessionBindings ?? {}).length)
      fail('MANAGED_ROUND_REQUIRED', 'Existing project execution state has no matching root plan binding; do not replace its authorization.')
    const stopped = admission()
    if (stopped) return stopped
    return result('grant-only', '已保存本会话授权；可按原目标和预算恢复首次开轮。', authorization)
  })
}
