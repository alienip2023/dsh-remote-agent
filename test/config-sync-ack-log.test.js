/**
 * fork.59 (item 2): the hub says what the node answered to a config push.
 *
 * Before: `registry-ingest` emitted `configAck` and nobody listened, so a node that refused a push (`patch-existing-invalid`)
 * was invisible on the hub — the push looked sent, nothing changed, no log line anywhere (s44).
 *
 * Through the real path: a push leaves through NodeRegistry.send, the node's `hub/config-ack` frame goes into a real
 * NodeRegistry (handleFrameFor), the listener lives in createConfigSync. Assertions are on what was logged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createConfigSync } from '../lib/hub/config-sync.js'
import { computeRevision } from '../lib/hub/stable-hash.js'
import { NODE_TO_HUB } from '../lib/protocol.js'
import { E2E_MARKER } from '../lib/e2e.js'

const KEY = 'sk-ack-LEAK-0123456789'
const BASE = 'https://private.example/v1'
const PAYLOAD = () => ({
  providers: [{ id: 'alpha', api: 'openai-completions', baseURL: BASE, apiKeyEnv: 'ALPHA_KEY', apiKey: KEY, models: [{ id: 'm1', name: 'M1' }] }],
  defaultModel: 'alpha/m1',
})
const fakeE2E = () => ({ sealFrame: (_type, _id, d) => ({ e2e: E2E_MARKER, inner: d }) })

function setup() {
  const logs = []
  const log = (level, msg, meta) => logs.push({ level, msg, meta })
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: fakeE2E() })
  const sync = createConfigSync({ registry, source: PAYLOAD, log })
  registry.on('configSyncRequest', (ev) => sync.handleSyncRequest(ev))
  const push = () => registry.handleFrameFor('n1', { t: NODE_TO_HUB.CONFIG_SYNC_REQUEST, d: { appliedRevision: 0 } })
  const ack = (d) => registry.handleFrameFor('n1', { t: NODE_TO_HUB.CONFIG_ACK, d })
  const ackLogs = () => logs.filter((l) => /node (rejected|applied) config/.test(l.msg))
  return { registry, sync, logs, push, ack, ackLogs, revision: computeRevision(PAYLOAD()) }
}

test('ACK-1: a refused push is a warn with the node, the revision that was pushed and the error code', () => {
  const w = setup()
  w.push()
  w.ack({ ok: false, error: 'patch-existing-invalid', rollbackRevision: 7, schema: 2 })
  const [entry, ...rest] = w.ackLogs()
  assert.equal(rest.length, 0)
  assert.equal(entry.level, 'warn')
  assert.equal(entry.msg, 'config-sync: node rejected config')
  assert.deepEqual(entry.meta, { nodeId: 'n1', revision: w.revision, error: 'patch-existing-invalid' }, 'exactly these three fields')
})

test('ACK-2: the detail behind the code, the field path and everything else in the receipt never reach the log', () => {
  const w = setup()
  w.push()
  w.ack({ ok: false, error: `merge-failed: bad value ${KEY} at ${BASE} line 4`, path: 'plugins[0].config.baseURL', rollbackRevision: 7, schema: 2, extra: BASE })
  const [entry] = w.ackLogs()
  assert.equal(entry.meta.error, 'merge-failed')
  const everything = JSON.stringify(w.logs)
  for (const secret of [KEY, BASE, 'private.example', 'plugins[0]', 'line 4']) assert.ok(!everything.includes(secret), `the log leaks ${secret}`)
})

test('ACK-3: an error that is not a plain code is logged as "unknown", never as the text it came with', () => {
  const w = setup()
  w.push()
  for (const error of [undefined, 42, { message: KEY }, 'x'.repeat(500), 'Has Spaces', `${KEY}`, '']) w.ack({ ok: false, error })
  const entries = w.ackLogs()
  assert.equal(entries.length, 7)
  for (const e of entries) assert.equal(e.meta.error, 'unknown')
  assert.ok(!JSON.stringify(w.logs).includes(KEY))
})

test('ACK-4: an applied push is an info line with the revision; a stale receipt says nothing', () => {
  const w = setup()
  w.push()
  w.ack({ ok: true, appliedRevision: w.revision, shouldRestart: false, schema: 2 })
  w.ack({ ok: true, appliedRevision: w.revision, stale: true, schema: 2 })
  const entries = w.ackLogs()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].level, 'info')
  assert.deepEqual(entries[0].meta, { nodeId: 'n1', revision: w.revision })
})

test('ACK-5: a receipt for a push this hub never made is still logged, with revision null', () => {
  const w = setup()
  w.ack({ ok: false, error: 'snapshot-failed: disk', rollbackRevision: 0 })
  assert.deepEqual(w.ackLogs().map((e) => e.meta), [{ nodeId: 'n1', revision: null, error: 'snapshot-failed' }])
})

test('ACK-6: the revision is the last one pushed to THAT node', () => {
  const w = setup()
  w.registry.nodes.set('n2', { nodeId: 'n2', online: true, lastSeen: 0, e2e: fakeE2E() })
  w.push()
  w.registry.handleFrameFor('n2', { t: NODE_TO_HUB.CONFIG_ACK, d: { ok: false, error: 'plugin-not-allowed' } })
  w.ack({ ok: false, error: 'plugin-not-allowed' })
  const [n2, n1] = w.ackLogs().map((e) => e.meta)
  assert.deepEqual(n2, { nodeId: 'n2', revision: null, error: 'plugin-not-allowed' })
  assert.deepEqual(n1, { nodeId: 'n1', revision: w.revision, error: 'plugin-not-allowed' })
})
