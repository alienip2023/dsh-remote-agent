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
 * 本文件是 hub 目录的依赖叶子（只依赖 protocol.js / ws.js / hub 内工具模块），
 * 所以不反向 import index.js —— 需要的小工具见 hub-util.js。
 *
 * P1-4 拆分：RelayLink → relay-link.js（此处 re-export 保持 import 兼容），
 * 日志器与小工具 → hub-util.js。
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
// P2-11：hub 身份签名（ed25519）。零外部依赖，与 protocol/ws 同级的基础层。
import { newNonce, signIdentity } from '../identity.js'
// 视图投影共享层：registry 给工具用的任务视图与 UI 路由共用同一份白名单。
import { taskView as taskProjection } from './views.js'
import { errText, numOr } from './hub-util.js'

// RelayLink 真身在 relay-link.js；re-export 让既有 import 路径继续可用。
export { RelayLink } from './relay-link.js'

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
    /** @type {import('./relay-link.js').RelayLink | undefined} */
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

      case NODE_TO_HUB.RESOURCE: {
        // 资源遥测（~30s 一次）：只更新 rec.resource，绝不影响任务链路。
        // 尽力而为的字段级校验：缺/类型不对就落 null —— 一个畸形遥测帧
        // 不能让节点记录缺胳膊少腿，更不能抛（单帧故障隔离不变式）。
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
        rec.resource = {
          cpuPct: num(d.cpuPct),
          load1: num(d.load1),
          memUsedMb: num(d.memUsedMb),
          memTotalMb: num(d.memTotalMb),
          at: Date.now(),
        }
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
      // 资源遥测（最近一次 node/resource；null = 尚未上报）。离线节点保留
      // 最后一份 —— 带 at 时间戳，消费方自行判断新鲜度。
      resource: r.resource ?? null,
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
