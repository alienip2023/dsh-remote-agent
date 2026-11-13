/**
 * §61 真机复验：relay 部署下 S2 的能力宣告不生效。
 *
 * relay 模式没有 welcome，hub 的 caps 只能搭在追发的 hub/identity 上；而节点
 * 在 identity 之前已 markOnline 并跑过一次 memoryLink.online()（hubCaps 为空，
 * 被 blocked）。这里钉住整条修复：identity 带 caps → 节点记下 → 重发 mem/hello，
 * 而旧 hub（identity 不带 caps）保持零帧。
 *
 * 用真 NodeRegistry 签发身份帧、真 NodeTransport 处理帧、真 memoryLink 发送，
 * 只有底层 socket 是捕获帧的假件。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadOrCreateHubIdentity, verifyIdentity } from '../lib/identity.js'
import {
  HUB_CAPS,
  HUB_TO_NODE,
  MEMORY,
  MEMORY_CAPS,
  PROTOCOL_VERSION,
  RELAY_FRAME,
  decodeFrame,
} from '../lib/protocol.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { NodeTransport } from '../lib/node/transport.js'
import { attachCapsAnnounce, createMemoryLink } from '../lib/node/memory-link.js'

const NODE_ID = 'node-01'
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const HELLO = {
  nodeId: NODE_ID,
  protocol: PROTOCOL_VERSION,
  os: 'linux',
  arch: 'x64',
  hostname: 'relay-node',
  dshVersion: '0.10.1',
  shells: ['bash'],
  roots: ['/tmp'],
  caps: ['exec'],
  profile: 'worker',
  agentMode: true,
  nonce: NONCE,
  time: Date.now(),
}

function tmpIdentity(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-relay-caps-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return loadOrCreateHubIdentity(path.join(dir, 'hub-identity.json'))
}

/** 假中继链路：捕获 registry 下行的 (to, 帧)。 */
function fakeRelay() {
  const sent = []
  return {
    ready: true,
    sent,
    send: (nodeId, text) => {
      sent.push({ nodeId, frame: JSON.parse(text) })
      return true
    },
    sendBinary: () => false,
  }
}

/** 真 registry 走 relay 上线 → 返回它追发的 hub/identity 载荷。 */
function identityPayload(t, identity, hello = HELLO) {
  const registry = new NodeRegistry({ log: () => {}, identity })
  const relay = fakeRelay()
  registry.attachRelay(relay)
  registry.ingestHello({ helloData: { ...hello }, conn: undefined, transport: 'relay', pending: undefined })
  const sent = relay.sent.find((s) => s.frame.t === HUB_TO_NODE.IDENTITY)
  assert.ok(sent, 'relay 上线后必须追发 hub/identity')
  return sent.frame.d
}

/** 假 socket：send 收协议文本，解出帧。 */
function fakeConn() {
  const frames = []
  const conn = {
    frames,
    closed: false,
    send: (text) => {
      const decoded = decodeFrame(text)
      frames.push(decoded.ok === false ? null : decoded.frame)
      return true
    },
    close: () => { conn.closed = true },
  }
  return conn
}

/**
 * 节点侧的真组合：NodeTransport + 真 memoryLink + 生产用的 caps 接线。
 * online 走与 lib/node/index.js 相同的顺序（bind → online）。
 */
function startNodeSide(t, o = {}) {
  const transport = new NodeTransport({
    mode: o.mode ?? 'relay',
    url: o.url ?? 'ws://127.0.0.1:1/relay',
    token: 'test-token',
    hello: { ...HELLO },
    e2e: false,
    pinStore: null,
  })
  const conn = fakeConn()
  transport.conn = conn
  const link = createMemoryLink({
    send: (type, data) => transport.send(type, data),
    nodeId: NODE_ID,
    hubCaps: () => transport.hubCaps,
    e2eReady: () => false,
    appliedSeq: () => 7,
  })
  const capsEvents = []
  transport.on('caps', (caps) => capsEvents.push(caps))
  attachCapsAnnounce(transport, link)
  transport.on('online', () => {
    link.bind(NODE_ID)
    link.online()
  })
  t.after(() => transport.stop())
  const hellos = () => conn.frames.filter((f) => f?.t === MEMORY.HELLO)
  return { transport, conn, link, capsEvents, hellos }
}

/* ───────── hub 侧：relay 的 identity 帧必须带 caps ───────── */

test('RMC-hub: relay 的 hub/identity 带 caps，签名仍然用 hello 的 nonce 验得过', (t) => {
  const identity = tmpIdentity(t)
  const payload = identityPayload(t, identity)
  assert.deepEqual(payload.caps, [...HUB_CAPS], 'caps 必须是 hub 的完整能力表')
  assert.ok(payload.caps.includes(MEMORY_CAPS), 'relay 没有 welcome，能力只能走这里')
  assert.equal(payload.fp, identity.fingerprint)
  assert.equal(payload.nonce, NONCE, '签名仍绑定本次连接的 nonce')
  assert.equal(
    verifyIdentity(payload.pub, { fingerprint: payload.fp, nodeId: NODE_ID, nonce: payload.nonce, at: payload.at }, payload.sig),
    true,
    'caps 是签名外的声明，不能破坏身份验签',
  )
})

/* ───────── 节点侧：relay 先 blocked，identity 到了再发 hello ───────── */

test('RMC-relay: hello 先 blocked；identity 带 caps 后 hubCaps 生效并真正发出 mem/hello', (t) => {
  const identity = tmpIdentity(t)
  const payload = identityPayload(t, identity)
  const { transport, link, capsEvents, hellos } = startNodeSide(t)

  transport.handleFrame({ t: RELAY_FRAME.HELLO_NODE, d: { accepted: true, nodeId: NODE_ID } })
  assert.equal(transport.online, true, 'relay 的 accepted 必须先让节点上线')
  assert.deepEqual(transport.hubCaps, [], 'identity 之前没有任何能力来源')
  assert.equal(link.stats.blocked, 1, '第一次 online() 必须被 memory-sync/1 闸门挡住')
  assert.equal(hellos().length, 0, '没有能力就不发记忆帧')

  transport.handleFrame({ t: HUB_TO_NODE.IDENTITY, d: payload })

  assert.deepEqual(transport.hubCaps, [...HUB_CAPS])
  assert.deepEqual(capsEvents, [[...HUB_CAPS]])
  const sent = hellos()
  assert.equal(sent.length, 1, '能力到达后必须补一次 mem/hello')
  assert.equal(sent[0].d.nodeId, NODE_ID, 'payload.nodeId 由连接身份覆盖')
  assert.equal(sent[0].d.appliedSeq, 7, 'appliedSeq 来自真实缓存读取')
})

test('RMC-old-hub: identity 不带 caps → hubCaps 仍为空、不重发 hello、零 mem 帧', (t) => {
  const identity = tmpIdentity(t)
  const payload = identityPayload(t, identity)
  const legacy = { ...payload }
  delete legacy.caps
  const { transport, link, capsEvents, hellos } = startNodeSide(t)

  transport.handleFrame({ t: RELAY_FRAME.HELLO_NODE, d: { accepted: true, nodeId: NODE_ID } })
  transport.handleFrame({ t: HUB_TO_NODE.IDENTITY, d: legacy })

  assert.deepEqual(transport.hubCaps, [], '旧 hub 的能力表必须保持为空')
  assert.deepEqual(capsEvents, [], '没有 caps 就没有 caps 事件')
  assert.equal(link.stats.blocked, 1, '仍然只有第一次 online() 被挡')
  assert.equal(hellos().length, 0, '旧 hub 一个记忆帧都不该收到')
})

test('RMC-dedupe: 重播同一张 identity（hub 重连后重发目录）不会重复发 hello', (t) => {
  const identity = tmpIdentity(t)
  const payload = identityPayload(t, identity)
  const { transport, capsEvents, hellos } = startNodeSide(t)

  transport.handleFrame({ t: RELAY_FRAME.HELLO_NODE, d: { accepted: true, nodeId: NODE_ID } })
  transport.handleFrame({ t: HUB_TO_NODE.IDENTITY, d: payload })
  transport.handleFrame({ t: HUB_TO_NODE.IDENTITY, d: { ...payload } })

  assert.equal(hellos().length, 1, '能力没变化就不重发')
  assert.equal(capsEvents.length, 1, 'caps 事件只在变化时发')
})

/* ───────── direct：welcome 带 caps 的既有路径不变 ───────── */

test('RMC-direct: welcome 的 caps 仍在上线时生效，并立刻发 hello', (t) => {
  const { transport, link, hellos } = startNodeSide(t, { mode: 'direct', url: 'ws://127.0.0.1:1/x' })

  transport.handleFrame({
    t: 'welcome',
    d: { protocol: PROTOCOL_VERSION, nodeId: NODE_ID, limits: {}, caps: [...HUB_CAPS], serverTime: Date.now() },
  })

  assert.deepEqual(transport.hubCaps, [...HUB_CAPS], 'direct 的 welcome 仍是能力来源')
  assert.equal(link.stats.blocked, 0, 'direct 上线时能力已在，不该被挡')
  assert.equal(hellos().length, 1, 'online() 当场发 hello')
})
