/**
 * 副机任务仓库：**任务状态的真身在副机**。
 *
 * 为什么不用 hub 侧当权威：
 *   - 任务在副机本地持久运行，断连不终止（核心不变式）
 *   - 如果 hub 是权威，断连期间 hub 不知道任务进展，重连后要"补齐"，很容易补齐错
 *   - 副机当权威后，重连只需 node → hub 一条 task/sync，hub 重建视图即可
 *
 * 存储：`<stateDir>/tasks/<taskId>.json`，每条原子写（写 .tmp 再 rename），
 * 崩溃后最多丢最后一次进度，不会出现半截 JSON。
 *
 * 幂等：taskId 重复 → 直接返回已有记录，不重跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { TASK_STATUS, TERMINAL_STATUS, newTaskId } from '../protocol.js'

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
    this.loadAll()
  }

  loadAll() {
    let names = []
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

  persist(record) {
    record.updatedAt = Date.now()
    atomicWriteJson(this.fileFor(record.taskId), record)
    return record
  }

  /** 合并式更新：只覆盖传入字段，其余保持。 */
  update(taskId, patch) {
    const rec = this.cache.get(taskId)
    if (!rec) return undefined
    Object.assign(rec, patch)
    return this.persist(rec)
  }

  appendProgress(taskId, entry, { maxEntries = 200 } = {}) {
    const rec = this.cache.get(taskId)
    if (!rec) return undefined
    rec.progress.push({ ...entry, at: Date.now() })
    if (rec.progress.length > maxEntries) rec.progress.splice(0, rec.progress.length - maxEntries)
    return this.persist(rec)
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
    return this.persist(rec)
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
