import test from 'node:test'
import assert from 'node:assert/strict'
import { hasGuestRunner } from '../lib/controller.js'

test('a configured custom runner is detected from its failure signatures', () => {
  assert.equal(hasGuestRunner({ configuredRunnerFailureSignatures: ['BRIDGE_FAIL'] }), true)
})

test('a configured custom runner is detected from its runner argv', () => {
  assert.equal(hasGuestRunner({ runnerCommand: ['node', 'runner.mjs'] }), true)
})

test('the default platform rung has no guest runner', () => {
  assert.equal(hasGuestRunner({}), false)
  assert.equal(hasGuestRunner(undefined), false)
})

test('a throwing service proxy falls back to host resolution', () => {
  const proxy = { get configuredRunnerFailureSignatures() { throw new Error('hidden') } }
  assert.equal(hasGuestRunner(proxy), false)
})
