#!/usr/bin/env node
// CLI for the generated umbrella bundle.
//
//   node scripts/sync-umbrella.mjs           rewrite the mirror + patch files
//   node scripts/sync-umbrella.mjs --check   exit 1 when anything drifted
//   node scripts/sync-umbrella.mjs --root <dir> --repo <dir>   (testing)
//
// Generation rules live in ./sync-lib.mjs so tests can exercise them in-process.
import { buildPlan, driftOf, writePlan, SyncError } from './sync-lib.mjs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const option = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const here = dirname(fileURLToPath(import.meta.url))
const root = option('--root') ?? resolve(here, '..')
const repo = option('--repo') ?? resolve(root, '..', '..')

try {
  const plan = buildPlan(root, repo)
  if (CHECK) {
    const drift = driftOf(plan)
    if (drift.length) {
      console.error(`sync-umbrella: DRIFT (${drift.length})`)
      for (const line of drift) console.error(`  ${line}`)
      process.exit(1)
    }
    console.log(`sync-umbrella: OK (${plan.expected.size} files, presets ${plan.versions.presets}, protocol ${plan.versions.protocol})`)
    process.exit(0)
  }
  const written = writePlan(plan)
  console.log(`sync-umbrella: wrote ${written} files (presets ${plan.versions.presets}, protocol ${plan.versions.protocol})`)
  if (plan.pkgChanged) console.log(`sync-umbrella: updated dsh.roleChain.contents to ${plan.contents.presets} + ${plan.contents.protocol}`)
} catch (error) {
  if (error instanceof SyncError) {
    console.error(`sync-umbrella: ${error.message}`)
    process.exit(2)
  }
  throw error
}
