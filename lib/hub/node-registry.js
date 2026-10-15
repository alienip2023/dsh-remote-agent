/**
 * 主机侧连接层 + 节点注册表（零外部依赖）。
 *
 * 定位：hub 眼里"有哪些副机、它们各自在跑什么"的唯一真身。
 *
 * 三条不变式（与 protocol.js / task-store.js 的契约对齐）：
 *   1. **任务状态的真身在副机** —— hub 只维护投影。断连只把 online 置 false，
 *      绝不清 tasks；重连后靠副机主动 task/sync 全量重建视图。
 *   2. **同 nodeId 第二实例拒掉新的** —— 正在跑的任务不能被挤掉，保住已在跑的那个连接。
 *   3. **任何一帧的解析失败只记日志** —— 一个畸形帧不能打挂 host。
 *
 * 两种接入方式共用同一套上行处理：
 *   direct —— 副机直接拨 hub 的 WebSocket 端点，一个节点一条 conn
 *   relay  —— 双方都在 NAT 后，经中继会合；中继只做寻址，hub 侧共用一个 link
 *
 * 本文件是 hub 目录的依赖叶子（只依赖 protocol.js / ws.js），所以共享的
 * 日志器 createPluginLogger 也放在这里，避免 hub 内部出现循环 import。
 */
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PULL_TIMEOUT_MS,
  ERROR_CODE,
  HUB_TO_NODE,
  NODE_TO_HUB,
  PROTOCOL_VERSION,
  RELAY_FRAME,
  RemoteAgentError,
  TASK_STATUS,
  TERMINAL_STATUS,
  decodeBinaryFrame,
  decodeFrame,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
  validateHello,
} from '../protocol.js'
import { connect } from '../ws.js'
// P2-11：hub 身份签名（ed25519）。零外部依赖，与 protocol/ws 同级的基础层。
import { newNonce, signIdentity } from '../identity.js'
// 视图投影共享层：registry 给工具用的任务视图与 UI 路由共用同一份白名单。
import { taskView as taskProjection } from './views.js'

const REDACT_KEY_RE = /(token|secret|password|passwd|credential|apikey|api_key|authorization)/i
const MAX_LOG_STRING = 400

/**
 * 构造一个插件日志器。
 *
 * 两条硬规则：
 *   - 日志本身绝不抛（拿不到 logger 就退化成 console）
 *   - 凭证形态的字段一律打码 —— 协议与日志里都不该出现模型凭证 / 节点 token
 */
export function createPluginLogger(ctx, scope = 'remote-agent') {
  return (level, msg, extra) => {
    const line = `[${scope}] ${msg}`
    const payload = sanitizeExtra(extra)
    try {
      const logger = ctx?.logger
      const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined
      if (fn) {
        fn(line, payload)
        return
      }
      if (logger && typeof logger.info === 'function') {
        logger.info(line, payload)
        return
      }
      if (level === 'warn' || level === 'error') console.warn(line, payload ?? '')
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }
}

/** 打码 + 截断，避免凭证与超长内容进日志。 */
export function sanitizeExtra(extra) {
  if (extra === undefined || extra === null) return undefined
  if (typeof extra !== 'object') return typeof extra === 'string' ? clip(extra) : extra
  const out = {}
  for (const [k, v] of Object.entries(extra)) {
    if (REDACT_KEY_RE.test(k)) {
      out[k] = '***'
      continue
    }
    if (v === null || v === undefined) continue
    if (typeof v === 'string') out[k] = clip(v)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (Array.isArray(v)) out[k] = v.length
    else out[k] = '[object]'
  }
  return out
}

function clip(s) {
  return s.length > MAX_LOG_STRING ? `${s.slice(0, MAX_LOG_STRING)}…` : s
}

function errText(err) {
  return String(err?.message ?? err ?? 'unknown error')
}

/** 调用一个 disposer，绝不抛。 */
export function safeDispose(fn) {
  if (typeof fn !== 'function') return false
  try {
    fn()
    return true
  } catch {
    return false
  }
}

/**
 * 中继链路：hub 拨入中继，之后所有下行帧带 `to`，中继负责投递。
 *
 * 断线自动重连（指数退避 + 抖动，封顶 60s）。断连期间 hub 侧任务记录不动 ——
 * 副机那边任务照跑，重连后副机 task/sync 会把视图补回来。
 *
 * ── 两条并发不变式（t1 动态测试查出，此前无护栏）────────────────────
 *
 * 1. **同时只允许一条在途连接**。`start()` 与退避 timer 都会调 `connectOnce()`，
 *    而 `connect()` 要等 101 响应才 resolve —— 这个窗口里 `this.conn` 还是
 *    undefined，任何一次重入都会再开一条 TCP 连接。实测（真中继）：连调两次
 *    `start()` → 中继侧 `hubs.size === 2`；`stop()` 只关得掉 `this.conn` 那一条，
 *    另一条变成**无人引用的孤儿连接**，永久占着中继的 hub 槽位，且 `stop()`
 *    之后再无任何路径能关掉它。用 `connecting` 闸门 + `start()` 幂等堵住。
 *
 * 2. **close 处理器必须确认自己就是当前连接**。真正的问题在**陈旧连接**：
 *    若它已被新连接取代（`this.conn` 指向新的），旧连接的 'close' 仍会把
 *    `this.conn` 清成 undefined 并排重连 —— 于是「已连上的新连接」被一条早就
 *    死掉的旧连接伪造成「掉线」。实测：造出两条连接、断开其中陈旧的那条，
 *    `ready` 由 true 翻成 false、`attempt` 涨到 1、还排了一个多余的 timer。
 *    修复即比较 `this.conn === conn` 再动手。
 */
export class RelayLink {
  constructor({ url, token = '', log, onFrame, onBinary, reconnectMs = 5000, name = 'hub-relay' } = {}) {
    this.url = url
    this.token = token
    this.log = log ?? (() => {})
    this.onFrame = onFrame ?? (() => {})
    this.onBinary = onBinary ?? (() => {})
    this.reconnectMs = reconnectMs
    this.name = name
    this.conn = undefined
    this.timer = undefined
    /** 有一次 connectOnce() 正在 await 中（见上面不变式 1）。 */
    this.connecting = false
    this.attempt = 0
    this.stopped = true
  }

  get ready() {
    return Boolean(this.conn && !this.conn.closed)
  }

  /**
   * 启动链路。**幂等**：已连接或已有在途连接时直接返回。
   *
   * 为什么必须幂等：hub/index.js 在 `ctx.effect` 里调它，而 Cordis 的 effect
   * 可能因配置热重载而重跑 —— 不幂等就会每次多开一条连接，且旧的那条再无人
   * 引用（见类注释不变式 1）。
   *
   * 注意 `stopped = false` 必须在闸门**之前**：`start() → stop() → start()`
   * 的快速序列里，第二次 start() 会因 `connecting` 仍为 true 而提前返回；
   * 若此时 stopped 还是 true，那条在途连接 resolve 后会走 `if (this.stopped)`
   * 分支把自己关掉 —— 调用方调了 start() 却永远连不上。先置 false 则那条
   * 在途连接会被正常采纳，语义与「重启」一致。
   */
  start() {
    this.stopped = false
    if (this.ready || this.connecting) return
    void this.connectOnce()
  }

  /** 中继 URL（不带 token），用于日志。 */
  describe() {
    try {
      const u = new URL(this.url)
      return `${u.origin}${u.pathname}`
    } catch {
      return '(invalid-relay-url)'
    }
  }

  async connectOnce() {
    if (this.stopped) return
    // 并发闸门：await connect() 期间 this.conn 仍为 undefined，不设这道闸门
    // 就会再开一条 TCP 连接（见类注释不变式 1）。
    if (this.connecting || this.ready) return
    let target
    try {
      target = new URL(this.url)
    } catch {
      this.log('error', 'relay url invalid', { url: this.describe() })
      return
    }
    target.searchParams.set('role', 'hub')
    // ⚠ token 走 header，**不进 URL query** —— URL 会进中继的 access log、
    // 反向代理日志、CDN 日志。中继侧本来就 header 优先：
    //   `url.searchParams.get('token') ?? req.headers['x-relay-token']`
    // 副机侧的 RelayTransport 也做了同样的改动（lib/node/transport.js）。

    this.connecting = true
    try {
      const headers = this.token ? { 'x-relay-token': this.token } : {}
      const conn = await connect(target.toString(), { name: this.name, headers })
      if (this.stopped) {
        conn.close(1000, 'stopped')
        return
      }
      this.conn = conn
      this.attempt = 0
      conn.on('message', (payload, isBinary) => {
        try {
          if (isBinary) {
            const dec = decodeBinaryFrame(payload)
            if (!dec.ok) {
              this.log('warn', 'relay binary frame undecodable', { error: dec.error })
              return
            }
            this.onBinary(dec.header, dec.payload)
            return
          }
          const dec = decodeFrame(payload)
          if (!dec.ok) {
            this.log('warn', 'relay frame undecodable', { error: dec.error })
            return
          }
          this.onFrame(dec.frame)
        } catch (err) {
          this.log('error', 'relay frame handler failed', { error: errText(err) })
        }
      })
      conn.on('close', (code) => {
        // 只有「当前生效的那条连接」断开才算掉线。
        // 陈旧连接的 close 若不校验身份，会把已被新连接顶替的状态清成「掉线」
        // （见类注释不变式 2）。
        if (this.conn !== conn) {
          this.log('info', 'stale relay connection closed', { code })
          return
        }
        this.conn = undefined
        this.log('warn', 'relay link closed', { code })
        this.schedule()
      })
      conn.on('error', (err) => this.log('warn', 'relay link error', { error: errText(err) }))
      this.log('info', 'hub attached to relay', { relay: this.describe() })

      // 主动拉一次节点目录。
      //
      // 为什么不能只等中继的 hello/hub：中继在 acceptUpgrade 之后立刻发这一帧，
      // 而它可能和 101 响应挤在同一个 TCP 段里 —— 那时 ws.js 的 connect() 还没
      // resolve，'message' 监听器尚未挂上，帧就丢了。同理，重连时中继也不会为
      // 已连着的节点重播 node/online。显式请求是唯一可靠的对齐方式。
      //
      // 实测（真中继，10 次连接）：hello/hub 到达 0 次、node/list 到达 10 次 ——
      // 该帧确实 100% 丢在 head 里，上面的理由不是推测。
      this.requestNodeList()
    } catch (err) {
      this.log('warn', 'relay connect failed', { relay: this.describe(), error: errText(err) })
      this.schedule()
    } finally {
      this.connecting = false
    }
  }

  /** 请求中继回一份当前节点目录（幂等，可随时调用）。 */
  requestNodeList() {
    if (!this.ready) return false
    try {
      this.conn.send(encodeFrame(envelope(RELAY_FRAME.NODE_LIST, {})))
      return true
    } catch {
      return false
    }
  }

  schedule() {
    if (this.stopped || this.timer) return
    const base = Math.min(this.reconnectMs * 2 ** Math.min(this.attempt, 4), 60_000)
    const delay = base + Math.floor(base * 0.2 * Math.random())
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connectOnce()
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  /** 文本下行帧：text 里已带 `to`，中继靠它路由。 */
  send(_nodeId, text) {
    if (!this.ready) return false
    try {
      this.conn.send(text)
      return true
    } catch {
      return false
    }
  }

  /** 二进制下行帧：buf 头部已带 `to`。 */
  sendBinary(_nodeId, buf) {
    if (!this.ready) return false
    try {
      this.conn.sendBinary(buf)
      return true
    } catch {
      return false
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const conn = this.conn
    this.conn = undefined
    if (conn && !conn.closed) {
      try {
        conn.close(1000, 'hub stopping')
      } catch {
        /* 已断 */
      }
    }
    // connecting 不清：connectOnce 的 finally 会清，且它 resolve 后走
    // `if (this.stopped)` 分支把刚建好的连接关掉（不留半开）。
  }
}

/**
 * 节点注册表。
 *
 * @typedef {object} HubTask
 * @property {string} taskId
 * @property {string} nodeId
 * @property {object} spec          派单时的 TaskSpec（协议层已归一化）
 * @property {string} status
 * @property {boolean} accepted
 * @property {object|null} handoff  副机上报的交接卡
 * @property {object|null} manifest hub 侧从 handoff 派生的产物清单
 * @property {Set<object>} waiters  等待 accept / 终态的等待者
 */
export class NodeRegistry {
  /**
   * @param {object} [identity] hub 身份（lib/identity.js loadOrCreateHubIdentity 的返回值）。
   *   缺省 / 不完整 = hub 身份认证能力关闭：welcome 不带 identity，relay 不追发，
   *   副机按旧协议处理 —— 身份子系统故障绝不演变成"拒绝所有副机"。
   */
  constructor({ log, limits = {}, relay = null, identity = null } = {}) {
    this.log = log ?? (() => {})
    this.limits = {
      helloTimeoutMs: 10_000,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
      pullTimeoutMs: DEFAULT_PULL_TIMEOUT_MS,
      maxPullBytes: 512 * 1024 * 1024,
      maxTasksPerNode: 64,
      ...limits,
    }
    /** nodeId → rec */
    this.nodes = new Map()
    /** 等 hello 的连接 */
    this.pending = new Set()
    /** taskId → HubTask（全局索引，工具只拿得到 taskId） */
    this.tasks = new Map()
    /** @type {import('./pull-manager.js').PullManager | undefined} */
    this.pulls = undefined
    /** @type {RelayLink | undefined} */
    this.relay = relay ?? null
    /** hub 身份（P2-11）：privateKeyB64/publicKeyB64/fingerprint；null = 无身份能力。 */
    this.identity = identity && typeof identity.privateKeyB64 === 'string' ? identity : null
    this.timer = undefined
    this.closed = false
    this.startedAt = Date.now()
  }

  /** 绑定产物拉取管理器（二进制帧路由目标）。 */
  bindPulls(pulls) {
    this.pulls = pulls
  }

  // ─────────────────────────── 连接接入 ───────────────────────────

  /**
   * 接管一条刚 upgrade 完的直连 socket。
   * 第一帧必须是 hello；超时未收到就拒绝并关闭。
   */
  attachDirect(conn, meta = {}) {
    const pending = { conn, remote: meta.remote ?? '', nodeId: '', timer: undefined, done: false }
    this.pending.add(pending)
    pending.timer = setTimeout(() => {
      if (pending.done) return
      pending.done = true
      this.pending.delete(pending)
      this.log('warn', 'hello timeout', { remote: pending.remote })
      this.rejectConn(conn, 'hello-timeout', 'hello frame required as the first frame')
    }, this.limits.helloTimeoutMs)
    if (pending.timer.unref) pending.timer.unref()

    conn.on('message', (payload, isBinary) => {
      try {
        if (isBinary) {
          this.onDirectBinary(pending, payload)
          return
        }
        const dec = decodeFrame(payload)
        if (!dec.ok) {
          this.log('warn', 'node frame undecodable', { error: dec.error, remote: pending.remote })
          return
        }
        this.onDirectFrame(pending, dec.frame)
      } catch (err) {
        this.log('error', 'node frame handler failed', { error: errText(err) })
      }
    })

    const onGone = (reason) => {
      pending.done = true
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(pending)
      const nodeId = pending.nodeId
      if (nodeId) {
        const rec = this.nodes.get(nodeId)
        // 只有"当前生效的那条连接"断开才算掉线（重复实例被拒后断开不算）
        if (rec && rec.conn === conn) this.markOffline(nodeId, reason)
      }
      this.log('info', 'node socket closed', { nodeId: nodeId || undefined, reason })
    }

    conn.on('close', (code, reason) => onGone(`socket closed ${code}${reason ? `: ${reason}` : ''}`))

    // 对端硬断（FIN 无 close 帧）由冻结层统一处理：ws.js 的 WSConnection 构造时
    // 就挂了 `socket.on('end')` → finish(1006) + destroy，所以这里只监听 conn 的
    // 'close' 即可，半关闭不会漏掉下线、fd 也已释放。
    // **不要**再补一层 conn.socket.on('end') 兜底 —— 对端干净 FIN 时同一个事件会
    // 走两遍 onGone，日志里 'node socket closed' 打两条。

    conn.on('error', (err) => this.log('warn', 'node socket error', { error: errText(err) }))
  }

  /** 绑定中继链路：上行帧由中继转发，下行帧靠 header.to / frame.to 路由。 */
  attachRelay(link) {
    this.relay = link
  }

  onDirectFrame(pending, frame) {
    if (!pending.nodeId) {
      if (frame.t !== NODE_TO_HUB.HELLO) {
        this.rejectConn(pending.conn, 'hello-required', `expected hello, got ${frame.t}`)
        return
      }
      this.ingestHello({
        helloData: frame.d,
        conn: pending.conn,
        transport: 'direct',
        pending,
      })
      return
    }
    this.handleFrameFor(pending.nodeId, frame, { conn: pending.conn, transport: 'direct' })
  }

  onDirectBinary(pending, payload) {
    if (!pending.nodeId) {
      this.log('warn', 'binary frame before hello, dropped', { remote: pending.remote })
      return
    }
    const dec = decodeBinaryFrame(payload)
    if (!dec.ok) {
      this.log('warn', 'binary frame undecodable', { error: dec.error })
      return
    }
    this.handleBinaryFor(pending.nodeId, dec.header, dec.payload, { conn: pending.conn })
  }

  /** 中继上行文本帧：中继已把来源写在 frame.from。 */
  handleRelayFrame(frame) {
    try {
      if (frame.t === RELAY_FRAME.HELLO_HUB || frame.t === RELAY_FRAME.NODE_LIST) {
        const list = Array.isArray(frame.d?.nodes) ? frame.d.nodes : []
        for (const summary of list) this.adoptRelaySummary(summary)
        this.log('info', 'relay node directory received', { count: list.length })
        return
      }
      if (frame.t === RELAY_FRAME.NODE_ONLINE) {
        this.adoptRelaySummary(frame.d?.node)
        return
      }
      if (frame.t === RELAY_FRAME.NODE_OFFLINE) {
        const nodeId = frame.d?.nodeId
        if (typeof nodeId === 'string') this.markOffline(nodeId, `relay: ${frame.d?.reason ?? 'offline'}`)
        return
      }
      if (frame.t === RELAY_FRAME.ERROR) {
        this.log('warn', 'relay reported error', { code: frame.d?.code, nodeId: frame.d?.nodeId })
        return
      }
      const from = typeof frame.from === 'string' ? frame.from : ''
      if (from === '') {
        this.log('warn', 'relay frame without source node', { type: frame.t })
        return
      }
      this.handleFrameFor(from, frame, { transport: 'relay' })
    } catch (err) {
      this.log('error', 'relay frame handler failed', { error: errText(err) })
    }
  }

  /** 中继上行二进制帧：来源在 header.from。 */
  handleRelayBinary(header, payload) {
    try {
      const from = typeof header?.from === 'string' ? header.from : ''
      if (from === '') {
        this.log('warn', 'relay binary frame without source node')
        return
      }
      this.handleBinaryFor(from, header, payload, { transport: 'relay' })
    } catch (err) {
      this.log('error', 'relay binary handler failed', { error: errText(err) })
    }
  }

  /**
   * 中继模式下 hub 看不到副机的 hello 帧（中继自己消费了 hello/node），
   * 只广播节点摘要。这里用摘要补一个等价 hello，让上层视图保持一致。
   */
  adoptRelaySummary(summary) {
    if (!summary || typeof summary !== 'object') return
    if (typeof summary.nodeId !== 'string') return
    this.ingestHello({
      helloData: { ...summary, protocol: summary.protocol ?? PROTOCOL_VERSION },
      conn: undefined,
      transport: 'relay',
      pending: undefined,
    })
  }

  /**
   * 处理 hello：校验 → 同 id 冲突判定 → 登记 / 回 welcome。
   */
  ingestHello({ helloData, conn, transport, pending }) {
    const v = validateHello(helloData)
    if (!v.ok) {
      const code = v.error === ERROR_CODE.PROTOCOL_MISMATCH ? ERROR_CODE.PROTOCOL_MISMATCH : 'hello-invalid'
      this.log('warn', 'hello rejected', { reason: v.error, transport })
      if (transport === 'direct') this.rejectConn(conn, code, `invalid hello: ${v.error}`)
      else this.send(helloData?.nodeId, HUB_TO_NODE.ERROR, { code, message: `invalid hello: ${v.error}` })
      this.finishPending(pending)
      return undefined
    }

    const hello = v.hello
    const existing = this.nodes.get(hello.nodeId)
    // 同 id 第二实例：拒掉新连接，保住已经在跑的那个（任务不能被打断）
    if (existing && existing.online && existing.conn && existing.conn !== conn && !existing.conn.closed) {
      this.log('warn', 'duplicate node rejected', { nodeId: hello.nodeId, transport })
      if (transport === 'direct') {
        this.rejectConn(conn, ERROR_CODE.DUPLICATE_NODE, 'another live connection owns this nodeId', hello.nodeId)
      } else {
        this.send(hello.nodeId, HUB_TO_NODE.ERROR, {
          code: ERROR_CODE.DUPLICATE_NODE,
          message: 'another live connection owns this nodeId',
          nodeId: hello.nodeId,
        })
      }
      this.finishPending(pending)
      return undefined
    }

    const rec = existing ?? {
      nodeId: hello.nodeId,
      hello,
      online: false,
      transport,
      since: Date.now(),
      lastSeen: Date.now(),
      conn: undefined,
      tasks: new Map(),
      pendingPulls: new Map(),
    }
    if (!existing) {
      rec.since = Date.now()
      this.nodes.set(hello.nodeId, rec)
    }
    rec.hello = hello
    rec.transport = transport
    rec.online = true
    rec.lastSeen = Date.now()
    rec.conn = transport === 'direct' ? conn : undefined
    this.finishPending(pending, hello.nodeId)

    if (transport === 'direct') this.sendWelcome(rec)
    else this.sendIdentityFrame(rec) // relay：hub 在握手期对副机静默，身份帧必须在上线后追发
    this.log('info', 'node online', { nodeId: hello.nodeId, os: hello.os, transport })
    return rec
  }

  finishPending(pending, nodeId) {
    if (!pending || pending.done) return
    pending.done = true
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(pending)
    if (nodeId) pending.nodeId = nodeId
  }

  /** welcome 里带 config 限制，让副机知道自己该守什么；P2-11 起再带一帧身份证明。 */
  sendWelcome(rec) {
    const data = {
      protocol: PROTOCOL_VERSION,
      nodeId: rec.nodeId,
      limits: {
        heartbeatMs: this.limits.heartbeatMs,
        ackTimeoutMs: this.limits.ackTimeoutMs,
        pullTimeoutMs: this.limits.pullTimeoutMs,
        maxPullBytes: this.limits.maxPullBytes,
        maxTasksPerNode: this.limits.maxTasksPerNode,
      },
      serverTime: Date.now(),
    }
    // 身份证明放在 welcome 里：副机在 markOnline **之前**先验 hub，
    // 验不过连上线资格都没有（副机侧 transport.js 负责拒绝）。
    const identity = this.buildIdentityPayload(rec)
    if (identity) data.identity = identity
    this.send(rec.nodeId, HUB_TO_NODE.WELCOME, data)
  }

  /**
   * 构造 hub 身份证明载荷（P2-11）。
   *
   * nonce 优先用副机 hello 里带来的 —— hub 对"本次连接"签名，副机核对一致
   * 即可确认这不是重放的旧帧。旧版副机 / 中继摘要不带 nonce 时自拟一个，
   * 副机退化为只靠 ±5min 时间窗（主防线仍是 pin 匹配）。
   *
   * 签名失败（私钥坏）返回 undefined：welcome 不带 identity，绝不抛 ——
   * 身份子系统故障不能拖垮接入路径。
   */
  buildIdentityPayload(rec) {
    if (!this.identity) return undefined
    const nonce = typeof rec?.hello?.nonce === 'string' && rec.hello.nonce !== '' ? rec.hello.nonce : newNonce()
    const at = Date.now()
    let sig
    try {
      sig = signIdentity(this.identity.privateKeyB64, {
        fingerprint: this.identity.fingerprint,
        nodeId: rec.nodeId,
        nonce,
        at,
      })
    } catch (err) {
      this.log('warn', 'hub identity sign failed', { error: errText(err) })
      return undefined
    }
    return { fp: this.identity.fingerprint, pub: this.identity.publicKeyB64, sig, at, nonce }
  }

  /**
   * relay 模式追发身份帧（P2-11）。
   *
   * relay 模式下副机的"在线"信号是中继的 hello/node accepted，hub 在握手期
   * 对副机**完全静默** —— 假中继正是利用这个空窗冒充 hub 下发任务。所以
   * 节点一经登记，hub 立刻经中继补一帧 hub/identity。链路未就绪时帧会丢，
   * 靠两条既有路径自愈：hub 与中继重连后 requestNodeList 会重播节点目录
   * （adoptRelaySummary → 本方法），中继的 node/online 通知同理。
   */
  sendIdentityFrame(rec) {
    const payload = this.buildIdentityPayload(rec)
    if (!payload) return false
    return this.send(rec.nodeId, HUB_TO_NODE.IDENTITY, payload)
  }

  /** 在指定连接上回 error 帧然后关闭。 */
  rejectConn(conn, code, message, nodeId) {
    try {
      conn.send(encodeFrame(envelope(HUB_TO_NODE.ERROR, { code, message, nodeId })))
    } catch {
      /* 连接可能已断 */
    }
    try {
      conn.close(1008, code)
    } catch {
      /* 已关闭 */
    }
  }

  // ─────────────────────────── 上行帧处理 ───────────────────────────

  /**
   * 上行文本帧分发。未知帧记日志忽略；任何异常都被吞掉。
   */
  handleFrameFor(nodeId, frame, meta = {}) {
    const rec = this.nodes.get(nodeId)
    if (rec) {
      rec.lastSeen = Date.now()
      if (rec.transport === 'direct' && !rec.conn && meta.conn) rec.conn = meta.conn
    } else if (frame.t !== NODE_TO_HUB.HELLO) {
      // 未知来源的上行帧（hub 重启后副机仍在跑）：登记一个"影子节点"，不丢任务视图
      this.log('warn', 'frame from unknown node', { nodeId, type: frame.t })
    }
    const d = frame.d && typeof frame.d === 'object' ? frame.d : {}

    switch (frame.t) {
      case NODE_TO_HUB.HELLO:
        this.ingestHello({ helloData: d, conn: meta.conn, transport: meta.transport ?? 'direct', pending: undefined })
        return

      case NODE_TO_HUB.TASK_ACCEPT: {
        const t = this.ensureTask(nodeId, d.taskId)
        if (!t) return
        t.accepted = true
        t.acceptedAt = Date.now()
        t.duplicate = d.duplicate === true
        if (typeof d.status === 'string') t.status = d.status
        if (typeof d.workspace === 'string') t.workspace = d.workspace
        if (typeof d.runner === 'string') t.runner = d.runner
        t.updatedAt = Date.now()
        this.resolveWaiters(t)
        return
      }

      case NODE_TO_HUB.TASK_PROGRESS: {
        const t = this.ensureTask(nodeId, d.taskId)
        if (!t) return
        if (typeof d.status === 'string') t.status = d.status
        const entry = {
          phase: typeof d.phase === 'string' ? d.phase : 'progress',
          detail: typeof d.detail === 'string' ? d.detail : typeof d.command === 'string' ? d.command : undefined,
          at: typeof d.at === 'number' ? d.at : Date.now(),
        }
        t.progressTail.push(entry)
        if (t.progressTail.length > 20) t.progressTail.splice(0, t.progressTail.length - 20)
        t.updatedAt = Date.now()
        this.resolveWaiters(t)
        return
      }

      case NODE_TO_HUB.TASK_SUMMARY: {
        const t = this.ensureTask(nodeId, d.taskId)
        if (!t) return
        if (d.handoff && typeof d.handoff === 'object') {
          t.handoff = d.handoff
          if (typeof d.handoff.status === 'string') t.status = d.handoff.status
          if (Array.isArray(d.handoff.changed)) t.changed = d.handoff.changed
          if (d.handoff.summary && typeof d.handoff.summary === 'object') t.summary = d.handoff.summary
          if (d.handoff.exit && typeof d.handoff.exit === 'object') t.exit = d.handoff.exit
          if (typeof d.handoff.workspace === 'string') t.workspace = d.handoff.workspace
          const a = d.handoff.artifacts
          if (a && typeof a === 'object') {
            t.manifest = {
              counts: a.counts ?? null,
              bytesFinal: typeof a.bytesFinal === 'number' ? a.bytesFinal : 0,
              final: Array.isArray(a.final) ? a.final : [],
              intermediateCount: typeof a.intermediateCount === 'number' ? a.intermediateCount : 0,
              note: typeof a.note === 'string' ? a.note : '',
            }
          }
        }
        t.updatedAt = Date.now()
        this.resolveWaiters(t)
        return
      }

      case NODE_TO_HUB.TASK_END: {
        const t = this.ensureTask(nodeId, d.taskId)
        if (!t) return
        if (typeof d.status === 'string') t.status = d.status
        t.endedAt = typeof d.endedAt === 'number' ? d.endedAt : Date.now()
        if (typeof d.durationMs === 'number') t.durationMs = d.durationMs
        if (d.error && typeof d.error === 'object') t.error = d.error
        if (d.manifestCounts && typeof d.manifestCounts === 'object') t.manifestCounts = d.manifestCounts
        t.updatedAt = Date.now()
        this.log('info', 'task ended', { taskId: t.taskId, nodeId, status: t.status })
        this.resolveWaiters(t)
        return
      }

      case NODE_TO_HUB.TASK_SYNC:
        this.applySync(nodeId, d)
        return

      case NODE_TO_HUB.ARTIFACT_MANIFEST: {
        const t = this.ensureTask(nodeId, d.taskId)
        if (!t) return
        if (d.manifest && typeof d.manifest === 'object') t.manifest = d.manifest
        t.updatedAt = Date.now()
        return
      }

      case NODE_TO_HUB.ARTIFACT_DONE:
        // 允许副机把 done 走文本帧（正常走二进制帧，见 handleBinaryFor）
        this.pulls?.ingestDone?.(d)
        return

      case HUB_TO_NODE.PING: {
        // 副机的应用层心跳：回 pong，并顺手刷新 lastSeen（上面已做）
        this.send(nodeId, NODE_TO_HUB.PONG, { echo: frame.id })
        return
      }

      case NODE_TO_HUB.PONG:
        return

      case NODE_TO_HUB.ERROR:
        this.log('warn', 'node reported error', { nodeId, code: d.code, taskId: d.taskId })
        if (d.taskId) {
          const t = this.tasks.get(d.taskId)
          if (t) {
            t.error = { code: d.code ?? 'node-error', message: d.message ?? '' }
            t.updatedAt = Date.now()
            this.resolveWaiters(t)
          }
        }
        return

      default:
        this.log('info', 'unknown frame ignored', { nodeId, type: String(frame.t) })
    }
  }

  /** 二进制上行帧：产物分块 / 完成帧交给 PullManager。 */
  handleBinaryFor(nodeId, header, payload, meta = {}) {
    const type = header?.t
    if (type === NODE_TO_HUB.ARTIFACT_CHUNK) {
      this.pulls?.ingestBinary?.(header, payload, { conn: meta.conn })
      return
    }
    if (type === NODE_TO_HUB.ARTIFACT_DONE) {
      this.pulls?.ingestDone?.(header)
      return
    }
    this.log('info', 'unknown binary frame ignored', { nodeId, type: String(type) })
  }

  /**
   * task/sync：副机的**全量**任务列表 → 重建该节点视图。
   * 列表里没有的、且不是"刚派出去还在途"的任务，从 hub 视图里移除。
   */
  applySync(nodeId, d) {
    const rec = this.nodes.get(nodeId)
    if (!rec) return
    const list = Array.isArray(d?.tasks) ? d.tasks : null
    if (!list) {
      this.log('warn', 'task/sync without tasks[]', { nodeId })
      return
    }
    const seen = new Set()
    for (const view of list) {
      if (!view || typeof view.taskId !== 'string') continue
      seen.add(view.taskId)
      const t = this.ensureTask(nodeId, view.taskId)
      if (!t) continue
      this.applyView(t, view)
    }
    for (const [taskId, t] of [...rec.tasks]) {
      if (seen.has(taskId)) continue
      // 宽限期只给"本 hub 派出去、还没等到 accept"的任务 —— 它可能正在路上。
      // 副机上报过（adopted）却不再出现在 sync 里的任务，说明副机那边已经没有了，
      // 以副机为权威直接移除；否则幽灵任务会一直挂在 hub 视图里。
      if (t.adopted !== true && t.accepted !== true && Date.now() - t.createdAt < this.limits.ackTimeoutMs) continue
      rec.tasks.delete(taskId)
      if (this.tasks.get(taskId) === t) this.tasks.delete(taskId)
    }

    // ── 顺手做一次自动清理（防视图无限累积）────────────────────────────
    //
    // 副机的 TaskStore 默认保留 7 天，所以它会在 sync 里**持续上报**这些终态
    // 任务 —— 上面那个"不在 sync 里就删"的循环因此不会清理它们。hub 视图
    // 一路累积到 `maxTasksPerNode`，然后**任何新任务都被拒**（实测踩到，
    // 连"派一条清理命令"都做不到）。
    //
    // 所以这里主动清：**终态 + 已上报 + 超过保留期**的视图。条件是保守的 ——
    // 只看超过 retainMs 的，刚结束的任务仍可被 remote_status / remote_handoff
    // 查到（那是用户最需要看结果的时候）。
    //
    // 想立即清（不等保留期）用 `remote_purge`。
    const retainMs = this.limits.taskViewRetainMs
    if (retainMs > 0) {
      const cutoff = Date.now() - retainMs
      let pruned = 0
      for (const [taskId, t] of [...rec.tasks]) {
        if (!TERMINAL_STATUS.has(t.status)) continue
        const endedAt = numOr(t.endedAt, 0) || numOr(t.updatedAt, 0) || numOr(t.createdAt, 0)
        if (endedAt >= cutoff) continue
        rec.tasks.delete(taskId)
        if (this.tasks.get(taskId) === t) this.tasks.delete(taskId)
        pruned += 1
      }
      if (pruned > 0) {
        this.log('info', 'pruned old task views', { nodeId, pruned, retainMs })
      }
    }

    this.log('info', 'node task view rebuilt from sync', { nodeId, count: seen.size })
  }

  applyView(t, view) {
    const strFields = ['status', 'mode', 'goal', 'workspace', 'sessionId']
    for (const f of strFields) {
      if (typeof view[f] === 'string') t[f] = view[f]
    }
    const numFields = ['createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs']
    for (const f of numFields) {
      if (typeof view[f] === 'number') t[f] = view[f]
    }
    if (view.exit && typeof view.exit === 'object') t.exit = view.exit
    if (Array.isArray(view.changed)) t.changed = view.changed
    if (view.error && typeof view.error === 'object') t.error = view.error
    if (view.summary && typeof view.summary === 'object') t.summary = view.summary
    if (view.manifestCounts && typeof view.manifestCounts === 'object') t.manifestCounts = view.manifestCounts
    if (Array.isArray(view.progressTail)) t.progressTail = view.progressTail.slice(-20)
    if (Array.isArray(view.logTail)) t.logTail = view.logTail.slice(-40)
    t.viewUpdatedAt = Date.now()
    this.resolveWaiters(t)
  }

  // ─────────────────────────── 任务视图 ───────────────────────────

  /** 取任务；不存在则登记一个（副机先上报、hub 后知道的情况）。 */
  ensureTask(nodeId, taskId) {
    if (typeof taskId !== 'string' || taskId === '') {
      this.log('warn', 'frame without taskId', { nodeId })
      return undefined
    }
    const existing = this.tasks.get(taskId)
    if (existing) return existing
    const rec = this.nodes.get(nodeId)
    if (!rec) return undefined
    const t = {
      taskId,
      nodeId,
      spec: null,
      status: TASK_STATUS.QUEUED,
      accepted: false,
      adopted: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      mode: null,
      goal: null,
      workspace: null,
      sessionId: null,
      exit: null,
      changed: [],
      error: null,
      summary: null,
      manifestCounts: null,
      manifest: null,
      handoff: null,
      progressTail: [],
      logTail: [],
      waiters: new Set(),
    }
    rec.tasks.set(taskId, t)
    this.tasks.set(taskId, t)
    this.log('info', 'task adopted from node report', { taskId, nodeId })
    return t
  }

  getTask(taskId) {
    return this.tasks.get(taskId)
  }

  listTasks() {
    return [...this.tasks.values()]
  }

  /**
   * 工具 remote_status 的输出形状。
   *
   * **必须经 views.js 投影**：这里的每个字段都源自副机上报（`exit`/`changed`/
   * `summary`/`error` 里可能有副机版本的诊断字段），而工具返回值会进会话日志。
   * 此前是逐字段裸拷贝（`exit: t.exit` 等），等于把"副机写什么就回什么"交给模型。
   *
   * 与 UI 路径共用同一份白名单 —— 这是把投影收敛到 views.js 的意义：
   * 新增消费方无处可绕开。
   */
  taskView(t) {
    const rec = this.nodes.get(t.nodeId)
    const base = taskProjection(
      {
        ...t,
        nodeOnline: Boolean(rec?.online),
        // taskProjection 读 t.summary.text，而注册表里存的是 summary 对象
        summary: t.summary && typeof t.summary === 'object' ? t.summary : null,
      },
      { tail: 6 },
    )
    return {
      ...base,
      accepted: t.accepted === true,
      handoffAvailable: Boolean(t.handoff),
    }
  }

  // ─────────────────────────── 等待器 ───────────────────────────

  /**
   * 等一个任务满足条件。超时与取消都会 reject，且一定清理定时器与监听器。
   */
  waitFor(t, predicate, { timeoutMs = 0, signal, label = 'wait' } = {}) {
    if (predicate(t)) return Promise.resolve(t)
    return new Promise((resolve, reject) => {
      const state = { settled: false, timer: undefined, onAbort: undefined }
      const waiter = { check: () => {}, fail: () => {} }
      const settle = (fn, arg) => {
        if (state.settled) return
        state.settled = true
        if (state.timer) clearTimeout(state.timer)
        if (state.onAbort && signal) {
          try {
            signal.removeEventListener('abort', state.onAbort)
          } catch {
            /* signal 可能已失效 */
          }
        }
        t.waiters.delete(waiter)
        fn(arg)
      }
      waiter.check = () => {
        if (predicate(t)) settle(resolve, t)
      }
      waiter.fail = (err) => settle(reject, err)

      if (timeoutMs > 0) {
        state.timer = setTimeout(() => {
          settle(reject, new RemoteAgentError(`${label}: timeout after ${timeoutMs}ms`, ERROR_CODE.INTERNAL))
        }, timeoutMs)
        if (state.timer.unref) state.timer.unref()
      }
      if (signal) {
        state.onAbort = () => settle(reject, new RemoteAgentError(`${label}: aborted`, 'aborted'))
        if (signal.aborted) {
          state.onAbort()
          return
        }
        signal.addEventListener('abort', state.onAbort, { once: true })
      }
      t.waiters.add(waiter)
      if (predicate(t)) waiter.check()
    })
  }

  /** 等 task/accept（或任务直接进入终态 —— 例如工作区被拒）。 */
  awaitAccepted(taskId, opts = {}) {
    const t = this.tasks.get(taskId)
    if (!t) return Promise.reject(new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN))
    return this.waitFor(t, (x) => x.accepted === true || TERMINAL_STATUS.has(x.status), {
      label: `task ${taskId} accept`,
      timeoutMs: opts.timeoutMs ?? this.limits.ackTimeoutMs,
      signal: opts.signal,
    })
  }

  /** 等任务进入终态。 */
  awaitTerminal(taskId, opts = {}) {
    const t = this.tasks.get(taskId)
    if (!t) return Promise.reject(new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN))
    return this.waitFor(t, (x) => TERMINAL_STATUS.has(x.status), {
      label: `task ${taskId} terminal`,
      timeoutMs: opts.timeoutMs ?? 0,
      signal: opts.signal,
    })
  }

  resolveWaiters(t) {
    if (!t.waiters || t.waiters.size === 0) return
    for (const w of [...t.waiters]) {
      try {
        w.check()
      } catch {
        /* 单个等待者出错不影响其他 */
      }
    }
  }

  // ─────────────────────────── 任务下发 ───────────────────────────

  /**
   * 下发一条任务（spec 必须是 validateTaskStart 归一化后的形状）。
   */
  createTask({ nodeId, spec }) {
    const rec = this.nodes.get(nodeId)
    if (!rec) throw new RemoteAgentError(`unknown node: ${nodeId}`, ERROR_CODE.TASK_UNKNOWN)
    if (!rec.online) throw new RemoteAgentError(`node offline: ${nodeId}`, ERROR_CODE.INTERNAL)

    // ═══════════════════════════════════════════════════════════════════════
    // 上限必须按**在跑的任务**算，不能按历史累计
    // ═══════════════════════════════════════════════════════════════════════
    //
    // 原实现：`if (rec.tasks.size >= maxTasksPerNode)` —— 而 `rec.tasks` 里
    // **包含已完成的任务**：它们只在副机的 `task/sync` 不再上报时才被移除
    // （见 applySync 的清理分支），而副机的 TaskStore 默认保留 7 天。
    //
    // 后果（实测踩到）：连续派几十条测试任务后，hub 侧累计到 64 条，
    // **之后任何新任务都被拒**，报 `already holds 64 tasks` —— 连"派一条
    // 清理命令"都做不到，节点彻底不可用。这不是"限制并发"的本意。
    //
    // 正确语义：上限约束**同时进行的任务数**（防一个节点被压垮），
    // 终态任务不该占额度。这里按状态过滤。
    const activeCount = [...rec.tasks.values()].filter(
      (t) => t && !TERMINAL_STATUS.has(t.status),
    ).length
    if (activeCount >= this.limits.maxTasksPerNode) {
      throw new RemoteAgentError(
        `node ${nodeId} already has ${activeCount} active tasks (maxTasksPerNode=${this.limits.maxTasksPerNode})`,
        ERROR_CODE.INTERNAL,
      )
    }
    if (this.tasks.has(spec.taskId)) {
      throw new RemoteAgentError(`taskId already used: ${spec.taskId}`, ERROR_CODE.TASK_DUPLICATE)
    }

    const t = {
      taskId: spec.taskId,
      nodeId,
      spec,
      status: TASK_STATUS.QUEUED,
      accepted: false,
      adopted: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      mode: spec.mode,
      goal: spec.goal,
      workspace: spec.workspace ?? null,
      sessionId: null,
      exit: null,
      changed: [],
      error: null,
      summary: null,
      manifestCounts: null,
      manifest: null,
      handoff: null,
      progressTail: [],
      logTail: [],
      waiters: new Set(),
    }
    rec.tasks.set(spec.taskId, t)
    this.tasks.set(spec.taskId, t)

    const sent = this.send(nodeId, HUB_TO_NODE.TASK_START, { ...spec })
    if (!sent) {
      rec.tasks.delete(spec.taskId)
      this.tasks.delete(spec.taskId)
      throw new RemoteAgentError(`node unreachable: ${nodeId}`, ERROR_CODE.INTERNAL)
    }
    this.log('info', 'task dispatched', { taskId: spec.taskId, nodeId, mode: spec.mode })
    return t
  }

  /** 取消任务。找不到 / 节点不在线都返回 false，不抛。 */
  cancelTask(taskId) {
    const t = this.tasks.get(taskId)
    if (!t) return false
    const ok = this.send(t.nodeId, HUB_TO_NODE.TASK_CANCEL, { taskId, reason: 'hub-request' })
    if (ok) this.log('info', 'task cancel requested', { taskId, nodeId: t.nodeId })
    return ok
  }

  /**
   * 清理 hub 侧的**终态**任务视图。
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * 为什么需要它（实测踩到的死锁）
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * hub 侧的任务视图只在**副机的 `task/sync` 不再上报某任务**时才清理
   * （见 `applySync`）。而副机的 TaskStore 默认保留 7 天 —— 于是：
   *
   *   连续派 N 条任务 → hub 视图累积 N 条 → 撞上 `maxTasksPerNode`
   *   → **之后任何新任务都被拒**，连"派一条清理命令"都做不到
   *
   * 这是**自锁**：唯一的解法是人工去副机删文件。实测连续几十条测试任务后
   * 节点就不可用了。
   *
   * ── 这个方法的语义 ────────────────────────────────────────────────────────
   * **只清 hub 侧的视图，不碰副机的任务状态** —— 副机是任务状态的权威
   * （见 lib/node/task-store.js），hub 只是投影。所以：
   *
   *   - 清掉后，如果副机还在 sync 里上报这些任务，它们会**自动重建**
   *     （`applySync` → `ensureTask`）。这没问题 —— 说明副机还认为它们该在。
   *   - 清掉后，`remote_status` 查不到已清的任务。这是**用户主动要求**的结果。
   *
   * 也就是说：本方法是"重置 hub 视图"的逃生舱，幂等、可重复调用。
   *
   * @param {object} [o]
   * @param {string} [o.nodeId] 只清这个节点；省略则清全部
   * @param {boolean} [o.includeActive=false] 是否连**在跑的任务**也清
   *   （默认只清终态。清在跑的会让 `remote_status` 查不到，但任务仍在副机继续跑）
   * @returns {{removed: number, kept: number}}
   */
  purgeTasks({ nodeId, includeActive = false } = {}) {
    let removed = 0
    let kept = 0
    for (const [taskId, t] of [...this.tasks]) {
      if (typeof nodeId === 'string' && nodeId !== '' && t.nodeId !== nodeId) continue
      const terminal = TERMINAL_STATUS.has(t.status)
      if (!terminal && !includeActive) {
        kept += 1
        continue
      }
      this.tasks.delete(taskId)
      const rec = this.nodes.get(t.nodeId)
      if (rec) rec.tasks.delete(taskId)
      removed += 1
    }
    if (removed > 0) this.log('info', 'task views purged', { removed, kept, nodeId: nodeId ?? '(all)' })
    return { removed, kept }
  }

  // ─────────────────────────── 发送 ───────────────────────────

  /**
   * 发一个文本帧给节点。
   * `to` 始终带上：直连时无害，经中继时是路由依据。
   */
  send(nodeId, type, data, opts = {}) {
    if (typeof nodeId !== 'string' || nodeId === '') return false
    const text = encodeFrame({ ...envelope(type, data, opts), to: nodeId })
    const rec = this.nodes.get(nodeId)
    const conn = rec?.conn
    if (conn && !conn.closed) {
      try {
        conn.send(text)
        return true
      } catch (err) {
        this.log('warn', 'send failed on direct conn', { nodeId, error: errText(err) })
      }
    }
    if (this.relay?.ready) return this.relay.send(nodeId, text)
    return false
  }

  /** 发一个二进制帧给节点（header.to 由中继用来路由）。 */
  sendBinary(nodeId, header, payload) {
    if (typeof nodeId !== 'string' || nodeId === '') return false
    let buf
    try {
      buf = encodeBinaryFrame({ ...header, to: nodeId }, payload)
    } catch (err) {
      // 头部过大等编码失败：如实记日志并返回 false，不让调用方炸掉。
      this.log('warn', 'binary frame encode failed', { nodeId, error: errText(err) })
      return false
    }
    const rec = this.nodes.get(nodeId)
    const conn = rec?.conn
    if (conn && !conn.closed) {
      try {
        conn.sendBinary(buf)
        return true
      } catch (err) {
        this.log('warn', 'sendBinary failed on direct conn', { nodeId, error: errText(err) })
      }
    }
    if (this.relay?.ready) return this.relay.sendBinary(nodeId, buf)
    return false
  }

  // ─────────────────────────── 节点视图 ───────────────────────────

  getNode(nodeId) {
    return this.nodes.get(nodeId)
  }

  onlineNodes() {
    return [...this.nodes.values()].filter((r) => r.online)
  }

  /** 按 nodeId 或主机名挑节点；prefer 为空时返回唯一在线节点。 */
  pickNode(prefer = '') {
    const online = this.onlineNodes()
    const want = String(prefer ?? '').trim().toLowerCase()
    if (want !== '') {
      const hit = online.find(
        (r) => r.nodeId.toLowerCase() === want || String(r.hello?.hostname ?? '').toLowerCase() === want,
      )
      if (hit) return hit
      const known = this.nodes.get(prefer)
      if (known) return known
      return undefined
    }
    if (online.length === 1) return online[0]
    return undefined
  }

  /** 工具 remote_nodes 的输出。 */
  list() {
    return [...this.nodes.values()].map((r) => ({
      nodeId: r.nodeId,
      os: r.hello?.os ?? 'unknown',
      arch: r.hello?.arch ?? 'unknown',
      hostname: r.hello?.hostname ?? r.nodeId,
      online: r.online === true,
      roots: Array.isArray(r.hello?.roots) ? r.hello.roots : [],
      caps: Array.isArray(r.hello?.caps) ? r.hello.caps : [],
      agentMode: r.hello?.agentMode === true,
      since: r.since,
      lastSeen: r.lastSeen,
      taskCount: r.tasks.size,
    }))
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  markOffline(nodeId, reason) {
    const rec = this.nodes.get(nodeId)
    if (!rec) return
    if (!rec.online && !rec.conn) return
    rec.online = false
    rec.lastSeen = Date.now()
    rec.conn = undefined
    this.log('info', 'node offline', { nodeId, reason })
    // 断连时在途的产物分块必然残缺，直接失败掉，别让临时文件挂着
    this.pulls?.onNodeOffline?.(nodeId)
  }

  startHeartbeat() {
    if (this.timer || this.closed) return
    // 下限 1000ms：心跳巡检没必要更密，避免在大量节点时打满定时器
    const ms = Math.max(1000, this.limits.heartbeatMs)
    this.timer = setInterval(() => this.tick(), ms)
    if (this.timer.unref) this.timer.unref()
  }

  /**
   * 一次心跳巡检。
   *
   * 两条路径都要有超时兜底（D7 修复）：
   *
   *   direct 模式（rec.conn 存在）：ping + 超时 conn.destroy()
   *
   *   relay 模式（rec.conn === undefined）：早期版本这里只靠"中继会发 node/offline"，
   *   但**中继自己死了就没人发** —— 实测 relay 整体死亡后 rec.online 永远为 true
   *   （+20s 仍 online:true），remote_nodes 报在线、remote_task 才失败，
   *   运维看到的是"节点在线但派不动活"。现在同样用 lastSeen 做超时判定。
   *
   * 公开方法（不只是内部回调），因为它是 C2-1/D7 的可测试入口。
   */
  tick() {
    if (this.closed) return
    const now = Date.now()
    for (const rec of this.nodes.values()) {
      if (!rec.online) continue
      const conn = rec.conn

      if (conn && !conn.closed) {
        try {
          conn.ping()
        } catch {
          /* 已断，close 事件会接手 */
        }
        if (now - rec.lastSeen > this.limits.heartbeatMs * 4) {
          this.log('warn', 'node heartbeat timeout', { nodeId: rec.nodeId, mode: 'direct' })
          try {
            conn.destroy(new Error('heartbeat timeout'))
          } catch {
            /* 已销毁 */
          }
        }
        continue
      }

      // relay 模式：没有专属 socket 可 ping，只能看 lastSeen。
      // 阈值放宽到 8 倍（direct 是 4 倍）：relay 的上行帧要经一跳，
      // 且节点侧 heartbeat 与中继转发都有各自的抖动，宁可晚判也不误杀。
      const relayTimeoutMs = this.limits.heartbeatMs * 8
      if (now - rec.lastSeen > relayTimeoutMs) {
        this.log('warn', 'node heartbeat timeout', {
          nodeId: rec.nodeId,
          mode: 'relay',
          silentMs: now - rec.lastSeen,
        })
        // 没有 socket 可 destroy，走与"节点主动断开"相同的下线路径，
        // 保证 tasks 投影保留（任务状态真身在副机）而 online 翻 false。
        try {
          this.markOffline(rec.nodeId, 'heartbeat timeout (relay)')
        } catch {
          /* 已被其他路径下线 */
        }
      }
    }
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const pending of [...this.pending]) {
      pending.done = true
      if (pending.timer) clearTimeout(pending.timer)
      try {
        pending.conn.close(1001, 'hub shutting down')
      } catch {
        /* 已断 */
      }
    }
    this.pending.clear()
    for (const rec of this.nodes.values()) {
      const conn = rec.conn
      rec.online = false
      rec.conn = undefined
      if (conn && !conn.closed) {
        try {
          conn.close(1001, 'hub shutting down')
        } catch {
          /* 已断 */
        }
      }
    }
    for (const t of this.tasks.values()) {
      for (const w of [...t.waiters]) w.fail(new RemoteAgentError('hub shutting down', 'aborted'))
      t.waiters.clear()
    }
    this.tasks.clear()
    // rec.tasks 用可选链：dispose 是清理路径，不该因为某个 rec 形状不全而抛错
    // 把整个卸载流程打断（那会让后面的 nodes.clear / relay.stop 都执行不到）。
    for (const rec of this.nodes.values()) rec.tasks?.clear?.()
    // 节点表也要清：卸载后不该再有任何引用挂着副机的主机名 / 工作区根。
    this.nodes.clear()
    try {
      this.relay?.stop()
    } catch {
      /* 已停 */
    }
    this.relay = null
    this.pulls = undefined
  }
}
