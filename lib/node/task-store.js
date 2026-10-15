/**
 * 副机任务仓库：**任务状态的真身在副机**。
 *
 * 为什么不用 hub 侧当权威：
 *   - 任务在副机本地持久运行，断连不终止（核心不变式）
 *   - 如果 hub 是权威，断连期间 hub 不知道任务进展，重连后要"补齐"，很容易补齐错
 *   - 副机当权威后，重连只需 node → hub 一条 task/sync，hub 重建视图即可
 *
 * 存储：`<stateDir>/tasks/<taskId>.json`，原子写（写 .tmp 再 rename），
 * 崩溃后最多丢最后一次进度，不会出现半截 JSON。
 *
 * 落盘策略（2026-10-15 热路径改造）：
 *   - **状态转移 / 创建 → 同步落盘**。耐久性语义要求：终态记录必须在进程
 *     存活期间落盘，否则崩溃后 reconcile 会把未落盘的 completed 当成
 *     interrupted 重跑 —— 任务被执行两次。
 *   - **日志 / 进度 → 批量写回**。这两类是高频率噪声（一条命令几十行输出），
 *     此前的实现是每行都全量重写整个记录文件（含最多 500 行 × 4000 字符的
 *     日志尾巴，单文件可达 2MB）—— 同步 fs 直接阻塞副机事件循环，而副机
 *     同时还要跑子进程 I/O 和 ws 帧。改为 200ms 合并窗口的写回，
 *     `flush()` / `close()` 可强制立即落盘。
 *
 * 幂等：taskId 重复 → 直接返回已有记录，不重跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { TASK_STATUS, TERMINAL_STATUS, newTaskId } from '../protocol.js'

/** 批量写回的合并窗口。日志/进度在这个窗口内的多次更新只落盘一次。 */
const FLUSH_INTERVAL_MS = 200

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export class TaskStore {
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'tasks')
    fs.mkdirSync(this.dir, { recursive: true })
    /** @type {Map<string, object>} 内存镜像，热路径不读盘 */
    this.cache = new Map()
    /** @type {Set<string>} 待写回的 taskId（批量窗口内的脏记录） */
    this.dirty = new Set()
    this.flushTimer = null
    this.closed = false
    this.loadAll()
  }

  loadAll() {
    let names
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'))
        if (rec && typeof rec.taskId === 'string') this.cache.set(rec.taskId, rec)
      } catch {
        // 单条损坏不影响其他任务：跳过，保留文件供人工排查
      }
    }
  }

  fileFor(taskId) {
    // taskId 已由协议层校验过格式；这里再做一次防目录穿越
    const safe = String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')
    return path.join(this.dir, `${safe}.json`)
  }

  get(taskId) {
    return this.cache.get(taskId)
  }

  has(taskId) {
    return this.cache.has(taskId)
  }

  list() {
    return [...this.cache.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  /** 正在跑或排队中的任务（重连后要上报的那些）。 */
  active() {
    return this.list().filter((t) => !TERMINAL_STATUS.has(t.status))
  }

  /** 创建一条任务记录。已存在则原样返回（幂等）。 */
  create(spec, { nodeId, workspace }) {
    const existing = this.cache.get(spec.taskId)
    if (existing) return { created: false, record: existing }

    const record = {
      taskId: spec.taskId,
      nodeId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: TASK_STATUS.QUEUED,
      mode: spec.mode,
      goal: spec.goal,
      workspace: spec.workspace ?? workspace,
      // 主机指定的模型选择（可选，normalizeModelSelection 已归一）。
      // 必须落盘：agent 任务可能在重启后 reconcile 重跑，模型选择要跟任务走。
      model: spec.model ?? null,
      constraints: spec.constraints,
      outputs: spec.outputs,
      artifactRules: spec.artifactRules ?? null,
      summaryPolicy: spec.summaryPolicy ?? 'on-complete',
      origin: spec.origin ?? 'hub',
      startedAt: null,
      endedAt: null,
      attempts: 0,
      progress: [],
      logs: [],
      sessionId: null,
      manifest: null,
      summary: null,
      error: null,
      exit: null,
      changed: [],
    }
    this.cache.set(record.taskId, record)
    this.persist(record)
    return { created: true, record }
  }

  /** 同步落盘：创建 / 状态转移 / 关闭前。立即写，不等批量窗口。 */
  persist(record) {
    record.updatedAt = Date.now()
    atomicWriteJson(this.fileFor(record.taskId), record)
    this.dirty.delete(record.taskId)
    return record
  }

  /**
   * 批量写回调度：日志 / 进度等高频走这里。
   *
   * 只更新内存镜像 + 标记脏；真正的磁盘写由 `flush()` 在合并窗口到期时
   * （或显式调用 / 进程关闭时）完成。窗口内同一任务的 N 次更新只写一次盘。
   */
  persistAsync(record) {
    if (this.closed) return this.persist(record)
    record.updatedAt = Date.now()
    this.dirty.add(record.taskId)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
      // 不拿定时器吊住进程：副机退出不该被一个待写回的 flush 挡住
      this.flushTimer.unref?.()
    }
    return record
  }

  /**
   * 把所有脏记录同步写盘。写失败的记录留在脏集合里等下次重试
   * （不抛：落盘失败不该炸掉任务流，最多是崩溃时多丢一份进度）。
   * @returns {number} 实际写掉的记录数
   */
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.dirty.size === 0) return 0
    const ids = [...this.dirty]
    this.dirty.clear()
    let written = 0
    for (const id of ids) {
      const rec = this.cache.get(id)
      if (!rec) continue
      try {
        atomicWriteJson(this.fileFor(id), rec)
        written += 1
      } catch {
        this.dirty.add(id)
      }
    }
    return written
  }

  /** 进程退出前调用：停批量窗口并全部落盘。 */
  close() {
    this.closed = true
    return this.flush()
  }

  /** 合并式更新：只覆盖传入字段，其余保持。 */
  update(taskId, patch) {
    const rec = this.cache.get(taskId)
    if (!rec) return undefined
    // 旧状态必须在 assign **之前**捕获（assign 后就取不到了）
    const prevStatus = rec.status
    Object.assign(rec, patch)
    // 状态转移与终态时间戳走同步落盘（耐久性语义，见文件头）：
    // 终态记录若只躺在批量窗口里，崩溃后 reconcile 会把未落盘的 completed
    // 判成 interrupted 重跑 —— 任务执行两次。其余字段走批量。
    const statusChanged = patch.status !== undefined && patch.status !== prevStatus
    const terminal = patch.endedAt !== undefined
    return statusChanged || terminal ? this.persist(rec) : this.persistAsync(rec)
  }

  appendProgress(taskId, entry, { maxEntries = 200 } = {}) {
    const rec = this.cache.get(taskId)
    if (!rec) return undefined
    rec.progress.push({ ...entry, at: Date.now() })
    if (rec.progress.length > maxEntries) rec.progress.splice(0, rec.progress.length - maxEntries)
    return this.persistAsync(rec)
  }

  appendLog(taskId, line, { maxLines = 500, maxChars = 200_000 } = {}) {
    const rec = this.cache.get(taskId)
    if (!rec) return undefined
    const text = String(line).replace(/\r?\n$/, '')
    if (text === '') return rec
    rec.logs.push({ at: Date.now(), line: text.slice(0, 4000) })
    if (rec.logs.length > maxLines) rec.logs.splice(0, rec.logs.length - maxLines)
    let total = rec.logs.reduce((n, l) => n + l.line.length, 0)
    while (total > maxChars && rec.logs.length > 1) {
      total -= rec.logs.shift().line.length
    }
    return this.persistAsync(rec)
  }

  /** 供 hub 读的摘要视图（不泄露副机内部路径以外的信息）。 */
  view(rec) {
    if (!rec) return undefined
    return {
      taskId: rec.taskId,
      nodeId: rec.nodeId,
      status: rec.status,
      mode: rec.mode,
      goal: rec.goal,
      workspace: rec.workspace,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      durationMs: rec.startedAt ? (rec.endedAt ?? Date.now()) - rec.startedAt : null,
      sessionId: rec.sessionId,
      exit: rec.exit,
      changed: rec.changed,
      error: rec.error,
      summary: rec.summary,
      manifestCounts: rec.manifest?.counts ?? null,
      progressTail: rec.progress.slice(-10),
      logTail: rec.logs.slice(-40).map((l) => l.line),
    }
  }

  /** 删除终态记录（保留 running 的）。 */
  prune({ olderThanMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - olderThanMs
    let removed = 0
    for (const rec of [...this.cache.values()]) {
      if (TERMINAL_STATUS.has(rec.status) && (rec.endedAt ?? rec.updatedAt) < cutoff) {
        try {
          fs.unlinkSync(this.fileFor(rec.taskId))
        } catch {
          /* 已经不在盘上 */
        }
        this.cache.delete(rec.taskId)
        removed += 1
      }
    }
    return removed
  }

  static newId() {
    return newTaskId()
  }
}
