/**
 * NodeRegistry 的「连接接入 + 握手 + hub 身份」职责（P1-4 自 node-registry.js
 * 拆出）。
 *
 * 以 mixin 形式合入：`class NodeRegistry extends withHandshake(withIngest(...))`。
 * 纯搬移 —— 方法体与拆分前一字不差。搬出动机：接入/握手是「连接生命周期」，
 * 身份证明（P2-11）是「安全协议」，两者与注册表的视图查询/任务下发是不同
 * 变更节奏，此前挤在同一个千行文件里。
 *
 * this.* 依赖面（全部由 NodeRegistryCore 提供）：
 *   nodes / pending / limits / log / send / markOffline
 * （finishPending / sendWelcome / buildIdentityPayload / sendIdentityFrame /
 *   rejectConn 在本 mixin 内自洽。）
 */
import {
  ERROR_CODE,
  HUB_TO_NODE,
  NODE_TO_HUB,
  PROTOCOL_VERSION,
  RELAY_FRAME,
  decodeBinaryFrame,
  decodeFrame,
  encodeFrame,
  envelope,
  validateHello,
} from '../protocol.js'
import { newNonce, signIdentity } from '../identity.js'
import { generateEphemeral, normalizeE2EPub, signExchange, createSession } from '../e2e.js'
import { errText } from './hub-util.js'

export function withHandshake(Base) {
  return class extends Base {
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
      // 记一次成功的连接尝试（2026-10-20，体验提升 ①）——
      // 面板据此区分"从没连上过"与"连上又断了"，这是排查方向的分水岭。
      try {
        this.noteConnectionAttempt({
          result: 'ok',
          nodeId: hello.nodeId,
          remote: remoteOf(conn),
          transport,
        })
      } catch {
        /* 诊断记录绝不能影响上线流程 */
      }
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

    /**
     * E2E 密钥交换（提案 #1）：处理副机的 node/e2e 提议。
     *
     * 流程：校验副机的一次性 X25519 公钥 → 生成本方一次性 X25519 →
     * ECDH 派生 AES-256-GCM 会话密钥（存 rec.e2e，此后本节点的收发自动
     * 加解密）→ 用持久 ed25519 身份签 hub/e2e 确认帧回给副机。签名绑定
     * 双方公钥 + 副机提议里的连接 nonce —— 中继既伪造不了签名，也偷换不了
     * 任何一侧公钥（偷换后另一端验签必败）。
     *
     * hub 身份不可用（identity=null）时直接跳过：E2E 的认证锚就是这把身份，
     * 没有它签出的确认帧一文不值 —— 副机等不到 ack 自然按明文继续（兼容旧版）。
     *
     * 会话随 rec 生存：重连 → 新 offer → 新会话覆盖旧会话（旧密钥销毁）。
     */
    handleE2EOffer(nodeId, d) {
      const rec = this.nodes.get(nodeId)
      if (!rec) {
        this.log('warn', 'e2e offer from unknown node', { nodeId })
        return false
      }
      const pub = normalizeE2EPub(d?.pub)
      const nonce = typeof d?.nonce === 'string' && /^[0-9a-f]{16,128}$/.test(d.nonce) ? d.nonce : ''
      if (pub === '' || nonce === '') {
        this.log('warn', 'e2e offer rejected: malformed', { nodeId })
        return false
      }
      if (!this.identity) {
        this.log('info', 'e2e skipped: hub identity unavailable, link stays plaintext', { nodeId })
        return false
      }
      let session
      let ackSig
      let ackPub
      // 签名与传输必须是**同一个** at —— 两次 Date.now() 会让副机验签必败
      // （实测踩过：签名载荷里的 at 和帧里的 at 差几毫秒，验签 false）。
      const now = Date.now()
      try {
        const eph = generateEphemeral()
        session = createSession({
          role: 'hub',
          ownPrivB64: eph.privateKeyB64,
          peerPubB64: pub,
          nodePubB64: pub,
          hubPubB64: eph.publicKeyB64,
        })
        ackSig = signExchange(this.identity.privateKeyB64, {
          fingerprint: this.identity.fingerprint,
          nodeId,
          nonce,
          pub: eph.publicKeyB64,
          peerPub: pub,
          at: now,
        })
        ackPub = eph.publicKeyB64
      } catch (err) {
        this.log('warn', 'e2e session setup failed, link stays plaintext', { nodeId, error: errText(err) })
        return false
      }
      // 旧会话（若有）销毁密钥材料后再覆盖 —— 重连重协商是常态路径。
      if (rec.e2e && typeof rec.e2e.destroy === 'function') rec.e2e.destroy()
      rec.e2e = session
      rec.e2eAt = now
      this.send(nodeId, HUB_TO_NODE.E2E_ACK, { pub: ackPub, sig: ackSig, at: now })
      this.log('info', 'e2e session established (relay traffic encrypted)', { nodeId })
      return true
    }

    /** 在指定连接上回 error 帧然后关闭。 */
    rejectConn(conn, code, message, nodeId) {
      // 记一次失败的连接尝试（2026-10-20，体验提升 ①）——
      // 副机连不上时，面板要能说清"为什么"，而不是只显示 0 在线。
      try {
        this.noteConnectionAttempt({
          result: 'fail',
          code: typeof code === 'string' ? code : '',
          message: typeof message === 'string' ? message : '',
          nodeId: typeof nodeId === 'string' ? nodeId : '',
          remote: remoteOf(conn),
          transport: 'direct',
        })
      } catch {
        /* 诊断记录绝不能影响拒绝流程本身 */
      }
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
  }
}

/**
 * 从连接对象上尽力取远端地址（用于诊断记录）。
 * WSConnection 不一定暴露 remote，取不到就返回空串。
 */
function remoteOf(conn) {
  try {
    const s = conn?.socket
    const addr = s?.remoteAddress
    const port = s?.remotePort
    if (typeof addr === 'string' && addr !== '') {
      return typeof port === 'number' ? `${addr}:${port}` : addr
    }
  } catch {
    /* 取不到就算了 */
  }
  return ''
}
