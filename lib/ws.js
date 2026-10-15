/**
 * 最小 RFC6455 WebSocket 实现（零外部依赖）。
 *
 * 只实现 dsh-remote-agent 需要的那一片：
 *   - 文本帧 / 二进制帧 / ping / pong / close
 *   - 分片（continuation）重组
 *   - 客户端强制掩码，服务端强制不掩码
 *   - 单帧长度上限，防止畸形帧吃内存
 * 不做：扩展协商（permessage-deflate）、子协议、UTF-8 增量校验。
 * 这是刻意的取舍 —— 少一层可变行为，跨网络长连接更好预测。
 */
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import { MAX_ARTIFACT_FRAME_BYTES, MAX_CONTROL_FRAME_BYTES } from './protocol.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64')
}

function encodeFrame(opcode, payload, mask) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  if (!mask) return Buffer.concat([header, payload], header.length + len)

  header[1] |= 0x80
  const key = randomBytes(4)
  const out = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ key[i & 3]
  return Buffer.concat([header, key, out], header.length + 4 + len)
}

/** 增量帧解析器：喂 Buffer，吐 {opcode, payload}。 */
class FrameParser {
  constructor(onFrame, onProtocolError) {
    this.buf = Buffer.alloc(0)
    this.onFrame = onFrame
    this.onProtocolError = onProtocolError
    this.fragOp = 0
    this.frags = []
    this.fragBytes = 0
    this.dead = false
  }

  push(chunk) {
    if (this.dead) return
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    while (!this.dead) {
      const consumed = this.step()
      if (consumed === 0) break
    }
  }

  /** @returns {number} 消费的字节数；0 表示数据不足。 */
  step() {
    const b = this.buf
    if (b.length < 2) return 0

    const fin = (b[0] & 0x80) !== 0
    const rsv = b[0] & 0x70
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let offset = 2

    if (rsv !== 0) {
      this.fail('rsv-set')
      return 0
    }
    if (len === 126) {
      if (b.length < offset + 2) return 0
      len = b.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (b.length < offset + 8) return 0
      const big = b.readBigUInt64BE(offset)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.fail('frame-too-large')
        return 0
      }
      len = Number(big)
      offset += 8
    }

    const limit = opcode === OP.BINARY ? MAX_ARTIFACT_FRAME_BYTES : MAX_CONTROL_FRAME_BYTES
    if (len > limit) {
      this.fail('frame-too-large')
      return 0
    }

    let maskKey
    if (masked) {
      if (b.length < offset + 4) return 0
      maskKey = b.subarray(offset, offset + 4)
      offset += 4
    }

    if (b.length < offset + len) return 0

    const payload = Buffer.allocUnsafe(len)
    b.copy(payload, 0, offset, offset + len)
    if (masked) {
      for (let i = 0; i < len; i += 1) payload[i] ^= maskKey[i & 3]
    }

    const total = offset + len
    this.buf = b.length === total ? Buffer.alloc(0) : b.subarray(total)
    this.dispatch(fin, opcode, payload)
    return total
  }

  dispatch(fin, opcode, payload) {
    if (opcode === OP.CONT) {
      if (this.fragOp === 0) {
        this.fail('unexpected-continuation')
        return
      }
      this.frags.push(payload)
      this.fragBytes += payload.length
      // ⚠ 分片也要有**总量**上限，不能只限单帧。
      //
      // 上面 `len > limit` 只挡住单个分片；RFC 6455 允许把一个消息拆成任意多片，
      // 而 CONT 帧数量不限 —— 于是一条连接可以发 N 个 4MiB 分片，把
      // `Buffer.concat(frags, fragBytes)` 之前的 frags 数组撑到任意大小。
      // 直连端点在 `nodeToken` 留空时**不做鉴权**（文档明示只适用于可信私网），
      // 所以这是一条"一条连接打爆 hub 内存"的路径。
      //
      // 阈值取单帧上限的 4 倍：产物分块本身不需要跨多片（单片上限已是 4MiB），
      // 留 4 倍余量足够容纳合法的大消息，又不给无限增长留空间。
      if (this.fragBytes > MAX_ARTIFACT_FRAME_BYTES * 4) {
        this.fail('fragment-too-large')
        return
      }
      if (fin) {
        const full = Buffer.concat(this.frags, this.fragBytes)
        const op = this.fragOp
        this.fragOp = 0
        this.frags = []
        this.fragBytes = 0
        this.onFrame(op, full)
      }
      return
    }

    if (opcode === OP.PING || opcode === OP.PONG || opcode === OP.CLOSE) {
      this.onFrame(opcode, payload)
      return
    }

    if (opcode !== OP.TEXT && opcode !== OP.BINARY) {
      this.fail('bad-opcode')
      return
    }

    if (this.fragOp !== 0) {
      this.fail('interleaved-fragments')
      return
    }

    if (fin) {
      this.onFrame(opcode, payload)
      return
    }

    this.fragOp = opcode
    this.frags = [payload]
    this.fragBytes = payload.length
  }

  fail(reason) {
    this.dead = true
    this.onProtocolError(reason)
  }
}

/**
 * 一条已建立握手的 WebSocket 连接。
 * 事件：'message'(data:Buffer, isBinary:boolean) / 'close'(code, reason) / 'error'(err)
 */
export class WSConnection extends EventEmitter {
  constructor(socket, { mask, maxQueuedBytes = 64 * 1024 * 1024, name = 'ws' } = {}) {
    super()
    this.socket = socket
    this.mask = mask
    this.name = name
    this.closed = false
    this.queuedBytes = 0
    this.maxQueuedBytes = maxQueuedBytes
    this.parser = new FrameParser(
      (op, payload) => this.handleFrame(op, payload),
      (reason) => this.destroy(new Error(`ws protocol error: ${reason}`)),
    )
    socket.on('data', (chunk) => {
      try {
        this.parser.push(chunk)
      } catch (err) {
        this.destroy(err)
      }
    })
    socket.on('error', (err) => this.destroy(err))

    // 对端硬断（kill -9 / 拔网线 / NAT 超时）时**不发** WebSocket close 帧，只发 FIN。
    // upgrade 过的 socket 是 allowHalfOpen=true，所以 FIN 只 emit 'end'、不 emit 'close'，
    // 而 finish() 原本只挂在 'close' 上 —— 结果 conn.on('close') 永不触发，
    // 上层（relay 的 node 清理、hub 的节点下线）会永久泄漏这条连接：
    // 死节点占着 maxNodes 配额，节点列表与在线广播全部失真。
    // 实测：客户端 destroy() 后 2 秒，服务端只见 'socket end'，'close' 从未来过。
    socket.on('end', () => {
      this.finish(1006, 'peer closed without close frame')
      // allowHalfOpen 下 'end' 之后 socket 仍可写，必须主动销毁才能释放 fd
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
    })

    socket.on('close', () => this.finish(1006, 'socket closed'))
    socket.setNoDelay?.(true)
    // 长连接不被中间设备静默掐断：交给上层 heartbeat，但底层也关掉空闲超时。
    socket.setTimeout?.(0)
  }

  handleFrame(opcode, payload) {
    if (opcode === OP.PING) {
      this.rawSend(OP.PONG, payload)
      this.emit('ping', payload)
      return
    }
    if (opcode === OP.PONG) {
      this.emit('pong', payload)
      return
    }
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      this.rawSend(OP.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0))
      this.finish(code, reason)
      return
    }
    this.emit('message', payload, opcode === OP.BINARY)
  }

  /**
   * 写缓冲是否已超预算。
   *
   * `maxQueuedBytes` 此前只是声明、从未被读（死代码）。中继用它做下行背压：
   * 一个停滞的节点（不读 socket）会让 `socket.write` 的缓冲无限增长 ——
   * 实测推 2000×256KiB 后 writableLength 达 339.8 MiB、relay RSS 419 MiB，
   * 单个停滞节点就能把中继 OOM 打掉。
   *
   * 注意：只对**数据帧**生效（send/sendBinary）。PING/PONG/CLOSE 走 rawSend，
   * 必须始终能发出，否则一条卡住的连接连优雅关闭都做不到。
   */
  get overBudget() {
    return this.bufferedBytes > this.maxQueuedBytes
  }

  rawSend(opcode, payload) {
    if (this.closed) return false
    try {
      this.socket.write(encodeFrame(opcode, payload, this.mask))
      return true
    } catch (err) {
      this.destroy(err)
      return false
    }
  }

  /** 发送文本帧。 */
  send(text) {
    return this.rawSend(OP.TEXT, Buffer.from(String(text), 'utf8'))
  }

  /** 发送二进制帧（产物分块走这里，避免 base64 的 33% 膨胀）。 */
  sendBinary(buf) {
    return this.rawSend(OP.BINARY, Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
  }

  /**
   * 尚未写出的字节数。
   * 产物分块必须靠它做背压 —— 一个 200MB 的产物若一次灌进 socket，
   * 内存会被撑爆，而且中继侧的转发队列会跟着一起涨。
   */
  get bufferedBytes() {
    return this.socket?.writableLength ?? 0
  }

  /** 等待写缓冲降到阈值以下，或超时。 */
  drain(threshold = 1 * 1024 * 1024, timeoutMs = 30_000) {
    if (this.bufferedBytes <= threshold) return Promise.resolve(true)
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = () => {
        if (this.closed) {
          resolve(false)
          return
        }
        if (this.bufferedBytes <= threshold) {
          resolve(true)
          return
        }
        if (Date.now() - started > timeoutMs) {
          resolve(false)
          return
        }
        setTimeout(tick, 5)
      }
      tick()
    })
  }

  ping() {
    return this.rawSend(OP.PING, Buffer.alloc(0))
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    const r = Buffer.from(reason, 'utf8')
    const payload = Buffer.allocUnsafe(2 + r.length)
    payload.writeUInt16BE(code, 0)
    r.copy(payload, 2)
    this.rawSend(OP.CLOSE, payload)
    this.finish(code, reason)
    try {
      this.socket.end()
    } catch {
      /* socket 可能已断，忽略 */
    }
  }

  destroy(err) {
    if (err) this.emit('error', err)
    this.finish(1006, err ? err.message : 'destroyed')
    try {
      this.socket.destroy()
    } catch {
      /* 已销毁 */
    }
  }

  finish(code, reason) {
    if (this.closed) return
    this.closed = true
    this.parser.dead = true
    this.emit('close', code, reason)
  }
}

/**
 * 服务端：接管一个已经 upgrade 的 socket。
 * 直接对接 ctx.webServer.registerUpgrade({ path, handler }) 的 handler 签名。
 */
export function acceptUpgrade(req, socket, head, opts = {}) {
  const key = req.headers['sec-websocket-key']
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy()
    return undefined
  }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n',
  ]
  socket.write(headers.join('\r\n'))
  const conn = new WSConnection(socket, { mask: false, ...opts })
  if (head && head.length > 0) conn.parser.push(head)
  return conn
}

/**
 * 客户端：连到 ws:// 或 wss://。
 * @returns {Promise<WSConnection>}
 */
export function connect(url, { headers = {}, timeoutMs = 15_000, name = 'ws-client' } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`invalid ws url: ${url}`))
      return
    }
    const isSecure = target.protocol === 'wss:'
    const mod = isSecure ? https : http
    const key = randomBytes(16).toString('base64')
    const req = mod.request({
      protocol: target.protocol === 'wss:' ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port || (isSecure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
    })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error(`ws connect timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    if (timer.unref) timer.unref()

    req.on('upgrade', (res, socket, head) => {
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      clearTimeout(timer)
      const expect = acceptKey(key)
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy()
        reject(new Error('ws handshake: bad Sec-WebSocket-Accept'))
        return
      }
      const conn = new WSConnection(socket, { mask: true, name })
      if (head && head.length > 0) conn.parser.push(head)
      resolve(conn)
    })

    req.on('response', (res) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`ws handshake rejected: HTTP ${res.statusCode}`))
      res.resume()
    })

    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    req.end()
  })
}
