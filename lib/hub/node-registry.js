/**
 * 主机侧节点注册表·核心（零外部依赖）。
 *
 * 定位：hub 眼里"有哪些副机、它们各自在跑什么"的唯一真身。
 *
 * 三条不变式（与 protocol.js / task-store.js 的契约对齐）：
 *   1. **任务状态的真身在副机** —— hub 只维护投影。断连只把 online 置 false，
 *      绝不清 tasks；重连后靠副机主动 task/sync 全量重建视图。
 *   2. **同 nodeId 第二实例拒掉新的** —— 正在跑的任务不能被挤掉，保住已在跑的那个连接。
 *   3. **任何一帧的解析失败只记日志** —— 一个畸形帧不能打挂 host。
 *
 * 两种接入方式的接入/握手在 registry-handshake.js，帧摄入在 registry-ingest.js，
 * 各自以 mixin 合入（见文件尾的 NodeRegistry 组合）。
 *
 * 本文件是 hub 目录的依赖叶子（不反向 import index.js —— 会成环）。
 *
 * P1-4 拆分：RelayLink → relay-link.js（此处 re-export 保持 import 兼容），
 * 日志器与小工具 → hub-util.js，帧摄入 → registry-ingest.js，
 * 连接接入/握手/身份 → registry-handshake.js。本文件只留核心注册表。
 */
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PULL_TIMEOUT_MS,
  ERROR_CODE,
  HUB_TO_NODE,
  RemoteAgentError,
  TASK_STATUS,
  TERMINAL_STATUS,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
} from '../protocol.js'
// 视图投影共享层：registry 给工具用的任务视图与 UI 路由共用同一份白名单。
import { taskView as taskProjection } from './views.js'
import { errText } from './hub-util.js'
import { withIngest } from './registry-ingest.js'
import { withHandshake } from './registry-handshake.js'

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
class NodeRegistryCore {
  /**
   * @param {object} [identity] hub 身份（lib/identity.js loadOrCreateHubIdentity 的返回值）。
   *   缺省 / 不完整 = hub 身份认证能力关闭：welcome 不带 identity，relay 不追发，
   *   副机按旧协议处理 —— 身份子系统故障绝不演变成"拒绝所有副机"。
   */
  constructor({ log, limits = {}, relay = null, identity = null, audit = null } = {}) {
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
    /** @type {import('./audit-log.js').createAuditLog | null} 审计写入器（提案 #19，null = 关闭）。 */
    this.audit = audit && typeof audit.record === 'function' ? audit : null
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

  /**
   * 审计一条事件（提案 #19）。绝不抛、绝不阻塞 —— 审计挂了任务链路照常跑，
   * 这是不变式（见 audit-log.js 头注释的优先级 1）。
   */
  auditRecord(event, fields) {
    try {
      this.audit?.record(event, fields)
    } catch {
      /* 审计层的任何异常都不上抛 */
    }
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
    // 审计（提案 #19）：任务派发是"hub 替谁在哪台机器上跑了什么"的证据链起点。
    // 字段刻意保持扁平且过 sanitizeExtra（打码 + 400 字符截断）—— goal 可能
    // 含整段任务书，绝不能整段落盘。
    this.auditRecord('task.dispatch', {
      taskId: spec.taskId,
      nodeId,
      mode: spec.mode,
      workspace: typeof spec.workspace === 'string' ? spec.workspace : '',
      goal: typeof spec.goal === 'string' ? spec.goal : '',
      outputsCount: Array.isArray(spec.outputs) ? spec.outputs.length : 0,
      timeoutMs: spec.constraints?.timeoutMs,
    })
    return t
  }

  /** 取消任务。找不到 / 节点不在线都返回 false，不抛。 */
  cancelTask(taskId) {
    const t = this.tasks.get(taskId)
    if (!t) return false
    const ok = this.send(t.nodeId, HUB_TO_NODE.TASK_CANCEL, { taskId, reason: 'hub-request' })
    if (ok) this.log('info', 'task cancel requested', { taskId, nodeId: t.nodeId })
    this.auditRecord('task.cancel', { taskId, nodeId: t.nodeId, delivered: ok === true })
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

/**
 * NodeRegistry = 核心注册表（本文件：任务视图 / 下发 / 发送 / 心跳 / 生命周期）
 * + 帧摄入 mixin（registry-ingest.js：上行帧分发与 task/sync 对账）
 * + 接入握手 mixin（registry-handshake.js：direct/relay 接入、hello、hub 身份）。
 * 对外形状与拆分前完全一致 —— 所有方法都在同一个原型链上。
 */
export class NodeRegistry extends withHandshake(withIngest(NodeRegistryCore)) {}
