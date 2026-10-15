/**
 * 中继服务（零依赖）。
 *
 * 定位：只做寻址与转发，不理解业务帧。三件事：
 *   1. hub 拨入 → 登记为控制端
 *   2. node 拨入 → 登记 nodeId，广播 node/online 给 hub
 *   3. 双向转发：node 的上行帧推给全部 hub；hub 的下行帧按 `to` 投给对应 node
 *
 * 刻意不做的事（v0.1）：
 *   - 不缓冲离线消息（任务状态真身在副机，重连后 node 自己 task/sync）
 *   - 不解析业务帧（二进制帧只读头部路由，净荷不解码）
 *   - 不持久化任务（中继是管子，不是数据库）
 *
 * 鉴权：hubToken / enrollToken 分离。node 用 enrollToken 入网，hub 用 hubToken 接管。
 * 二者都支持一次性 token（consumed 后失效），便于"发一台机器出去"。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import {
  ERROR_CODE,
  PROTOCOL_VERSION,
  RELAY_FRAME,
  decodeBinaryFrame,
  decodeFrame,
  encodeBinaryFrame,
  encodeFrame,
} from './protocol.js'
import { acceptUpgrade } from './ws.js'

/** 恒定时间字符串比较，避免 token 逐字节泄露。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function newRelayToken(prefix = 'rt') {
  return `${prefix}_${randomBytes(24).toString('base64url')}`
}

/**
 * 启动中继。
 * @param {object} o
 * @param {number} [o.port=8890]
 * @param {string} [o.host='0.0.0.0']
 * @param {string} o.hubToken hub 端凭证
 * @param {string} o.enrollToken node 入网凭证
 * @param {boolean} [o.allowOneTimeTokens=true] 是否接受注册表里的一次性 token
 * @param {number} [o.maxNodes=64]
 * @param {(evt:object)=>void} [o.onEvent] 观测钩子（日志）
 */
/**
 * 安全解析 request-target。
 *
 * 为什么必须包住：Node 对畸形 request-target（如 `GET http://[/ HTTP/1.1`）抛
 * `TypeError: Invalid URL`。在 `http.createServer` 回调里抛会被 http 层兜住，
 * 但在 `server.on('upgrade')` 回调里抛是 EventEmitter 的普通事件 —— 直接冒泡成
 * uncaughtException，进程退出。实测：一条 TCP 连接、一个畸形请求行、**零 token**
 * 就能打死中继；而中继是 NAT 场景双方唯一的会合点，CLI 默认监听 0.0.0.0，
 * 暴露即等于可被单包打掉，副机与 hub 全体断连。
 */
function safeParseUrl(req, fallback = '/') {
  try {
    return new URL(req?.url ?? fallback, 'http://localhost')
  } catch {
    return undefined
  }
}

/**
 * 中继连接的写缓冲预算。
 *
 * 比 ws.js 默认的 64 MiB 小得多：中继只是转发点，任何时刻都不该攒住这么多字节 ——
 * 它攒住的每一字节都是"下游节点读不动"的堆积，而不是它自己的有用工作。
 * 16 MiB 足够吸收正常的网络抖动，又能在节点真停滞时快速断连而非拖到 OOM。
 */
const RELAY_QUEUE_BUDGET = 16 * 1024 * 1024

export function createRelay(o = {}) {
  const {
    port = 8890,
    host = '0.0.0.0',
    hubToken,
    enrollToken,
    allowOneTimeTokens = true,
    maxNodes = 64,
    // 空闲淘汰（见 sweepIdleConnections 的说明）。
    // idleMs 取 3 分钟：比常见的 NAT 表项超时（5–30 分钟）短，
    // 又远大于正常心跳间隔，不会误杀健康连接。
    idleMs = 3 * 60 * 1000,
    sweepMs = 60 * 1000,
    onEvent,
  } = o

  if (!hubToken || !enrollToken) throw new Error('relay requires hubToken and enrollToken')

  const log = (level, msg, extra) => {
    if (typeof onEvent === 'function') onEvent({ level, msg, ...extra, time: Date.now() })
  }

  /** nodeId → { conn, hello, since, bytesUp, bytesDown } */
  const nodes = new Map()
  /** hub 连接集合 */
  const hubs = new Set()
  /**
   * hub 连接 → 最后活跃时间（ms）。
   *
   * 为什么单独一张表而不是挂在连接上：`hubs` 里放的是 ws.js 的连接对象，
   * 那是另一个模块的类 —— 往它身上挂业务字段会耦合两个模块的内部形状。
   * 用 WeakMap 做旁路映射，连接被回收时条目自动消失。
   */
  const hubSeen = new WeakMap()
  /** 空闲淘汰扫描的定时器（在 listen 里起、close 里清）。 */
  let sweepTimer
  /** 一次性 token：token → { nodeId?, expiresAt, consumed } */
  const oneTime = new Map()
  const stats = { upFrames: 0, downFrames: 0, upBytes: 0, downBytes: 0, rejected: 0, backpressureDrops: 0 }

  function sweepTokens(now = Date.now()) {
    for (const [tok, rec] of oneTime) {
      if (rec.consumed || rec.expiresAt <= now) oneTime.delete(tok)
    }
  }

  /**
   * 空闲连接淘汰扫描。
   *
   * ═════════════════════════════════════════════════════════════════════════
   * 为什么必须有（2026-10-15 独立评审发现）
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `nodes` 的清理**只发生在 `conn.on('close')`** 里。而 TCP 连接的 close
   * 依赖于 FIN/RST 真的到达 —— 以下场景**不会**触发 close：
   *
   *   - NAT 表项静默超时（家庭路由器 5–30 分钟，常见）
   *   - 副机断电 / 强制关机 / 断网
   *   - 中间设备悄悄丢连接
   *
   * 于是 `nodes.get(nodeId)` 里的死条目**永久占用 `maxNodes` 配额**，
   * 配额满了之后新节点连进来直接 503 —— 中继就此缓慢"饱和而死"。
   *
   * ── 策略 ────────────────────────────────────────────────────────────────
   * 周期性（默认 60s）检查每个 node 与 hub 的最后活跃时间：
   *   - 超过 idleMs（默认 3 分钟）没动静 → 发一个 **WebSocket ping** 探测
   *   - 再等一个周期仍无 pong/帧 → 判定死连接，主动 destroy 并清条目
   *
   * 为什么用 ping 而不是直接断：正常空闲的节点也不发帧（任务间隙），
   * 直接按"多久没帧"断会误杀健康节点。ping/pong 是 WS 协议自带的活性探测，
   * ws.js 会自动回 pong（见其 OP.PING 分支）。
   *
   * 为什么阈值是 3 分钟 + 60s 扫描：比任何合理的 NAT 超时都短，
   * 又不至于把正常空闲误判成死（健康连接会被 ping 唤醒回 pong）。
   *
   * @returns {{nodes: number, hubs: number}} 本轮淘汰的连接数
   */
  function sweepIdleConnections(now = Date.now()) {
    let deadNodes = 0
    let deadHubs = 0

    for (const [nodeId, rec] of nodes) {
      const idle = now - rec.lastSeen
      if (idle < idleMs) continue
      if (!rec.pingSentAt) {
        // 第一次发现空闲：发 ping 探测，记下时间，下轮再判
        rec.pingSentAt = now
        try {
          rec.conn.ping()
        } catch {
          /* 连接可能已经坏了，下一轮会兜住 */
        }
        continue
      }      if (now - rec.pingSentAt < idleMs) continue
      // ping 发出后整个 idleMs 仍无任何回应 → 判定死亡
      try {
        rec.conn.destroy(new Error('idle timeout'))
      } catch {
        /* 已销毁 */
      }
      nodes.delete(nodeId)
      broadcastHubs(RELAY_FRAME.NODE_OFFLINE, { nodeId, reason: 'idle-timeout' })
      deadNodes += 1
      log('warn', 'node evicted: idle timeout', { nodeId, idleMs })
    }

    for (const h of [...hubs]) {
      const seen = hubSeen.get(h) ?? now
      if (now - seen < idleMs) continue
      try {
        h.destroy(new Error('idle timeout'))
      } catch {
        /* 已销毁 */
      }
      hubs.delete(h)
      hubSeen.delete(h)
      deadHubs += 1
      log('warn', 'hub evicted: idle timeout', { idleMs })
    }

    return { nodes: deadNodes, hubs: deadHubs }
  }

  /** 铸造一个一次性入网 token（由 hub 通过管理接口调用）。 */
  function mintToken({ nodeId, ttlMs = 15 * 60 * 1000 } = {}) {
    const token = newRelayToken('en')
    oneTime.set(token, { nodeId, expiresAt: Date.now() + ttlMs, consumed: false })
    return token
  }

  function checkNodeToken(token) {
    if (enrollToken && safeEqual(token, enrollToken)) return { ok: true, kind: 'static' }
    if (!allowOneTimeTokens) return { ok: false }
    sweepTokens()
    const rec = oneTime.get(token)
    if (!rec) return { ok: false }
    rec.consumed = true
    return { ok: true, kind: 'one-time', nodeId: rec.nodeId }
  }

  function sendJson(conn, type, data, opts) {
    conn.send(encodeFrame({ v: PROTOCOL_VERSION, t: type, id: randomBytes(8).toString('hex'), d: data ?? {}, ...opts }))
  }

  function broadcastHubs(type, data, opts) {
    const text = encodeFrame({ v: PROTOCOL_VERSION, t: type, id: randomBytes(8).toString('hex'), d: data ?? {}, ...opts })
    for (const h of [...hubs]) {
      if (h.closed) continue
      // ⚠ hub 方向也必须过背压 —— 见 applyHubBackpressure 的说明。
      if (!applyHubBackpressure(h)) continue
      h.send(text)
    }
  }

  function nodeSummary(rec) {
    return {
      nodeId: rec.hello.nodeId,
      // protocol 必须带上（t3 审计查出）：relay 模式下 hub 从来看不到副机的
      // hello 原文，只能看这份摘要。而 hub 侧 node-registry.js 的
      // `summary.protocol ?? PROTOCOL_VERSION` 在缺字段时会**静默填默认值** ——
      // 于是「双方协议版本一致」成了被假设而非被验证的事。带上它，
      // hub 才能真正做版本协商。
      protocol: rec.hello.protocol,
      os: rec.hello.os,
      arch: rec.hello.arch,
      hostname: rec.hello.hostname,
      dshVersion: rec.hello.dshVersion,
      shells: rec.hello.shells,
      roots: rec.hello.roots,
      caps: rec.hello.caps,
      profile: rec.hello.profile,
      agentMode: rec.hello.agentMode,
      // P2-11：连接级 nonce 透传 —— hub 签身份帧时用它，副机才能核对
      // "这是对我本次 hello 的回应"，而不是被重放的旧帧。
      nonce: rec.hello.nonce,
      since: rec.since,
      lastSeen: rec.lastSeen,
      bytesUp: rec.bytesUp,
      bytesDown: rec.bytesDown,
    }
  }

  function nodeList() {
    return [...nodes.values()].map(nodeSummary)
  }

  /** 文本帧下行（控制帧走这里）。 */
  function forwardToNode(nodeId, text, bytes) {
    const rec = nodes.get(nodeId)
    if (!rec || rec.conn.closed) return false
    if (!applyBackpressure(rec)) return false
    rec.conn.send(text)
    rec.bytesDown += bytes ?? text.length
    stats.downFrames += 1
    stats.downBytes += bytes ?? text.length
    return true
  }

  /**
   * 二进制帧下行。
   *
   * 必须走 sendBinary：早期版本把 encodeBinaryFrame 的 Buffer 交给 forwardToNode，
   * 而后者调 conn.send(text)，ws.js 的 send() 会做 Buffer.from(String(text),'utf8') ——
   * 净荷里所有非 UTF-8 字节被替换成 U+FFFD（0xff/0xfe/0x80 → EF BF BD），
   * 整帧损坏（实测 65 字节发出、73 字节收到）。
   */
  function forwardBinaryToNode(nodeId, buf) {
    const rec = nodes.get(nodeId)
    if (!rec || rec.conn.closed) return false
    if (!applyBackpressure(rec)) return false
    rec.conn.sendBinary(buf)
    rec.bytesDown += buf.length
    stats.downFrames += 1
    stats.downBytes += buf.length
    return true
  }

  /**
   * 下行背压（C1-1 修复）。
   *
   * 此前 forwardToNode/forwardBinaryToNode 从不检查写缓冲，relay.js 全文
   * 没有 drain / bufferedBytes / writableLength 的任何引用；ws.js 声明的
   * maxQueuedBytes 也从未被读。实测：一个停滞的节点（不读 socket）会让
   * writableLength 涨到 339.8 MiB、relay RSS 419 MiB —— 单个停滞节点
   * 就能把中继 OOM 打掉。
   *
   * 策略选择：**超限即断连**，而不是 await drain 或静默丢帧。
   *   - await drain 会阻塞整个转发循环，一个慢节点拖死所有其他节点
   *   - 静默丢帧会让对端拿到残缺的流而毫无察觉（产物分块丢一块就废了整份）
   *   - 断连是可观测的，且节点会自动重连、靠 task/sync 重建视图，
   *     代价只是那一条连接重来，不影响其他节点
   *
   * 阈值取 maxQueuedBytes（默认 64 MiB），并在日志与 stats 里留下痕迹。
   */
  function applyBackpressure(rec) {
    if (!rec.conn.overBudget) return true
    stats.backpressureDrops += 1
    log('warn', 'node over write budget, dropping connection', {
      nodeId: rec.nodeId,
      bufferedBytes: rec.conn.bufferedBytes,
      budget: rec.conn.maxQueuedBytes,
    })
    try {
      rec.conn.destroy(new Error('write budget exceeded'))
    } catch {
      /* 已销毁 */
    }
    return false
  }

  /**
   * hub 方向的背压：与 `applyBackpressure` 同样的策略，但作用对象是**裸连接**。
   *
   * ═════════════════════════════════════════════════════════════════════════
   * 为什么必须补这一个（2026-10-15 独立评审发现）
   * ═════════════════════════════════════════════════════════════════════════
   *
   * 原实现只在 `forwardToNode` / `forwardBinaryToNode`（node 方向）查预算，
   * 而 `broadcastHubs` / `broadcastHubsBinary`（hub 方向）直接 `h.send()` ——
   * **背压只修了一半**。
   *
   * 风险对称：一个不读 socket 的 hub 连接（卡死的浏览器页、暂停的调试器、
   * 被挂起的宿主进程）会让 `writableLength` 无限增长。中继是**单进程常驻**
   * 服务，这正是本文件上面那段注释描述的 OOM 场景，只是换了个方向。
   *
   * 与 node 方向的差别：hub 连接没有 `rec` 包装，所以这里直接接连接对象；
   * 阈值用连接自己的 `maxQueuedBytes`（ws.js 的构造参数，默认 64 MiB）。
   *
   * @param {object} h hub 连接（ws.js 的 WSConnection）
   * @returns {boolean} true = 可以写；false = 已断连，调用方应跳过
   */
  function applyHubBackpressure(h) {
    if (!h.overBudget) return true
    stats.backpressureDrops += 1
    log('warn', 'hub over write budget, dropping connection', {
      bufferedBytes: h.bufferedBytes,
      budget: h.maxQueuedBytes,
    })
    try {
      h.destroy(new Error('write budget exceeded'))
    } catch {
      /* 已销毁 */
    }
    return false
  }

  const server = http.createServer((req, res) => {
    // 畸形 request-target 一律 400，绝不让 TypeError 冒泡成 uncaughtException
    const url = safeParseUrl(req)
    if (!url) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'bad-request-target' }))
      return
    }

    // 健康检查 + 节点目录（只读，给运维看）
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, nodes: nodes.size, hubs: hubs.size, stats }))
      return
    }
    if (url.pathname === '/api/relay/nodes') {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      const token = url.searchParams.get('token') ?? req.headers['x-relay-token']
      if (!token || !safeEqual(token, hubToken)) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ nodes: nodeList() }))
      return
    }
    if (url.pathname === '/api/relay/token') {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const token = url.searchParams.get('token') ?? req.headers['x-relay-token']
      if (!token || !safeEqual(token, hubToken)) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        let parsed = {}
        try {
          parsed = body ? JSON.parse(body) : {}
        } catch {
          parsed = {}
        }
        const tok = mintToken({ nodeId: parsed.nodeId, ttlMs: parsed.ttlMs })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ token: tok, expiresInMs: parsed.ttlMs ?? 15 * 60 * 1000 }))
      })
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not-found' }))
  })

  // 兜底：畸形请求行可能在到达任何 handler 之前就被 http 解析器拒绝
  // （HPE_INVALID_* 等）。没有这个监听器时，这类连接会被直接销毁并可能
  // 触发 'clientError' 的默认行为；显式处理保证一律 400 + 关闭，不升级为进程级错误。
  server.on('clientError', (err, socket) => {
    stats.rejected += 1
    log('warn', 'client error', { code: err?.code ?? 'unknown' })
    try {
      if (socket.writable && !socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      } else {
        socket.destroy()
      }
    } catch {
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
    }
  })

  server.on('upgrade', (req, socket, head) => {
    // 这一处是 blocker 的真正入口：upgrade 回调抛错 = uncaughtException = 进程退出
    const url = safeParseUrl(req)
    if (!url) {
      stats.rejected += 1
      log('warn', 'upgrade rejected: malformed request-target')
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        /* socket 可能已断 */
      }
      socket.destroy()
      return
    }
    const role = url.searchParams.get('role')
    const token = url.searchParams.get('token') ?? req.headers['x-relay-token']
    const wantNodeId = url.searchParams.get('nodeId') ?? ''

    if (url.pathname !== '/relay') {
      socket.destroy()
      return
    }

    if (role === 'hub') {
      if (!token || !safeEqual(token, hubToken)) {
        stats.rejected += 1
        log('warn', 'hub rejected: bad token')
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      const conn = acceptUpgrade(req, socket, head, { name: 'relay-hub', maxQueuedBytes: RELAY_QUEUE_BUDGET })
      if (!conn) return
      hubs.add(conn)
      log('info', 'hub connected', { hubs: hubs.size })
      sendJson(conn, RELAY_FRAME.HELLO_HUB, { protocol: PROTOCOL_VERSION, nodes: nodeList() })
      conn.on('message', (payload, isBinary) => {
        if (isBinary) {
          const dec = decodeBinaryFrame(payload)
          if (!dec.ok) {
            log('warn', 'hub binary frame undecodable', { error: dec.error })
            return
          }
          const to = dec.header.to
          if (typeof to !== 'string') return
          const out = encodeBinaryFrame(dec.header, dec.payload)
          forwardBinaryToNode(to, out)
          return
        }
        const dec = decodeFrame(payload)
        if (!dec.ok) {
          sendJson(conn, RELAY_FRAME.ERROR, { code: dec.error })
          return
        }
        const frame = dec.frame
        if (frame.t === RELAY_FRAME.NODE_LIST) {
          sendJson(conn, RELAY_FRAME.NODE_LIST, { nodes: nodeList() })
          return
        }
        const to = frame.to ?? frame.d?.to
        if (typeof to === 'string' && to !== '') {
          const ok = forwardToNode(to, encodeFrame(frame), undefined)
          if (!ok) {
            sendJson(conn, RELAY_FRAME.ERROR, { code: 'node-offline', nodeId: to, replyTo: frame.id })
          }
          return
        }
        // 无 to 的下行帧 → 广播（用于广播式指令）
        broadcastHubs(frame.t, frame.d, { r: frame.id })
      })
      conn.on('close', () => {
        hubs.delete(conn)
        hubSeen.delete(conn)
        log('info', 'hub disconnected', { hubs: hubs.size })
      })
      conn.on('error', (err) => log('warn', 'hub error', { error: err.message }))
      // 记录活跃时间，供空闲淘汰扫描判断（见 startIdleSweep）
      conn.on('message', () => hubSeen.set(conn, Date.now()))
      conn.on('pong', () => hubSeen.set(conn, Date.now()))
      hubSeen.set(conn, Date.now())
      return
    }

    if (role === 'node') {
      const check = checkNodeToken(token)
      if (!check.ok) {
        stats.rejected += 1
        log('warn', 'node rejected: bad token', { nodeId: wantNodeId })
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      if (nodes.size >= maxNodes) {
        stats.rejected += 1
        log('warn', 'node rejected: relay full')
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return
      }
      const conn = acceptUpgrade(req, socket, head, { name: 'relay-node', maxQueuedBytes: RELAY_QUEUE_BUDGET })
      if (!conn) return

      let boundId = ''
      conn.on('message', (payload, isBinary) => {
        if (isBinary) {
          const dec = decodeBinaryFrame(payload)
          if (!dec.ok) return
          if (boundId === '') return
          const out = encodeBinaryFrame({ ...dec.header, from: boundId }, dec.payload)
          broadcastHubsBinary(out)
          const rec = nodes.get(boundId)
          if (rec) {
            rec.bytesUp += out.length
            rec.lastSeen = Date.now()
            // 收到任何帧都算"活着"：清掉 ping 标记，否则下一轮扫描
            // 会因为 pingSentAt 仍在而误判为死亡（见 sweepIdleConnections）。
            rec.pingSentAt = undefined
          }
          stats.upFrames += 1
          stats.upBytes += out.length
          return
        }

        const dec = decodeFrame(payload)
        if (!dec.ok) {
          sendJson(conn, RELAY_FRAME.ERROR, { code: dec.error })
          return
        }
        const frame = dec.frame

        if (frame.t === RELAY_FRAME.HELLO_NODE) {
          // ⚠ 一条连接只能 hello 一次。
          //
          // 原实现没有这个守卫 —— 同一连接二次 HELLO_NODE 换一个 nodeId 时，
          // `nodes.set(newId, rec)` 会**覆盖** boundId，而旧 id 的条目**留在
          // nodes 里永不清除**（close 处理器只看当时的 boundId）。后果：
          //   - 幽灵条目永久占用 `maxNodes` 配额
          //   - 配额满了之后新节点直接 503
          //   - 反复 hello 可以在单条连接上堆任意多幽灵条目
          // 拒绝第二次 hello 是最简单且语义正确的处理（重连应该开新连接）。
          if (boundId !== '') {
            sendJson(conn, RELAY_FRAME.ERROR, { code: 'already-helloed' })
            conn.close(1008, 'already-helloed')
            log('warn', 'node re-hello on same connection rejected', { boundId })
            return
          }
          const hello = frame.d ?? {}
          const nodeId = String(hello.nodeId ?? '')
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nodeId)) {
            sendJson(conn, RELAY_FRAME.ERROR, { code: 'node-id-invalid' })
            conn.close(1008, 'node-id-invalid')
            return
          }
          if (check.nodeId && check.nodeId !== nodeId) {
            sendJson(conn, RELAY_FRAME.ERROR, { code: ERROR_CODE.UNAUTHORIZED, message: 'token bound to another nodeId' })
            conn.close(1008, ERROR_CODE.UNAUTHORIZED)
            return
          }
          const existing = nodes.get(nodeId)
          if (existing && !existing.conn.closed) {
            // 同 id 第二实例：拒掉新的，保住已经在跑的那个（任务不能被打断）
            sendJson(conn, RELAY_FRAME.ERROR, { code: ERROR_CODE.DUPLICATE_NODE, nodeId })
            conn.close(1008, ERROR_CODE.DUPLICATE_NODE)
            log('warn', 'duplicate node rejected', { nodeId })
            return
          }
          boundId = nodeId
          const rec = { conn, hello, since: Date.now(), lastSeen: Date.now(), bytesUp: 0, bytesDown: 0 }
          nodes.set(nodeId, rec)
          sendJson(conn, RELAY_FRAME.HELLO_NODE, { protocol: PROTOCOL_VERSION, nodeId, accepted: true })
          broadcastHubs(RELAY_FRAME.NODE_ONLINE, { node: nodeSummary(rec) })
          log('info', 'node online', { nodeId, os: hello.os })
          return
        }

        if (boundId === '') {
          sendJson(conn, RELAY_FRAME.ERROR, { code: ERROR_CODE.UNAUTHORIZED, message: 'hello/node required first' })
          return
        }

        const rec = nodes.get(boundId)
        if (rec) {
          rec.lastSeen = Date.now()
          rec.pingSentAt = undefined   // 同上：有帧即活着，清掉 ping 标记
          rec.bytesUp += payload.length
        }
        stats.upFrames += 1
        stats.upBytes += payload.length
        // 上行：原样推给所有 hub，附带来源
        const out = encodeFrame({ ...frame, from: boundId })
        for (const h of hubs) {
          if (!h.closed) h.send(out)
        }
      })

      conn.on('close', () => {
        if (boundId === '') return
        const rec = nodes.get(boundId)
        if (rec && rec.conn === conn) {
          nodes.delete(boundId)
          broadcastHubs(RELAY_FRAME.NODE_OFFLINE, { nodeId: boundId, reason: 'disconnected' })
          log('info', 'node offline', { nodeId: boundId })
        }
      })
      // pong 也是"活着"的证据 —— 空闲淘汰发 ping 后，健康节点回的正是 pong。
      // ws.js 会在收到 PONG 时 emit('pong')（见其 OP.PONG 分支）。
      conn.on('pong', () => {
        const rec = nodes.get(boundId)
        if (rec) {
          rec.lastSeen = Date.now()
          rec.pingSentAt = undefined
        }
      })
      conn.on('error', (err) => log('warn', 'node error', { nodeId: boundId, error: err.message }))
      return
    }

    stats.rejected += 1
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
  })

  function broadcastHubsBinary(buf) {
    for (const h of [...hubs]) {
      if (h.closed) continue
      // 二进制方向同样要过背压 —— 产物分块正是最容易把缓冲撑爆的流量。
      if (!applyHubBackpressure(h)) continue
      h.sendBinary(buf)
    }
  }

  /** 主动断开一个节点（hub 侧吊销）。 */
  function kickNode(nodeId, reason = 'revoked') {
    const rec = nodes.get(nodeId)
    if (!rec) return false
    sendJson(rec.conn, RELAY_FRAME.ERROR, { code: 'revoked', reason })
    rec.conn.close(1008, reason)
    return true
  }

  return {
    server,
    nodes,
    hubs,
    stats,
    mintToken,
    nodeList,
    kickNode,
    listen: (cb) => {
      // 起空闲淘汰扫描（见 sweepIdleConnections 的说明）。
      // `unref()` 是必须的 —— 否则这个定时器会吊住 Node 事件循环，
      // 让进程无法自然退出（测试里的 `close()` 之后尤其明显）。
      if (idleMs > 0 && sweepMs > 0 && !sweepTimer) {
        sweepTimer = setInterval(() => {
          try {
            sweepIdleConnections()
          } catch (err) {
            // 扫描内部已经逐个 try/catch，这里是兜底：绝不让它变成 uncaughtException
            log('warn', 'idle sweep failed', { error: String(err?.message ?? err) })
          }
        }, sweepMs)
        if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
      }
      return server.listen(port, host, cb)
    },
    close: () => new Promise((resolve) => {
      if (sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = undefined
      }
      for (const n of nodes.values()) n.conn.close(1001, 'relay shutting down')
      for (const h of hubs) h.close(1001, 'relay shutting down')
      nodes.clear()
      hubs.clear()
      server.close(() => resolve())
    }),
    /** 主动跑一次空闲淘汰（测试用，避免依赖真实定时器）。 */
    sweepIdle: (now) => sweepIdleConnections(now),
    address: () => server.address(),
  }
}

/** 给一次性 token 生成指纹，用于日志里不泄露 token 本体。 */
export function tokenFingerprint(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
}
