import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function layout(nodes, size) {
  let plugin
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(mod) {
      plugin = mod.factory(id => {
        assert.equal(id, 'react')
        return { createElement() {}, useState(v) { return [v, () => {}] }, useEffect() {},
          useRef(v) { return { current: v } }, useMemo(fn) { return fn() } }
      })
    } } }, console,
  }, { filename: 'lib/client.js' })
  assert.equal(typeof plugin.topologyLayout, 'function')
  return JSON.parse(JSON.stringify(plugin.topologyLayout(nodes, size)))
}
const nodes = () => [
  { nodeId: 'd', online: false, peerCapable: true },
  { nodeId: 'c', online: true, peerCapable: false },
  { nodeId: 'b', online: true, peerCapable: true, transport: 'relay', tunnelState: 'error' },
  { nodeId: 'a', online: true, peerCapable: true, connectivity: { transportMode: 'direct', tunnelState: 'ready' } },
]

test('G5 topologyLayout: stable sorting, geometry and explicit projection', () => {
  const input = nodes()
  const before = structuredClone(input)
  const result = layout(input, { width: 640, height: 200 })
  assert.deepEqual(result, layout(input, { width: 640, height: 200 }))
  assert.deepEqual(result, layout(nodes().reverse(), { width: 640, height: 200 }))
  assert.deepEqual(input, before)
  assert.deepEqual(result.hub, { x: 320, y: 34 })
  assert.deepEqual(result.nodes.map(n => n.nodeId), ['a', 'b', 'c', 'd'])
  assert.deepEqual(result.nodes[0], { nodeId: 'a', x: 128, y: 118, online: true, transport: 'direct', tunnelState: 'ready', peerCapable: true })
  assert.deepEqual(result.hubLinks[0], { nodeId: 'a', kind: 'hub', transport: 'direct' })
  assert.equal(result.rows, 1)
  const many = layout(Array.from({ length: 13 }, (_, i) => ({ nodeId: String(i) })))
  assert.equal(many.rows, 3)
  assert.ok(Object.values(Object.groupBy(many.nodes, n => n.y)).every(row => row.length <= 6))
  assert.equal(layout([]).rows, 0)
  assert.deepEqual(layout(null).nodes, [])
  const resized = layout(input, { width: 800, height: 400 })
  assert.equal(resized.hub.x, 400)
  assert.ok(resized.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y) && n.y < 400))
})

test('G6 topologyLayout: peers require both online and peerCapable; false means no peers', () => {
  const result = layout(nodes())
  assert.deepEqual(result.peerLinks, [{ from: 'a', to: 'b', x1: 128, y1: 118, x2: 256, y2: 118 }])
  assert.deepEqual(layout(nodes().map(n => ({ ...n, peerCapable: false }))).peerLinks, [])
  assert.deepEqual(layout(nodes().map(n => ({ ...n, online: false }))).peerLinks, [])
  assert.deepEqual(layout(nodes().map(n => ({ ...n, peerCapable: 'true' }))).peerLinks, [])
  const many = Array.from({ length: 15 }, (_, i) => ({ nodeId: String(i).padStart(2, '0'), online: true, peerCapable: true }))
  assert.equal(layout(many).peerLinks.length, 60)
  assert.deepEqual(layout(many.reverse()).peerLinks, layout(many).peerLinks)
})
