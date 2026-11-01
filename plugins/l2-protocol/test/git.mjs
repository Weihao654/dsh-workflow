// Real Git callback checks; subprocess adapter is a stand-in, not a Host range-proof test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { harness } from './helpers.mjs'
import * as svc from '../lib/service.js'
function setup(cwd, ...args) {
  const result = spawnSync('git', ['--no-pager', '-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
}
function gitAdapter() {
  return { spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, signal: spec.signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })) })
    return { done, waitForExit: async () => { await done; return true },
      collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } } }
  } }
}
test('fixed Git baseline suppresses repository fsmonitor and clean-filter callbacks', async t => {
  const h = await harness(); t.after(() => h.close())
  setup(h.dir, 'init'); setup(h.dir, 'config', 'user.name', 'Fixture'); setup(h.dir, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(h.dir, 'source.txt'), 'first\n')
  setup(h.dir, 'add', 'source.txt'); setup(h.dir, 'commit', '-m', 'fixture')
  const trap = join(h.dir, 'callback.cjs'), marker = join(h.dir, 'callback-ran')
  await writeFile(trap, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected callback')`)
  await writeFile(join(h.dir, '.gitattributes'), '*.txt filter=trap\n')
  setup(h.dir, 'config', 'core.fsmonitor', `node "${trap}"`)
  setup(h.dir, 'config', 'filter.trap.clean', `node "${trap}"`)
  setup(h.dir, 'config', 'filter.trap.required', 'true')
  await writeFile(join(h.dir, 'source.txt'), 'changed\n')
  Object.assign(h.services.subprocess, gitAdapter())
  const { work } = await h.spawnWork({ freeze: false })
  const result = await svc.freezeBaseline(h.ctx, h.store, work)
  assert.equal(result.baseline.mode, 'git'); assert.equal(result.baseline.callbacksDisabled, true)
  assert.equal(result.baseline.dirty, true); assert.ok(result.baseline.filterOverrides >= 2, 'includes fixture and any inherited Git filter keys')
  await assert.rejects(access(marker), error => error.code === 'ENOENT')
  const checked = await svc.checkBaseline(h.ctx, h.store, work)
  assert.equal(checked.commitChanged, false)
  await assert.rejects(access(marker), error => error.code === 'ENOENT')
})
test('cancelled fixed query cannot start a subprocess or be relabelled no-git', async t => {
  const h = await harness(); t.after(() => h.close())
  const { work } = await h.spawnWork({ freeze: false }), abort = new AbortController()
  abort.abort(); let calls = 0
  h.services.subprocess.spawn = () => { calls++; throw new Error('must not enter backend') }
  await assert.rejects(svc.freezeBaseline(h.ctx, h.store, { ...work, signal: abort.signal }), error => error.code === 'BASELINE_UNAVAILABLE')
  assert.equal(calls, 0); assert.equal((await h.store.read(s => s.rounds[h.opened.roundId])).baseline, null)
})
