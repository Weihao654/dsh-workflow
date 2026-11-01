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
  id: 'dsh-role-chain-protocol',
  factory(require) {
    const React = require('react')

    const note = (text) => {
      try {
        console.info(`[role-chain] ${text}`)
      } catch {
        // A console that refuses messages must not break the UI.
      }
    }

    note('client bundle 已加载（dsh-role-chain-protocol）')

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
    const EFFORTS = ['', 'minimal', 'low', 'medium', 'high']

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

    function Card() {
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState({})
      const [enabled, setEnabled] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')

      const absorb = React.useCallback((payload) => {
        setData(payload)
        setEnabled(payload?.enabled !== false)
        const next = {}
        for (const role of ROLES) {
          const route = roleOf(payload?.roles, role)
          next[role] = {
            provider: String(route.provider ?? ''),
            model: String(route.model ?? ''),
            reasoningEffort: String(route.reasoningEffort ?? ''),
          }
        }
        setDraft(next)
      }, [])

      const load = React.useCallback(async () => {
        setBusy(true)
        setMessage('')
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          if (!response.ok || payload?.ok === false) {
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
          if (key === 'provider') route.model = ''
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
          const payload = await response.json()
          if (!response.ok || payload?.ok === false) {
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
              disabled: busy,
              onChange: (event) => patch(role, 'reasoningEffort', event.target.value),
            },
            EFFORTS.map((effort) =>
              React.createElement('option', { key: effort, value: effort }, effort || '默认思考'),
            ),
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
      name: 'dsh-role-chain-protocol',
      // Only a base client service is required; `remote.*` and the web route are
      // resolved at runtime so a missing one degrades instead of hanging.
      inject: ['slots'],
      apply(ctx) {
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
