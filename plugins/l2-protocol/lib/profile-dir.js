import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED = 'AUTHORITY_LOCATION_REQUIRED: a profile-owned ledger is mandatory'

function readProfileFacts(readJson, file) {
  try {
    const pkg = readJson(file)
    const bundles = pkg?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? pkg : undefined
  } catch {
    return undefined
  }
}

// A profile directory that hosts this plugin as a real installed copy:
//   <profile>/node_modules/dsh-role-chain-protocol/lib/index.js
// Sandboxes that carry the plugin elsewhere (a workspace junction, a pnpm virtual
// store) cannot be derived from, so they must supply DSH_PROFILE_DIR explicitly.
function profileDirFromModule(moduleUrl, exists, readJson) {
  let file
  try {
    file = fileURLToPath(moduleUrl)
  } catch {
    return undefined
  }
  const packageRoot = dirname(dirname(file))
  const profile = dirname(dirname(packageRoot))
  if (!profile || !exists(join(profile, 'package.json'))) return undefined
  return readProfileFacts(readJson, join(profile, 'package.json')) ? profile : undefined
}

/**
 * Resolve the profile directory that owns the role-chain ledger.
 *
 * The launcher's DSH_PROFILE_DIR stays authoritative: it is the only source an
 * isolated rehearsal or a CLI profile can rely on. A desktop Host boots the
 * profile without that variable, so an installed copy of this plugin falls back
 * to its own module location, accepted only when the parent directory really is
 * a profile (its package.json declares dsh.profile.bundles). Anything else fails
 * closed with the same message instead of guessing a ledger location.
 *
 * @param {{ envDir?: string, moduleUrl?: string, exists: (path: string) => boolean, readJson: (path: string) => unknown }} input
 * @returns {{ dir: string, source: 'env' | 'module' }}
 */
export function resolveProfileDir({ envDir, moduleUrl, exists, readJson }) {
  const env = typeof envDir === 'string' ? envDir.trim() : ''
  if (env) return { dir: env, source: 'env' }
  if (typeof moduleUrl === 'string' && moduleUrl) {
    const derived = profileDirFromModule(moduleUrl, exists, readJson)
    if (derived) return { dir: derived, source: 'module' }
  }
  throw new Error(REQUIRED)
}
