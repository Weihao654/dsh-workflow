// Browser half: the New-Session preset seat, restricted to the chain's entry.
//
// Why shadow instead of configure: the preset roster has no "hidden from the
// picker" flag (dsh-agent-preset exposes id/name/description/order/plugins and
// the registry lists every definition), and a single slot accepts one occupant
// per priority with the lowest priority rendering. So this module registers
// `conversation.hero.agentPreset` at priority -1 and the shipped four-way picker
// stops rendering.
//
// What the user keeps:
//   - Settings -> Agent presets still lists all four presets and can change the
//     default, which is the supported way to deliberately open a work or review
//     session (方式 B / 方式 C). Doing that is a root out of role, and the
//     chain_* tools keep refusing for it.
//   - L1 sets the registry default to `plan`, so a brand-new session lands in
//     the chain without this chip having to stage anything.
//
// Removing the `dsh.client` block from package.json restores the shipped picker.

window.__ModuleLoader__.load({
  id: 'dsh-role-chain-protocol',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PLAN = 'plan'
    const NOTE =
      '角色链：新会话固定从 plan 开始。work / code / review 由 plan 派发，不能单独新建。' +
      '若要单独开 work 或 review 会话，到 设置 → Agent presets 改默认。'

    const dot = h('span', {
      'aria-hidden': true,
      style: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: '#38bdf8',
        flex: 'none',
      },
    })

    function PlanOnlyChip() {
      return h(
        'span',
        {
          title: NOTE,
          'aria-label': NOTE,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
            color: 'var(--dsw-alias-text-secondary, inherit)',
            fontSize: '12px',
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            cursor: 'default',
            userSelect: 'none',
          },
        },
        dot,
        h('span', null, PLAN),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.hero.agentPreset', () =>
          ctx.slots.register(
            { name: 'conversation.hero.agentPreset', priority: -1 },
            PlanOnlyChip,
          ),
        )
      },
    }
  },
})
