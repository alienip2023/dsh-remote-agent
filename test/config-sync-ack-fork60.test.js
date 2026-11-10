/**
 * fork.60 (s47): the receipt listener and the ingest path behind it.
 *
 *  N  `hub/config-ack` frames carry node-written fields. The event the hub emits must carry the AUTHENTICATED node id
 *     (the registry slot the frame arrived on), never a `nodeId` the frame brought along — otherwise one authenticated
 *     node could write log lines (and pick the revision shown) for another node, with any length.
 *  H  A listener that throws must not take the hub down, and must not starve the listeners registered after it:
 *     onAck swallows its own failures (a logger that throws), and the ingest path swallows a listener that throws.
 *
 * Real NodeRegistry.handleFrameFor, real createConfigSync; assertions are on what was logged / what other listeners got.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createConfigSync } from '../lib/hub/config-sync.js'
import { computeRevision } from '../lib/hub/stable-hash.js'
import { NODE_TO_HUB } from '../lib/protocol.js'
import { E2E_MARKER } from '../lib/e2e.js'

const PAYLOAD = () => ({ providers: [{ id: 'alpha', api: 'openai-completions', baseURL: 'https://private.example/v1', apiKeyEnv: 'ALPHA_KEY', apiKey: 'sk-n60-LEAK-0123456789', models: [{ id: 'm1', name: 'M1' }] }], defaultModel: 'alpha/m1' })
const fakeE2E = () => ({ sealFrame: (_type, _id, d) => ({ e2e: E2E_MARKER, inner: d }) })

function setup({ throwingLog = false } = {}) {
  const logs = []
  const log = (level, msg, meta) => {
    if (throwingLog && /node (rejected|applied) config/.test(msg)) throw new Error('logger down')
    logs.push({ level, msg, meta })
  }
  const registry = new NodeRegistry({ log: () => {}, relay: { ready: true, send: () => true } })
  for (const id of ['n1', 'n2']) registry.nodes.set(id, { nodeId: id, online: true, lastSeen: 0, e2e: fakeE2E() })
  const sync = createConfigSync({ registry, source: PAYLOAD, log })
  registry.on('configSyncRequest', (ev) => sync.handleSyncRequest(ev))
  const events = []
  registry.on('configAck', (ev) => events.push(ev))
  const frame = (nodeId, d) => registry.handleFrameFor(nodeId, { t: NODE_TO_HUB.CONFIG_ACK, d })
  const push = (nodeId) => registry.handleFrameFor(nodeId, { t: NODE_TO_HUB.CONFIG_SYNC_REQUEST, d: { appliedRevision: 0 } })
  const ackLogs = () => logs.filter((l) => /node (rejected|applied) config/.test(l.msg))
  return { registry, logs, events, frame, push, ackLogs, revision: computeRevision(PAYLOAD()) }
}

test('N60-event: the configAck event carries the node the frame arrived from, not the nodeId written inside the frame', () => {
  const w = setup()
  w.frame('n1', { ok: false, error: 'patch-existing-invalid', nodeId: 'n2' })
  assert.equal(w.events.length, 1)
  assert.equal(w.events[0].nodeId, 'n1')
  assert.equal(w.events[0].error, 'patch-existing-invalid', 'the rest of the receipt still travels')
})

test('N60-log: a forged nodeId in the frame does not choose the node, the revision or the length of the log line', () => {
  const w = setup()
  w.push('n2')                                   // the hub pushed to n2 only
  const forged = 'n2' + 'x'.repeat(100000)
  w.frame('n1', { ok: false, error: 'plugin-not-allowed', nodeId: 'n2' })
  w.frame('n1', { ok: false, error: 'plugin-not-allowed', nodeId: forged })
  w.frame('n1', { ok: true, nodeId: 'n2' })
  const entries = w.ackLogs()
  assert.equal(entries.length, 3)
  for (const e of entries) {
    assert.equal(e.meta.nodeId, 'n1')
    assert.equal(e.meta.revision, null, 'n1 was never pushed to; n2\'s revision must not show up on n1\'s receipt')
  }
  assert.ok(JSON.stringify(w.logs).length < 2000, 'a forged id of any length does not reach the log')
  assert.equal(w.ackLogs().filter((e) => e.meta.nodeId !== 'n1').length, 0)
})

test('N60-own: the honest receipt still shows its own revision (the fix did not blank the node id)', () => {
  const w = setup()
  w.push('n2')
  w.frame('n2', { ok: false, error: 'patch-existing-invalid', nodeId: 'n1' })
  assert.deepEqual(w.ackLogs().map((e) => e.meta), [{ nodeId: 'n2', revision: w.revision, error: 'patch-existing-invalid' }])
})

test('H60-logger: a logger that throws inside the receipt listener does not take the ingest path down, and a listener registered after it still hears the receipt', () => {
  const w = setup({ throwingLog: true })
  const later = []
  w.registry.on('configAck', (ev) => later.push(ev))     // registered after createConfigSync's own listener
  assert.doesNotThrow(() => w.frame('n1', { ok: false, error: 'patch-existing-invalid' }))
  assert.equal(later.length, 1, 'the later listener must not be starved by the failure of the earlier one')
  assert.equal(later[0].nodeId, 'n1')
  assert.doesNotThrow(() => w.frame('n1', { ok: true }))
  assert.equal(later.length, 2)
})

test('H60-listener: a listener of someone else that throws does not take the ingest path down either; the frames after it are still handled', () => {
  const w = setup()
  w.registry.on('configAck', () => { throw new Error('foreign listener failed') })
  assert.doesNotThrow(() => w.frame('n1', { ok: false, error: 'plugin-not-allowed' }))
  assert.doesNotThrow(() => w.frame('n1', { ok: false, error: 'plugin-not-allowed' }))
  assert.equal(w.ackLogs().length, 2, 'our own listener ran for both frames')
  assert.equal(w.events.length, 2)
})
