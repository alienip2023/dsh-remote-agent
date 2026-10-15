/**
 * WebSocket 实现单元测试（lib/ws.js，冻结层，只测不改）。
 *
 * 覆盖：
 *   - 本地 http server + acceptUpgrade 与 connect 往返
 *   - 文本帧 / 二进制帧 / ping-pong / close 全通
 *   - 超长帧被拒（> MAX_CONTROL_FRAME_BYTES），连接被 destroy 且不抛
 *   - 分片（continuation）重组正确
 *   - mask 方向正确：客户端发掩码帧、服务端不发掩码帧
 *   - 对端硬断（FIN 无 close 帧）触发 close 事件（captain 修复 3 的回归防线）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { MAX_CONTROL_FRAME_BYTES } from '../lib/protocol.js'
import { acceptUpgrade, acceptKey, connect } from '../lib/ws.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

/** 起一个本地 http server，upgrade 时交给 acceptUpgrade。 */
function startServer(t) {
  const conns = []
  const errors = []
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head, { name: 'test-server' })
    if (!conn) return
    // WSConnection 在 destroy 时会 emit 'error'；没有监听器会让 EventEmitter 抛。
    conn.on('error', (err) => errors.push(err))
    conns.push(conn)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        conns,
        errors,
        port: server.address().port,
        url: `ws://127.0.0.1:${server.address().port}/ws`,
        close: () =>
          new Promise((r) => {
            for (const c of conns) {
              try {
                c.socket?.destroy()
              } catch {
                /* 已断 */
              }
            }
            server.close(() => r())
          }),
      })
    })
  })
}

/**
 * 连一个客户端并**始终挂上 error 监听器**。
 *
 * 不做这一步会看到大量 "generated asynchronous activity after the test ended"
 * 的 ECONNRESET —— 清理阶段服务端 destroy socket，客户端侧 emit 'error'，
 * 没有监听器就会冒成 uncaughtException。
 */
async function connectClient(url, t, opts) {
  const conn = await connect(url, opts)
  const errors = []
  conn.on('error', (err) => errors.push(err))
  if (t) t.after(() => {
    try {
      conn.socket?.destroy()
    } catch {
      /* 已断 */
    }
  })
  conn.clientErrors = errors
  return conn
}

/** 等一个事件，带超时。 */
function once(emitter, evt, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(evt, onEvt)
      reject(new Error(`timeout waiting for '${evt}'`))
    }, timeoutMs)
    const onEvt = (...args) => {
      clearTimeout(timer)
      resolve(args)
    }
    emitter.once(evt, onEvt)
  })
}

/** 等条件成立（轮询），带超时。 */
async function waitFor(fn, { timeoutMs = 5000, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/* ─────────────────────────── 原始帧构造 ─────────────────────────── */

function buildFrame({ fin = true, opcode = OP.TEXT, payload = Buffer.alloc(0), mask = false, maskKey } = {}) {
  const len = payload.length
  const parts = []
  parts.push(Buffer.from([(fin ? 0x80 : 0x00) | opcode]))

  if (len < 126) {
    parts.push(Buffer.from([len | (mask ? 0x80 : 0)]))
  } else if (len < 65536) {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(len, 0)
    parts.push(Buffer.from([126 | (mask ? 0x80 : 0)]), b)
  } else {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(len), 0)
    parts.push(Buffer.from([127 | (mask ? 0x80 : 0)]), b)
  }

  if (!mask) {
    parts.push(payload)
    return Buffer.concat(parts)
  }
  const key = maskKey ?? randomBytes(4)
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ key[i & 3]
  parts.push(key, masked)
  return Buffer.concat(parts)
}

/** 原始 TCP 客户端：手工完成 WebSocket 握手，之后收发裸字节。 */
function rawConnect(port, path = '/ws') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    let handshaken = false
    const onData = (chunk) => {
      chunks.push(chunk)
      const buf = Buffer.concat(chunks)
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      if (handshaken) return
      handshaken = true
      socket.removeListener('data', onData)
      const head = buf.subarray(0, idx).toString('latin1')
      if (!/ 101 /.test(head.split('\r\n')[0])) {
        reject(new Error(`handshake rejected: ${head.split('\r\n')[0]}`))
        return
      }
      resolve({ socket, head, leftover: buf.subarray(idx + 4) })
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.on('connect', () => {
      const key = randomBytes(16).toString('base64')
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
  })
}

/* ─────────────────────────── 往返：文本 / 二进制 ─────────────────────────── */

test('acceptUpgrade + connect 往返：文本帧', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const client = await connectClient(srv.url, t, { name: 'test-client' })

  assert.equal(srv.conns.length, 1)
  const server = srv.conns[0]

  const got = once(server, 'message')
  client.send('hello 世界')
  const [payload, isBinary] = await got
  assert.equal(payload.toString('utf8'), 'hello 世界')
  assert.equal(isBinary, false)

  const got2 = once(client, 'message')
  server.send('reply ✓')
  const [payload2, isBinary2] = await got2
  assert.equal(payload2.toString('utf8'), 'reply ✓')
  assert.equal(isBinary2, false)
})

test('acceptUpgrade + connect 往返：二进制帧（含 NUL 与非 UTF-8 字节）', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const client = await connectClient(srv.url, t)
  const server = srv.conns[0]

  const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xfe, 0x00])
  const got = once(server, 'message')
  client.sendBinary(bytes)
  const [payload, isBinary] = await got
  assert.equal(isBinary, true)
  assert.equal(Buffer.compare(payload, bytes), 0)

  const got2 = once(client, 'message')
  server.sendBinary(bytes)
  const [payload2, isBinary2] = await got2
  assert.equal(isBinary2, true)
  assert.equal(Buffer.compare(payload2, bytes), 0)
})

test('握手：Sec-WebSocket-Accept 按 RFC 计算', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { head } = await rawConnect(srv.port)
  assert.match(head, /HTTP\/1\.1 101 Switching Protocols/)
  assert.match(head, /Upgrade: websocket/i)
  assert.match(head, /Sec-WebSocket-Accept: /i)
  // 独立复算一遍 accept key 的算法
  const expect = createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==' + GUID).digest('base64')
  assert.equal(expect, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), expect)
})

/* ─────────────────────────── ping / pong / close ─────────────────────────── */

test('ping/pong 双向都通', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const client = await connectClient(srv.url, t)
  const server = srv.conns[0]

  // 客户端 ping → 服务端收到 'ping' 并自动回 'pong'
  const serverPing = once(server, 'ping')
  const clientPong = once(client, 'pong')
  assert.equal(client.ping(), true)
  await serverPing
  await clientPong

  // 服务端 ping → 客户端收到 'ping' 并自动回 'pong'
  const clientPing = once(client, 'ping')
  const serverPong = once(server, 'pong')
  assert.equal(server.ping(), true)
  await clientPing
  await serverPong
})

test('close：客户端主动关闭 → 服务端 close 事件带 code/reason', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const client = await connectClient(srv.url, t)
  const server = srv.conns[0]

  const closed = once(server, 'close')
  client.close(1000, 'bye')
  const [code, reason] = await closed
  assert.equal(code, 1000)
  assert.equal(reason, 'bye')
  assert.equal(client.closed, true)
  assert.equal(server.closed, true)
})

test('对端硬断（FIN 无 close 帧）也触发 close 事件 —— 修复 3 回归防线', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  const closed = once(server, 'close', 8000)
  // 不做 close 握手，直接销毁 socket（模拟 kill -9 / 拔网线）
  socket.destroy()
  const [code] = await closed
  assert.equal(code, 1006, '硬断应报 1006')
  assert.equal(server.closed, true)
  assert.equal(server.parser.dead, true)
  // 服务端 socket 应被主动销毁，释放 fd
  await waitFor(() => server.socket.destroyed === true, { label: 'server socket destroyed' })
})

test('destroy(err) 触发 error 与 close，且不抛', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  await connectClient(srv.url, t)
  const server = srv.conns[0]

  const errP = once(server, 'error')
  const closeP = once(server, 'close')
  assert.doesNotThrow(() => server.destroy(new Error('boom')))
  const [err] = await errP
  assert.equal(err.message, 'boom')
  const [code] = await closeP
  assert.equal(code, 1006)
})

/* ─────────────────────────── 超长帧被拒 ─────────────────────────── */

test('超长控制帧（> MAX_CONTROL_FRAME_BYTES）被拒：连接 destroy 且不抛', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  const closeP = once(server, 'close', 8000)

  // 只发头部：声明一个超过上限的文本帧长度，净荷一个字节都不发。
  const declared = MAX_CONTROL_FRAME_BYTES + 1
  const header = Buffer.alloc(10)
  header[0] = 0x80 | OP.TEXT
  header[1] = 127
  header.writeBigUInt64BE(BigInt(declared), 2)

  assert.doesNotThrow(() => socket.write(header))

  const [code] = await closeP
  assert.equal(code, 1006)
  assert.equal(server.closed, true)
  assert.equal(srv.errors.length, 1, '应有一个协议错误，且被 error 监听器接住（未抛出）')
  assert.match(srv.errors[0].message, /frame-too-large/)
})

test('二进制帧上限更宽：> MAX_CONTROL_FRAME_BYTES 的 BINARY 仍可声明（不被误拒）', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  // 声明略超控制帧上限、但仍在产物帧上限内的二进制长度，然后补齐净荷
  const payload = Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 16, 0x41)
  const frame = buildFrame({ opcode: OP.BINARY, payload })
  const got = once(server, 'message', 8000)
  socket.write(frame)
  const [received, isBinary] = await got
  assert.equal(isBinary, true)
  assert.equal(received.length, payload.length)
  assert.equal(server.closed, false)
})

/* ─────────────────────────── 分片重组 ─────────────────────────── */

test('分片（continuation）重组正确：文本', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  const got = once(server, 'message')
  socket.write(buildFrame({ fin: false, opcode: OP.TEXT, payload: Buffer.from('part1-'), mask: true }))
  socket.write(buildFrame({ fin: false, opcode: OP.CONT, payload: Buffer.from('part2-'), mask: true }))
  socket.write(buildFrame({ fin: true, opcode: OP.CONT, payload: Buffer.from('part3'), mask: true }))

  const [payload, isBinary] = await got
  assert.equal(payload.toString('utf8'), 'part1-part2-part3')
  assert.equal(isBinary, false)
  // 只应产生一条完整消息
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(server.closed, false)
})

test('分片（continuation）重组正确：二进制', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  const a = Buffer.from([0x01, 0x02])
  const b = Buffer.from([0x03, 0xff])
  const got = once(server, 'message')
  socket.write(buildFrame({ fin: false, opcode: OP.BINARY, payload: a, mask: true }))
  socket.write(buildFrame({ fin: true, opcode: OP.CONT, payload: b, mask: true }))

  const [payload, isBinary] = await got
  assert.equal(isBinary, true)
  assert.equal(Buffer.compare(payload, Buffer.concat([a, b])), 0)
})

test('异常分片序列：先 CONT 后 TEXT → 协议错误并 destroy', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  const closeP = once(server, 'close', 8000)
  socket.write(buildFrame({ fin: true, opcode: OP.CONT, payload: Buffer.from('x'), mask: true }))
  const [code] = await closeP
  assert.equal(code, 1006)
  assert.match(srv.errors.map((e) => e.message).join('|'), /unexpected-continuation/)
})

test('分片未完成时插入新数据帧 → interleaved-fragments 错误', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  const closeP = once(server, 'close', 8000)
  socket.write(buildFrame({ fin: false, opcode: OP.TEXT, payload: Buffer.from('a'), mask: true }))
  socket.write(buildFrame({ fin: true, opcode: OP.TEXT, payload: Buffer.from('b'), mask: true }))
  await closeP
  assert.match(srv.errors.map((e) => e.message).join('|'), /interleaved-fragments/)
})

/* ─────────────────────────── mask 方向 ─────────────────────────── */

test('mask 方向：客户端发掩码帧、服务端不发掩码帧', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  // 1) 真实客户端 connect() → 服务端收到的原始字节必须带 mask 位
  const client = await connectClient(srv.url, t)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  const rawSeen = []
  const origPush = server.parser.push.bind(server.parser)
  server.parser.push = (chunk) => {
    rawSeen.push(Buffer.from(chunk))
    return origPush(chunk)
  }

  const got = once(server, 'message')
  client.send('masked?')
  await got

  assert.ok(rawSeen.length > 0, '服务端应收到字节')
  const first = rawSeen[0]
  assert.equal((first[1] & 0x80) !== 0, true, '客户端帧的 mask 位必须为 1')
  // 净荷在线上确实是掩码后的（与明文不同）
  const len = first[1] & 0x7f
  assert.equal(len, Buffer.byteLength('masked?', 'utf8'))
  const wire = first.subarray(2 + 4, 2 + 4 + len)
  assert.notEqual(wire.toString('utf8'), 'masked?')

  // 2) 服务端 send() → 原始客户端看到的字节 mask 位必须为 0
  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 2, { label: 'second server conn' })
  const server2 = srv.conns[1]

  const frames = []
  socket.on('data', (chunk) => frames.push(Buffer.from(chunk)))
  server2.send('plain')
  await waitFor(() => frames.length > 0 && Buffer.concat(frames).length >= 2 + 5, { label: 'server frame bytes' })

  const out = Buffer.concat(frames)
  assert.equal(out[0] & 0x0f, OP.TEXT)
  assert.equal((out[1] & 0x80) !== 0, false, '服务端帧的 mask 位必须为 0')
  assert.equal(out[1] & 0x7f, 5)
  assert.equal(out.subarray(2, 7).toString('utf8'), 'plain')
})

test('掩码帧解码正确（各种长度档位：<126 / 126 / 127）', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const { socket } = await rawConnect(srv.port)
  await waitFor(() => srv.conns.length === 1, { label: 'server conn' })
  const server = srv.conns[0]

  for (const size of [5, 200, 70000]) {
    const payload = Buffer.alloc(size, 0x5a)
    const got = once(server, 'message', 8000)
    socket.write(buildFrame({ opcode: OP.BINARY, payload, mask: true }))
    const [received, isBinary] = await got
    assert.equal(isBinary, true, `size=${size}`)
    assert.equal(received.length, size, `size=${size}`)
    assert.ok(received.equals(payload), `size=${size}`)
  }
})

/* ─────────────────────────── 连接清理 / drain ─────────────────────────── */

test('drain：缓冲低于阈值立即返回 true（阈值检查先于 closed 检查）', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const client = await connectClient(srv.url, t)
  const server = srv.conns[0]

  // 空缓冲：立即 true，不等待
  const started = Date.now()
  assert.equal(await client.drain(1 * 1024 * 1024, 1000), true)
  assert.ok(Date.now() - started < 200, '不应等待')
  assert.equal(typeof client.bufferedBytes, 'number')

  // drain 的语义是"等写缓冲降到阈值以下"。缓冲已达标时直接返回 true，
  // 该检查发生在 closed 检查之前 —— 所以 closed 连接传 threshold=0 也返回 true（本机实测）。
  server.close(1000, 'done')
  assert.equal(server.closed, true)
  assert.equal(await server.drain(0, 300), true, '缓冲已为 0，阈值检查先命中')

  // 阈值不可满足（负数）时才走到 closed 分支 → false
  assert.equal(await server.drain(-1, 300), false, 'closed 且阈值不可满足 → false')
})

test('send / sendBinary 在 closed 连接上返回 false，不抛', async (t) => {
  const srv = await startServer(t)
  t.after(() => srv.close())

  const client = await connectClient(srv.url, t)
  const server = srv.conns[0]
  server.close(1000, 'bye')

  assert.equal(server.send('x'), false)
  assert.equal(server.sendBinary(Buffer.from('x')), false)
  assert.equal(server.ping(), false)
  assert.doesNotThrow(() => server.close(1000, 'again'))
  client.close()
})

test('connect：非法 url / 握手被拒时 reject，不挂起', async (t) => {
  await assert.rejects(() => connect('not-a-url'), /invalid ws url/)

  const server = http.createServer((_req, res) => res.writeHead(403).end())
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(() => r())))
  await assert.rejects(
    () => connect(`ws://127.0.0.1:${server.address().port}/ws`, { timeoutMs: 3000 }),
    /handshake rejected: HTTP 403/,
  )
})

test('acceptUpgrade：非 websocket 请求直接 destroy 并返回 undefined', async (t) => {
  const socket = { destroy: () => {}, write: () => {} }
  const r = acceptUpgrade({ headers: {} }, socket, Buffer.alloc(0))
  assert.equal(r, undefined)

  const r2 = acceptUpgrade({ headers: { upgrade: 'h2c', 'sec-websocket-key': 'x' } }, socket, Buffer.alloc(0))
  assert.equal(r2, undefined)
})
