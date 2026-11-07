// Offline client rendering and real command-wiring checks using a tiny React
// hook stand-in. No browser, Host, provider or model request is involved.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile, mkdir, writeFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const statusOf = (id, state = 'ready', extra = {}) => ({
  ok: true, sessionId: id, preset: 'plan', role: 'plan', isRoot: true,
  state, authorization: null, roundId: null, ...extra,
})
const responseOf = value => ({ ok: true, text: async () => JSON.stringify(value) })

function fixture({ preset = 'plan', sessionId = 'plan-a', read, execute, blockCapability = true, initialBlock } = {}) {
  const hooks = [], effects = [], slots = new Map(), calls = [], reads = []
  const blockValues = new Map(initialBlock === undefined ? [] : [[sessionId, initialBlock]])
  // Match the shipped registry: unchanged reason is a no-op, object identity
  // is retained, and each session has one existing owner's block at a time.
  const blocks = {
    set(id, block) {
      if (blockValues.get(id)?.reason === block?.reason) return
      blockValues.set(id, block)
    },
    storeFor(id) { return { getSnapshot: () => blockValues.get(id) } },
  }
  let cursor = 0, changed = true, tree, props, component
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const React = {
    Fragment: 'fragment',
    createElement(type, properties, ...children) { return { type, props: properties ?? {}, children: children.flat(Infinity) } },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, value => {
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value
        changed = true
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!same(hooks[index]?.deps, deps)) hooks[index] = { deps, callback }
      return hooks[index].callback
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!same(hooks[index]?.deps, deps)) {
        const prior = hooks[index]
        hooks[index] = { deps, cleanup: prior?.cleanup }
        effects.push(() => { prior?.cleanup?.(); hooks[index].cleanup = effect() })
      }
    },
  }
  const remote = {
    agentPresets: { list: async () => ({ ok: true, value: { presets: [] } }) },
    commands: { execute: async (...args) => {
      calls.push(args)
      return execute ? execute(...args) : { ok: true, value: { commandId: 'fixture-human-command', result: { kind: 'success' } } }
    } },
  }
  const ctx = {
    remote, get: key => key === 'remote.commands' ? remote.commands
      : key === 'remote.agentPresets' ? remote.agentPresets
      : key === 'conversation' && blockCapability ? { blocks } : undefined,
    slots: {
      inject(_name, apply) { return apply() },
      register(definition, value) { slots.set(definition.id, { definition, component: value }); return () => {} },
    },
    effect() {},
  }
  const sandbox = {
    console: { info() {} },
    fetch: async url => {
      const id = new URL(url, 'http://fixture.invalid').searchParams.get('sessionId')
      reads.push(id)
      return read ? read(id) : responseOf(statusOf(id))
    },
    setInterval() { throw new Error('remote menu namespace is already present') }, clearInterval() {},
    window: { __ModuleLoader__: { load(value) { value.factory(name => {
      assert.equal(name, 'react'); return React
    }).apply(ctx) } } },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const entry = slots.get('role-chain-plan-start')
  assert.equal(entry.definition.name, 'conversation.input.dock', 'startup is visible in blank hero and normal composer')
  component = entry.component
  props = { sessionId, useProjection: () => preset, ...entry.definition.inject(sessionId) }
  const render = () => {
    cursor = 0; changed = false; tree = component(props)
    for (const effect of effects.splice(0)) effect()
  }
  const settle = async () => {
    for (let i = 0; i < 12; i++) { if (changed) render(); await Promise.resolve() }
    if (changed) render()
    return tree
  }
  const switchSession = (id, nextPreset = 'plan') => {
    preset = nextPreset
    props = { ...props, sessionId: id, useProjection: () => preset, ...entry.definition.inject(id) }
    changed = true
  }
  const nodes = () => {
    const result = []
    const visit = node => {
      if (node === null || node === undefined || node === false) return
      if (typeof node === 'object') { result.push(node); for (const child of node.children ?? []) visit(child) }
    }
    visit(tree); return result
  }
  const text = () => {
    const visit = node => node && typeof node === 'object' ? (node.children ?? []).map(visit).join(' ') : node === null || node === undefined || node === false ? '' : String(node)
    return visit(tree)
  }
  const label = name => nodes().find(node => node.props['aria-label'] === name)
  const button = name => nodes().find(node => node.type === 'button' && node.children.includes(name))
  const change = async (name, value) => { label(name).props.onChange({ target: { value } }); await settle() }
  const unmount = () => { for (const hook of hooks) hook?.cleanup?.() }
  return { settle, switchSession, nodes, text, label, button, change, calls, reads, unmount,
    block: (id = props.sessionId) => blockValues.get(id),
    replaceBlock: (block, id = props.sessionId) => blockValues.set(id, block),
    get tree() { return tree } }
}

test('startup card is a first-session dock; ordinary presets neither render nor read/execute', async () => {
  for (const preset of ['standard', 'cordis', 'work', 'code', 'review']) {
    const h = fixture({ preset }); await h.settle()
    assert.equal(h.tree, null); assert.equal(h.reads.length, 0); assert.equal(h.calls.length, 0)
  }
})

test('ready plan renders editable draft and never authorizes automatically', async () => {
  const h = fixture(); await h.settle()
  assert.match(h.text(), /启动 plan/)
  assert.equal(h.label('总 token 额度').props.value, '600000')
  assert.equal(h.label('总请求次数').props.value, '20')
  assert.equal(h.label('最长时间（分钟）').props.value, '30')
  assert.equal(h.label('单次输出上限').props.value, '4096')
  assert.equal(h.label('预留收尾请求').props.value, '6')
  assert.equal(h.label('预留收尾时间（毫秒）').props.value, '120000')
  assert.equal(h.calls.length, 0)
})

test('blank goal and invalid budget cannot enter Commands', async () => {
  const h = fixture(); await h.settle()
  await h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
  assert.match(h.text(), /请先填写本轮目标/); assert.equal(h.calls.length, 0)
  await h.change('本轮目标', '验证目标'); await h.change('总请求次数', '1.5')
  await h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
  assert.match(h.text(), /正整数/); assert.equal(h.calls.length, 0)
})

test('explicit click calls official Commands with exact session, input and attachments then rereads binding', async () => {
  let bound = false
  const h = fixture({
    execute: async () => { bound = true; return { ok: true, value: { commandId: 'cmd-real-path', result: { kind: 'success' } } } },
    read: id => responseOf(statusOf(id, bound ? 'bound' : 'ready')),
  })
  await h.settle(); await h.change('本轮目标', '  完成此目标  '); await h.change('总 token 额度', '500000')
  await h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
  assert.equal(h.calls.length, 1)
  const [id, line, attachments] = h.calls[0]
  assert.equal(id, 'plan-a'); assert.equal(attachments.length, 0)
  const args = JSON.parse(line.slice('/chain-authorize '.length))
  assert.equal(args.authorizationId, 'plan-ui-plan-a'); assert.equal(args.goal, '完成此目标')
  assert.deepEqual(args.budget, { tokens: 500000, requests: 20, wallMinutes: 30, outputCap: 4096, closeoutRequests: 6, closeoutTimeMs: 120000 })
  assert.match(h.text(), /已就绪/); assert.equal(h.reads.length, 2)
  assert.equal(h.button('确认目标和额度，启动 plan'), undefined)
})

test('draft cannot request too few slots, excessive time or undersized closeout reserves', async () => {
  for (const [label, value] of [['总请求次数', '5'], ['最长时间（分钟）', '91'], ['预留收尾请求', '5'], ['预留收尾时间（毫秒）', '119999']]) {
    const h = fixture(); await h.settle(); await h.change('本轮目标', '目标'); await h.change(label, value)
    await h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
    assert.match(h.text(), /收尾至少预留/); assert.equal(h.calls.length, 0)
  }
})

test('busy click is single-flight and handler error is never displayed as success', async () => {
  const command = deferred()
  const h = fixture({ execute: () => command.promise }); await h.settle(); await h.change('本轮目标', '目标')
  const click = h.button('确认目标和额度，启动 plan').props.onClick
  const first = click(); await click(); await h.settle()
  assert.equal(h.calls.length, 1); assert.equal(h.button('正在确认…').props.disabled, true)
  command.resolve({ ok: true, value: { result: { kind: 'error', text: 'ROLE_DENIED: root plan required' } } })
  await first; await h.settle()
  assert.match(h.text(), /启动失败：ROLE_DENIED/); assert.doesNotMatch(h.text(), /已就绪/)
  assert.equal(h.reads.length, 2)
})

test('failed first-round creation rereads persisted grant, preserves the error and restores original parameters', async () => {
  let grant = null, bound = false, attempts = 0
  const h = fixture({
    read: id => responseOf(statusOf(id, bound ? 'bound' : grant ? 'grant-only' : 'ready', { authorization: grant })),
    execute: async (id, line) => {
      attempts++
      const args = JSON.parse(line.slice('/chain-authorize '.length))
      if (attempts === 1) {
        grant = { id: args.authorizationId, sessionId: id, goal: args.goal, budget: args.budget }
        return { ok: true, value: { result: { kind: 'error', text: 'FIRST_ROUND_FAILED: saved grant, round write failed' } } }
      }
      bound = true
      return { ok: true, value: { result: { kind: 'success' } } }
    },
  })
  await h.settle(); await h.change('本轮目标', '已确认的原目标'); await h.change('总 token 额度', '450000')
  await h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
  assert.equal(h.calls.length, 1, 'a failed command is never replayed automatically')
  assert.equal(h.reads.length, 2)
  assert.match(h.text(), /FIRST_ROUND_FAILED/)
  assert.match(h.text(), /已保存授权/)
  assert.equal(h.label('本轮目标'), undefined, 'persisted goal and budget are no longer editable')
  assert.ok(h.button('恢复本轮绑定'))
  await h.button('恢复本轮绑定').props.onClick(); await h.settle()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1][1], h.calls[0][1], 'recovery uses the exact original id, goal and budget')
  assert.match(h.text(), /已就绪/)
})

test('transport failures and absent command outcomes are explicit failures', async () => {
  for (const outcome of [{ ok: false, error: { message: '连接中断' } }, { ok: true }, { ok: true, value: { result: { kind: 'unknown' } } }]) {
    const h = fixture({ execute: async () => outcome }); await h.settle(); await h.change('本轮目标', '目标')
    await h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
    assert.match(h.text(), /启动失败/); assert.doesNotMatch(h.text(), /已就绪/)
  }
})

test('grant-only recovery uses original immutable authorization without editable replacement', async () => {
  const grant = { id: 'original-grant', sessionId: 'plan-a', goal: '原目标', budget: { tokens: 123456, requests: 14, wallMinutes: 9, outputCap: 512, closeoutRequests: 4, closeoutTimeMs: 45000 } }
  const h = fixture({ read: id => responseOf(statusOf(id, 'grant-only', { authorization: grant })) }); await h.settle()
  assert.equal(h.label('本轮目标'), undefined); assert.match(h.text(), /原目标/)
  await h.button('恢复本轮绑定').props.onClick(); await h.settle()
  const args = JSON.parse(h.calls[0][1].slice('/chain-authorize '.length))
  assert.deepEqual(args, { authorizationId: grant.id, goal: grant.goal, budget: grant.budget })
})

test('stopped, closed, other-owner and non-root cannot initiate another authorization', async () => {
  for (const state of ['stopped', 'closed', 'other-owner', 'bound']) {
    const h = fixture({ read: id => responseOf(statusOf(id, state)) }); await h.settle()
    assert.equal(h.button('确认目标和额度，启动 plan'), undefined); assert.equal(h.button('恢复本轮绑定'), undefined)
    assert.equal(h.calls.length, 0)
  }
  const h = fixture({ read: id => responseOf(statusOf(id, 'ready', { isRoot: false })) }); await h.settle()
  assert.match(h.text(), /根 plan 会话/); assert.equal(h.button('确认目标和额度，启动 plan'), undefined)
})

test('unknown read failure shows no enrollment UI and a later session classifies independently', async () => {
  let fail = true
  const h = fixture({ read: id => fail ? Promise.reject(new Error('状态暂不可用')) : responseOf(statusOf(id)) })
  await h.settle(); assert.equal(h.tree, null); assert.equal(h.button('确认目标和额度，启动 plan'), undefined)
  fail = false; h.switchSession('plan-b'); await h.settle()
  assert.ok(h.button('确认目标和额度，启动 plan')); assert.equal(h.calls.length, 0)
})

test('old session reads and command settlements cannot overwrite a newly selected session', async () => {
  const staleRead = deferred(), staleCommand = deferred()
  const h = fixture({ read: id => id === 'plan-a' ? staleRead.promise : responseOf(statusOf(id)), execute: () => staleCommand.promise })
  await h.settle(); h.switchSession('plan-b'); await h.settle()
  staleRead.resolve(responseOf(statusOf('plan-a', 'stopped'))); await h.settle()
  assert.ok(h.button('确认目标和额度，启动 plan')); assert.doesNotMatch(h.text(), /本轮已停止/)
  await h.change('本轮目标', 'B目标')
  const pendingClick = h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
  h.switchSession('plan-c'); await h.settle()
  staleCommand.resolve({ ok: true, value: { result: { kind: 'error', text: 'B session failed' } } }); await pendingClick; await h.settle()
  assert.doesNotMatch(h.text(), /B session failed/); assert.equal(h.label('本轮目标').props.value, '')
  assert.equal(h.calls[0][0], 'plan-b')
})

test('switching preset hides the card and ignores outstanding plan state', async () => {
  const late = deferred(), h = fixture({ read: () => late.promise }); await h.settle()
  h.switchSession('plan-a', 'standard'); await h.settle()
  late.resolve(responseOf(statusOf('plan-a'))); await h.settle()
  assert.equal(h.tree, null); assert.equal(h.calls.length, 0)
})

test('unknown plan does not block input; explicit controlled ready does, while ordinary chats do not', async () => {
  const read = deferred(), h = fixture({ read: () => read.promise })
  await h.settle()
  assert.equal(h.block(), undefined)
  assert.equal(h.tree, null, 'classification read does not flash a startup card')
  read.resolve(responseOf(statusOf('plan-a'))); await h.settle()
  assert.match(h.block().reason, /先确认目标和额度/)
  assert.equal(h.calls.length, 0)
  for (const preset of ['standard', 'cordis', 'work', 'code', 'review']) {
    const ordinary = fixture({ preset }); await ordinary.settle()
    assert.equal(ordinary.block(), undefined)
  }
})

test('startup remains composer-blocked while busy and releases its block only after bound readback', async () => {
  const command = deferred()
  let bound = false
  const h = fixture({ execute: () => command.promise, read: id => responseOf(statusOf(id, bound ? 'bound' : 'ready')) })
  await h.settle(); await h.change('本轮目标', '目标')
  const started = h.button('确认目标和额度，启动 plan').props.onClick(); await h.settle()
  assert.match(h.block().reason, /正在启动 plan/)
  bound = true
  command.resolve({ ok: true, value: { result: { kind: 'success' } } })
  await started; await h.settle()
  assert.equal(h.block(), undefined)
  assert.equal(h.calls.length, 1)
})

test('unknown read failure preserves input; failed controlled startup and terminal states retain a block', async () => {
  const failedRead = fixture({ read: () => Promise.reject(new Error('状态暂不可用')) })
  await failedRead.settle()
  assert.equal(failedRead.block(), undefined)
  assert.equal(failedRead.tree, null, 'an unavailable classification does not inject an enrollment card into an ordinary workflow')
  const failedStart = fixture({ execute: async () => ({ ok: false, error: { message: '连接中断' } }) })
  await failedStart.settle(); await failedStart.change('本轮目标', '目标')
  await failedStart.button('确认目标和额度，启动 plan').props.onClick(); await failedStart.settle()
  assert.match(failedStart.block().reason, /查看启动卡片/)
  for (const [state, expected] of [
    ['grant-only', /恢复本轮绑定/], ['other-owner', /授权状态/],
    ['stopped', /已停止/], ['closed', /已关闭/],
  ]) {
    const h = fixture({ read: id => responseOf(statusOf(id, state)) }); await h.settle()
    assert.match(h.block().reason, expected)
  }
})

test('session changes, preset changes and unmount release only this cards exact block object', async () => {
  const late = deferred(), h = fixture({ read: id => id === 'plan-a' ? late.promise : responseOf(statusOf(id)) })
  await h.settle()
  assert.equal(h.block('plan-a'), undefined)
  h.switchSession('plan-b'); await h.settle()
  assert.equal(h.block('plan-a'), undefined)
  assert.ok(h.block('plan-b'))
  late.resolve(responseOf(statusOf('plan-a', 'bound'))); await h.settle()
  assert.ok(h.block('plan-b'), 'stale bound response cannot release the new session block')
  h.switchSession('plan-b', 'standard'); await h.settle()
  assert.equal(h.block('plan-b'), undefined)
  h.switchSession('plan-c'); await h.settle()
  assert.ok(h.block('plan-c'))
  const external = { reason: h.block('plan-c').reason }
  h.replaceBlock(external)
  h.unmount()
  assert.equal(h.block('plan-c'), external, 'same reason with a different object still belongs to another owner')
  const own = fixture(); await own.settle(); own.unmount()
  assert.equal(own.block(), undefined)
})

test('existing external composer blocks survive status changes and absent block capability degrades safely', async () => {
  const external = { reason: '模型尚未配置，请先配置模型。' }
  let bound = false
  const h = fixture({ initialBlock: external, read: id => responseOf(statusOf(id, bound ? 'bound' : 'ready')) })
  await h.settle()
  assert.equal(h.block(), external)
  bound = true
  await h.button('重新读取').props.onClick(); await h.settle()
  assert.equal(h.block(), external)
  h.unmount(); assert.equal(h.block(), external)
  const missing = fixture({ blockCapability: false }); await missing.settle()
  assert.ok(missing.button('确认目标和额度，启动 plan'))
  assert.equal(missing.block(), undefined)
  assert.equal(missing.calls.length, 0)
})

test('default workflow plan has no startup card, budget inputs, composer block or automatic command', async () => {
  const h = fixture({ read: id => responseOf(statusOf(id, 'workflow')) })
  await h.settle()
  assert.equal(h.tree, null)
  assert.equal(h.label('总 token 额度'), undefined)
  assert.equal(h.button('确认目标和额度，启动 plan'), undefined)
  assert.equal(h.block(), undefined)
  assert.equal(h.calls.length, 0)
  assert.deepEqual(h.reads, ['plan-a'])
})

test('slow workflow classification never disables input or shows budget UI and preserves external blocks', async () => {
  const pending = deferred(), h = fixture({ read: () => pending.promise })
  await h.settle()
  assert.equal(h.tree, null); assert.equal(h.block(), undefined)
  pending.resolve(responseOf(statusOf('plan-a', 'workflow'))); await h.settle()
  assert.equal(h.tree, null); assert.equal(h.block(), undefined); assert.equal(h.calls.length, 0)
  const external = { reason: '另一个插件的输入提示。' }
  const other = fixture({ initialBlock: external, read: id => responseOf(statusOf(id, 'workflow')) })
  await other.settle(); other.unmount()
  assert.equal(other.block(), external)
  assert.equal(other.calls.length, 0)
})

test('known controlled stop survives a failed refresh and switching to a new workflow releases only its own block', async () => {
  let fail = false
  const h = fixture({ read: id => id === 'workflow-plan'
    ? responseOf(statusOf(id, 'workflow'))
    : fail ? Promise.reject(new Error('刷新失败')) : responseOf(statusOf(id, 'stopped')) })
  await h.settle()
  assert.match(h.block().reason, /已停止/)
  fail = true
  await h.button('重新读取').props.onClick(); await h.settle()
  assert.ok(h.block(), 'a failed refresh cannot convert a known stop into unknown ordinary state')
  assert.match(h.text(), /本轮已停止/)
  assert.equal(h.button('确认目标和额度，启动 plan'), undefined)
  h.switchSession('workflow-plan'); await h.settle()
  assert.equal(h.block('plan-a'), undefined)
  assert.equal(h.block('workflow-plan'), undefined)
  assert.equal(h.tree, null)
  assert.equal(h.calls.length, 0)
})

// Optional, standalone visual artifact from the same rendered element trees.
// This is an offline preview and deliberately has no command/network wiring.
if (process.argv.includes('--preview')) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const render = node => {
    if (node === null || node === undefined || node === false) return ''
    if (typeof node !== 'object') return escape(node)
    if (node.type === 'fragment') return node.children.map(render).join('')
    const properties = node.props ?? {}, attributes = []
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'key' || key === 'children' || key.startsWith('on') || (node.type === 'textarea' && key === 'value')) continue
      if (key === 'style') {
        const css = Object.entries(value).map(([name, number]) => `${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}:${typeof number === 'number' && !['lineHeight', 'opacity', 'fontWeight', 'flex', 'order'].includes(name) ? `${number}px` : number}`).join(';')
        attributes.push(`style="${escape(css)}"`)
      } else if (value === true) attributes.push(escape(key))
      else if (value !== false && value !== null && value !== undefined) attributes.push(`${escape(key)}="${escape(value)}"`)
    }
    const open = `<${node.type}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`
    if (['input', 'br', 'hr'].includes(node.type)) return open
    return `${open}${node.type === 'textarea' ? escape(properties.value ?? '') : node.children.map(render).join('')}</${node.type}>`
  }
  const ready = fixture(); await ready.settle()
  await ready.change('本轮目标', '整理本地受控任务的改动清单，完成必要检查，并交付可核对的结果。')
  const grant = { id: 'offline-preview', sessionId: 'preview-bound', goal: '整理本地受控任务的改动清单，完成必要检查，并交付可核对的结果。', budget: { tokens: 600000, requests: 20, wallMinutes: 30, outputCap: 4096, closeoutRequests: 6, closeoutTimeMs: 120000 } }
  const bound = fixture({ sessionId: 'preview-bound', read: id => responseOf(statusOf(id, 'bound', { authorization: grant, roundId: 'R-offline-preview' })) }); await bound.settle()
  const failed = fixture({ read: () => Promise.reject(new Error('暂时无法读取启动状态，请重试。')) }); await failed.settle()
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>启动 plan — 离线界面预览</title><style>body{margin:0;background:#f5f6f8;color:#252932;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:980px;margin:0 auto;padding:28px 20px 48px}h1{font-size:22px;margin:0 0 8px}h2{font-size:14px;margin:28px 0 10px;color:#68717e}.note{color:#68717e;margin-bottom:18px}section{background:white}input,textarea,button{font-family:inherit}button:disabled{opacity:.55}input,textarea{color:#252932!important;background:#fff!important}input:focus,textarea:focus{outline:2px solid #7391cb}details summary{cursor:pointer}details label{margin-top:10px}button{min-height:32px}label{min-width:0}@media(max-width:480px){main{padding:18px 12px 32px}h1{font-size:20px}}</style><main><h1>启动 plan</h1><p class="note">离线界面预览：以下内容由实际组件的离线渲染树生成，不代表真实 Host 已授权或通过验证。按钮没有接入执行服务。</p><h2>首次确认目标和额度</h2>${render(ready.tree)}<h2>已有绑定</h2>${render(bound.tree)}<h2>状态读取失败</h2>${render(failed.tree)}</main></html>`
  const directory = new URL('../../../../_work/plan-ui-fix-20261107/', import.meta.url)
  await mkdir(directory, { recursive: true })
  await writeFile(new URL('plan-start-preview.html', directory), html)
  console.log('Offline preview: ' + new URL('plan-start-preview.html', directory).pathname)
}
