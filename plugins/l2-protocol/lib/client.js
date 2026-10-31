// Client half: keep the role-chain's worker presets out of the new-session menu.
//
// Why this shape instead of a replacement chip: the new-session preset seat is a
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
// Constraints this file has to respect, each learned the hard way:
//   1. NOTHING may be declared at module scope. The bundle is served as a plain
//      script and can be evaluated twice in one realm; a top-level `const` then
//      throws `SyntaxError: Identifier '…' has already been declared` and the
//      whole client half dies before it ever applies. Every declaration lives
//      inside the factory.
//   2. `dsh.client.inject` entries are client module-graph edges; an edge that
//      names a module the loader does not have can drop this module silently, so
//      it stays empty and the remote namespace is resolved at runtime instead.
//   3. The gateway installs each remote method as an own GETTER
//      (`Object.defineProperty(this, method, { get() { return (...args) => … } })`),
//      so `namespace.list = wrapped` throws in strict mode. Redefine the
//      property instead.
//   4. `remote.agentPresets` mounts asynchronously, after the modules that
//      request it, so the install polls for it instead of failing once.

window.__ModuleLoader__.load({
  id: 'dsh-role-chain-protocol',
  factory(require) {
    void require // the client half needs no host module

    const note = (text) => {
      try {
        console.info(`[role-chain] ${text}`)
      } catch {
        // A console that refuses messages must not break the menu.
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

    return {
      name: 'dsh-role-chain-protocol',
      // No hard service dependency: an inject that never resolves leaves the
      // fiber pending with no log line at all, which is indistinguishable from
      // "the module never loaded".
      inject: [],
      apply(ctx) {
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
