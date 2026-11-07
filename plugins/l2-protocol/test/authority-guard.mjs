import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { harness } from './helpers.mjs'
import { assertProjectAdmission } from '../lib/authorization.js'
test('controlled tools cannot reach the profile authority or let review write', async t => {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'role-chain-authority-guard-'))
  const h = await harness({ noOpen: true, authorityRoot })
  t.after(async () => { await h.close(); const path = resolve(authorityRoot); assert.ok(path.startsWith(`${resolve(tmpdir())}${sep}`) && path.includes('role-chain-authority-guard-')); await rm(path, { recursive: true, force: true }) })
  const result = await h.commands.get('chain-authorize').handler({ commandId: 'ui-1', agent: h.plan.agent,
    rawInput: JSON.stringify({ authorizationId: 'guard', goal: 'Guard test', budget: { tokens: 10000, requests: 2, wallMinutes: 10, outputCap: 16 } }) })
  assert.equal(result.kind, 'success', result.text)
  h.definitions.set('write', { parameters: { properties: { file_path: {}, content: {} } }, execute() {} })
  const store = h.controller.storeForCwd(h.dir)
  assert.match(h.controller.guard({ name: 'write', arguments: { file_path: store.statePath }, agent: h.plan.agent }), /CONTROL_STATE_PROTECTED/)
  h.sessions.get(h.plan.sessionId).header.agentPreset = 'review'
  assert.match(h.controller.guard({ name: 'write', arguments: { file_path: join(h.dir, 'source.js') }, agent: h.plan.agent }), /ROLE_WRITE_DENIED/)
})
test('malformed authority cannot turn missing numeric fields into unlimited admission', () => {
  assert.throws(() => assertProjectAdmission({ authorization: { version: 1, id: 'corrupt', deadlineAt: new Date(Date.now() + 10000).toISOString(), budget: {} }, rounds: {} }), { code: 'AUTHORIZATION_CORRUPT' })
})
