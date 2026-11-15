import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { applyWorker } from '../lib/node/index.js'
import { NodeTransport } from '../lib/node/transport.js'
import { handleConfigPush } from '../lib/node/config-sync.js'
import { currentPatchFile } from '../lib/setup-routes.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateNodeConfigResult } from '../lib/protocol.js'

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

function worker(t) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ra-config-profile-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  setDshEnv(t, home)
  let transport
  const sent = []
  const originalOn = NodeTransport.prototype.on
  t.mock.method(NodeTransport.prototype, 'on', function (...args) {
    transport = this
    return originalOn.apply(this, args)
  })
  t.mock.method(NodeTransport.prototype, 'start', () => assert.fail('test must never connect'))
  t.mock.method(NodeTransport.prototype, 'send', (type, data) => { sent.push({ type, data }); return true })
  const dispose = applyWorker({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get() {}, provide() {},
  }, {
    nodeId: 'profile-test', stateDir: path.join(home, 'state'), roots: [home],
    resourceIntervalMs: 0, reposIntervalMs: 0,
  })
  t.after(dispose)
  assert.ok(transport, 'real worker must reach transport wiring')
  // Exercise the worker dispatch after the transport's E2E gate, without a connection.
  const push = async (data) => {
    transport.emit('frame', { id: 'profile-push', t: HUB_TO_NODE.CONFIG_PUSH, d: data })
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { home, sent, push, web: path.join(home, 'profiles', 'web') }
}

test('worker config push writes all three providers to installed web and persists revision in its home', async (t) => {
  const f = worker(t)
  mkdirSync(path.join(f.web, 'node_modules', 'dsh-remote-agent'), { recursive: true })
  const patchFile = path.join(f.web, 'cordis.patch.yml')
  // Fail before dispatch on the old implementation, so it cannot touch a live home.
  assert.equal(currentPatchFile(), patchFile)
  const providers = ['xai', 'a6api', 'dsa6'].map((id) => ({
    id, apiKeyEnv: id.toUpperCase() + '_KEY', models: [{ id: id + '-model' }],
  }))
  // Prime matching digests with the real writer so dispatch cannot schedule a restart.
  const seed = handleConfigPush({
    data: { schema: 2, revision: 1, providers, plugins: [] },
    dshHome: f.home, profileDir: f.web, _systemd: false,
  })
  assert.equal(seed.ok, true)
  writeFileSync(patchFile, readFileSync(patchFile, 'utf8').replace(/(?:xai|a6api|dsa6)-model/g, 'old-model'))
  await f.push({ schema: 2, revision: 2, providers, plugins: [] })
  const ack = f.sent.find((f) => f.type === NODE_TO_HUB.CONFIG_ACK)
  assert.equal(ack?.data.ok, true, JSON.stringify(ack))
  assert.equal(ack.data.shouldRestart, false)
  const patch = readFileSync(patchFile, 'utf8')
  for (const { id } of providers) assert.ok(patch.includes(id + '-model'), id)
  assert.equal(patch.includes('old-model'), false)
  assert.equal(JSON.parse(readFileSync(path.join(f.home, 'config-sync.json'), 'utf8')).appliedRevision, 2)
  assert.equal(existsSync(path.join(f.home, 'profiles', 'desktop')), false)
})

test('unresolved worker profile returns a failure result and ACK without touching sync state', async (t) => {
  const f = worker(t)
  const stateFile = path.join(f.home, 'config-sync.json')
  const state = '{"schema":2,"appliedRevision":7}\n'
  writeFileSync(stateFile, state)
  // Invalid revision also keeps the old implementation read-only during the red run.
  await f.push({ schema: 2, revision: null, providers: [] })
  const result = f.sent.find((f) => f.type === NODE_TO_HUB.NODE_CONFIG_RESULT)
  assert.equal(result?.data.ok, false)
  assert.equal(result.data.error, 'profile-unresolved')
  assert.equal(result.data.requestId, 'profile-push')
  assert.equal(validateNodeConfigResult(result.data).ok, true)
  const ack = f.sent.find((f) => f.type === NODE_TO_HUB.CONFIG_ACK)
  assert.equal(ack?.data.ok, false)
  assert.equal(ack.data.error, 'profile-unresolved')
  f.sent.length = 0
  await f.push({ schema: 2, revision: 8, providers: [], plugins: [] })
  assert.deepEqual(f.sent.map(({ type, data }) => [type, data.ok, data.error]), [
    [NODE_TO_HUB.NODE_CONFIG_RESULT, false, 'profile-unresolved'],
    [NODE_TO_HUB.CONFIG_ACK, false, 'profile-unresolved'],
  ])
  assert.equal(readFileSync(stateFile, 'utf8'), state)
  assert.equal(existsSync(path.join(f.home, 'profiles')), false)
  assert.equal(existsSync(path.join(f.home, '.credentials.yaml')), false)
})
