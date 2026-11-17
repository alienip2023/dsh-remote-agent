import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const linkedProfileCache = new Map()

/** Clear cached installation topology after relinking profiles (also useful for tests). */
export function clearProfileDirCache() {
  linkedProfileCache.clear()
}

function linkedProfileDir(profilesDir, moduleUrl) {
  // This module lives at <package>/lib/profile-path.js, even in a generation.
  const packageDir = path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..')
  const cacheKey = JSON.stringify([profilesDir, packageDir])
  if (linkedProfileCache.has(cacheKey)) return linkedProfileCache.get(cacheKey)

  let resolved = null
  try {
    const packageRealpath = fs.realpathSync(packageDir)
    const parentName = path.basename(path.dirname(packageDir))
    let packageName = parentName.startsWith('@')
      ? `${parentName}/${path.basename(packageDir)}`
      : path.basename(packageDir)
    try {
      const { name } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
      if (typeof name === 'string' && name.trim() !== '') packageName = name
    } catch { /* An absent or unreadable manifest still allows directory-name inference. */ }

    const matches = []
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
      const profileDir = path.join(profilesDir, entry.name)
      try {
        if (fs.realpathSync(path.join(profileDir, 'node_modules', packageName)) === packageRealpath) {
          matches.push(profileDir)
        }
      } catch { /* Missing or broken package links cannot identify this profile. */ }
    }
    if (matches.length === 1) resolved = matches[0]
  } catch { /* Unreadable installation roots remain unresolved. */ }

  // Cache misses and ambiguity as well: failing setup requests must not rescan either.
  linkedProfileCache.set(cacheKey, resolved)
  return resolved
}

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
  let generationProfilesDir
  for (let dir = path.dirname(fileURLToPath(moduleUrl)); ; dir = path.dirname(dir)) {
    const modulesDir = path.dirname(dir)
    const profileDir = path.dirname(modulesDir)
    if (path.basename(dir) === 'dsh-remote-agent'
      && path.basename(modulesDir) === 'node_modules'
      && path.basename(path.dirname(profileDir)) === 'profiles') return profileDir
    if (path.basename(dir) === 'live'
      && path.basename(modulesDir) === '.generations'
      && path.basename(profileDir) === 'profiles') generationProfilesDir = profileDir
    if (path.dirname(dir) === dir) break
  }

  // Desktop's generation location supplies the home only when none was configured.
  const hasDshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
  const linkedProfile = linkedProfileDir(!hasDshHome && generationProfilesDir ? generationProfilesDir : profilesDir, moduleUrl)
  if (linkedProfile) return linkedProfile

  throw unresolvedProfileError('set DSH_PROFILE or load dsh-remote-agent from a DSH profile')
}

/** The patch may not exist yet, but its profile must be resolved first. */
export function resolvePatchFile(options) {
  return path.join(resolveProfileDir(options), 'cordis.patch.yml')
}
