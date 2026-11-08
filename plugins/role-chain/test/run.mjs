// Repeatable regression entry for the dsh-role-chain umbrella bundle.
//
//   node test/run.mjs               each test file in its own child process
//   node test/run.mjs --in-process  single-process fallback for sandboxes that
//                                   forbid spawning grandchildren; weaker
//
// Exit codes: 0 pass, 1 failure, 2 incomplete (a skipped/absent suite is missing
// evidence, never a pass). Nothing here sends a model request or touches a profile.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const inProcess = process.argv.includes('--in-process')
const files = ['generated.test.mjs', 'tools.test.mjs', 'layout.test.mjs']

let failed = 0
let skipped = 0
for (const file of files) {
  const args = ['--test', join(here, file)]
  if (inProcess) args.unshift('--test-isolation=none')
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' })
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const summaryOf = label => Number((out.match(new RegExp(`^(?:# |ℹ )${label} (\d+)$`, 'm')) ?? [])[1] ?? -1)
  const pass = summaryOf('pass')
  const fail = summaryOf('fail')
  const skip = summaryOf('skipped')
  const summary = `pass=${pass} fail=${fail} skipped=${skip} exit=${run.status}`
  if (run.status !== 0 || pass < 1 || fail !== 0 || skip !== 0) {
    failed += 1
    console.log(`FAIL ${file} (${summary})`)
    process.stdout.write(out.split('\n').filter(line => /not ok|Error|AssertionError|DRIFT|expected/.test(line)).slice(0, 25).join('\n') + '\n')
  } else {
    skipped += 0
    console.log(`ok   ${file} (${summary})`)
  }
}

if (failed) {
  console.log(`\nRESULT: ${failed} file(s) failed`)
  process.exit(1)
}
console.log(`\nRESULT: all ${files.length} file(s) passed${inProcess ? ' (--in-process: weaker, not spawn-verified)' : ''}`)
