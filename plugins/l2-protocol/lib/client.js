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
// Two host facts this file has to respect:
//   1. `remote.agentPresets` mounts asynchronously, after the modules that
//      request it — a plain read at apply time can come back undefined, so the
//      install is also parked on that service.
//   2. The gateway installs each remote method as an own GETTER
//      (`Object.defineProperty(this, method, { get() { return (...args) => … } })`),
//      so `namespace.list = wrapped` throws in strict mode. Redefine the
//      property instead.
//
// `dsh.client.inject` in package.json is deliberately EMPTY: those entries are
// client module-graph edges, and an edge naming a module the loader does not
// have drops this whole module without an error. Nothing here needs the picker's
// module — only one remote namespace, resolved at runtime from ctx.

const HIDDEN = ['work', 'code', 'review']
const INSTALLED = new WeakSet()

// Module-scope marker: printed before any plugin machinery runs, so the log
// distinguishes "the browser executed this file" from "the module was never
// served". It is the first thing to grep for when the menu still shows workers.
try {
  console.info('[role-chain] client bundle 已加载（dsh-role-chain-protocol）')
} catch {
  // A console that refuses messages must not break the menu.
}

function filterRoster(result) {
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

function install(namespace) {
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

window.__ModuleLoader__.load({
  id: 'dsh-role-chain-protocol',
  factory(require) {
    const note = (text) => {
      try {
        console.info(`[role-chain] ${text}`)
      } catch {
        // A console that refuses messages must not break the menu.
      }
    }

    const attempt = (namespace) => {
      try {
        if (install(namespace)) note('新建菜单已过滤 work/code/review（内置预设与 plan 保留）')
      } catch (error) {
        note(`菜单过滤安装失败：${error && error.message ? error.message : error}`)
      }
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
      // fiber pending with no log line, which is indistinguishable from "the
      // module never loaded". Poll for the namespace instead and say what
      // happened either way.
      inject: [],
      apply(ctx) {
        let tries = 0
        let timer
        const settle = () => {
          const namespace = namespaceOf(ctx)
          if (namespace === undefined) return false
          attempt(namespace)
          return true
        }
        if (settle()) return
        note('等待 remote.agentPresets 挂载…')
        // The namespace mounts asynchronously, after the modules that request it.
        timer = setInterval(() => {
          tries += 1
          if (settle() || tries >= 100) {
            if (tries >= 100) note('未等到 remote.agentPresets，菜单过滤未安装')
            clearInterval(timer)
          }
        }, 200)
        ctx.effect(() => () => clearInterval(timer))
      },
    }
  },
})
