import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Resolve the active profile without creating directories or relying on an existing patch. */
export function resolveProfileDir({ env = process.env, moduleUrl = import.meta.url, homeDir = os.homedir() } = {}) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(homeDir, '.dsh')
  const profilesDir = path.resolve(dshHome, 'profiles')
  const profile = typeof env.DSH_PROFILE === 'string'
    ? env.DSH_PROFILE.trim().replace(/[^A-Za-z0-9._-]/g, '')
    : ''
  // Dot segments are not profile names: never allow them to escape profilesDir.
  if (profile !== '' && profile !== '.' && profile !== '..') return path.join(profilesDir, profile)

  // The loaded package location is stronger evidence than any other installed profile.
  for (let dir = path.dirname(fileURLToPath(moduleUrl)); ; dir = path.dirname(dir)) {
    const modulesDir = path.dirname(dir)
    const profileDir = path.dirname(modulesDir)
    if (path.basename(dir) === 'dsh-remote-agent'
      && path.basename(modulesDir) === 'node_modules'
      && path.basename(path.dirname(profileDir)) === 'profiles') return profileDir
    if (path.dirname(dir) === dir) break
  }

  let names = []
  try {
    names = fs.readdirSync(profilesDir)
  } catch {
    // A missing or unreadable home supplies no evidence of an installed profile.
  }
  const installed = names.filter((name) => isDirectory(path.join(profilesDir, name, 'node_modules', 'dsh-remote-agent')))
  const preferred = ['web', 'desktop'].find((name) => installed.includes(name)) ?? installed.sort()[0]
  if (preferred !== undefined) return path.join(profilesDir, preferred)

  const error = new Error('profile-unresolved: set DSH_PROFILE or install dsh-remote-agent in a DSH profile')
  error.code = 'profile-unresolved'
  throw error
}

/** The patch may not exist yet, but its profile must be resolved first. */
export function resolvePatchFile(options) {
  return path.join(resolveProfileDir(options), 'cordis.patch.yml')
}
