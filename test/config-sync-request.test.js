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

const PAYLOAD = () => ({
  providers: [{ id: 'alpha', api: 'openai-completions', apiKeyEnv: 'ALPHA_KEY', apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] }],
  defaultModel: 'alpha/m1',
})

function setup({ source, sendThrows = false } = {}) {
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
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0 })
  const sync = createConfigSync({ registry, source, log: (level, msg, meta) => logs.push({ level, msg, meta }) })
  // exactly the wiring in lib/hub/index.js
  registry.on('configSyncRequest', ev => sync.handleSyncRequest(ev))
  const request = (appliedRevision) => registry.handleFrameFor('n1', { t: NODE_TO_HUB.CONFIG_SYNC_REQUEST, d: { appliedRevision } })
  const frames = () => wire.map((w) => {
    const decoded = decodeFrame(w.text)
    assert.equal(decoded.ok, true, 'frame decodes: ' + JSON.stringify(decoded))
    return decoded.frame
  })
  return { registry, sync, logs, wire, request, frames }
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
  const sync = createConfigSync({ registry: { send: () => false }, source: PAYLOAD, log: (l, m, meta) => logs.push({ level: l, msg: m, meta }) })
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
