/**
 * 协议黄金向量（2026-10-15，评估报告 P0-1）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件为什么存在
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 竞品 ds-harness-remote 用 `fixtures/crypto/v1/noise-ik.json` 把它的
 * Noise IK 握手钉成跨实现黄金向量；我们的自研 ws / 二进制帧协议此前只有
 * **行为测试**（往返语义对），没有**字节测试**（线上字节对）。行为测试
 * 挡不住"重构时悄悄改一个字节序/长度档位/错误字符串"—— 那种改动在所有
 * 往返测试里都是绿的，直到某天对上真客户端。
 *
 * 所以这里的纪律是：
 *   1. 所有期望字节**手写计算**，helper 不 import 任何生产代码
 *      （`rawFrame` 独立实现，防止"用被测代码验证被测代码"）
 *   2. 能拿到跨实现锚点的（RFC 6455 规范示例值）一律用规范值
 *   3. 错误原因字符串当作契约锁：分类学漂移同样要让测试变红
 *   4. 分段不变性：TCP 分段时机不是协议保证，同样字节不同切法必须同果
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { WSConnection, acceptKey } from '../lib/ws.js'
import {
  PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  envelope,
} from '../lib/protocol.js'

/* ───────────────────────── 测试基建（不依赖生产代码） ───────────────────────── */

/** 假 socket：捕获写出的字节，提供 WSConnection 需要的全部方法。 */
function mockSocket() {
  const sock = new EventEmitter()
  sock.written = []
  sock.writableLength = 0
  sock.destroyed = false
  sock.write = (buf) => {
    sock.written.push(Buffer.from(buf))
    return true
  }
  sock.end = () => {}
  sock.destroy = () => {
    sock.destroyed = true
  }
  sock.setNoDelay = () => {}
  sock.setTimeout = () => {}
  return sock
}

/** 收集一条连接上收到的数据帧。 */
function collectMessages(conn) {
  const seen = []
  conn.on('message', (payload, isBinary) => {
    seen.push({ payload: Buffer.from(payload), isBinary })
  })
  return seen
}

/** 收集协议错误原因（WSConnection 把它包成 `ws protocol error: <reason>`）。 */
function collectErrors(conn) {
  const reasons = []
  conn.on('error', (err) => reasons.push(String(err.message)))
  return reasons
}

/**
 * 手写一个未掩码 WebSocket 帧 —— 刻意不 import lib/ws.js 的 encodeFrame。
 * 黄金向量的期望值必须独立于被测代码，否则只是循环论证。
 */
function rawFrame(fin, opcode, payload) {
  const head = [(fin ? 0x80 : 0x00) | opcode]
  const len = payload.length
  if (len < 126) {
    head.push(len)
  } else if (len < 65536) {
    head.push(126, (len >> 8) & 0xff, len & 0xff)
  } else {
    // 127 档：8 字节大端。测试载荷 < 4 GiB，高 4 字节恒 0。
    head.push(127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
  }
  return Buffer.concat([Buffer.from(head), payload])
}

/** 把一串 Buffer 按指定块大小切碎喂进连接（模拟 TCP 分段）。 */
function feedInChunks(conn, chunks, size) {
  if (!size) {
    for (const c of chunks) conn.socket.emit('data', c)
    return
  }
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += size) {
      conn.socket.emit('data', c.subarray(i, i + size))
    }
  }
}

/* ───────────────────────── 一、RFC 6455 跨实现锚点 ───────────────────────── */

test('黄金向量：Sec-WebSocket-Accept 取 RFC 6455 §1.3 规范示例值', (t) => {
  // RFC 6455 文档里的原始示例：该 key 的 accept 值在所有合规实现中必须一致。
  // 这是本文件里唯一"别人写的期望值"—— 改哈希算法/常量 GUID 立刻变红。
  assert.equal(
    acceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'acceptKey 必须与 RFC 6455 规范向量一致',
  )
})

/* ───────────────────────── 二、帧编码字节向量 ───────────────────────── */

test('黄金向量：未掩码帧编码（服务端方向）逐字节精确', (t) => {
  const sock = mockSocket()
  const conn = new WSConnection(sock, { mask: false })

  conn.send('Hello')
  assert.deepEqual(sock.written.at(-1), Buffer.from('810548656c6c6f', 'hex'), '短文本帧')

  conn.sendBinary(Buffer.from([0xde, 0xad, 0x00, 0xff]))
  assert.deepEqual(sock.written.at(-1), Buffer.from('8204dead00ff', 'hex'), '二进制帧 opcode=0x82')

  conn.ping()
  assert.deepEqual(sock.written.at(-1), Buffer.from('8900', 'hex'), 'ping 空载荷')

  // 126 档：载荷 200 字节 → 头部 82 7E 00C8（BINARY opcode=0x2）
  const p200 = Buffer.alloc(200, 0x41)
  conn.sendBinary(p200)
  const f200 = sock.written.at(-1)
  assert.deepEqual(f200.subarray(0, 4), Buffer.from('827e00c8', 'hex'), '126 档长度头')
  assert.equal(f200.length, 4 + 200)
  assert.ok(f200.subarray(4).equals(p200), '126 档净荷原样')

  // 127 档：载荷 70000 字节 → 头部 82 7F 00000000_00011170
  const p70k = Buffer.alloc(70000, 0x42)
  conn.sendBinary(p70k)
  const f70k = sock.written.at(-1)
  assert.deepEqual(f70k.subarray(0, 10), Buffer.from('827f0000000000011170', 'hex'), '127 档长度头')
  assert.equal(f70k.length, 10 + 70000)
  assert.ok(f70k.subarray(10).equals(p70k), '127 档净荷原样')

  // close 必须最后：它会把连接置 closed，之后 send 全部静默 no-op
  conn.close(1000, 'bye')
  // 88 | len=5 | code=0x03E8 | "bye"
  assert.deepEqual(sock.written.at(-1), Buffer.from('880503e8627965', 'hex'), 'close 帧带 code+reason')
})

test('黄金向量：掩码帧字节布局（客户端方向）', (t) => {
  const sock = mockSocket()
  const conn = new WSConnection(sock, { mask: true })

  conn.send('Hi')
  const f = sock.written.at(-1)
  assert.equal(f[0], 0x81, 'FIN+TEXT')
  assert.equal(f[1], 0x82, 'MASK 置位 + len=2')
  const key = f.subarray(2, 6)
  const masked = f.subarray(6)
  // 掩码必须是异或自逆：用帧内 key 解回原文 —— 锁"key 在头后、载荷 XOR key[i&3]"的布局
  const unmasked = Buffer.alloc(masked.length)
  for (let i = 0; i < masked.length; i += 1) unmasked[i] = masked[i] ^ key[i & 3]
  assert.equal(unmasked.toString('utf8'), 'Hi', '掩码载荷必须能用帧内 key 解开')
  assert.equal(f.length, 8, '掩码短帧总长 = 2 头 + 4 key + 2 载荷')
})

/* ───────────────────────── 三、解析器黄金向量 ───────────────────────── */

test('黄金向量：分片重组 —— 手写字节序列 → 单条完整消息', (t) => {
  const sock = mockSocket()
  const conn = new WSConnection(sock, { mask: false })
  const seen = collectMessages(conn)

  sock.emit(
    'data',
    Buffer.concat([
      rawFrame(false, 0x02, Buffer.from('AB')), // BINARY 首片
      rawFrame(false, 0x00, Buffer.from('CD')), // CONT 中片
      rawFrame(true, 0x00, Buffer.from('EF')), // CONT 末片
    ]),
  )

  assert.equal(seen.length, 1, '三片必须重组为一条消息')
  assert.equal(seen[0].isBinary, true, 'opcode 取首片')
  assert.equal(seen[0].payload.toString('utf8'), 'ABCDEF', '载荷按序拼接')
})

test('黄金向量：协议错误原因字符串是契约（分类学不许漂移）', (t) => {
  const cases = [
    ['rsv 置位', Buffer.from('c100', 'hex'), 'rsv-set'],
    ['裸 CONT（没有首片）', Buffer.from('0000', 'hex'), 'unexpected-continuation'],
    ['保留 opcode 0x3', Buffer.from('8300', 'hex'), 'bad-opcode'],
    // TEXT 声明 4MiB+1（127 档），只发 10 字节头部即触发 —— 不需要真发 4MiB
    ['TEXT 声明超控制帧上限', Buffer.from('817f0000000000400001', 'hex'), 'frame-too-large'],
  ]
  for (const [name, bytes, reason] of cases) {
    const sock = mockSocket()
    const conn = new WSConnection(sock, { mask: false })
    const errors = collectErrors(conn)
    sock.emit('data', bytes)
    assert.equal(errors.length, 1, `${name}：必须恰好一条协议错误`)
    assert.equal(errors[0], `ws protocol error: ${reason}`, `${name}：原因字符串锁定为 ${reason}`)
    assert.equal(sock.destroyed, true, `${name}：连接必须被销毁`)
  }
})

test('黄金向量：分片中途插入新数据帧 → interleaved-fragments', (t) => {
  const sock = mockSocket()
  const conn = new WSConnection(sock, { mask: false })
  const errors = collectErrors(conn)
  const seen = collectMessages(conn)

  sock.emit('data', rawFrame(false, 0x01, Buffer.from('part'))) // TEXT 首片，未完成
  sock.emit('data', rawFrame(true, 0x02, Buffer.from('!!'))) // 又来一个完整 BINARY
  assert.equal(seen.length, 0, '未完成分片期间不得吐出任何消息')
  assert.deepEqual(errors, ['ws protocol error: interleaved-fragments'])
})

test('黄金向量：分片累积上限是 4×单帧上限（边界值 33554433 触发）', (t) => {
  // fragBytes > MAX_ARTIFACT_FRAME_BYTES * 4（32 MiB）才判死。边界需要真实字节。
  // 注意 per-opcode 上限不同：CONT 帧走控制帧上限（4 MiB），所以后续分片
  // 必须是 4MiB 的 CONT，不能图省事全用 BINARY。
  const sock = mockSocket()
  const conn = new WSConnection(sock, { mask: false })
  const errors = collectErrors(conn)

  const bin = (n) => rawFrame(false, 0x02, Buffer.alloc(n, 0x5a))
  const cont = (fin, n) => rawFrame(fin, 0x00, Buffer.alloc(n, 0x5a))
  const M = 1024 * 1024

  sock.emit('data', bin(4 * M)) // 首片 BINARY 4 MiB
  for (let i = 0; i < 7; i += 1) sock.emit('data', cont(false, 4 * M)) // 7×CONT = 28 MiB
  assert.equal(errors.length, 0, '累计恰好 32 MiB（4+28）不判死')
  sock.emit('data', cont(true, 1)) // 第 9 片 1 字节 → 33554433 > 33554432
  assert.deepEqual(errors, ['ws protocol error: fragment-too-large'], '越界一个字节也必须判死')
  assert.equal(sock.destroyed, true)
})

test('黄金向量：分段不变性 —— 同样字节不同切法必须同果', (t) => {
  const bytes = Buffer.concat([
    rawFrame(true, 0x01, Buffer.from('{"t":"hello"}')),
    rawFrame(false, 0x02, Buffer.from('chunk-1')),
    rawFrame(false, 0x00, Buffer.from('chunk-2')),
    rawFrame(true, 0x00, Buffer.from('chunk-3')),
    Buffer.from('8900', 'hex'), // ping
  ])

  const run = (size) => {
    const sock = mockSocket()
    const conn = new WSConnection(sock, { mask: false })
    const seen = collectMessages(conn)
    const pings = []
    conn.on('ping', (p) => pings.push(p.length))
    feedInChunks(conn, [bytes], size)
    return {
      frames: seen.map((s) => `${s.isBinary ? 'B' : 'T'}:${s.payload.toString('utf8')}`),
      pings,
    }
  }

  const whole = run(0)
  assert.deepEqual(whole.frames, ['T:{"t":"hello"}', 'B:chunk-1chunk-2chunk-3'], '整块喂入的期望帧流')
  assert.deepEqual(whole.pings, [0], 'ping 必须被识别')
  // 1 字节 / 3 字节 / 13 字节切法 —— TCP 分段时机不是协议保证
  assert.deepEqual(run(1), whole, '逐字节喂入必须同果')
  assert.deepEqual(run(3), whole, '3 字节切法必须同果')
  assert.deepEqual(run(13), whole, '13 字节切法必须同果')
})

test('黄金向量：背靠背帧单 chunk 一次喂入，消费精确无残留', (t) => {
  const sock = mockSocket()
  const conn = new WSConnection(sock, { mask: false })
  const seen = collectMessages(conn)

  const a = rawFrame(true, 0x01, Buffer.from('first'))
  const b = rawFrame(true, 0x01, Buffer.from('second'))
  sock.emit('data', Buffer.concat([a, b]))

  assert.equal(seen.length, 2)
  assert.equal(seen[0].payload.toString(), 'first')
  assert.equal(seen[1].payload.toString(), 'second')
  assert.equal(conn.parser.buf.length, 0, '两个完整帧必须被完全消费，不残留半帧')
})

/* ───────────────────────── 四、二进制帧黄金向量 ───────────────────────── */

test('黄金向量：二进制帧 [u16 头长][头 JSON][净荷] 逐段精确', (t) => {
  const header = { v: 1, t: 'artifact/chunk', id: 'vec-1' }
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])
  const buf = encodeBinaryFrame(header, payload)

  const headJson = JSON.stringify(header)
  assert.equal(buf.readUInt16BE(0), Buffer.byteLength(headJson), '头部长度字段 = 头 JSON 字节数')
  assert.equal(
    buf.subarray(2, 2 + Buffer.byteLength(headJson)).toString('utf8'),
    headJson,
    '头部段必须是该 JSON 的 UTF-8 字节',
  )
  assert.ok(buf.subarray(2 + Buffer.byteLength(headJson)).equals(payload), '净荷段逐字节原样')
  assert.equal(buf.length, 2 + Buffer.byteLength(headJson) + payload.length, '总长度守恒')

  // 空净荷合法（心跳类帧）
  const empty = encodeBinaryFrame({ t: 'ping' }, Buffer.alloc(0))
  assert.deepEqual(decodeBinaryFrame(empty), { ok: true, header: { t: 'ping' }, payload: Buffer.alloc(0) })
})

test('黄金向量：二进制帧错误分类字符串是契约', (t) => {
  const cases = [
    ['空 Buffer', Buffer.alloc(0), 'binary-frame-too-short'],
    ['1 字节', Buffer.from('00', 'hex'), 'binary-frame-too-short'],
    ['头长超过实际', Buffer.from('00ff00', 'hex'), 'binary-frame-header-truncated'],
    ['头 JSON 畸形', Buffer.from('0003616263', 'hex'), 'binary-frame-header-malformed'],
    ['头不是对象', Buffer.from('0003313233', 'hex'), 'binary-frame-header-not-object'],
  ]
  for (const [name, buf, error] of cases) {
    const r = decodeBinaryFrame(buf)
    assert.equal(r.ok, false, `${name}：必须失败`)
    assert.equal(r.error, error, `${name}：错误字符串锁定为 ${error}`)
  }
  // 非 Buffer 输入同样走结构化失败，不抛
  assert.deepEqual(decodeBinaryFrame('not-a-buffer'), { ok: false, error: 'binary-frame-too-short' })
  assert.deepEqual(decodeBinaryFrame(null), { ok: false, error: 'binary-frame-too-short' })
})

test('黄金向量：二进制帧头部超 0xffff 必须明确失败（INTERNAL）', (t) => {
  const bigHeader = { pad: 'x'.repeat(70000) } // JSON 远超 65535 字节
  assert.throws(
    () => encodeBinaryFrame(bigHeader, Buffer.alloc(0)),
    (e) => e.code === 'internal' && /header too large/.test(e.message),
  )
})

/* ───────────────────────── 五、信封字段向量 ───────────────────────── */

test('黄金向量：envelope 字段名/顺序/版本号锁定', (t) => {
  const env = envelope('task/assign', { goal: 'x' }, { id: 'fixed-id' })
  // JSON.stringify 的键序 = 插入序：字段名或顺序漂移都会让这个字符串变化
  assert.equal(
    JSON.stringify(env),
    '{"v":1,"t":"task/assign","id":"fixed-id","d":{"goal":"x"}}',
    '信封序列化字节锁定',
  )
  assert.equal(env.v, PROTOCOL_VERSION, '版本字段必须等于 PROTOCOL_VERSION')

  const withReply = envelope('task/ack', {}, { id: 'a1', replyTo: 'm1' })
  assert.equal(
    JSON.stringify(withReply),
    '{"v":1,"t":"task/ack","id":"a1","d":{},"r":"m1"}',
    'replyTo 必须序列化为 r 且位于最后',
  )
})
