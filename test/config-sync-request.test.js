// Hub config-sync through the real path: a node's `hub/config-sync-request` frame goes
// into a real NodeRegistry (handleFrameFor), the registry emits `configSyncRequest`, the
// listener wired exactly as lib/hub/index.js wires it calls createConfigSync(...)
// .handleSyncRequest, and the push leaves through NodeRegistry.send → relay.
// An exception inside a registry listener is swallowed by the ingest, so these assert on
// what reached the wire and what was logged, not on a throw.
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createConfigSync } from '../lib/hub/config-sync.js'
import { computeRevision } from '../lib/hub/stable-hash.js'
import { HUB_TO_NODE, NODE_TO_HUB, decodeFrame } from '../lib/protocol.js'
import { E2E_MARKER } from '../lib/e2e.js'

const PAYLOAD = () => ({
  providers: [{ id: 'alpha', api: 'openai-completions', apiKeyEnv: 'ALPHA_KEY', apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] }],
  defaultModel: 'alpha/m1',
})

// A stand-in for an established e2e session: NodeRegistry.send seals the frame body with it.
const fakeE2E = () => ({ sealFrame: (_type, _id, d) => ({ e2e: E2E_MARKER, inner: d }) })

function setup({ source, sendThrows = false, e2e = true } = {}) {
  const logs = []
  const wire = []
  const relay = {
    ready: true,
    send: (nodeId, text) => {
      if (sendThrows) throw new Error('relay down')
      wire.push({ nodeId, text })
      return true
    },
  }
  const registry = new NodeRegistry({ log: (level, msg, meta) => logs.push({ level, msg, meta }), relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, ...(e2e ? { e2e: fakeE2E() } : {}) })
  const sync = createConfigSync({ registry, source, log: (level, msg, meta) => logs.push({ level, msg, meta }) })
  // exactly the wiring in lib/hub/index.js
  registry.on('configSyncRequest', ev => sync.handleSyncRequest(ev))
  const request = (appliedRevision) => registry.handleFrameFor('n1', { t: NODE_TO_HUB.CONFIG_SYNC_REQUEST, d: { appliedRevision } })
  // the frames as the node would open them (the e2e body unwrapped)
  const frames = () => wire.map((w) => {
    const decoded = decodeFrame(w.text)
    assert.equal(decoded.ok, true, 'frame decodes: ' + JSON.stringify(decoded))
    const frame = decoded.frame
    return frame.d?.e2e === E2E_MARKER ? { ...frame, d: frame.d.inner } : frame
  })
  const clearFrames = () => wire.filter(w => decodeFrame(w.text).frame?.d?.e2e !== E2E_MARKER)
  return { registry, sync, logs, wire, request, frames, clearFrames }
}

test('1. appliedRevision=0 → exactly one config-push frame, payload.revision = computeRevision(payload)', () => {
  const { request, frames, logs } = setup({ source: PAYLOAD })
  request(0)
  const sent = frames()
  assert.equal(sent.length, 1, 'one frame on the wire; logs=' + JSON.stringify(logs.filter(l => l.level === 'warn')))
  assert.equal(sent[0].t, HUB_TO_NODE.CONFIG_PUSH)
  const d = sent[0].d
  assert.equal(d.revision, computeRevision(d))
  assert.notEqual(d.revision, 0)
  assert.equal(d.providers[0].apiKey, 'sk-x')
  assert.equal(logs.some(l => l.level === 'warn'), false)
})

test('2. appliedRevision >= revision → nothing is sent', () => {
  const { request, frames } = setup({ source: PAYLOAD })
  const rev = computeRevision(PAYLOAD())
  request(rev)
  assert.equal(frames().length, 0)
  request(rev + 1)
  assert.equal(frames().length, 0)
})

test('3. source returns null / no source → nothing sent, nothing thrown', () => {
  for (const source of [() => null, undefined]) {
    const { request, frames } = setup({ source })
    assert.doesNotThrow(() => request(0))
    assert.equal(frames().length, 0)
  }
})

test('4. source throws → not thrown out of the listener, a warn is logged, nothing sent', () => {
  const { sync, request, frames, logs } = setup({ source: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => sync.handleSyncRequest({ nodeId: 'n1', appliedRevision: 0 }))
  request(0)
  assert.equal(frames().length, 0)
  const warn = logs.find(l => l.level === 'warn' && /source threw/.test(l.msg))
  assert.ok(warn, 'a warn about the source was logged')
  assert.match(warn.meta.error, /boom/)
})

test('5. registry.send throws → not thrown out, warn logged', () => {
  const { sync, request, logs } = setup({ source: PAYLOAD, sendThrows: true })
  assert.doesNotThrow(() => sync.handleSyncRequest({ nodeId: 'n1', appliedRevision: 0 }))
  request(0)
  assert.ok(logs.some(l => l.level === 'warn' && /push threw/.test(l.msg) && /relay down/.test(l.meta.error)), JSON.stringify(logs))
})

test('6. registry.send returns false (node not reachable) → warn, not a silent success', () => {
  const logs = []
  const sync = createConfigSync({ registry: { send: () => false, hasE2E: () => true }, source: PAYLOAD, log: (l, m, meta) => logs.push({ level: l, msg: m, meta }) })
  assert.equal(sync.sendPush('n1'), false)
  assert.ok(logs.some(l => l.level === 'warn' && /not delivered/.test(l.msg)))
})

test('7. an async source (Promise) is refused with a warn instead of hashing a Promise', () => {
  const { request, frames, logs } = setup({ source: async () => PAYLOAD() })
  request(0)
  assert.equal(frames().length, 0)
  assert.ok(logs.some(l => l.level === 'warn' && /synchronously/.test(l.msg)))
})

test('8. sendPush goes through the same path; setSource replaces the source; payload not mutated', () => {
  const { sync, frames } = setup()
  assert.equal(sync.sendPush('n1'), false, 'no source yet')
  sync.setSource(PAYLOAD)
  const p = PAYLOAD()
  assert.equal(sync.sendPush('n1', p), true)
  assert.equal('revision' in p, false, 'caller payload is not mutated')
  assert.equal(frames()[0].d.revision, sync.currentRevision)
  assert.equal(sync.sendPush('n1'), true)
  assert.equal(frames().length, 2)
})

test('9. the keys travel in the frame but never in a log line', () => {
  const { request, logs } = setup({ source: PAYLOAD })
  request(0)
  assert.equal(JSON.stringify(logs).includes('sk-x'), false)
})

test('10. node without an e2e session → no frame at all, no throw, a warn (the payload carries apiKey)', () => {
  const { sync, request, wire, logs } = setup({ source: PAYLOAD, e2e: false })
  assert.doesNotThrow(() => request(0))
  assert.equal(wire.length, 0, 'nothing went out, not even clear text: ' + JSON.stringify(wire))
  assert.equal(sync.sendPush('n1'), false)
  assert.equal(wire.length, 0)
  const warn = logs.find(l => l.level === 'warn' && /no e2e session/.test(l.msg))
  assert.ok(warn, 'a warn was logged: ' + JSON.stringify(logs))
  assert.equal(warn.meta.nodeId, 'n1')
  assert.equal(JSON.stringify(logs).includes('sk-x'), false, 'no key in the log')
})

test('11. node with an e2e session → one frame, its body sealed (never clear text)', () => {
  const { request, wire, frames, clearFrames } = setup({ source: PAYLOAD })
  request(0)
  assert.equal(wire.length, 1)
  assert.equal(clearFrames().length, 0, 'the body went out sealed')
  assert.equal(frames()[0].t, HUB_TO_NODE.CONFIG_PUSH)
})

test('12. NodeRegistry.hasE2E: true only for a known node with a session', () => {
  const registry = new NodeRegistry({ log: () => {} })
  registry.nodes.set('with', { nodeId: 'with', e2e: fakeE2E() })
  registry.nodes.set('without', { nodeId: 'without' })
  assert.equal(registry.hasE2E('with'), true)
  assert.equal(registry.hasE2E('without'), false)
  assert.equal(registry.hasE2E('unknown'), false)
  assert.equal(registry.hasE2E(undefined), false)
})

test('13. a registry with no hasE2E at all is treated as no session (fail closed)', () => {
  const logs = []
  let sent = 0
  const sync = createConfigSync({ registry: { send: () => { sent += 1; return true } }, source: PAYLOAD, log: (l, m) => logs.push({ level: l, msg: m }) })
  assert.equal(sync.sendPush('n1'), false)
  assert.equal(sent, 0)
  assert.ok(logs.some(l => l.level === 'warn' && /no e2e session/.test(l.msg)))
})

test('14. only apiKeyEnv changes (id unchanged) → shouldRestart=true', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { handleConfigPush } = await import('../lib/node/config-sync.js')
  const base = mkdtempSync(join(tmpdir(), 'fp-test-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const noRestart = () => {}
  try {
    const acks = []
    const send = (type, data) => { acks.push({ type, data }) }
    // First push: establish baseline with apiKeyEnv=OLD_KEY
    const r1 = handleConfigPush({
      data: { revision: 1, providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-1', apiKeyEnv: 'OLD_KEY', models: [] }] },
      dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart,
    })
    assert.equal(r1.ok, true)
    // Second push: same id + baseURL, but different apiKeyEnv → token rotated → must restart
    const r2 = handleConfigPush({
      data: { revision: 2, providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-2', apiKeyEnv: 'NEW_KEY', models: [] }] },
      dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart,
    })
    assert.equal(r2.ok, true)
    assert.equal(r2.shouldRestart, true, 'token rotation (apiKeyEnv change) must trigger restart')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('15. identical payload applied twice → shouldRestart=false on second push', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { handleConfigPush } = await import('../lib/node/config-sync.js')
  const base = mkdtempSync(join(tmpdir(), 'fp-test2-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const noRestart = () => {}
  try {
    const acks = []
    const send = (type, data) => { acks.push({ type, data }) }
    const payload = { providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-1', apiKeyEnv: 'SAME_KEY', models: [] }] }
    handleConfigPush({ data: { revision: 1, ...payload }, dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart })
    // Re-apply identical payload with a new revision number (content unchanged, same fingerprint)
    const r2 = handleConfigPush({ data: { revision: 2, ...payload }, dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart })
    assert.equal(r2.ok, true)
    assert.equal(r2.shouldRestart, false, 'identical provider fingerprint must not trigger restart')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('1A4-legacy: state file without schema:2 → shouldRestart=true + legacy-fingerprint warn', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { handleConfigPush } = await import('../lib/node/config-sync.js')
  const base = mkdtempSync(join(tmpdir(), 'legacy-test-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const noRestart = () => {}
  // Write pre-v2 state file (no schema field)
  writeFileSync(
    join(dshHome, 'config-sync.json'),
    JSON.stringify({ appliedRevision: 1, lastPayload: { providers: [{ id: 'p1' }] } }, null, 2) + '\n',
    { mode: 0o600 }
  )
  const logs = []
  const log = (level, msg, meta) => logs.push({ level, msg, meta })
  try {
    const acks = []
    const send = (type, data) => { acks.push({ type, data }) }
    const r = handleConfigPush({
      data: { revision: 2, providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }] },
      dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart, logger: log,
    })
    assert.equal(r.ok, true)
    assert.equal(r.shouldRestart, true, 'legacy state must trigger restart')
    assert.ok(logs.some(l => l.level === 'warn' && /legacy-fingerprint/.test(l.msg)), 'legacy-fingerprint warn must appear: ' + JSON.stringify(logs))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('1A4-legacy one-time: after schema:2 upgrade, same payload → shouldRestart=false', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { handleConfigPush } = await import('../lib/node/config-sync.js')
  const base = mkdtempSync(join(tmpdir(), 'legacy-once-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const noRestart = () => {}
  const payload = { providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }] }
  try {
    const send = (type, data) => {}
    // First push: writes schema:2 to state
    handleConfigPush({ data: { revision: 1, ...payload }, dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart })
    // Second push: schema:2 present, same fingerprint → should NOT restart
    const r2 = handleConfigPush({ data: { revision: 2, ...payload }, dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart })
    assert.equal(r2.ok, true)
    assert.equal(r2.shouldRestart, false, 'after schema:2 upgrade, same fingerprint must not restart')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('1A4-apikey: only apiKey value changes (apiKeyEnv unchanged) → shouldRestart=true', async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { handleConfigPush } = await import('../lib/node/config-sync.js')
  const base = mkdtempSync(join(tmpdir(), 'apikey-test-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const noRestart = () => {}
  try {
    const send = (type, data) => {}
    // First push: establish baseline
    handleConfigPush({
      data: { revision: 1, providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-original', apiKeyEnv: 'P1_KEY', models: [] }] },
      dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart,
    })
    // Second push: same id, baseURL, apiKeyEnv — but different apiKey value (upstream key rotated)
    const r2 = handleConfigPush({
      data: { revision: 2, providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-rotated', apiKeyEnv: 'P1_KEY', models: [] }] },
      dshHome, profileDir, e2e: true, wasEncrypted: true, send, _restartFn: noRestart,
    })
    assert.equal(r2.ok, true)
    assert.equal(r2.shouldRestart, true, 'apiKey value change must trigger restart (worker reads credentials once at startup)')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

