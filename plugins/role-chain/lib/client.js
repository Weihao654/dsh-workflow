// Client half: (1) keep the worker presets out of the new-session menu, and
// (2) render the 「角色 → 模型」 settings card.
//
// Why the menu is filtered rather than replaced: the new-session preset seat is a
// single-occupancy slot owned by the shipped UI, and re-implementing it would
// duplicate staging, draft syncing, and the settings roster. The roster itself
// comes from one remote call (`agentPresets.list`), so filtering that answer
// leaves the host's own control intact: no slot to shadow, nothing to keep in
// sync, and if the wrap cannot be installed the menu simply shows every preset
// again — a fail-open regression, never a broken picker.
//
// The built-in presets (standard / ptc / minimal / cordis) stay. `plan` stays:
// it is the only role the user creates directly, because plan is the one that
// can raise a gate. work/code/review exist only as plan-dispatched subagents.
//
// The card talks HTTP, not the Remote gateway: our host half owns no Typert
// Remote namespace (that shape is compiler-generated), while `webServer.register`
// is a plain route any host half may add. Same-origin `fetch` then needs no token
// of its own.
//
// Constraints this file has to respect, each learned the hard way:
//   1. NOTHING may be declared at module scope. The bundle is served as a plain
//      script and can be evaluated twice in one realm; a top-level `const` then
//      throws `SyntaxError: Identifier '…' has already been declared` and the
//      whole client half dies before it ever applies. Every declaration lives
//      inside the factory.
//   2. `dsh.client.inject` entries are client module-graph edges; an edge that
//      names a module the loader does not have can drop this module silently, so
//      it stays empty and services are resolved at runtime instead.
//   3. The gateway installs each remote method as an own GETTER
//      (`Object.defineProperty(this, method, { get() { return (...args) => … } })`),
//      so `namespace.list = wrapped` throws in strict mode. Redefine the
//      property instead.
//   4. `remote.agentPresets` mounts asynchronously, after the modules that
//      request it, so the install polls for it instead of failing once.

window.__ModuleLoader__.load({
  id: 'dsh-role-chain',
  factory(require) {
    const React = require('react')

    const note = (text) => {
      try {
        console.info(`[role-chain] ${text}`)
      } catch {
        // A console that refuses messages must not break the UI.
      }
    }

    note('client bundle 已加载（dsh-role-chain）')

    const HIDDEN = ['work', 'code', 'review']
    const INSTALLED = new WeakSet()

    const filterRoster = (result) => {
      try {
        const presets = result?.value?.presets
        if (!result?.ok || !Array.isArray(presets)) return result
        return {
          ...result,
          value: {
            ...result.value,
            presets: presets.filter((preset) => !HIDDEN.includes(preset?.id)),
          },
        }
      } catch {
        return result
      }
    }

    const install = (namespace) => {
      if (!namespace || typeof namespace.list !== 'function') return false
      if (INSTALLED.has(namespace)) return false
      const original = namespace.list.bind(namespace)
      const wrapped = async (...args) => filterRoster(await original(...args))
      Object.defineProperty(namespace, 'list', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: wrapped,
      })
      INSTALLED.add(namespace)
      return true
    }

    const namespaceOf = (ctx) => {
      try {
        return ctx?.get?.('remote.agentPresets') ?? ctx?.remote?.agentPresets
      } catch {
        return undefined
      }
    }

    // ---- settings card ----------------------------------------------------

    const API = '/role-chain/api/table'
    const ROLES = ['plan', 'work', 'code', 'review']
    const ROLE_HINT = {
      plan: '定方案、发门禁',
      work: '派活、验结果',
      code: '写代码',
      review: '只读终审',
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', lineHeight: 1.5 },
      head: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { fontSize: '15px', fontWeight: 600 },
      hint: { opacity: 0.68, fontSize: '12px', wordBreak: 'break-all' },
      grid: {
        display: 'grid',
        gridTemplateColumns: '92px minmax(120px, 1fr) minmax(150px, 1.4fr) 110px',
        gap: '8px',
        alignItems: 'center',
      },
      label: { fontWeight: 600 },
      select: {
        width: '100%',
        padding: '5px 6px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.36)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      row: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
      button: {
        padding: '5px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.36)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      message: { fontSize: '12px', whiteSpace: 'pre-wrap' },
    }

    const roleOf = (roles, role) => roles?.[role] ?? { provider: '', model: '', reasoningEffort: '' }

    /** JSON or null; never throws, so a stray HTML body cannot mask the real status. */
    const parseJson = (text) => {
      if (typeof text !== 'string' || text.trim() === '') return null
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    /** A short, single-line peek at a non-JSON body, for the error line. */
    const bodyHint = (text) => {
      const body = String(text ?? '').trim()
      if (body === '') return '（空响应）'
      const head = body.slice(0, 120).replace(/\s+/g, ' ')
      return `（响应不是 JSON：${head}${body.length > 120 ? '…' : ''}）`
    }

    const PLAN_START_API = '/role-chain/api/plan-start'
    const PLAN_BUDGET_FIELDS = [
      ['tokens', '总 token 额度', 600000],
      ['requests', '总请求次数', 20],
      ['wallMinutes', '最长时间（分钟）', 30],
      ['outputCap', '单次输出上限', 4096],
      ['closeoutRequests', '预留收尾请求', 6],
      ['closeoutTimeMs', '预留收尾时间（毫秒）', 120000],
    ]
    const planDraft = () => Object.fromEntries(PLAN_BUDGET_FIELDS.map(([key, , value]) => [key, String(value)]))

    // A session-scoped dock receives these standard sources from uiSession.
    // Approval uses the real Commands Remote, whose Host executor mints the
    // command id and records its genuine user-command lifecycle. A settings
    // HTTP write must never manufacture that authority.
    function PlanStartCard({ sessionId, useProjection, runPlanCommand, planBlocks }) {
      const preset = typeof useProjection === 'function' ? useProjection('agentPreset') : undefined
      const identity = `${String(sessionId ?? '')}\0${String(preset ?? '')}`
      const current = React.useRef(identity)
      current.current = identity
      const requests = React.useRef(0)
      const pending = React.useRef(new Set())
      const [status, setStatus] = React.useState(null)
      const [goal, setGoal] = React.useState('')
      const [draft, setDraft] = React.useState(planDraft)
      const [loading, setLoading] = React.useState(false)
      const [busyFor, setBusyFor] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(async () => {
        if (!sessionId || preset !== 'plan') return
        const sequence = ++requests.current
        const belongs = () => current.current === identity && sequence === requests.current
        setLoading(true)
        try {
          const response = await fetch(`${PLAN_START_API}?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
          })
          const payload = parseJson(await response.text())
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.message ?? '暂时无法读取启动状态，请重试。')
          if (payload.sessionId !== sessionId) throw new Error('会话已变化，请重新读取启动状态。')
          if (belongs()) {
            setStatus(payload)
            setNotice(null)
          }
        } catch (error) {
          if (belongs()) {
            // A failed refresh cannot erase a known controlled stop. A new
            // session stays unknown until its own Host status arrives.
            setStatus(previous => previous?.sessionId === sessionId ? previous : null)
            setNotice({ identity, text: `读取失败：${error?.message ?? error}` })
          }
        } finally {
          if (belongs()) setLoading(false)
        }
      }, [sessionId, preset, identity])

      React.useEffect(() => {
        current.current = identity
        setStatus(null)
        setGoal('')
        setDraft(planDraft())
        setNotice(null)
        setBusyFor(pending.current.has(sessionId) ? identity : null)
        if (sessionId && preset === 'plan') void load()
        else setLoading(false)
        return () => {
          requests.current++
          if (current.current === identity) current.current = null
        }
      }, [sessionId, preset, identity, load])

      const liveStatus = status?.sessionId === sessionId ? status : null
      const state = liveStatus?.state
      const restoring = state === 'grant-only'
      const grant = liveStatus?.authorization
      const restoreValid = restoring && grant && grant.sessionId === sessionId && typeof grant.id === 'string' &&
        typeof grant.goal === 'string' && grant.budget && typeof grant.budget === 'object'
      const canStart = liveStatus?.isRoot === true && (state === 'ready' || restoreValid)
      const busy = busyFor === identity || pending.current.has(sessionId)
      const message = notice?.identity === identity ? notice.text : ''
      const controlledState = ['ready', 'grant-only', 'other-owner', 'bound', 'stopped', 'closed'].includes(state)
      const blockReason = !sessionId || preset !== 'plan' || state === 'workflow' ? null
        : busy ? '正在启动 plan，请等待授权和绑定完成。'
        : !controlledState ? null
        : state === 'bound' ? null
        : message ? 'plan 启动尚未完成，请查看启动卡片并重新读取状态。'
        : ({
          ready: '请先确认目标和额度，启动 plan 后再发送消息。',
          'grant-only': '请先在启动卡片恢复本轮绑定，再发送消息。',
          'other-owner': '本会话尚未绑定，请查看启动卡片中的授权状态。',
          stopped: '本轮已停止，请新建 plan 会话开始新任务。',
          closed: '本轮已关闭，请新建 plan 会话开始新任务。',
        }[state] ?? null)

      // The Host's public composer-block registry is presentation only. Keep
      // its existing owner intact; cleanup releases only our exact object.
      // Missing UI capability degrades to the still-enforced Host gate.
      React.useEffect(() => {
        if (!blockReason || typeof planBlocks?.set !== 'function' || typeof planBlocks?.storeFor !== 'function') return
        let store, block
        try {
          store = planBlocks.storeFor(sessionId)
          if (typeof store?.getSnapshot !== 'function' || store.getSnapshot() !== undefined) return
          block = { reason: blockReason }
          planBlocks.set(sessionId, block)
        } catch { return }
        return () => {
          try {
            if (store.getSnapshot() === block) planBlocks.set(sessionId, undefined)
          } catch {}
        }
      }, [sessionId, preset, planBlocks, blockReason])

      // No state read, authority write or model request for ordinary chats.
      if (!sessionId || preset !== 'plan') return null
      if (liveStatus && liveStatus.role !== 'plan') return null
      // Default plan conversations use the Host's ordinary workflow behavior.
      // Reading their classification must neither flash a budget form nor
      // temporarily disable their input. Explicit controlled states keep the
      // original enrollment/recovery card and enforcement hints below.
      if (state === 'workflow' || !liveStatus) return null
      const summary = {
        bound: '已就绪，可以在本会话继续与 plan 对话。',
        stopped: '本轮已停止，不能重新启动或延长额度。',
        closed: '本轮已关闭，请保留原记录。',
        'other-owner': '此项目已有其他会话的授权，请返回原 plan 会话继续，保留原轮次。',
        'grant-only': '已保存授权，恢复绑定会继续使用原目标、额度与期限。',
      }[state]

      const start = async () => {
        if (!canStart || loading || pending.current.has(sessionId) || current.current !== identity) return
        let args
        if (restoring) args = { authorizationId: grant.id, goal: grant.goal, budget: { ...grant.budget } }
        else {
          const target = goal.trim()
          const budget = Object.fromEntries(PLAN_BUDGET_FIELDS.map(([key]) => [key, Number(draft[key])]))
          if (!target) { setNotice({ identity, text: '请先填写本轮目标。' }); return }
          if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 1)) {
            setNotice({ identity, text: '请为所有额度填写正整数。' }); return
          }
          if (budget.requests < 6 || budget.wallMinutes > 90 || budget.closeoutRequests < 6 || budget.closeoutTimeMs < 120000) {
            setNotice({ identity, text: '请求次数至少 6 次，最长时间不超过 90 分钟；收尾至少预留 6 次请求和 120000 毫秒。' }); return
          }
          args = { authorizationId: `plan-ui-${sessionId}`, goal: target, budget }
        }
        pending.current.add(sessionId)
        setBusyFor(identity)
        setNotice(null)
        try {
          const result = await runPlanCommand(sessionId, `/chain-authorize ${JSON.stringify(args)}`, [])
          if (!result?.ok) throw new Error(result?.error?.message ?? '启动服务尚未就绪，请稍后重试。')
          const outcome = result.value?.result
          if (outcome?.kind !== 'success') throw new Error(outcome?.text ?? '授权未完成，请重新读取状态后重试。')
          if (current.current === identity) {
            // Success is read back from the Host; a command receipt alone does
            // not fabricate a binding. Starting never sends a model prompt.
            await load()
          }
        } catch (error) {
          if (current.current === identity) {
            const startupError = `启动失败：${error?.message ?? error}`
            // Grant persistence and first-round creation can fail separately.
            // Refresh immutable Host state before allowing another attempt;
            // this read never retries the authority-changing command.
            await load()
            if (current.current === identity) setNotice({ identity, text: startupError })
          }
        } finally {
          pending.current.delete(sessionId)
          if (current.current === identity) setBusyFor(null)
        }
      }

      const budgetSummary = grant?.budget
        ? PLAN_BUDGET_FIELDS.map(([key, label]) => `${label}：${grant.budget[key] ?? '—'}`).join('；') : ''
      return React.createElement('section', {
        'aria-label': '启动 plan',
        style: { ...styles.wrap, width: '100%', boxSizing: 'border-box', padding: '14px', border: '1px solid rgba(127,127,127,0.32)', borderRadius: '10px' },
      },
      React.createElement('div', { style: styles.title }, '启动 plan'),
      loading ? React.createElement('div', { role: 'status' }, '正在读取本会话的启动状态…') : null,
      summary ? React.createElement('div', { role: 'status' }, liveStatus.message || summary) : null,
      state === 'ready' && liveStatus.isRoot
        ? React.createElement('div', { role: 'status' }, liveStatus.message || '新任务使用本会话的独立额度。请先启动 plan，再发送消息。') : null,
      state === 'ready' && !liveStatus.isRoot
        ? React.createElement('div', { role: 'status' }, '请在根 plan 会话确认目标和额度。') : null,
      state === 'ready' && liveStatus.isRoot ? React.createElement(React.Fragment, null,
        React.createElement('label', { style: styles.head }, '本轮目标',
          React.createElement('textarea', {
            'aria-label': '本轮目标', value: goal, disabled: busy, rows: 3,
            placeholder: '描述希望 plan 完成的目标',
            style: { ...styles.select, resize: 'vertical', boxSizing: 'border-box' },
            onChange: event => setGoal(event.target.value),
          })),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: '10px' } },
          ...PLAN_BUDGET_FIELDS.slice(0, 4).map(([key, label]) => React.createElement('label', { key, style: styles.head }, label,
            React.createElement('input', {
              'aria-label': label, type: 'number', min: key === 'requests' ? 6 : 1,
              ...(key === 'wallMinutes' ? { max: 90 } : {}), step: 1, value: draft[key], disabled: busy,
              style: { ...styles.select, boxSizing: 'border-box' },
              onChange: event => setDraft(value => ({ ...value, [key]: event.target.value })),
            })))),
        React.createElement('details', null, React.createElement('summary', null, '收尾预留额度'),
          ...PLAN_BUDGET_FIELDS.slice(4).map(([key, label]) => React.createElement('label', { key, style: styles.head }, label,
            React.createElement('input', {
              'aria-label': label, type: 'number', min: key === 'closeoutRequests' ? 6 : 120000, step: 1, value: draft[key], disabled: busy,
              style: { ...styles.select, boxSizing: 'border-box' },
              onChange: event => setDraft(value => ({ ...value, [key]: event.target.value })),
            })))),
        React.createElement('div', { style: styles.hint }, '以上额度为草稿。点击确认后授权并绑定本轮，随后即可发送消息。'),
      ) : null,
      grant && state !== 'ready' ? React.createElement('div', { style: styles.head },
        React.createElement('div', null, `目标：${grant.goal}`),
        React.createElement('div', { style: styles.hint }, budgetSummary)) : null,
      message ? React.createElement('div', { role: 'alert', style: styles.message }, message) : null,
      React.createElement('div', { style: styles.row },
        canStart ? React.createElement('button', { type: 'button', style: styles.button, disabled: busy || loading, onClick: start },
          busy ? '正在确认…' : restoring ? '恢复本轮绑定' : '确认目标和额度，启动 plan') : null,
        React.createElement('button', { type: 'button', style: styles.button, disabled: busy || loading, onClick: load }, '重新读取'),
      ))
    }

    function Card() {
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState({})
      const [enabled, setEnabled] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')

      const absorb = React.useCallback((payload) => {
        setData(payload)
        setEnabled(payload?.enabled !== false)
        const effortsFor = (route) => {
          const found = (payload?.providers ?? []).find((entry) => entry.provider === route.provider)
          const model = (found?.models ?? []).find((entry) => entry.id === route.model)
          return Array.isArray(model?.efforts) ? model.efforts : []
        }
        const next = {}
        for (const role of ROLES) {
          const route = roleOf(payload?.roles, role)
          const effort = String(route.reasoningEffort ?? '')
          const allowed = effortsFor(route)
          next[role] = {
            provider: String(route.provider ?? ''),
            model: String(route.model ?? ''),
            // Drop an effort the model provably does not accept (a hand-edited
            // "medium" on deepseek-flash would otherwise be resent and refused
            // on every save). An unknown model keeps its value untouched.
            reasoningEffort: effort && allowed.length > 0 && !allowed.includes(effort) ? '' : effort,
          }
        }
        setDraft(next)
      }, [])

      const load = React.useCallback(async () => {
        setBusy(true)
        setMessage('')
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          const text = await response.text()
          const payload = parseJson(text)
          if (payload === null) {
            // An HTML or empty body means the route is not ours (404 from the
            // static fallback, or a proxy page). Say that plainly instead of
            // surfacing a JSON.parse complaint.
            setMessage(`读取失败：HTTP ${response.status}${bodyHint(text)}`)
          } else if (!response.ok || payload?.ok === false) {
            setMessage(`读取失败：${(payload?.errors ?? [response.statusText]).join('；')}`)
          } else {
            absorb(payload)
          }
        } catch (error) {
          setMessage(`读取失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }, [absorb])

      React.useEffect(() => {
        void load()
      }, [load])

      const providers = Array.isArray(data?.providers) ? data.providers : []
      const modelsOf = (provider) => {
        const found = providers.find((entry) => entry.provider === provider)
        return Array.isArray(found?.models) ? found.models : []
      }

      const patch = (role, key, value) => {
        setDraft((current) => {
          const next = { ...current }
          const route = { ...(next[role] ?? { provider: '', model: '', reasoningEffort: '' }), [key]: value }
          if (key === 'provider') {
            route.model = ''
            route.reasoningEffort = ''
          }
          if (key === 'model') {
            const picked = modelsOf(route.provider).find((model) => model.id === value)
            const allowed = Array.isArray(picked?.efforts) ? picked.efforts : []
            // Switching to a model that does not advertise the current effort
            // would otherwise send a value the host refuses on save.
            if (route.reasoningEffort && !allowed.includes(route.reasoningEffort)) route.reasoningEffort = ''
          }
          next[role] = route
          return next
        })
      }

      const save = async () => {
        const set = {}
        for (const role of ROLES) {
          const route = draft[role] ?? {}
          if (route.provider && route.model) {
            set[role] = { provider: route.provider, model: route.model }
            if (route.reasoningEffort) set[role].reasoningEffort = route.reasoningEffort
          }
        }
        setBusy(true)
        setMessage('')
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-role-chain': '1' },
            body: JSON.stringify({ cwd: data?.cwd, set, enabled }),
          })
          const payload = parseJson(await response.text())
          if (payload === null) {
            setMessage(`写入失败：HTTP ${response.status}（响应不是 JSON，路由可能没注册）`)
          } else if (!response.ok || payload?.ok === false) {
            setMessage(`写入被拒：${(payload?.errors ?? [response.statusText]).join('；')}`)
          } else {
            setMessage(`已写入 ${payload.path}`)
            await load()
          }
        } catch (error) {
          setMessage(`写入失败：${error?.message ?? error}`)
        } finally {
          setBusy(false)
        }
      }

      if (!data) {
        return React.createElement(
          'div',
          { style: styles.wrap },
          React.createElement('div', { style: styles.title }, '角色 → 模型'),
          React.createElement('div', { style: styles.message }, busy ? '读取中…' : message || '尚未读取'),
        )
      }

      const rows = ROLES.map((role) => {
        const route = draft[role] ?? { provider: '', model: '', reasoningEffort: '' }
        const models = modelsOf(route.provider)
        const picked = models.find((model) => model.id === route.model)
        // Only the efforts this model advertises: `deepseek-flash` refuses
        // `medium`, and a hardcoded list would offer a value that always fails
        // validation on save.
        const efforts = Array.isArray(picked?.efforts) ? picked.efforts : []
        const defaultEffort = picked?.defaultEffort ? `（默认 ${picked.defaultEffort}）` : '（默认）'
        return React.createElement(
          'div',
          { key: role, style: styles.grid },
          React.createElement(
            'div',
            { style: styles.label, title: ROLE_HINT[role] },
            role,
          ),
          React.createElement(
            'select',
            {
              style: styles.select,
              value: route.provider,
              disabled: busy,
              onChange: (event) => patch(role, 'provider', event.target.value),
            },
            [
              React.createElement('option', { key: '', value: '' }, '（不设）'),
              ...providers.map((entry) =>
                React.createElement('option', { key: entry.provider, value: entry.provider }, entry.name ?? entry.provider),
              ),
            ],
          ),
          React.createElement(
            'select',
            {
              style: styles.select,
              value: route.model,
              disabled: busy || !route.provider,
              onChange: (event) => patch(role, 'model', event.target.value),
            },
            [
              React.createElement('option', { key: '', value: '' }, '（选模型）'),
              ...models.map((model) =>
                React.createElement('option', { key: model.id, value: model.id }, model.name ?? model.id),
              ),
            ],
          ),
          React.createElement(
            'select',
            {
              style: styles.select,
              value: route.reasoningEffort ?? '',
              disabled: busy || !route.model || efforts.length === 0,
              onChange: (event) => patch(role, 'reasoningEffort', event.target.value),
            },
            [
              React.createElement('option', { key: '', value: '' }, defaultEffort),
              ...efforts.map((effort) => React.createElement('option', { key: effort, value: effort }, effort)),
            ],
          ),
        )
      })

      return React.createElement(
        'div',
        { style: styles.wrap },
        React.createElement(
          'div',
          { style: styles.head },
          React.createElement('div', { style: styles.title }, '角色 → 模型'),
          React.createElement(
            'div',
            { style: styles.hint },
            `写入 ${data.configPath ?? '（未确定）'}，下一次模型请求起生效；浏览器里手动选过模型的会话保持手选。`,
          ),
          data.errors && data.errors.length > 0
            ? React.createElement('div', { style: styles.message }, `当前文件有问题：${data.errors.join('；')}`)
            : null,
        ),
        React.createElement(
          'div',
          { style: styles.grid },
          React.createElement('div', { style: styles.hint }, '角色'),
          React.createElement('div', { style: styles.hint }, 'Provider'),
          React.createElement('div', { style: styles.hint }, '模型'),
          React.createElement('div', { style: styles.hint }, '思考深度'),
        ),
        ...rows,
        React.createElement(
          'div',
          { style: styles.row },
          React.createElement(
            'label',
            { style: styles.row },
            React.createElement('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: busy,
              onChange: (event) => setEnabled(event.target.checked),
            }),
            '启用这张表',
          ),
          React.createElement('button', { style: styles.button, disabled: busy, onClick: save }, busy ? '处理中…' : '保存'),
          React.createElement('button', { style: styles.button, disabled: busy, onClick: load }, '重新读取'),
        ),
        message ? React.createElement('div', { style: styles.message }, message) : null,
        data.catalogErrors && data.catalogErrors.length > 0
          ? React.createElement('div', { style: styles.hint }, `模型清单有缺口：${data.catalogErrors.join('；')}`)
          : null,
      )
    }

    return {
      name: 'dsh-role-chain',
      // Only a base client service is required; `remote.*` and the web route are
      // resolved at runtime so a missing one degrades instead of hanging.
      inject: ['slots'],
      apply(ctx) {
        try {
          // This list slot is rendered in both the first-session hero and the
          // normal composer. composer.dock only appears after the hero phase.
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
            name: 'conversation.input.dock', id: 'role-chain-plan-start', order: -20,
            inject: () => ({ planBlocks: (() => {
              try { return ctx.get?.('conversation')?.blocks } catch { return undefined }
            })(), runPlanCommand: async (...args) => {
              let commands
              try { commands = ctx.get?.('remote.commands') ?? ctx.remote?.commands } catch {}
              if (typeof commands?.execute !== 'function') throw new Error('启动服务尚未就绪，请稍后重试。')
              return commands.execute(...args)
            } }),
          }, PlanStartCard))
          note('会话页已注册「启动 plan」卡片')
        } catch (error) {
          note(`启动卡片注册失败：${error && error.message ? error.message : error}`)
        }
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'role-models', order: 21, label: '角色 → 模型' },
              Card,
            ),
          )
          note('设置页已注册「角色 → 模型」卡片')
        } catch (error) {
          note(`设置卡片注册失败：${error && error.message ? error.message : error}`)
        }

        let tries = 0
        let timer

        const settle = () => {
          const namespace = namespaceOf(ctx)
          if (namespace === undefined) return false
          try {
            if (install(namespace)) note('新建菜单已过滤 work/code/review（内置预设与 plan 保留）')
          } catch (error) {
            note(`菜单过滤安装失败：${error && error.message ? error.message : error}`)
          }
          return true
        }

        if (settle()) return
        note('等待 remote.agentPresets 挂载…')
        timer = setInterval(() => {
          tries += 1
          if (settle()) {
            clearInterval(timer)
            return
          }
          if (tries >= 150) {
            note('未等到 remote.agentPresets，菜单过滤未安装')
            clearInterval(timer)
          }
        }, 200)
        ctx.effect(() => () => clearInterval(timer))
      },
    }
  },
})
