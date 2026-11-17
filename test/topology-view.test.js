import test from 'node:test'
import assert from 'node:assert/strict'
import * as views from '../lib/hub/views.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'

const forbidden = ['peerUrl', 'peerSecret', 'hello', 'resource', 'roots']
function privateFields() {
  return Object.fromEntries(forbidden.map(key => [key, `PRIVATE-${key}`]))
}
function noPrivate(value) {
  const json = JSON.stringify(value)
  for (const key of forbidden) {
    assert.ok(!json.includes(`"${key}"`), `leaked key ${key}`)
    assert.ok(!json.includes(`PRIVATE-${key}`), `leaked value ${key}`)
  }
}
const rows = () => [
  { nodeId: 'd', online: false, peerCapable: true, connectivity: { transportMode: 'direct', tunnelState: 'ready' } },
  { nodeId: 'c', online: true, peerCapable: false },
  { nodeId: 'b', online: true, peerCapable: true, connectivity: { transportMode: 'relay', tunnelState: 'error', sampledAt: NaN } },
  { nodeId: 'a', online: true, peerCapable: true, connectivity: { transportMode: 'direct', tunnelState: 'ready', sampledAt: 123 } },
]

test('G1 nodeView: missing and malformed connectivity degrade silently', () => {
  for (const connectivity of [undefined, null, false, 12, 'bad', []]) {
    assert.equal(views.nodeView({ connectivity }).connectivity, null)
  }
  const defaults = { transportMode: null, tunnelState: null, tunnel: null, probes: [], sampledAt: null }
  assert.deepEqual(views.nodeView({ connectivity: {} }).connectivity, defaults)
  assert.deepEqual(views.nodeView({ connectivity: {
    transportMode: 'bad', tunnelState: 'weird', tunnel: 'bad', probes: {}, sampledAt: NaN,
  } }).connectivity, defaults)
  assert.equal(views.nodeView({ peerCapable: 'true' }).peerCapable, false)
  assert.equal(views.nodeView({ peerCapable: true }).peerCapable, true)
})

test('G1 nodeView: projects bounded tunnel/probes and finite numbers', () => {
  const c = views.nodeView({ connectivity: {
    transportMode: 'relay', tunnelState: 'configured', sampledAt: 123,
    tunnel: { kind: 'k'.repeat(20), server: 's'.repeat(130), localPort: '80', remotePort: Infinity },
    probes: [null, 7, {}, { target: 'x', result: 'open', rttMs: 4 },
      { target: 't'.repeat(130), result: 'bad', rttMs: 'x' },
      { target: 'c', result: 'closed' }, { target: 'd', result: 'timeout', rttMs: NaN },
      { target: 'e', result: 'open' }, { target: 'discard', result: 'open' }],
  } }).connectivity
  assert.equal(c.transportMode, 'relay')
  assert.equal(c.tunnelState, 'configured')
  assert.equal(c.sampledAt, 123)
  assert.deepEqual(c.tunnel, { kind: 'k'.repeat(16), server: 's'.repeat(120), localPort: null, remotePort: null })
  assert.equal(c.probes.length, 5)
  assert.deepEqual(c.probes[0], { target: 'x', result: 'open', rttMs: 4 })
  assert.deepEqual(c.probes[1], { target: 't'.repeat(120), result: 'timeout', rttMs: null })
  assert.equal(views.nodeView({ connectivity: { probes: Array.from({ length: 12 }, () => ({ target: 'x' })) } }).connectivity.probes.length, 8)
  assert.deepEqual(views.nodeView({ connectivity: { tunnel: { localPort: 80, remotePort: 90 } } }).connectivity.tunnel,
    { kind: '', server: '', localPort: 80, remotePort: 90 })
})

test('G2 nodeView: connectivity never exposes private keys or values at any depth', () => {
  const n = views.nodeView({ ...privateFields(), connectivity: {
    ...privateFields(), tunnel: privateFields(), probes: [{ target: 'safe', ...privateFields() }],
  } })
  // Existing node resource/roots contracts are checked separately by UI route tests.
  noPrivate(n.connectivity)
  for (const key of ['peerUrl', 'peerSecret', 'hello']) assert.ok(!(key in n))
})

test('G3 topologyView: offline nodes cannot form ghost peers; summary and links are exact', () => {
  const topology = views.topologyView(rows())
  assert.deepEqual(topology.nodes.map(n => n.nodeId), ['a', 'b', 'c', 'd'])
  assert.deepEqual(topology.peerLinks, [{ from: 'a', to: 'b' }])
  assert.deepEqual(topology.links, ['a', 'b', 'c', 'd'].map(to => ({ from: '@hub', to, kind: 'hub' })))
  assert.deepEqual(topology.summary, { total: 4, online: 3, direct: 2, relay: 1, unknown: 1, peerCapable: 2, tunnelReady: 2, tunnelError: 1 })
  assert.deepEqual(topology.nodes[0], { nodeId: 'a', online: true, transport: 'direct', tunnelState: 'ready', peerCapable: true, sampledAt: 123 })
  assert.equal(topology.nodes[1].sampledAt, null)
  assert.deepEqual(views.topologyView(rows().reverse()), topology)
})

test('G3 topologyView: caps stable peer pairs at 60 and handles empty/invalid data', () => {
  const nodes = Array.from({ length: 15 }, (_, i) => ({ nodeId: String(i).padStart(2, '0'), online: true, peerCapable: true }))
  const expected = nodes.flatMap((n, i) => nodes.slice(i + 1).map(m => ({ from: n.nodeId, to: m.nodeId }))).slice(0, 60)
  assert.deepEqual(views.topologyView(nodes.reverse()).peerLinks, expected)
  for (const input of [undefined, null, {}, [], [null, 1, 'bad']]) assert.equal(views.topologyView(input).nodes.length, 0)
  const invalid = views.topologyView([{ nodeId: 'x', online: 'true', peerCapable: 1, connectivity: { transportMode: 'weird', tunnelState: 'bad', sampledAt: NaN } }])
  assert.deepEqual(invalid.nodes[0], { nodeId: 'x', online: false, transport: null, tunnelState: null, peerCapable: false, sampledAt: null })
})

test('G3 registry.list: peerCapable requires strict online and nonempty string address', () => {
  const records = [
    { online: true, hello: { peerUrl: 'http://peer' } },
    { online: false, hello: { peerUrl: 'http://peer' } },
    { online: true, hello: { peerUrl: '' } },
    { online: true, hello: { peerUrl: 123 } },
    { online: 1, hello: { peerUrl: 'http://peer' } },
    { online: true },
  ].map((r, i) => ({ ...r, nodeId: String(i), tasks: new Map() }))
  const listed = NodeRegistry.prototype.list.call({ nodes: new Map(records.map(r => [r.nodeId, r])) })
  assert.deepEqual(listed.map(n => n.peerCapable), [true, false, false, false, false, false])
})

test('G4 topologyView: output never exposes internal objects or values', () => {
  noPrivate(views.topologyView([{ nodeId: 'safe', online: true, peerCapable: true,
    ...privateFields(), connectivity: { ...privateFields(), tunnel: privateFields() } }]))
})
