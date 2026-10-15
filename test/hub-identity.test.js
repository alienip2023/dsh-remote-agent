/**
 * P2-11 hub 侧接线测试：welcome 带 identity / relay 追发 hub/identity /
 * 配对码带指纹（encode/decode/expand 三段）。
 *
 * 测试基建用最小假件（不 import 生产测试工具）：假 conn 只需 send/close，
 * 假 relay 链路只需 ready/send —— NodeRegistry.send 的两条下行路径都能被
 * 真实触发，而不是 mock 出来的一致性幻觉。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadOrCreateHubIdentity, verifyIdentity } from '../lib/identity.js'
import { HUB_TO_NODE, PROTOCOL_VERSION } from '../lib/protocol.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { decodePairCode, encodePairCode, expandPairConfig } from '../lib/pairing.js'
import { buildWorkerYaml } from '../lib/setup.js'

/* ───────────────────────── 测试基建 ───────────────────────── */

const HELLO = {
  nodeId: 'node-01',
  protocol: PROTOCOL_VERSION,
  os: 'windows',
  arch: 'x64',
  hostname: 'DESKTOP-ABC',
  dshVersion: '0.2.0',
  shells: ['pwsh'],
  roots: ['D:\\work'],
  caps: ['fs', 'exec'],
  profile: 'worker',
  agentMode: true,
  nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  time: Date.now(),
}

/** 假直连 socket：捕获下行文本帧。 */
function fakeConn() {
  const frames = []
  return {
    frames,
    closed: false,
    send: (text) => frames.push(JSON.parse(text)),
    close: (code) => {
      frames.push({ __closed: code })
    },
  }
}

/** 假中继链路：ready 时 send 走这里，捕获 (to, 帧原文)。 */
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

function tmpIdentity(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hubid-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return loadOrCreateHubIdentity(path.join(dir, 'hub-identity.json'))
}

function registryWith(identity) {
  return new NodeRegistry({ log: () => {}, identity })
}

/* ───────────────────────── welcome 身份帧（direct） ───────────────────────── */

test('direct 握手：welcome 携带身份证明，签名可用 hello 的 nonce 验过', (t) => {
  const id = tmpIdentity(t)
  const registry = registryWith(id)
  const conn = fakeConn()
  const rec = registry.ingestHello({ helloData: { ...HELLO }, conn, transport: 'direct', pending: undefined })
  assert.ok(rec, 'hello 必须被接受')

  const welcome = conn.frames.find((f) => f.t === HUB_TO_NODE.WELCOME)
  assert.ok(welcome, '必须发出 welcome')
  const identity = welcome.d.identity
  assert.ok(identity, 'welcome 必须带 identity')
  assert.equal(identity.fp, id.fingerprint, '指纹必须是 hub 自己的')
  assert.equal(identity.nonce, HELLO.nonce, '签名必须用副机 hello 带来的 nonce（防重放）')
  assert.equal(
    verifyIdentity(identity.pub, { fingerprint: identity.fp, nodeId: rec.nodeId, nonce: identity.nonce, at: identity.at }, identity.sig),
    true,
    '副机视角：验签必须通过',
  )
})

test('direct 握手：hello 不带 nonce（旧版副机）→ hub 自拟 32 位 hex，签名仍可验', (t) => {
  const id = tmpIdentity(t)
  const registry = registryWith(id)
  const conn = fakeConn()
  const { nonce: _drop, ...legacyHello } = HELLO
  registry.ingestHello({ helloData: legacyHello, conn, transport: 'direct', pending: undefined })
  const identity = conn.frames.find((f) => f.t === HUB_TO_NODE.WELCOME)?.d.identity
  assert.ok(identity)
  assert.match(identity.nonce, /^[0-9a-f]{32}$/, 'hub 必须自拟 nonce')
  assert.equal(
    verifyIdentity(identity.pub, { fingerprint: identity.fp, nodeId: 'node-01', nonce: identity.nonce, at: identity.at }, identity.sig),
    true,
  )
})

test('direct 握手：无身份能力（旧版 hub 行为）→ welcome 不带 identity，不抛', (t) => {
  const registry = registryWith(null)
  const conn = fakeConn()
  registry.ingestHello({ helloData: { ...HELLO }, conn, transport: 'direct', pending: undefined })
  const welcome = conn.frames.find((f) => f.t === HUB_TO_NODE.WELCOME)
  assert.ok(welcome, 'welcome 照发')
  assert.equal(welcome.d.identity, undefined, '不携带 identity 字段')
  assert.equal(welcome.d.limits.heartbeatMs > 0, true, 'limits 等既有字段不受影响')
})

test('direct 握手：身份对象损坏 → 签名失败被吞，welcome 不带 identity 且不抛', (t) => {
  const registry = registryWith({ privateKeyB64: '!!!garbage!!!', publicKeyB64: 'x', fingerprint: 'hubfp1-' + 'A'.repeat(22) })
  const conn = fakeConn()
  registry.ingestHello({ helloData: { ...HELLO }, conn, transport: 'direct', pending: undefined })
  const welcome = conn.frames.find((f) => f.t === HUB_TO_NODE.WELCOME)
  assert.ok(welcome, '接入路径不受身份子系统故障影响')
  assert.equal(welcome.d.identity, undefined)
})

/* ───────────────────────── hub/identity 追发（relay） ───────────────────────── */

test('relay 模式：ingestHello 后 hub 主动追发 hub/identity，签名可用摘要里的 nonce 验过', (t) => {
  const id = tmpIdentity(t)
  const registry = registryWith(id)
  const relay = fakeRelay()
  registry.attachRelay(relay)

  registry.ingestHello({ helloData: { ...HELLO }, conn: undefined, transport: 'relay', pending: undefined })

  const sent = relay.sent.find((s) => s.frame.t === HUB_TO_NODE.IDENTITY)
  assert.ok(sent, '必须经中继追发 hub/identity')
  assert.equal(sent.nodeId, 'node-01', '路由目标必须是该节点')
  assert.equal(sent.frame.to, 'node-01', '信封必须带 to（中继寻址依据）')
  const identity = sent.frame.d
  assert.equal(identity.fp, id.fingerprint)
  assert.equal(identity.nonce, HELLO.nonce, 'relay 摘要透传的 nonce 必须被用于签名')
  assert.equal(
    verifyIdentity(identity.pub, { fingerprint: identity.fp, nodeId: 'node-01', nonce: identity.nonce, at: identity.at }, identity.sig),
    true,
  )
})

test('relay 模式：无身份能力 → 不发 hub/identity（旧版行为不变）', (t) => {
  const registry = registryWith(null)
  const relay = fakeRelay()
  registry.attachRelay(relay)
  registry.ingestHello({ helloData: { ...HELLO }, conn: undefined, transport: 'relay', pending: undefined })
  assert.equal(relay.sent.length, 0, '什么下行帧都不该有')
})

test('relay 链路未就绪 → 追发返回 false，不抛（靠 hub 重连后的 node/list 自愈）', (t) => {
  const id = tmpIdentity(t)
  const registry = registryWith(id)
  registry.attachRelay({ ready: false, sent: [], send: () => false, sendBinary: () => false })
  const rec = registry.ingestHello({ helloData: { ...HELLO }, conn: undefined, transport: 'relay', pending: undefined })
  assert.ok(rec, '登记不受链路影响')
})

/* ───────────────────────── 配对码带指纹 ───────────────────────── */

const FP = 'hubfp1-ZKBSPB6tLRXi8EqTDeSRlA'

test('配对码：hubFingerprint 进载荷、decode 原样取回、expandPairConfig 自动变 pinnedHubFingerprint', () => {
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', token: 'nt_x', nodeId: 'slave-pc', hubFingerprint: FP })
  const dec = decodePairCode(code)
  assert.equal(dec.ok, true)
  assert.equal(dec.payload.hubFingerprint, FP)

  const { config } = expandPairConfig({ pair: code, roots: ['D:\\work'] })
  assert.equal(config.pinnedHubFingerprint, FP, '展开后必须钉住')
  assert.equal(config.hubUrl, 'ws://192.168.1.10:19387/api/remote-agent/node')
})

test('配对码：显式配置优先 —— 用户手写了 pinnedHubFingerprint 就不覆盖', () => {
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', hubFingerprint: FP })
  const { config } = expandPairConfig({ pair: code, pinnedHubFingerprint: FP.replace('ZKB', 'AAA') })
  assert.equal(config.pinnedHubFingerprint, FP.replace('ZKB', 'AAA'))
})

test('配对码：指纹形态不合法就不进载荷；decode 收到坏指纹报结构化错误', () => {
  const bad = 'hubfp1-短'
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/x', hubFingerprint: bad })
  const dec = decodePairCode(code)
  assert.equal(dec.ok, true)
  assert.equal(dec.payload.hubFingerprint, undefined, '坏指纹整个不进载荷')

  // 手工构造一个载荷里带坏指纹的码（模拟被改过的码）
  const forged = 'dshra1://' + Buffer.from(JSON.stringify({ v: 1, hubUrl: 'ws://x', hubFingerprint: 'hubfp1-' + '!'.repeat(22) }), 'utf8').toString('base64url')
  const dec2 = decodePairCode(forged)
  assert.equal(dec2.ok, false)
  assert.match(dec2.error, /hubFingerprint/)
})

test('配对码：不带指纹的旧码照常工作（向后兼容）', () => {
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/x', token: 'nt_x' })
  const { config } = expandPairConfig({ pair: code })
  assert.equal(config.pinnedHubFingerprint, undefined)
  assert.equal(config.hubUrl, 'ws://192.168.1.10:19387/x')
})

/* ───────────────────────── buildWorkerYaml 指纹行 ───────────────────────── */

test('buildWorkerYaml：pinnedHubFingerprint 非空才输出一行；为空不输出', () => {
  const withFp = buildWorkerYaml({ hubUrl: 'ws://192.168.1.10:19387/x', pinnedHubFingerprint: FP })
  assert.match(withFp, /pinnedHubFingerprint: hubfp1-ZKBSPB6tLRXi8EqTDeSRlA/)

  const withoutFp = buildWorkerYaml({ hubUrl: 'ws://192.168.1.10:19387/x' })
  assert.doesNotMatch(withoutFp, /pinnedHubFingerprint/)

  const pairMode = buildWorkerYaml({ pair: 'dshra1://AAA', pinnedHubFingerprint: FP })
  assert.match(pairMode, /pair: dshra1:\/\/AAA/)
  assert.match(pairMode, /pinnedHubFingerprint: /, 'pair 模式下显式指纹也照输出（显式配置优先于码内指纹）')
})
