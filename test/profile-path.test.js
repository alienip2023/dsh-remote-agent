import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

test('setup resolves web without DSH_PROFILE or a patch and never creates desktop', (t) => {
  const f = fixture(t)
  f.install('web')
  setDshEnv(t, f.home)
  assert.equal(currentPatchFile(), path.join(f.profile('web'), 'cordis.patch.yml'))
  assert.equal(existsSync(f.profile('desktop')), false)
})

test('scanner requires the plugin installation, not an existing desktop patch', async (t) => {
  const f = fixture(t)
  f.install('web')
  mkdirSync(f.profile('desktop'))
  writeFileSync(path.join(f.profile('desktop'), 'cordis.patch.yml'), 'plugins: []\n')
  const { resolveProfileDir, resolvePatchFile } = await resolver()
  assert.equal(resolveProfileDir(f.options), f.profile('web'))
  assert.equal(resolvePatchFile(f.options), path.join(f.profile('web'), 'cordis.patch.yml'))
})

test('the actually loaded web installation wins over DSH_HOME scanning', async (t) => {
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

test('a sanitized explicit DSH_PROFILE wins over installation and scanning', async (t) => {
  const f = fixture(t)
  const plugin = f.install('web')
  const { resolveProfileDir } = await resolver()
  assert.equal(resolveProfileDir({
    ...f.options,
    env: { DSH_HOME: ` ${f.home} `, DSH_PROFILE: ' ../headless/ ' },
    moduleUrl: pathToFileURL(path.join(plugin, 'lib', 'profile-path.js')).href,
  }), f.profile('..headless'))
  assert.equal(existsSync(f.profile('..headless')), false, 'resolution must be read-only')
})

for (const name of ['', '  ', '/! ', '.', '..']) {
  test(`empty or unsafe profile ${JSON.stringify(name)} falls through to installed web`, async (t) => {
    const f = fixture(t)
    f.install('web')
    const { resolveProfileDir } = await resolver()
    assert.equal(resolveProfileDir({ ...f.options, env: { DSH_HOME: f.home, DSH_PROFILE: name } }), f.profile('web'))
  })
}

for (const [names, expected] of [
  [['headless', 'desktop', 'web'], 'web'],
  [['headless', 'desktop'], 'desktop'],
  [['zeta', 'alpha'], 'alpha'],
]) {
  test(`multiple installed profiles ${names.join(', ')} select ${expected}`, async (t) => {
    const f = fixture(t)
    for (const name of names) f.install(name)
    const { resolveProfileDir } = await resolver()
    assert.equal(resolveProfileDir(f.options), f.profile(expected))
  })
}

test('without DSH_HOME, scan the default home .dsh installation', async (t) => {
  const f = fixture(t)
  const dshHome = path.join(f.home, '.dsh')
  const web = path.join(dshHome, 'profiles', 'web')
  mkdirSync(path.join(web, 'node_modules', 'dsh-remote-agent'), { recursive: true })
  const { resolveProfileDir } = await resolver()
  assert.equal(resolveProfileDir({ env: {}, homeDir: f.home }), web)
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
