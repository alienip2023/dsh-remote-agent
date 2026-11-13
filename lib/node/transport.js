/**
 * 副机侧的传输层：把"连到 hub"这件事抽象成两种后端。
 *
 *   direct —— 直连 hub 的 WebSocket 端点（双方至少一方有公网地址 / cloudflared）
 *   relay  —— 经中继 VPS 会合（双方都在 NAT 后）
 *
 * 对上层（worker）暴露同一个接口：send / sendBinary / on('frame') / on('binary')。
 * 任务逻辑完全不需要知道自己在走哪条管子 —— 这是 transportMode 能成为纯配置项的前提。
 *
 * 重连策略：指数退避 + 抖动，封顶 30s。断连期间任务**不中断**（核心不变式），
 * 重连成功后由 worker 主动 task/sync 上报状态，hub 侧由此重建视图。
 */
import { EventEmitter } from 'node:events'
import {
  ERROR_CODE,
  HUB_TO_NODE,
  NODE_TO_HUB,
  PROTOCOL_VERSION,
  RELAY_FRAME,
  decodeBinaryFrame,
  decodeFrame,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
} from '../protocol.js'
import { connect } from '../ws.js'
// P2-11：hub 身份验证。transport 不碰 fs —— pin 落盘经构造注入（pinStore）。
import { fingerprintOf, newNonce, normalizeFingerprint, verifyIdentity } from '../identity.js'
// 提案 #1：E2E 会话加密（中继不可见业务帧内容）。
import { E2E_MARKER, generateEphemeral, verifyExchange, createSession, normalizeE2EPub } from '../e2e.js'

export const TRANSPORT_MODE = Object.freeze({ DIRECT: 'direct', RELAY: 'relay' })

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

/**
 * fork.61：duplicate-node 的重试预算。
 *
 * 为什么不再当致命错误：节点进程重启（配置推送后的 scheduleRestart 就是）时，
 * 中继还留着旧进程的记录（旧连接的 close 要晚到几秒），新连接因此被回
 * duplicate-node。这是一个几秒内自愈的竞态，不是配置错误。
 *
 * 默认 1s/2s/4s/8s/16s/16s/…，累计（不含抖动）不超过 600s（约 10 分钟，约 40 次重连）；
 * 超过预算才按原样 stop() 等人工。预算按「计划等待时间」累加而不是读时钟，
 * 这样行为可确定地测试。
 *
 * 为什么是 600s（fork.62，原 fork.61 为 120s）：中继对「没有 FIN 的旧连接」要靠空闲淘汰
 * 才会清掉记录——空闲 idleMs(3min) 发 ping，再等 idleMs 仍无回应才 destroy，加上扫描
 * 间隔 sweepMs(1min)，最坏约 7 分钟。120s 的预算在旧记录消失之前就 fatal 了（验收官用
 * 缩比中继实测：同比 120s 预算在 623ms 就停，3000ms 预算则成功）。
 */
export const DUPLICATE_RETRY_DEFAULTS = Object.freeze({ baseMs: 1000, maxMs: 16_000, totalMs: 600_000 })
const DUPLICATE_RETRY_TOTAL_CEILING_MS = 3_600_000

/** 合法 = 有限的正数（YAML 里写成字符串的数字不认）；非法的字段各自回退默认。 */
export function resolveDuplicateRetry(raw) {
  const d = DUPLICATE_RETRY_DEFAULTS
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
  const baseMs = ok(src.baseMs) ? src.baseMs : d.baseMs
  let maxMs = ok(src.maxMs) ? src.maxMs : d.maxMs
  if (maxMs < baseMs) maxMs = baseMs
  const totalMs = ok(src.totalMs) && src.totalMs <= DUPLICATE_RETRY_TOTAL_CEILING_MS ? src.totalMs : d.totalMs
  return { baseMs, maxMs, totalMs }
}

/** 第 n 次（从 1 起）duplicate 重试的基础等待（不含抖动）。 */
export function duplicateBackoffMs(n, cfg = DUPLICATE_RETRY_DEFAULTS) {
  const k = Math.max(1, Math.floor(n))
  return Math.min(cfg.baseMs * 2 ** Math.min(k - 1, 30), cfg.maxMs)
}
const HEARTBEAT_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 45_000
/**
 * 握手超时：upgrade 成功后，hub 必须在这个时间内回 welcome（direct）或
 * 中继回 accepted（relay）。此前 heartbeat 只在 markOnline 之后启动，
 * 服务端若 upgrade 后不发帧，连接会**永久挂起且不重连** —— 小白看到的就是
 * "副机没反应"，而日志里连一条错误都没有。
 *
 * 取值与 hub 侧 helloTimeoutMs（10s）对齐：两边给同一次握手各 10s 预算。
 */
const HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * P2-11：relay 模式下等 hub 追发身份帧的宽限窗口。
 * direct 模式不需要它 —— 身份就在 welcome 里，随握手一起到。
 */
export const IDENTITY_GRACE_MS = 15_000
/** hub 身份帧时间戳容差：双方时钟各让 5 分钟。 */
export const IDENTITY_MAX_SKEW_MS = 5 * 60 * 1000

/**
 * 提案 #1：会话建立后**必须加密**的下行业务帧类型。
 * 明文形态出现在这里 = 伪造（中继运营者持有 enrollToken 可冒充 hub）或
 * hub 丢失会话 —— 一律拒绝执行并回 e2e-required。
 * welcome / hub/identity / error / ping / hub/e2e 是握手与控制面，永远明文豁免。
 */
const E2E_REQUIRED_TYPES = new Set([
  HUB_TO_NODE.TASK_START,
  // 名单第 2 步：bot/turn 带会话正文，必须加密。
  HUB_TO_NODE.BOT_TURN,
  HUB_TO_NODE.TASK_CANCEL,
  HUB_TO_NODE.TASK_QUERY,
  HUB_TO_NODE.ARTIFACT_LIST,
  HUB_TO_NODE.ARTIFACT_PULL,
  HUB_TO_NODE.ARTIFACT_CANCEL,
  // 远程文件请求（提案 #25）：目录结构与文件内容是敏感信息，必须加密。
  HUB_TO_NODE.FS_REQ,
  // 工作区共享请求（2026-10-17）：帧里含工作区**绝对路径**（暴露副机的
  // 目录结构），必须加密。
  HUB_TO_NODE.SHARE_REQ,
  // 名单第 3 步：bot/create 携带 modelRef / workDir / instructions，必须加密。
  HUB_TO_NODE.BOT_CREATE,
  HUB_TO_NODE.BOT_HISTORY,
  HUB_TO_NODE.BOT_UPDATE,
  // 停掉节点上的 Bot 回合：帧里带 Bot 身份，与其它 bot/* 帧同口径。
  HUB_TO_NODE.BOT_STOP,
  // M2：config-push 携带 apiKey 明文，必须加密。
  HUB_TO_NODE.CONFIG_PUSH,
  // T9a：peer roster 暴露主控的 Bot 名单，必须加密。
  HUB_TO_NODE.PEER_ROSTER,
  // M2：节点 Bot 清单暴露节点上有哪些 Bot，必须加密。
  NODE_TO_HUB.BOT_INVENTORY,
])

/**
 * 判断一个帧类型是否必须加密。导出给测试和审计代码使用。
 * 刀：从 E2E_REQUIRED_TYPES 删掉 BOT_CREATE → isE2ERequired('bot/create') 返回 false → 测试红。
 */
export function isE2ERequired(type) {
  return E2E_REQUIRED_TYPES.has(type)
}

/**
 * 纯函数：判断入站帧是否应被 E2E 门拒绝。
 * 抽出来让测试可以直接调用，不依赖 WebSocket 基础设施。
 * 刀：把 wasEncrypted 去掉（恒 true）→ 即使明文帧也通过 → 测试红。
 *
 * @param {{ t: string }} frame 入站帧
 * @param {{ e2e: boolean, wasEncrypted: boolean }} opts
 * @returns {{ rejected: true, code: string, message: string } | { rejected: false }}
 */
export function checkE2EGate(frame, { e2e, wasEncrypted }) {
  if (e2e && !wasEncrypted && E2E_REQUIRED_TYPES.has(frame.t)) {
    return {
      rejected: true,
      code: ERROR_CODE.E2E_REQUIRED,
      message: `unencrypted ${frame.t} rejected while e2e session active`,
    }
  }
  return { rejected: false }
}

/** 副机侧永远明文的帧类型（握手/心跳/交换本身）。 */
const E2E_CLEAR_TYPES = new Set([
  'hello',
  RELAY_FRAME.HELLO_NODE,
  'ping',
  'pong',
  NODE_TO_HUB.E2E_OFFER,
])

/** 把各种写法收敛成 ws:// 或 wss:// 的 URL。 */
export function normalizeWsUrl(raw, fallbackPath = '/') {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  let s = raw.trim()
  if (!/^wss?:\/\//i.test(s)) {
    if (/^https:\/\//i.test(s)) s = `wss://${s.slice(8)}`
    else if (/^http:\/\//i.test(s)) s = `ws://${s.slice(7)}`
    else s = `ws://${s}`
  }
  try {
    const u = new URL(s)
    if (u.pathname === '/' || u.pathname === '') u.pathname = fallbackPath
    return u.toString()
  } catch {
    return ''
  }
}

/**
 * 一个可重连的节点连接。
 * 事件：'online'(ack) / 'offline'(reason) / 'reconnecting'({attempt,delayMs}) /
 *       'frame'(frame) / 'binary'(header,payload) / 'error'(err)
 */
export class NodeTransport extends EventEmitter {
  constructor(o) {
    super()
    this.mode = o.mode === TRANSPORT_MODE.RELAY ? TRANSPORT_MODE.RELAY : TRANSPORT_MODE.DIRECT
    this.rawUrl = o.url
    this.token = o.token ?? ''
    this.hello = o.hello
    this.heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS
    this.conn = undefined
    // 并发闸门（2026-10-17 修 L1）：防 start() 被调两次时开两条 TCP 连接。
    // 见 connectOnce 的说明。
    this.connecting = false
    this.online = false
    this.attempt = 0
    this.stopped = false
    // fork.61：duplicate-node 重试状态（markOnline 清零）
    this.dupRetry = resolveDuplicateRetry(o.duplicateRetry)
    this.dupCount = 0
    this.dupSpentMs = 0
    /** 已决定重试、等本条连接 close 后据此排期的等待毫秒数；undefined = 无。 */
    this.dupPendingMs = undefined
    this.lastPongAt = 0
    this.timer = undefined
    this.hbTimer = undefined
    this.hsTimer = undefined
    // ── P2-11：hub 身份验证 ──
    // pinnedFingerprint 来自显式配置（最高优先级）；pinStore 是 TOFU 落盘的
    // 三件套 { get/set/clear }，由 worker 用 <stateDir>/hub-pin.json 实现 ——
    // transport 自身不碰 fs，测试可以注入内存实现。
    this.pinnedFingerprint = normalizeFingerprint(o.pinnedFingerprint ?? '')
    this.pinStore = o.pinStore ?? null
    this.identityGraceMs = Number.isFinite(o.identityGraceMs) ? o.identityGraceMs : IDENTITY_GRACE_MS
    /** hub 身份状态：'pending'（未验证）| 'ok'（已验过）| 'absent'（hub 未提供，旧版兼容）。 */
    this.hubIdentity = 'pending'
    this.identityTimer = undefined
    // ── 提案 #1：E2E 会话加密 ──
    // e2e:false 可关（默认开）。会话/提议随连接生死：close 一律清零。
    this.e2eEnabled = o.e2e !== false
    /** 已协商的 E2ESession（null = 明文）。 */
    this.e2e = null
    /** 在途的握手提议 { privateKeyB64, publicKeyB64, nonce, timer }。 */
    this.e2eOffer = null
    /** 已验证的 hub 身份 { fp, pub }（E2E 确认帧的验签锚）。 */
    this.identityPeer = null
  }

  resolveUrl() {
    if (this.mode === TRANSPORT_MODE.RELAY) {
      const base = normalizeWsUrl(this.rawUrl, '/relay')
      if (base === '') return ''
      const u = new URL(base)
      u.searchParams.set('role', 'node')
      // ⚠ token **不再**放进 URL query。
      //
      // 原来这里是 `u.searchParams.set('token', this.token)` —— 而 URL 会进
      // 各级访问日志（中继自己的 access log、反向代理、CDN、浏览器历史、
      // Referer）。凭证写进 URL 等于把密钥抄在很多地方。
      //
      // 中继侧本来就支持 header 优先：
      //   `url.searchParams.get('token') ?? req.headers['x-relay-token']`
      // 所以改成走 header（见 connectOnce 里的 headers）。
      //
      // direct 模式早就是这个做法（`x-dsh-token` header），relay 模式此前与它
      // 不对称 —— 这是评审指出的不一致。
      u.searchParams.set('nodeId', this.hello.nodeId)
      return u.toString()
    }
    return normalizeWsUrl(this.rawUrl, '/api/remote-agent/node')
  }

  start() {
    this.stopped = false
    void this.connectOnce()
  }

  async connectOnce() {
    if (this.stopped) return

    // ⚠ 并发闸门（2026-10-17 修 L1）：`start()` 可能被调两次（cordis effect
    // 热重载会重跑 applyWorker）。没有这道闸门就会开两条 TCP 连接，随后陈旧
    // 连接的 close 把 `this.conn` 清成 undefined —— 活着的新连接变成引用丢失
    // 的孤儿，发送全失败，重连又被中继 duplicate-node 拒，副机永久失联。
    //
    // hub 侧的 `RelayLink` 早有这道闸门（那是用真中继动态测试查出来的），
    // 副机侧当时没对称复制过来。
    if (this.connecting) return
    this.connecting = true
    try {
      await this.connectOnceInner()
    } finally {
      this.connecting = false
    }
  }

  async connectOnceInner() {
    if (this.stopped) return
    const url = this.resolveUrl()
    if (url === '') {
      this.emit('error', new Error(`transport: invalid url "${this.rawUrl}"`))
      this.scheduleReconnect()
      return
    }

    // 凭证一律走 header，不走 URL query（URL 会进各级日志）。
    // 两种模式用不同的 header 名，因为两端是不同组件：
    //   direct → 主机 DSH 的直连 upgrade 端点，认 `x-dsh-token`
    //   relay  → 中继服务，认 `x-relay-token`
    const headers = {}
    if (this.token) {
      if (this.mode === TRANSPORT_MODE.DIRECT) headers['x-dsh-token'] = this.token
      else headers['x-relay-token'] = this.token
    }

    try {
      const conn = await connect(url, { headers, name: `node:${this.hello.nodeId}` })
      if (this.stopped) {
        conn.close(1000, 'stopped')
        return
      }
      this.conn = conn
      this.attach(conn)
      // P2-11：新连接 → hub 身份重新进入待验证态（上一条连接的结论对新连接无效，
      // 也可能连到了另一个 hub）。worker 侧凭这个状态拦宽限窗口内的任务。
      this.setHubIdentity('pending')
      // 提案 #1：新连接 = 旧会话密钥作废（ECDH 临时钥不复用），从头协商。
      this.resetE2E()
      this.handshake()
      this.armHandshakeTimeout(conn)
    } catch (err) {
      this.emit('error', err)
      this.scheduleReconnect()
    }
  }

  /**
   * 握手超时守卫。upgrade 成功、hello 发出之后，`markOnline`（welcome /
   * accepted）必须在预算内到达；不到就毁掉这条连接 —— close 处理器会照常
   * 走重连退避，避免"TCP 连着但永远上不了线"的哑状态。
   *
   * 必须校验 `this.conn === conn`：超时触发时连接可能已被更新的连接顶替
   * （与 RelayLink 的陈旧连接问题同源），此时不能动新连接。
   */
  armHandshakeTimeout(conn) {
    this.stopHandshakeTimeout()
    this.hsTimer = setTimeout(() => {
      this.hsTimer = undefined
      if (this.online || this.conn !== conn || conn.closed) return
      this.emit('error', new Error(`handshake timeout: no welcome/accepted within ${HANDSHAKE_TIMEOUT_MS}ms`))
      try {
        conn.destroy(new Error('handshake timeout'))
      } catch {
        /* 已销毁，close 处理器接手 */
      }
    }, HANDSHAKE_TIMEOUT_MS)
    if (this.hsTimer.unref) this.hsTimer.unref()
  }

  stopHandshakeTimeout() {
    if (this.hsTimer) {
      clearTimeout(this.hsTimer)
      this.hsTimer = undefined
    }
  }

  attach(conn) {
    conn.on('message', (payload, isBinary) => {
      if (isBinary) {
        const dec = decodeBinaryFrame(payload)
        if (!dec.ok) {
          this.emit('error', new Error(`transport: bad binary frame (${dec.error})`))
          return
        }
        // E2E 解密（提案 #1）：带标记的先拆密，把内层 header/payload 交上层。
        let hdr = dec.header
        let pl = dec.payload
        if (hdr && hdr.e2e === E2E_MARKER) {
          if (!this.e2e) {
            this.emit('error', new Error('收到加密二进制帧但 E2E 会话未建立，已丢弃'))
            this.reofferAfterUnreadable()
            return
          }
          try {
            const opened = this.e2e.openBinary(hdr.t, hdr, pl)
            hdr = opened.header
            pl = opened.payload
          } catch (err) {
            this.emit('error', new Error(`E2E 二进制解密失败，已丢弃：${err?.message ?? err}`))
            return
          }
        }
        this.emit('binary', hdr, pl)
        return
      }
      const dec = decodeFrame(payload)
      if (!dec.ok) {
        this.emit('error', new Error(`transport: bad frame (${dec.error})`))
        return
      }
      this.handleFrame(dec.frame)
    })

    conn.on('pong', () => {
      this.lastPongAt = Date.now()
    })

    conn.on('close', (code, reason) => {
      // ⚠ 陈旧连接校验（2026-10-17 修 L1，与并发闸门配套）。
      //
      // 只有"当前连接"的 close 才有权清理状态。否则陈旧连接的 close 会把
      // 活着的新连接引用清掉（`this.conn = undefined`）→ 新连接变孤儿 →
      // 发送全失败 + 重连被中继 duplicate-node 拒 → 副机永久失联。
      //
      // 这是 hub 侧 `RelayLink` 早已有的第二条不变式，副机侧当时没复制过来。
      if (this.conn !== conn) {
        // 不是当前连接：什么都不做（它的 close 与当前状态无关）
        return
      }
      const wasOnline = this.online
      this.online = false
      this.conn = undefined
      this.stopHandshakeTimeout()
      this.stopHeartbeat()
      this.stopIdentityGrace()
      // 提案 #1：会话随连接生死 —— 密钥材料销毁，下条连接重新协商。
      this.resetE2E()
      if (wasOnline) this.emit('offline', `closed ${code}${reason ? `: ${reason}` : ''}`)
      if (!this.stopped) this.scheduleReconnect()
    })

    conn.on('error', (err) => this.emit('error', err))
  }

  handshake() {
    // P2-11：每次连接换 nonce，hub 把它签进身份证明 —— 录一帧旧 welcome
    // 重放给新连接会因 nonce 对不上被拒。hello 冻结等异常时静默退化
    // （hub 自拟 nonce + ±5min 时间窗兜底）。
    try {
      this.hello.nonce = newNonce()
    } catch {
      /* hello 只读：走退化路径 */
    }
    if (this.mode === TRANSPORT_MODE.RELAY) {
      this.sendRaw(RELAY_FRAME.HELLO_NODE, { ...this.hello, protocol: PROTOCOL_VERSION })
      return
    }
    this.sendRaw('hello', { ...this.hello, protocol: PROTOCOL_VERSION })
  }

  handleFrame(frame) {
    // E2E 解密（提案 #1）：带标记的帧先拆密再走分发。会话不存在时丢帧 ——
    // 正常时序里 ack 先于任何密文到达（WS FIFO），除非被中间人插队。
    let wasEncrypted = false
    if (frame.d && frame.d.e2e === E2E_MARKER) {
      if (!this.e2e) {
        this.emit('error', new Error('收到加密帧但 E2E 会话未建立，已丢弃（疑似伪造或时序错乱）'))
        this.reofferAfterUnreadable()
        return
      }
      try {
        frame = { ...frame, d: this.e2e.openFrame(frame.t, frame.id, frame.d) }
        wasEncrypted = true
      } catch (err) {
        this.emit('error', new Error(`E2E 解密失败，已丢弃该帧：${err?.message ?? err}`))
        return
      }
    }
    if (frame.t === 'welcome') {
      if (this.mode === TRANSPORT_MODE.DIRECT) {
        // P2-11：先验 hub 身份，验过才上线 —— 假 hub 回一帧 welcome 让副机
        // 上线的路，在这里被钉住的指纹挡死。
        const v = this.verifyHubIdentity(frame.d?.identity)
        if (!v.ok) {
          this.failHubIdentity(v.reason)
          return
        }
        this.setHubIdentity(v.status)
        this.markOnline(frame.d)
      }
      return
    }
    if (frame.t === HUB_TO_NODE.IDENTITY) {
      // P2-11：relay 模式 hub 在上线后追发的身份帧（direct 模式重发也照收，
      // 幂等 —— 验证逻辑无副作用，只有 TOFU 首次落盘）。
      this.stopIdentityGrace()
      const v = this.verifyHubIdentity(frame.d)
      if (!v.ok) {
        this.failHubIdentity(v.reason)
        return
      }
      this.setHubIdentity(v.status)
      return
    }
    if (frame.t === HUB_TO_NODE.E2E_ACK) {
      // 提案 #1：密钥交换确认。明文帧（此时还没有共享密钥）。
      this.handleE2EAck(frame.d)
      return
    }
    if (frame.t === RELAY_FRAME.HELLO_HUB) {
      // relay 自身的握手回执，节点继续等 hello/node 的 accepted
      return
    }
    if (frame.t === RELAY_FRAME.HELLO_NODE) {
      if (this.mode === TRANSPORT_MODE.RELAY) {
        if (frame.d?.accepted === true) {
          this.markOnline({ relay: true, nodeId: frame.d.nodeId })
          // P2-11：relay 模式的"在线"信号来自中继，hub 身份还没验 —— 开一个
          // 宽限窗口等追发的 hub/identity；窗口内到达的任务由 worker 拦下。
          this.armIdentityGrace()
        } else this.emit('error', new Error(`relay rejected hello: ${JSON.stringify(frame.d)}`))
      }
      return
    }
    // 中继级错误与 hub 错误帧共用 t='error'（RELAY_FRAME.ERROR === HUB_TO_NODE.ERROR）。
    if (frame.t === RELAY_FRAME.ERROR) {
      const code = frame.d?.code ?? 'relay-error'
      if (code === ERROR_CODE.E2E_RESET) {
        // 提案 #1：hub 侧丢了会话（典型：hub 重启而中继连接还在）。清掉本地
        // 会话重新握手 —— 提议已在途时跳过（避免 reset 风暴下反复重发）。
        if (this.e2e) {
          this.e2e.destroy()
          this.e2e = null
        }
        this.emit('e2e', 'reset')
        // ⚠ 时间窗去抖（2026-10-17 修）：常量 `E2E_REOFFER_DEBOUNCE_MS` 原先是
        // **死代码** —— 声明了 250ms 窗口但从未被引用，实际只在 `e2eOffer` 在途
        // 时跳过。而 `e2eOffer` 在提议发出后很快就被清空（见 beginE2EOffer 的
        // then 分支），所以 reset 风暴下**每次 reset 都会重发**一次提议。
        //
        // 现在按常量做时间窗：距上次提议不足 250ms 就不重发（等它自然完成）。
        //
        // ⚠ 常量是**实例字段**（`E2E_REOFFER_DEBOUNCE_MS = 250`，不是 static），
        // 所以必须经 `this.` 读 —— 裸写会 ReferenceError（模块作用域里没有它）。
        const debounceMs = typeof this.E2E_REOFFER_DEBOUNCE_MS === 'number'
          ? this.E2E_REOFFER_DEBOUNCE_MS
          : 250
        const now = Date.now()
        const last = typeof this.lastE2EOfferAt === 'number' ? this.lastE2EOfferAt : 0
        if (!this.e2eOffer && now - last >= debounceMs) {
          this.lastE2EOfferAt = now
          this.beginE2EOffer()
        }
        return
      }
      this.emit('error', new Error(`relay error: ${code} ${frame.d?.message ?? ''}`.trim()))
      if (code === ERROR_CODE.DUPLICATE_NODE) {
        // fork.61：重启竞态，退避重连；预算耗尽才按致命处理（日志文案不变）。
        if (this.dupPendingMs !== undefined) return
        const wait = this.nextDuplicateDelay()
        if (wait !== null) {
          this.dupPendingMs = wait
          // 中继随后会 close(1008)；主动关一次，避免依赖对端一定关。
          try {
            if (this.conn && !this.conn.closed) this.conn.close(1000, 'duplicate-node retry')
          } catch {
            /* 已断 */
          }
          return
        }
        this.emit('fatal', { code, attempts: this.dupCount })
        this.stop()
        return
      }
      if (code === 'node-id-invalid' || code === 'unauthorized' || code === 'revoked') {
        // 这类错误重连不会自愈，停下来等人工处理，避免把中继刷爆
        this.emit('fatal', { code, attempts: 0 })
        this.stop()
      }
      return
    }
    if (frame.t === 'ping') {
      this.sendRaw('pong', { echo: frame.id })
      return
    }
    // 会话已建立后，未加密的业务帧一律拒绝（fail-closed）—— 中继运营者
    // 持有 enrollToken、可以伪造"hub"发任意 task/start；加密层是唯一能挡住
    // 它的防线。明文 task 帧在此处死，绝不执行。带标记的帧在顶部已解开，
    // wasEncrypted 为真不会进这里。
    const gate = checkE2EGate(frame, { e2e: this.e2e, wasEncrypted })
    if (gate.rejected) {
      this.emit('error', new Error(`收到明文 ${frame.t} 帧（E2E 已启用）—— 已拒绝执行，疑似伪造或 hub 丢失会话`))
      this.sendRaw(NODE_TO_HUB.ERROR, { code: gate.code, message: gate.message })
      return
    }
    this.emit('frame', frame)
  }

  /* ───────────────── P2-11：hub 身份验证 ───────────────── */

  /**
   * 验证 hub 身份帧。返回 {ok:true,status:'ok'|'absent'} 或 {ok:false,reason}。
   *
   * 验证链（任何一环失败即整体失败，fail-closed）：
   *   1. 指纹自洽 —— sha256(报上来的公钥) 必须等于报上来的指纹，
   *      防"报真指纹、递假钥匙"的糊弄；
   *   2. 指纹匹配 pin —— 显式配置或 TOFU 落盘的值，这是主防线；
   *   3. ed25519 验签；
   *   4. nonce 回显 —— 必须等于本次 hello 发出的（防重放旧帧）；
   *   5. 时间窗 —— |now - at| ≤ 5min（nonce 缺失时的兜底）。
   *
   * 'absent' = hub 没提供身份（旧版 hub）。只在**没有任何 pin 期望**时放行：
   * 已钉住指纹的副机遇到不报身份的 hub 一律视为红线（身份帧可能被中间人
   * 剥掉），绝不静默降级。
   */
  verifyHubIdentity(idFrame) {
    const endpoint = this.resolveUrl()
    const expected = this.expectedPin(endpoint)
    if (!idFrame || typeof idFrame !== 'object') {
      if (expected) return { ok: false, reason: `pinned hub (${expected.fingerprint}) presented no identity frame` }
      return { ok: true, status: 'absent' }
    }
    const { fp, pub, sig, at, nonce } = idFrame
    if (typeof fp !== 'string' || typeof pub !== 'string' || pub === '' || typeof sig !== 'string') {
      return { ok: false, reason: 'malformed identity frame' }
    }
    const fpNorm = normalizeFingerprint(fp)
    if (!fpNorm || fingerprintOf(Buffer.from(pub, 'base64url')) !== fpNorm) {
      return { ok: false, reason: 'fingerprint does not match presented public key' }
    }
    if (expected && fpNorm !== expected.fingerprint) {
      return { ok: false, reason: `hub fingerprint mismatch: pinned ${expected.fingerprint}, got ${fpNorm}` }
    }
    if (!verifyIdentity(pub, { fingerprint: fpNorm, nodeId: this.hello.nodeId, nonce: typeof nonce === 'string' ? nonce : '', at: typeof at === 'number' ? at : 0 }, sig)) {
      return { ok: false, reason: 'hub identity signature invalid' }
    }
    const sentNonce = typeof this.hello.nonce === 'string' ? this.hello.nonce : ''
    if (sentNonce !== '' && nonce !== sentNonce) {
      return { ok: false, reason: 'identity nonce does not match this connection (replayed frame?)' }
    }
    if (Math.abs(Date.now() - (typeof at === 'number' ? at : 0)) > IDENTITY_MAX_SKEW_MS) {
      return { ok: false, reason: 'identity timestamp outside ±5min window' }
    }
    // TOFU：没有任何 pin 期望时，把这次验证过的指纹钉住（endpoint 一并记录，
    // 供"用户换了拨入地址 → 重新 TOFU"的判定）。
    if (!expected && this.pinStore) {
      const saved = this.pinStore.set({ fingerprint: fpNorm, endpoint })
      if (!saved) this.emit('error', new Error('hub pin 落盘失败 —— 下次连接将重新首连钉住'))
    }
    // 提案 #1：记录已验证的 hub 身份 —— E2E 确认帧（hub/e2e）的验签锚。
    this.identityPeer = { fp: fpNorm, pub }
    return { ok: true, status: 'ok', fingerprint: fpNorm }
  }

  /**
   * 当前生效的指纹期望：显式配置 > pin 文件。
   *
   * pin 文件记录的 endpoint 与本次拨入地址不同 → 视为"用户自己换了 hub"
   * （本地配置行为，远程攻击者改不了副机的配置），发 re-pin 提示并返回
   * null 重新 TOFU。endpoint 缺省（旧格式）时不比较，从严处理。
   */
  expectedPin(endpoint) {
    if (this.pinnedFingerprint) return { fingerprint: this.pinnedFingerprint, source: 'config' }
    const stored = this.pinStore?.get?.() ?? null
    if (!stored?.fingerprint) return null
    if (stored.endpoint && endpoint && stored.endpoint !== endpoint) {
      this.emit('re-pin', { from: stored.endpoint, to: endpoint, fingerprint: stored.fingerprint })
      return null
    }
    return { fingerprint: stored.fingerprint, source: 'file' }
  }

  setHubIdentity(status) {
    if (this.hubIdentity === status) return
    this.hubIdentity = status
    this.emit('hubIdentity', status)
  }

  /**
   * 身份验证失败：大声报错并**停止重连**。
   *
   * 这不是瞬时网络问题 —— 指纹不匹配意味着假 hub / 中间人 / hub 身份被重建，
   * 盲目重连只会无限循环刷错误。钉住的指纹**不**清除：失败持续可见，修法
   * 只有两条 —— 确认是主动换 hub 后删 <stateDir>/hub-pin.json（或更新
   * pinnedHubFingerprint），或者去查为什么有人站在中间。
   */
  failHubIdentity(reason) {
    this.stopIdentityGrace()
    this.emit('error', new Error(
      `hub 身份验证失败，已停止重连：${reason}`
      + ' —— 若你确实更换了 hub，删除副机 stateDir 下的 hub-pin.json（或更新 pinnedHubFingerprint）后重启副机；'
      + '否则请排查是否被中间人劫持。',
    ))
    // fork.62：stop() 之前发 fatal（只带白名单码，不带 reason 细节），journal 才看得到停止原因。
    this.emit('fatal', { code: 'hub-identity', attempts: 0 })
    this.stop()
  }

  /**
   * relay 模式的身份宽限窗口：上线后 hub/identity 必须在窗口内到达。
   * 超时分支按"有没有 pin 期望"分两种结局 —— 有 pin = 拒绝（我们钉住的
   * hub 没证明自己，可能被剥帧）；无 pin = absent 放行（旧版 hub 兼容）。
   */
  armIdentityGrace() {
    this.stopIdentityGrace()
    this.identityTimer = setTimeout(() => {
      this.identityTimer = undefined
      if (this.hubIdentity !== 'pending' || !this.online) return
      const expected = this.expectedPin(this.resolveUrl())
      if (expected) {
        this.failHubIdentity(`pinned hub sent no identity frame within ${this.identityGraceMs}ms`)
        return
      }
      this.setHubIdentity('absent')
      this.emit('error', new Error('提示：hub 未提供身份帧（可能是旧版 hub）—— 按无身份认证模式继续，建议两端都升级到同一版本'))
    }, this.identityGraceMs)
    if (this.identityTimer.unref) this.identityTimer.unref()
  }

  stopIdentityGrace() {
    if (this.identityTimer) {
      clearTimeout(this.identityTimer)
      this.identityTimer = undefined
    }
  }

  markOnline(ack) {
    this.online = true
    this.attempt = 0
    this.dupCount = 0
    this.dupSpentMs = 0
    this.dupPendingMs = undefined
    this.lastPongAt = Date.now()
    this.stopHandshakeTimeout()
    this.startHeartbeat()
    // 提案 #1：上线即提议 E2E 握手（direct/relay 通吃 —— direct 的 ws:// 同样
    // 可能是明文链路）。放在 emit('online') **之前**：worker 收到 online 后立刻
    // 发的 task/sync 已排在提议之后，保证 hub 先看到 offer。
    if (this.e2eEnabled) this.beginE2EOffer()
    this.emit('online', ack ?? {})
  }

  /* ───────────────── 提案 #1：E2E 会话加密 ───────────────── */

  /** 每次连接/重连清一次 E2E 状态（密钥材料销毁，绝不跨连接复用）。 */
  resetE2E() {
    if (this.e2e) {
      this.e2e.destroy()
      this.e2e = null
    }
    this.clearE2EOfferTimer()
    this.clearE2ERetry()
    this.e2eTimeouts = 0
    this.e2eOffer = null
    this.recentOffers = []
    this.identityPeer = null
  }

  clearE2ERetry() {
    if (this.e2eRetryTimer) {
      clearTimeout(this.e2eRetryTimer)
      this.e2eRetryTimer = undefined
    }
  }

  /** 第 n 次连续超时后的重提议等待：base、2×base … 封顶。 */
  e2eRetryDelayMs(n) {
    return Math.min(this.E2E_RETRY_BASE_MS * 2 ** Math.min(Math.max(n, 1) - 1, 30), this.E2E_RETRY_MAX_MS)
  }

  armE2ERetry(delayMs) {
    this.clearE2ERetry()
    if (!this.e2eEnabled || this.stopped) return
    this.e2eRetryTimer = setTimeout(() => {
      this.e2eRetryTimer = undefined
      if (this.e2e || this.e2eOffer || !this.online || !this.conn || this.conn.closed) return
      this.beginE2EOffer()
    }, delayMs)
    if (this.e2eRetryTimer.unref) this.e2eRetryTimer.unref()
  }

  /**
   * fork.63（N1）：收到一个带 e2e 标记、本端却没有会话的帧 —— hub 有会话而我们没有
   * （我们的提议超时了，迟到的 ack 被忽略），hub 之后发的每一帧我们都读不了。
   * 限速地重新提议，而不是只丢帧。关闭 e2e 的节点从不提议。
   */
  reofferAfterUnreadable() {
    if (!this.e2eEnabled || !this.online || this.e2e || this.e2eOffer) return
    const now = Date.now()
    if (now - this.lastUnreadableOfferAt < this.E2E_REOFFER_MIN_MS) return
    this.lastUnreadableOfferAt = now
    this.beginE2EOffer()
  }

  clearE2EOfferTimer() {
    if (this.e2eOffer?.timer) {
      clearTimeout(this.e2eOffer.timer)
      this.e2eOffer.timer = undefined
    }
  }

  /** E2E_ACK 等待窗口：超时只是"没握成"，按明文继续（旧版 hub 兼容），只提示不报错。 */
  E2E_ACK_TIMEOUT_MS = 5_000
  /**
   * fork.63（N2）：提议超时后不再永远停在明文。按 30s/60s/120s/240s、封顶 5min 重提议；
   * 新连接（resetE2E）或会话建成后从头计。旧版 hub 不认 node/e2e 时每 5 分钟一帧，代价可忽略。
   * 实例字段，测试可缩放。
   */
  E2E_RETRY_BASE_MS = 30_000
  E2E_RETRY_MAX_MS = 300_000
  /**
   * fork.63（N1）：收到解不开的加密帧（没有会话）时重新提议，最短间隔。
   * 与 reset 的 250ms 去抖分开计时，所以这里不会被连接时的那次提议吃掉。
   */
  E2E_REOFFER_MIN_MS = 5_000
  e2eTimeouts = 0
  e2eRetryTimer = undefined
  lastUnreadableOfferAt = 0
  /**
   * fork.64（s56）：保留最近若干个在途/已超时 offer 的 nonce→keypair 映射，
   * 用来处理迟到的 ACK（offer 超时后 hub 才发来 ACK，此时 this.e2eOffer 已是
   * 下一个 offer 或 null，用当前 offer 的 nonce 验签必定失败 → 假报 fatal）。
   * 条目按发出时间 TTL 清理；上限 4 条（bounded）。
   */
  E2E_OFFER_HISTORY_MAX = 4
  E2E_OFFER_HISTORY_TTL_MS = 60_000
  recentOffers = []
  /** 重置风暴去抖：连续 e2e-reset 时最多每 250ms 重发一次提议。 */
  E2E_REOFFER_DEBOUNCE_MS = 250

  /**
   * 发出 node/e2e 提议：一次性 X25519 公钥 + 连接 nonce。
   * hub 的确认帧（hub/e2e）签名绑定这两个值 —— 中继偷换/重放都会在副机
   * 验签处失败。会话就绪前业务帧继续明文（hub 两侧都接受）。
   */
  beginE2EOffer() {
    this.clearE2EOfferTimer()
    if (!this.online || !this.conn || this.conn.closed) return
    const eph = generateEphemeral()
    const nonce = newNonce()
    this.e2eOffer = { ...eph, nonce }
    this.e2eOffer.timer = setTimeout(() => {
      if (!this.e2eOffer) return
      this.e2eOffer.timer = undefined
      this.e2eOffer = null
      // 不是错误 —— 旧版 hub 不认识 node/e2e，按未知帧忽略。降级可见即可。
      // fork.63：之后按退避重提议（N2），不再永远明文。
      this.e2eTimeouts += 1
      const delayMs = this.e2eEnabled && !this.stopped ? this.e2eRetryDelayMs(this.e2eTimeouts) : undefined
      this.emit('e2e', 'timeout', { attempt: this.e2eTimeouts, delayMs })
      if (delayMs !== undefined) this.armE2ERetry(delayMs)
    }, this.E2E_ACK_TIMEOUT_MS)
    if (this.e2eOffer.timer.unref) this.e2eOffer.timer.unref()
    const now = Date.now()
    // fork.64: record this offer so a late ACK can still verify against its own keys
    this.recentOffers = this.recentOffers
      .filter((o) => now - o.sentAt < this.E2E_OFFER_HISTORY_TTL_MS)
      .slice(-(this.E2E_OFFER_HISTORY_MAX - 1))
    this.recentOffers.push({ nonce, publicKeyB64: eph.publicKeyB64, privateKeyB64: eph.privateKeyB64, sentAt: now })
    this.sendRaw(NODE_TO_HUB.E2E_OFFER, { pub: eph.publicKeyB64, nonce })
    this.emit('e2e', 'offer')
  }

  /**
   * 处理 hub/e2e 确认帧。验证链（fail-closed）：
   *   1. 必须有在途提议（没提议过就收到 ack = 伪造）；
   *   2. 必须已验证 hub 身份（P2-11 链）—— 没有验签锚就不该有 ack；
   *   3. ed25519 验签（绑定双方临时公钥 + 本连接 nonce + 时间窗）。
   * 任一失败：伪造 = 中间人，大声报错并停止重连（与身份失败同待遇）；
   * 形态不对 = 版本错乱，丢帧按明文继续。
   */
  handleE2EAck(d) {
    if (!this.e2eOffer) {
      // fork.64: no in-flight offer — either the session was just built (offer2 ACK already
      // processed) or offer timed out with no heal RESET. In both cases we still check
      // recentOffers so a stale ACK (offer1's ACK arriving after offer2 succeeded) emits a
      // warn instead of silently vanishing. If recentOffers is empty, nothing to do.
      if (this.recentOffers.length === 0 || !this.identityPeer) return
      const peerPub = normalizeE2EPub(d?.pub)
      if (peerPub === '' || typeof d?.sig !== 'string' || typeof d?.at !== 'number') return
      if (Math.abs(Date.now() - d.at) > IDENTITY_MAX_SKEW_MS) return
      const now = Date.now()
      for (let i = this.recentOffers.length - 1; i >= 0; i -= 1) {
        const rec = this.recentOffers[i]
        if (now - rec.sentAt >= this.E2E_OFFER_HISTORY_TTL_MS) continue
        const ok = verifyExchange(this.identityPeer.pub, {
          fingerprint: this.identityPeer.fp,
          nodeId: this.hello.nodeId,
          nonce: rec.nonce,
          pub: peerPub,
          peerPub: rec.publicKeyB64,
          at: d.at,
        }, d.sig)
        if (ok) {
          this.emit('error', new Error('hub/e2e 收到迟到 ACK（已超时的提议），已丢弃（当前提议仍在途，等新 ACK）'))
          return
        }
      }
      // No match among recent offers — unknown or forged; discard silently (session intact)
      return
    }
    if (!this.identityPeer) {
      this.emit('error', new Error('收到 hub/e2e 但 hub 身份未验证 —— 拒绝建立 E2E 会话'))
      this.emit('fatal', { code: 'e2e-identity', attempts: 0 })
      this.stop()
      return
    }
    const peerPub = normalizeE2EPub(d?.pub)
    if (peerPub === '' || typeof d?.sig !== 'string' || typeof d?.at !== 'number') {
      this.emit('error', new Error('hub/e2e 帧形态不对，已丢弃（链路按明文继续）'))
      return
    }
    if (Math.abs(Date.now() - d.at) > IDENTITY_MAX_SKEW_MS) {
      this.emit('error', new Error('hub/e2e 时间戳超出 ±5min 窗口，已丢弃（链路按明文继续）'))
      return
    }
    // fork.64: try the CURRENT offer first; if its nonce does not match, search recentOffers
    // (a late ACK whose offer already timed out). A signed ACK that matches a past offer is
    // safe to build a session with — the hub signed it with the same keypair it used for the
    // current session, so it can still bootstrap encryption. We log a warn and skip it only
    // if no offer matches at all, which means the ACK is for a session on a different connection
    // (already cleaned up by resetE2E) or is genuinely forged.
    const matchOffer = (() => {
      if (this.e2eOffer) {
        const ok = verifyExchange(this.identityPeer.pub, {
          fingerprint: this.identityPeer.fp,
          nodeId: this.hello.nodeId,
          nonce: this.e2eOffer.nonce,
          pub: peerPub,
          peerPub: this.e2eOffer.publicKeyB64,
          at: d.at,
        }, d.sig)
        if (ok) return { offer: this.e2eOffer, stale: false }
      }
      const now = Date.now()
      for (let i = this.recentOffers.length - 1; i >= 0; i -= 1) {
        const rec = this.recentOffers[i]
        if (now - rec.sentAt >= this.E2E_OFFER_HISTORY_TTL_MS) continue
        const ok = verifyExchange(this.identityPeer.pub, {
          fingerprint: this.identityPeer.fp,
          nodeId: this.hello.nodeId,
          nonce: rec.nonce,
          pub: peerPub,
          peerPub: rec.publicKeyB64,
          at: d.at,
        }, d.sig)
        if (ok) return { offer: rec, stale: true }
      }
      return null
    })()
    if (!matchOffer) {
      // fork.64: a forged or cross-connection ACK cannot match any known offer: warn and discard.
      // Do NOT fatal/stop: an injected ACK with the right nonce but wrong sig is exactly a
      // one-frame relay DoS — killing the link permanently rewards the attacker.
      this.emit('error', new Error('hub/e2e 签名验证失败 —— 已丢弃（不 fatal；若持续出现请检查中间人）'))
      return
    }
    if (matchOffer.stale) {
      // Late ACK: the hub built a session from an earlier offer (before we timed out and sent
      // offer2). We already have — or are about to get — a newer session from offer2. Discard
      // this one and let the current cycle finish.
      this.emit('error', new Error('hub/e2e 收到迟到 ACK（已超时的提议），已丢弃（当前提议仍在途，等新 ACK）'))
      return
    }
    try {
      this.e2e = createSession({
        role: 'node',
        ownPrivB64: matchOffer.offer.privateKeyB64,
        peerPubB64: peerPub,
        nodePubB64: matchOffer.offer.publicKeyB64,
        hubPubB64: peerPub,
      })
    } catch (err) {
      this.emit('error', new Error(`E2E 会话建立失败，链路按明文继续：${err?.message ?? err}`))
      this.e2eOffer = null
      return
    }
    this.clearE2EOfferTimer()
    this.clearE2ERetry()
    this.e2eTimeouts = 0
    this.e2eOffer = null
    this.emit('e2e', 'ok')
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.hbTimer = setInterval(() => {
      if (!this.conn || this.conn.closed) return
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.emit('error', new Error('heartbeat timeout, forcing reconnect'))
        this.conn.destroy(new Error('heartbeat timeout'))
        return
      }
      this.conn.ping()
      this.sendRaw('ping', { time: Date.now() })
    }, this.heartbeatMs)
    if (this.hbTimer.unref) this.hbTimer.unref()
  }

  stopHeartbeat() {
    if (this.hbTimer) {
      clearInterval(this.hbTimer)
      this.hbTimer = undefined
    }
  }

  /** 返回本次 duplicate 重试要等的毫秒（含 ≤20% 抖动），预算用尽返回 null。 */
  nextDuplicateDelay() {
    const n = this.dupCount + 1
    const base = duplicateBackoffMs(n, this.dupRetry)
    if (this.dupSpentMs + base > this.dupRetry.totalMs) return null
    this.dupCount = n
    this.dupSpentMs += base
    return base + Math.floor(base * 0.2 * Math.random())
  }

  scheduleReconnect() {
    if (this.stopped || this.timer) return
    this.attempt += 1
    const dup = this.dupPendingMs !== undefined
    const delay = dup
      ? this.dupPendingMs
      : (() => {
          const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS)
          return base + Math.floor(base * 0.2 * Math.random())
        })()
    this.dupPendingMs = undefined
    this.emit('reconnecting', { attempt: this.attempt, delayMs: delay, ...(dup ? { reason: 'duplicate-node' } : {}) })
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connectOnce()
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  /**
   * 发送一个协议信封。
   *
   * 注意 `encodeFrame` 的契约是"收一个完整 frame 对象"，不是 (type, data, opts)。
   * 早期版本这里误按三参调用，导致首帧实际发出裸字符串 `"hello/node"`，
   * 对端 decodeFrame 报 missing-type，副机永远上不了线。
   * 统一用 envelope() 构造，与 relay.js / hub/node-registry.js 保持同一形式。
   */
  sendRaw(type, data, opts) {
    if (!this.conn || this.conn.closed) return false
    const env = envelope(type, data, opts)
    // E2E 封密（提案 #1）：握手/心跳/交换帧保持明文，业务帧在会话就绪后自动加密。
    if (this.e2e && !E2E_CLEAR_TYPES.has(type)) {
      try {
        env.d = this.e2e.sealFrame(type, env.id, env.d)
      } catch (err) {
        this.emit('error', new Error(`E2E 封密失败，帧已丢弃：${err?.message ?? err}`))
        return false
      }
    }
    return this.conn.send(encodeFrame(env))
  }

  send(type, data, opts) {
    return this.sendRaw(type, data, opts)
  }

  sendBinary(header, payload) {
    if (!this.conn || this.conn.closed) return false
    let hdr = header ?? {}
    let pl = payload ?? Buffer.alloc(0)
    // E2E 封密（提案 #1）：内层完整帧（含 pullId/offset/sha256）进密文，
    // 外层只留 t/seq/iv —— 中继看不到文件名与完整性字段。
    if (this.e2e) {
      try {
        const sealed = this.e2e.sealBinary(hdr.t, hdr, pl)
        hdr = sealed.header
        pl = sealed.payload
      } catch (err) {
        this.emit('error', new Error(`E2E 二进制封密失败，帧已丢弃：${err?.message ?? err}`))
        return false
      }
    }
    return this.conn.sendBinary(encodeBinaryFrame(hdr, pl))
  }

  /** 写缓冲字节数（产物分块背压用）。 */
  get bufferedBytes() {
    return this.conn?.bufferedBytes ?? 0
  }

  /** 等待写缓冲降到阈值以下。 */
  drain(threshold, timeoutMs) {
    if (!this.conn) return Promise.resolve(false)
    return this.conn.drain(threshold, timeoutMs)
  }

  stop() {
    this.stopped = true
    this.dupPendingMs = undefined
    this.stopHandshakeTimeout()
    this.stopHeartbeat()
    this.stopIdentityGrace()
    this.resetE2E()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.conn && !this.conn.closed) this.conn.close(1000, 'node stopping')
    this.conn = undefined
    this.online = false
  }
}
