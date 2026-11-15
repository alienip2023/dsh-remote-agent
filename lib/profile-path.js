import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function unresolvedProfileError(message) {
  const error = new Error(`profile-unresolved: ${message}`)
  error.code = 'profile-unresolved'
  return error
}

/** Resolve the active profile without creating directories or relying on an existing patch. */
export function resolveProfileDir({ env = process.env, moduleUrl = import.meta.url, homeDir = os.homedir() } = {}) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(homeDir, '.dsh')
  const profilesDir = path.resolve(dshHome, 'profiles')
  const profile = typeof env.DSH_PROFILE === 'string'
    ? env.DSH_PROFILE.trim()
    : ''
  if (profile !== '') {
    // Reject invalid names rather than silently changing them or escaping profilesDir.
    if (/[^A-Za-z0-9._-]/.test(profile) || profile === '.' || profile === '..') {
      throw unresolvedProfileError('invalid DSH_PROFILE')
    }
    return path.join(profilesDir, profile)
  }

  // Without an explicit profile, only the loaded package location identifies it.
  for (let dir = path.dirname(fileURLToPath(moduleUrl)); ; dir = path.dirname(dir)) {
    const modulesDir = path.dirname(dir)
    const profileDir = path.dirname(modulesDir)
    if (path.basename(dir) === 'dsh-remote-agent'
      && path.basename(modulesDir) === 'node_modules'
      && path.basename(path.dirname(profileDir)) === 'profiles') return profileDir
    if (path.dirname(dir) === dir) break
  }

  throw unresolvedProfileError('set DSH_PROFILE or load dsh-remote-agent from a DSH profile')
}

/** The patch may not exist yet, but its profile must be resolved first. */
export function resolvePatchFile(options) {
  return path.join(resolveProfileDir(options), 'cordis.patch.yml')
}
