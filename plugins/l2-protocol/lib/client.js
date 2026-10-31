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

const HIDDEN = ['work', 'code', 'review']

window.__ModuleLoader__.load({
  id: 'dsh-role-chain-protocol',
  factory(require) {
    return {
      inject: ['remote.agentPresets'],
      apply(ctx) {
        try {
          const namespace = ctx.remote?.agentPresets
          if (!namespace || typeof namespace.list !== 'function') return
          if (namespace.__roleChainFiltered === true) return

          const original = namespace.list.bind(namespace)
          namespace.list = async (...args) => {
            const result = await original(...args)
            try {
              const presets = result?.value?.presets
              if (!result?.ok || !Array.isArray(presets)) return result
              return {
                ...result,
                value: { ...result.value, presets: presets.filter((preset) => !HIDDEN.includes(preset?.id)) },
              }
            } catch {
              return result
            }
          }
          namespace.__roleChainFiltered = true
        } catch {
          // Fail open: an unfiltered roster is the previous behaviour.
        }
      },
    }
  },
})
