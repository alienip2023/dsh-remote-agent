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
])

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
    this.online = false
    this.attempt = 0
    this.stopped = false
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
        if (!this.e2eOffer) this.beginE2EOffer()
        return
      }
      this.emit('error', new Error(`relay error: ${code} ${frame.d?.message ?? ''}`.trim()))
      if (code === 'duplicate-node' || code === 'node-id-invalid' || code === 'unauthorized' || code === 'revoked') {
        // 这类错误重连不会自愈，停下来等人工处理，避免把中继刷爆
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
    if (this.e2e && !wasEncrypted && E2E_REQUIRED_TYPES.has(frame.t)) {
      this.emit('error', new Error(`收到明文 ${frame.t} 帧（E2E 已启用）—— 已拒绝执行，疑似伪造或 hub 丢失会话`))
      this.sendRaw(NODE_TO_HUB.ERROR, { code: ERROR_CODE.E2E_REQUIRED, message: `unencrypted ${frame.t} rejected while e2e session active` })
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
    this.e2eOffer = null
    this.identityPeer = null
  }

  clearE2EOfferTimer() {
    if (this.e2eOffer?.timer) {
      clearTimeout(this.e2eOffer.timer)
      this.e2eOffer.timer = undefined
    }
  }

  /** E2E_ACK 等待窗口：超时只是"没握成"，按明文继续（旧版 hub 兼容），只提示不报错。 */
  E2E_ACK_TIMEOUT_MS = 5_000
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
      this.emit('e2e', 'timeout')
    }, this.E2E_ACK_TIMEOUT_MS)
    if (this.e2eOffer.timer.unref) this.e2eOffer.timer.unref()
    this.sendRaw(NODE_TO_HUB.E2E_OFFER, { pub: eph.publicKeyB64, nonce })
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
      // 没有在途提议：会话已建立（同一提议的重复 ack，reset 风暴下 hub 会话
      // 被后到的 offer 覆盖时会出现）或提议已超时清理 —— 两种都静默忽略，
      // 绝不杀连接。伪造的 ack 本身过不了验签，走到这里的不构成威胁。
      return
    }
    if (!this.identityPeer) {
      this.emit('error', new Error('收到 hub/e2e 但 hub 身份未验证 —— 拒绝建立 E2E 会话'))
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
    const ok = verifyExchange(this.identityPeer.pub, {
      fingerprint: this.identityPeer.fp,
      nodeId: this.hello.nodeId,
      nonce: this.e2eOffer.nonce,
      pub: peerPub,
      peerPub: this.e2eOffer.publicKeyB64,
      at: d.at,
    }, d.sig)
    if (!ok) {
      this.failHubIdentity('hub/e2e 签名验证失败 —— 公钥被偷换或 hub 身份不符（疑似中间人）')
      return
    }
    try {
      this.e2e = createSession({
        role: 'node',
        ownPrivB64: this.e2eOffer.privateKeyB64,
        peerPubB64: peerPub,
        nodePubB64: this.e2eOffer.publicKeyB64,
        hubPubB64: peerPub,
      })
    } catch (err) {
      this.emit('error', new Error(`E2E 会话建立失败，链路按明文继续：${err?.message ?? err}`))
      this.e2eOffer = null
      return
    }
    this.clearE2EOfferTimer()
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

  scheduleReconnect() {
    if (this.stopped || this.timer) return
    this.attempt += 1
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS)
    const jitter = Math.floor(base * 0.2 * Math.random())
    const delay = base + jitter
    this.emit('reconnecting', { attempt: this.attempt, delayMs: delay })
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
