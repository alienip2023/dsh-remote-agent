import assert from 'node:assert/strict'
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { currentPatchFile } from '../lib/setup-routes.js'

function setDshEnv(t, home) {
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE }
  process.env.DSH_HOME = home
  delete process.env.DSH_PROFILE
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ra-profile-path-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = (name) => path.join(home, 'profiles', name)
  const install = (name) => {
    const dir = path.join(profile(name), 'node_modules', 'dsh-remote-agent')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  return { home, profile, install, options: { env: { DSH_HOME: home }, homeDir: home } }
}

async function resolver() {
  return import('../lib/profile-path.js')
}

function generation(f, name = 'current', packageName = 'dsh-remote-agent') {
  const dir = path.join(f.home, 'profiles', '.generations', 'live', name, 'node_modules', packageName)
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: packageName, type: 'module' }))
  return { dir, moduleUrl: pathToFileURL(path.join(dir, 'lib', 'profile-path.js')).href }
}

function linkGeneration(f, profile, dir, packageName = 'dsh-remote-agent') {
  const link = path.join(f.profile(profile), 'node_modules', packageName)
  mkdirSync(path.dirname(link), { recursive: true })
  symlinkSync(dir, link, 'dir')
}

for (const packageName of ['dsh-remote-agent', 'renamed-agent', '@fixture/agent']) {
  test(`generation ${packageName} resolves the unique linked profile and skips hidden profiles`, async (t) => {
    const f = fixture(t)
    const g = generation(f, 'current', packageName)
    linkGeneration(f, 'web', g.dir, packageName)
    linkGeneration(f, '.hidden', g.dir, packageName)
    const { resolveProfileDir, resolvePatchFile } = await resolver()
    const options = { ...f.options, moduleUrl: g.moduleUrl }
    assert.equal(resolveProfileDir(options), f.profile('web'))
    assert.equal(resolvePatchFile(options), path.join(f.profile('web'), 'cordis.patch.yml'))
    assert.equal(existsSync(f.profile('desktop')), false)
  })
}

test('generation linked to another generation stays unresolved', async (t) => {
  const f = fixture(t)
  const current = generation(f)
  const other = generation(f, 'other')
  linkGeneration(f, 'web', other.dir)
  const { resolveProfileDir } = await resolver()
  assert.throws(() => resolveProfileDir({ ...f.options, moduleUrl: current.moduleUrl }), { code: 'profile-unresolved' })
})

test('generation shared by two profiles stays unresolved instead of selecting the first', async (t) => {
  const f = fixture(t)
  const g = generation(f)
  linkGeneration(f, 'web', g.dir)
  linkGeneration(f, 'desktop', g.dir)
  const { resolveProfileDir } = await resolver()
  assert.throws(() => resolveProfileDir({ ...f.options, moduleUrl: g.moduleUrl }), { code: 'profile-unresolved' })
})

test('explicit DSH_PROFILE bypasses generation enumeration, including invalid names', async (t) => {
  const f = fixture(t)
  const g = generation(f)
  const { resolveProfileDir } = await resolver()
  const readdir = t.mock.method(fs, 'readdirSync', () => { throw new Error('must not enumerate profiles') })
  assert.equal(resolveProfileDir({
    ...f.options, moduleUrl: g.moduleUrl, env: { DSH_HOME: f.home, DSH_PROFILE: ' web ' },
  }), f.profile('web'))
  assert.throws(() => resolveProfileDir({
    ...f.options, moduleUrl: g.moduleUrl, env: { DSH_HOME: f.home, DSH_PROFILE: '../web' },
  }), { code: 'profile-unresolved' })
  assert.equal(readdir.mock.callCount(), 0)
})

test('traditional injected installation still resolves without enumerating profiles', async (t) => {
  const f = fixture(t)
  const plugin = f.install('web')
  const { resolveProfileDir } = await resolver()
  const readdir = t.mock.method(fs, 'readdirSync', () => { throw new Error('must not enumerate profiles') })
  assert.equal(resolveProfileDir({
    ...f.options, moduleUrl: pathToFileURL(path.join(plugin, 'lib', 'profile-path.js')).href,
  }), f.profile('web'))
  assert.equal(readdir.mock.callCount(), 0)
})

test('generation infers the package name when package.json has no name', async (t) => {
  const f = fixture(t)
  const g = generation(f, 'current', 'inferred-agent')
  writeFileSync(path.join(g.dir, 'package.json'), '{"type":"module"}')
  linkGeneration(f, 'web', g.dir, 'inferred-agent')
  const { resolveProfileDir } = await resolver()
  assert.equal(resolveProfileDir({ ...f.options, moduleUrl: g.moduleUrl }), f.profile('web'))
})

test('generation uses package.json name when the package directory is an alias', async (t) => {
  const f = fixture(t)
  const g = generation(f, 'current', 'artifact-directory')
  writeFileSync(path.join(g.dir, 'package.json'), '{"name":"manifest-agent"}')
  linkGeneration(f, 'web', g.dir, 'manifest-agent')
  const { resolveProfileDir } = await resolver()
  assert.equal(resolveProfileDir({ ...f.options, moduleUrl: g.moduleUrl }), f.profile('web'))
})

test('generation resolves under the injected default home .dsh', async (t) => {
  const f = fixture(t)
  const dshHome = path.join(f.home, '.dsh')
  const defaultFixture = { home: dshHome, profile: name => path.join(dshHome, 'profiles', name) }
  const g = generation(defaultFixture)
  linkGeneration(defaultFixture, 'web', g.dir)
  const { resolveProfileDir } = await resolver()
  assert.equal(resolveProfileDir({ env: {}, homeDir: f.home, moduleUrl: g.moduleUrl }), defaultFixture.profile('web'))
})

test('generation without DSH_HOME uses its containing profiles root instead of guessing from the default home', async (t) => {
  const f = fixture(t)
  const g = generation(f)
  linkGeneration(f, 'web', g.dir)
  const defaultFixture = { profile: name => path.join(f.home, '.dsh', 'profiles', name) }
  linkGeneration(defaultFixture, 'desktop', g.dir)
  const { resolveProfileDir } = await resolver()
  assert.equal(resolveProfileDir({ env: {}, homeDir: f.home, moduleUrl: g.moduleUrl }), f.profile('web'))
  assert.equal(resolveProfileDir({
    env: { DSH_HOME: path.join(f.home, '.dsh') }, homeDir: f.home, moduleUrl: g.moduleUrl,
  }), defaultFixture.profile('desktop'))
})

for (const initialProfiles of [[], ['web'], ['web', 'desktop']]) {
  test(`generation caches ${initialProfiles.length} matches and can explicitly clear the cache`, async (t) => {
    const f = fixture(t)
    const g = generation(f)
    for (const name of initialProfiles) linkGeneration(f, name, g.dir)
    const { resolveProfileDir, resolvePatchFile, clearProfileDirCache } = await resolver()
    clearProfileDirCache()
    t.after(clearProfileDirCache)
    const readdir = t.mock.method(fs, 'readdirSync')
    const options = { ...f.options, moduleUrl: g.moduleUrl }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (initialProfiles.length === 1) {
        assert.equal(resolveProfileDir(options), f.profile('web'))
        assert.equal(resolvePatchFile(options), path.join(f.profile('web'), 'cordis.patch.yml'))
      } else {
        assert.throws(() => resolveProfileDir(options), { code: 'profile-unresolved' })
        assert.throws(() => resolvePatchFile(options), { code: 'profile-unresolved' })
      }
    }
    assert.equal(readdir.mock.callCount(), 1)
    if (initialProfiles.length === 0) linkGeneration(f, 'web', g.dir)
    else if (initialProfiles.length === 2) rmSync(f.profile('desktop'), { recursive: true })
    clearProfileDirCache()
    assert.equal(resolveProfileDir(options), f.profile('web'))
    assert.equal(readdir.mock.callCount(), 2)
  })
}

test('setup resolves explicit web without a patch and never creates desktop', (t) => {
  const f = fixture(t)
  f.install('web')
  setDshEnv(t, f.home)
  process.env.DSH_PROFILE = 'web'
  assert.equal(currentPatchFile(), path.join(f.profile('web'), 'cordis.patch.yml'))
  assert.equal(existsSync(f.profile('desktop')), false)
})

test('installed web and an existing desktop patch cannot identify the active profile', async (t) => {
  const f = fixture(t)
  f.install('web')
  mkdirSync(f.profile('desktop'))
  writeFileSync(path.join(f.profile('desktop'), 'cordis.patch.yml'), 'plugins: []\n')
  const { resolveProfileDir, resolvePatchFile } = await resolver()
  for (const resolve of [resolveProfileDir, resolvePatchFile]) {
    assert.throws(() => resolve(f.options), { code: 'profile-unresolved' })
  }
})

test('the actually loaded web installation identifies the active profile despite another DSH_HOME', async (t) => {
  const f = fixture(t)
  const plugin = f.install('web')
  const lib = path.join(plugin, 'lib')
  mkdirSync(lib)
  writeFileSync(path.join(plugin, 'package.json'), '{"type":"module"}')
  // Import a real installed copy: the resolver must use its own import.meta.url.
  await resolver()
  const installedFile = path.join(lib, 'profile-path.js')
  copyFileSync(new URL('../lib/profile-path.js', import.meta.url), installedFile)
  const otherHome = path.join(f.home, 'other-home')
  mkdirSync(path.join(otherHome, 'profiles', 'desktop', 'node_modules', 'dsh-remote-agent'), { recursive: true })
  setDshEnv(t, otherHome)
  const installed = await import(pathToFileURL(installedFile).href)
  assert.equal(installed.resolveProfileDir(), f.profile('web'))
  assert.equal(installed.resolvePatchFile(), path.join(f.profile('web'), 'cordis.patch.yml'))
  process.env.DSH_PROFILE = ' headless '
  assert.equal(installed.resolveProfileDir(), path.join(otherHome, 'profiles', 'headless'))
})

test('a trimmed explicit DSH_PROFILE wins over the loaded installation', async (t) => {
  const f = fixture(t)
  const plugin = f.install('web')
  const { resolveProfileDir } = await resolver()
  assert.equal(resolveProfileDir({
    ...f.options,
    env: { DSH_HOME: ` ${f.home} `, DSH_PROFILE: ' headless-1.0_test ' },
    moduleUrl: pathToFileURL(path.join(plugin, 'lib', 'profile-path.js')).href,
  }), f.profile('headless-1.0_test'))
  assert.equal(existsSync(f.profile('headless-1.0_test')), false, 'resolution must be read-only')
})

for (const name of ['', '  ']) {
  test(`empty profile ${JSON.stringify(name)} uses the loaded web installation`, async (t) => {
    const f = fixture(t)
    const plugin = f.install('web')
    const { resolveProfileDir } = await resolver()
    assert.equal(resolveProfileDir({
      ...f.options,
      env: { DSH_HOME: f.home, DSH_PROFILE: name },
      moduleUrl: pathToFileURL(path.join(plugin, 'lib', 'profile-path.js')).href,
    }), f.profile('web'))
  })
}

for (const name of ['/! ', '.', '..', 'a/b', '../headless/']) {
  test(`invalid profile ${JSON.stringify(name)} throws instead of changing the name or inferring a profile`, async (t) => {
    const f = fixture(t)
    const plugin = f.install('web')
    f.install('ab')
    const { resolveProfileDir } = await resolver()
    assert.throws(() => resolveProfileDir({
      ...f.options,
      env: { DSH_HOME: f.home, DSH_PROFILE: name },
      moduleUrl: pathToFileURL(path.join(plugin, 'lib', 'profile-path.js')).href,
    }), { code: 'profile-unresolved' })
  })
}

for (const names of [
  ['desktop'],
  ['headless', 'desktop', 'web'],
  ['headless', 'desktop'],
  ['zeta', 'alpha'],
]) {
  test(`installed profiles ${names.join(', ')} without DSH_PROFILE or a loaded installation throw profile-unresolved`, async (t) => {
    const f = fixture(t)
    for (const name of names) f.install(name)
    const { resolveProfileDir, resolvePatchFile } = await resolver()
    for (const resolve of [resolveProfileDir, resolvePatchFile]) {
      assert.throws(() => resolve(f.options), { code: 'profile-unresolved' })
    }
  })
}

test('without DSH_HOME, the default home .dsh still requires an explicit profile or loaded installation', async (t) => {
  const f = fixture(t)
  const dshHome = path.join(f.home, '.dsh')
  const web = path.join(dshHome, 'profiles', 'web')
  mkdirSync(path.join(web, 'node_modules', 'dsh-remote-agent'), { recursive: true })
  const { resolveProfileDir } = await resolver()
  assert.throws(() => resolveProfileDir({ env: {}, homeDir: f.home }), { code: 'profile-unresolved' })
  assert.equal(resolveProfileDir({ env: { DSH_PROFILE: 'web' }, homeDir: f.home }), web)
})

for (const layout of ['missing', 'patch-only', 'node-modules-only', 'plugin-is-file']) {
  test(`unresolved ${layout} throws profile-unresolved without creating desktop`, async (t) => {
    const f = fixture(t)
    if (layout === 'patch-only') {
      mkdirSync(f.profile('web'), { recursive: true })
      writeFileSync(path.join(f.profile('web'), 'cordis.patch.yml'), 'plugins: []\n')
    } else if (layout !== 'missing') {
      const modules = path.join(f.profile('web'), 'node_modules')
      mkdirSync(modules, { recursive: true })
      if (layout === 'plugin-is-file') writeFileSync(path.join(modules, 'dsh-remote-agent'), '')
    }
    const { resolveProfileDir, resolvePatchFile } = await resolver()
    for (const resolve of [resolveProfileDir, resolvePatchFile]) {
      assert.throws(() => resolve(f.options), { code: 'profile-unresolved' })
    }
    assert.equal(existsSync(f.profile('desktop')), false)
  })
}
