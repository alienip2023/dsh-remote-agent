/**
 * M4 S2：hub 侧摄入的身份与安全边界。
 *
 * 两条独立的防线，都在本文件里打真实行为：
 *   1. 摄入层：帧内自报的 nodeId 与连接身份不符 → 整帧丢弃（不写、不广播、
 *      不抛），只记一次 warn；坏帧 / 无 E2E / 超限同理。
 *   2. 传输层：真中继会把 node→hub 帧的 `from` 改写成**连接绑定的** nodeId，
 *      节点无法在信封上伪造来源。测试用真 relay + 真 WebSocket 发一帧带错
 *      `from` 的 mem/read，断言 hub 收到的是绑定值，并且把该帧交给摄入层时
 *      因载荷里的伪造 nodeId 被整帧丢弃。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MEMORY,
  PROTOCOL_VERSION,
  RELAY_FRAME,
  encodeFrame,
  envelope,
} from '../lib/protocol.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createRelay, newRelayToken } from '../lib/relay.js'
import { connect } from '../lib/ws.js'

const READ = { requestId: 'r-1', remoteBotId: 'bot-1', scope: 'bot', query: 'deploy' }
const WRITE = { requestId: 'r-2', remoteBotId: 'bot-1', scope: 'bot', op: 'add', text: 'remember' }

function registryWithLogs() {
  const logs = []
  const registry = new NodeRegistry({
    log: (level, code, extra) => logs.push({ level, code, extra }),
    relay: { ready: true, send: () => true },
  })
  const events = []
  for (const name of ['memoryHello', 'memoryRead', 'memoryWrite', 'memoryAck']) {
    registry.on(name, (payload) => events.push({ name, payload }))
  }
  // 认证连接上的已登记节点。e2e 用空对象表示会话已建立 —— 正文帧只要求
  // 「有会话」，加解密本身由 transport/e2e 层负责，不在这里重复实现。
  registry.nodes.set('n-1', { nodeId: 'n-1', lastSeen: 0, e2e: {} })
  return { registry, logs, events }
}

test('a well-formed memory frame from the bound node reaches its listener', () => {
  const { registry, events } = registryWithLogs()
  registry.handleFrameFor('n-1', { t: MEMORY.HELLO, d: { appliedSeq: 4, nodeId: 'n-1' } })
  registry.handleFrameFor('n-1', { t: MEMORY.READ, d: { ...READ, nodeId: 'n-1' } })
  registry.handleFrameFor('n-1', { t: MEMORY.WRITE, d: { ...WRITE, nodeId: 'n-1' } })
  registry.handleFrameFor('n-1', { t: MEMORY.ACK, d: { seq: 4 } })

  assert.deepEqual(events.map((e) => e.name), ['memoryHello', 'memoryRead', 'memoryWrite', 'memoryAck'])
  assert.equal(events[0].payload.appliedSeq, 4)
  assert.equal(events[1].payload.nodeId, 'n-1')
  assert.equal(events[1].payload.requestId, 'r-1')
  assert.equal(events[2].payload.op, 'add')
  assert.equal(events[3].payload.seq, 4)
})

test('a frame claiming another node is dropped whole, with a single warn', () => {
  const { registry, logs, events } = registryWithLogs()
  registry.handleFrameFor('n-1', { t: MEMORY.READ, d: { ...READ, nodeId: 'n-2' } })

  assert.deepEqual(events, [], 'an impersonated read must not be broadcast')
  assert.equal(registry.memoryDrops.identity, 1)
  const warns = logs.filter((l) => l.code === 'memory frame dropped')
  assert.equal(warns.length, 1, 'one frame, one warn')
  assert.equal(warns[0].extra.reason, 'identity')

  // hello 也走同一条身份口径
  registry.handleFrameFor('n-1', { t: MEMORY.HELLO, d: { appliedSeq: 1, nodeId: 'n-2' } })
  assert.equal(events.filter((e) => e.name === 'memoryHello').length, 0)
  assert.equal(registry.memoryDrops.identity, 2)
})

test('bad frames are dropped without throwing and counted as invalid', () => {
  const { registry, events } = registryWithLogs()
  for (const d of [null, 'mem/read', 42, [], {}, { requestId: 'r' }]) {
    assert.doesNotThrow(() => registry.handleFrameFor('n-1', { t: MEMORY.READ, d }))
  }
  assert.deepEqual(events, [])
  assert.equal(registry.memoryDrops.invalid, 6)
})

test('a body frame without an e2e session is refused', () => {
  const { registry, logs, events } = registryWithLogs()
  registry.nodes.set('n-2', { nodeId: 'n-2', lastSeen: 0 })
  registry.handleFrameFor('n-2', { t: MEMORY.READ, d: { ...READ, nodeId: 'n-2' } })

  assert.deepEqual(events, [])
  assert.equal(registry.memoryDrops.e2e, 1)
  assert.equal(logs.filter((l) => l.code === 'memory frame dropped').length, 1)
})

test('an oversized frame is dropped and counted, not parsed field by field', () => {
  const { registry, events } = registryWithLogs()
  const junk = 'x'.repeat(70 * 1024)
  registry.handleFrameFor('n-1', { t: MEMORY.HELLO, d: { appliedSeq: 0, nodeId: 'n-1', junk } })

  assert.deepEqual(events, [])
  assert.equal(registry.memoryDrops.oversize, 1)
})

/* ─────────────────────────── 真中继：from 不可伪造 ─────────────────────────── */

const HUB_TOKEN = newRelayToken('rt')
const ENROLL_TOKEN = newRelayToken('en')

function startRelay() {
  const relay = createRelay({ port: 0, host: '127.0.0.1', hubToken: HUB_TOKEN, enrollToken: ENROLL_TOKEN })
  return new Promise((resolve) => {
    relay.listen(() => resolve({ relay, base: `ws://127.0.0.1:${relay.address().port}/relay` }))
  })
}

function collect(conn) {
  const frames = []
  conn.on('error', () => {})
  conn.on('message', (payload, isBinary) => {
    if (isBinary) return
    try { frames.push(JSON.parse(payload.toString('utf8'))) } catch { /* relay noise */ }
  })
  return frames
}

async function waitFor(fn, label) {
  const started = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - started > 8000) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a real relay rewrites from to the bound node, and ingest then drops the forged payload', async (t) => {
  const { relay, base } = await startRelay()
  t.after(async () => {
    for (const n of [...relay.nodes.values()]) { try { n.conn.socket?.destroy?.() } catch { /* gone */ } }
    for (const h of [...relay.hubs]) { try { h.socket?.destroy?.() } catch { /* gone */ } }
    await Promise.race([relay.close(), new Promise((r) => setTimeout(r, 2000))])
  })

  const hub = await connect(`${base}?role=hub&token=${encodeURIComponent(HUB_TOKEN)}`, { name: 'mem-test-hub' })
  const hubFrames = collect(hub)
  const node = await connect(`${base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}&nodeId=node-r1`, { name: 'mem-test-node' })
  const nodeFrames = collect(node)
  node.on('error', () => {})
  hub.on('error', () => {})
  node.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, {
    nodeId: 'node-r1', protocol: PROTOCOL_VERSION, os: 'linux', arch: 'arm64',
    hostname: 'node-r1', shells: ['bash'], roots: ['/tmp'], caps: ['fs'], agentMode: true,
  })))
  await waitFor(() => relay.nodes.size === 1 && relay.hubs.size === 1, 'relay registration')
  await waitFor(() => nodeFrames.find((f) => f.t === RELAY_FRAME.HELLO_NODE)?.d?.accepted === true, 'node hello ack')
  hubFrames.length = 0

  // 节点在信封上伪造来源，载荷里也伪造 nodeId。
  node.send(encodeFrame({
    v: PROTOCOL_VERSION,
    t: MEMORY.READ,
    id: 'm-forged-1',
    from: 'forged-node',
    d: { ...READ, nodeId: 'forged-node' },
  }))

  const up = await waitFor(() => hubFrames.find((f) => f.t === MEMORY.READ), 'memory read forwarded')
  assert.equal(up.from, 'node-r1', 'the relay must overwrite from with the connection identity')
  assert.equal(up.d.nodeId, 'forged-node', 'the payload stays untouched for ingest to judge')

  // hub 侧摄入：载荷里的伪造身份与连接绑定不符 → 整帧丢弃。
  const { registry, events } = registryWithLogs()
  registry.nodes.set('node-r1', { nodeId: 'node-r1', lastSeen: 0, e2e: {} })
  registry.handleFrameFor('node-r1', up)
  assert.deepEqual(events, [])
  assert.equal(registry.memoryDrops.identity, 1)
})
