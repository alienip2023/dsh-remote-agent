/**
 * 任务执行编排：把一条 TaskSpec 变成副机本地的一次真实运行，并产出 handoff 结果。
 *
 * 生命周期：
 *   accept → running → (exec | agent) → 建 manifest → 生成 handoff → end
 *
 * 核心不变式：
 *   - 断连不终止：运行中的任务完全不依赖连接状态，连接断了照跑
 *   - 幂等：taskId 已存在直接回 accept(duplicate=true)，不重跑
 *   - 可取消：task/cancel 会打断 agent 或杀进程树，并把状态落成 aborted
 *   - 状态先落盘再上报：崩溃后重启，task/sync 能如实反映最后状态
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ARTIFACT_ROLE,
  ERROR_CODE,
  RemoteAgentError,
  TASK_MODE,
  TASK_STATUS,
} from '../protocol.js'
import { hashText } from '../artifacts.js'
import { unifiedDiff } from './diff.js'
import { isDenied, resolveWorkspace, runCommand } from './exec.js'

/** 摘要里最多保留多少条 changed 记录。 */
const MAX_CHANGED = 500

/**
 * 默认任务超时（提案 #26-1）：**exec 与 agent 分开**。
 *
 * 一条 exec 卡住 = 整台副机 1 小时不可用是 #26 实测的事故形态（两条慢 exec
 * 占满 maxConcurrent，队列永动不了）。exec 是跑命令，绝大多数 1 分钟内结束；
 * 10 分钟足够暴露"命令本身有问题"（路径不存在/权限/巨目录）。agent 会话
 * 可能真的要跑很久，保持 1 小时。
 *
 * tools.js 的 remote_task 默认值必须与这里**同源**（直接 import 本常量），
 * 否则会出现"工具说 10 分钟、副机兜底 1 小时"的分裂。
 */
export const EXEC_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const AGENT_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

/** 队列饥饿判定阈值（提案 #26-3）：queued>0 且并发占满且最久排队超过此时长。 */
export const QUEUE_STARVED_AFTER_MS = 2 * 60 * 1000

export class TaskEngine {
  /**
   * @param {object} o
   * @param {import('./task-store.js').TaskStore} o.store
   * @param {import('./artifact-service.js').ArtifactService} o.artifacts
   * @param {object} o.runner 选定的 runner（InProcessRunner | HeadlessRunner）
   * @param {string} o.nodeId
   * @param {string[]} o.roots 允许的工作区根
   * @param {string[]} o.denyPaths
   * @param {string} o.defaultWorkspace
   * @param {boolean} o.caseInsensitive
   * @param {(type:string, data:object)=>void} o.send 发送业务帧
   * @param {object} [o.logger]
   */
  constructor(o) {
    this.store = o.store
    this.artifacts = o.artifacts
    this.runner = o.runner
    this.nodeId = o.nodeId
    this.roots = o.roots
    this.denyPaths = o.denyPaths ?? []
    this.defaultWorkspace = o.defaultWorkspace
    this.caseInsensitive = o.caseInsensitive ?? true
    this.send = o.send
    this.logger = o.logger
    /** taskId → { controller, startedAt } */
    this.running = new Map()
    /** 任务并发上限，防止副机被一次派单压垮。
     *  默认 4（提案 #26-2）：2 太脆 —— 两条慢任务就能锁死整台机器；
     *  4 让"两条慢 + 两条快"正常共存。配置项保留，按内存调整。 */
    this.maxConcurrent = o.maxConcurrent ?? 4
    this.queue = []
    /** 卸载闸门：stop() 置 true 后不再接受/启动新任务（见 stop() 注释）。 */
    this.stopped = false
  }

  log(level, msg, extra) {
    if (this.logger?.info) this.logger[level === 'warn' ? 'warn' : 'info']?.(`[remote-agent] ${msg}`, extra)
  }

  /** 接受一条任务。幂等。 */
  accept(spec) {
    const existing = this.store.get(spec.taskId)
    if (existing) {
      this.send('task/accept', {
        taskId: spec.taskId,
        duplicate: true,
        status: existing.status,
        nodeId: this.nodeId,
      })
      return { duplicate: true, record: existing }
    }

    // 工作区必须在允许根内 —— 这一步先于任何副作用
    let workspace
    try {
      workspace = resolveWorkspace(spec.workspace, {
        roots: this.roots,
        caseInsensitive: this.caseInsensitive,
        defaultDir: this.defaultWorkspace,
      })
    } catch (err) {
      const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.WORKSPACE_DENIED
      this.send('task/end', {
        taskId: spec.taskId,
        nodeId: this.nodeId,
        status: TASK_STATUS.FAILED,
        error: { code, message: String(err?.message ?? err) },
      })
      return { rejected: true, error: String(err?.message ?? err) }
    }

    fs.mkdirSync(workspace, { recursive: true })

    const { record } = this.store.create({ ...spec, workspace }, { nodeId: this.nodeId, workspace })
    this.send('task/accept', {
      taskId: spec.taskId,
      duplicate: false,
      status: TASK_STATUS.QUEUED,
      nodeId: this.nodeId,
      workspace,
      runner: this.runner.kind,
      queueDepth: this.queue.length,
    })

    this.enqueue(record.taskId)
    return { accepted: true, record }
  }

  enqueue(taskId) {
    if (this.stopped) return
    this.queue.push(taskId)
    void this.pump()
  }

  /**
   * 队列泵。
   *
   * `stopped` 闸门（E5-1 修复）：teardown 会清空 queue 并置 stopped=true，
   * 但 execute() 的 finally 里有 `setTimeout(() => this.pump(), 0)` ——
   * 没有这个闸门，一次已经在途的 pump 会在卸载后继续启动任务
   * （实测卸载后仍启动了 2 个排队任务）。
   * 注意：stopped 只阻止**执行**，磁盘上的 queued 记录原样保留，
   * 下次启动的 reconcile 仍能重排。
   */
  async pump() {
    if (this.stopped) return
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const taskId = this.queue.shift()
      const rec = this.store.get(taskId)
      if (!rec) continue
      void this.execute(taskId)
    }
  }

  /** 停止接受与启动新任务（不取消在跑的）。卸载时由 teardown 调用。 */
  stop() {
    this.stopped = true
    this.queue.length = 0
  }

  /** 执行一条任务。不 await —— 由 running 表跟踪。 */
  async execute(taskId) {
    if (this.stopped) return
    const rec = this.store.get(taskId)
    if (!rec) return
    if (this.running.has(taskId)) return

    const controller = new AbortController()
    this.running.set(taskId, { controller, startedAt: Date.now() })

    this.store.update(taskId, {
      status: TASK_STATUS.RUNNING,
      startedAt: Date.now(),
      attempts: (rec.attempts ?? 0) + 1,
    })
    this.send('task/progress', {
      taskId,
      nodeId: this.nodeId,
      status: TASK_STATUS.RUNNING,
      phase: 'started',
      at: Date.now(),
    })

    const before = this.snapshotWorkspace(rec.workspace, { withContent: true })

    try {
      const result = rec.mode === TASK_MODE.EXEC
        ? await this.runExec(rec, controller)
        : await this.runAgent(rec, controller)

      const manifest = await this.artifacts.build({
        workspace: rec.workspace,
        outputs: rec.outputs,
        artifactRules: rec.artifactRules ?? undefined,
        denyPaths: [...this.denyPaths, ...(rec.constraints?.denyPaths ?? [])],
        signal: controller.signal,
      })

      const after = this.snapshotWorkspace(rec.workspace)
      const changed = diffSnapshots(before, after, rec.workspace, this.caseInsensitive)
      const diffs = buildDiffs({
        workspace: rec.workspace,
        changed,
        before,
        caseInsensitive: this.caseInsensitive,
      })

      // 状态映射必须把 aborted 纳入 —— 否则用户主动取消会被显示成"任务失败"，
      // 自动化流程可能据此误判需要重试。abort 时 exec.js 给的是
      // ok=false / timedOut=false / aborted=true，旧映射会落进 FAILED。
      const status = result.aborted
        ? TASK_STATUS.ABORTED
        : result.timedOut
          ? TASK_STATUS.INTERRUPTED
          : result.ok
            ? TASK_STATUS.COMPLETED
            : TASK_STATUS.FAILED

      const failure = result.aborted || result.timedOut || result.ok
        ? null
        : {
          code: 'task-failed',
          message: result.stderr || 'task failed',
          // 让 hub 侧能区分"命令真的失败了"与"取消/超时"，
          // 而不是只能看到一个笼统的 error=null
          exitCode: result.exitCode ?? null,
        }

      this.store.update(taskId, {
        status,
        endedAt: Date.now(),
        exit: {
          code: result.exitCode ?? null,
          timedOut: result.timedOut === true,
          aborted: result.aborted === true,
          runner: this.runner.kind,
          toolCalls: result.toolCalls?.length ?? 0,
        },
        sessionId: result.sessionId ?? null,
        manifest,
        changed,
        error: failure,
      })

      this.send('task/summary', {
        taskId,
        nodeId: this.nodeId,
        handoff: buildHandoff({
          rec: this.store.get(taskId),
          nodeId: this.nodeId,
          result,
          manifest,
          changed,
          diffs,
          workspace: rec.workspace,
        }),
      })

      // 失败路径也要带 error —— 此前 catch 路径带、正常失败路径不带，
      // 两条路径不一致，hub 投影里普通失败任务的 error 恒为 null。
      this.send('task/end', {
        taskId,
        nodeId: this.nodeId,
        status,
        durationMs: Date.now() - (rec.startedAt ?? Date.now()),
        manifestCounts: manifest.counts,
        ...(failure ? { error: failure } : {}),
      })
    } catch (err) {
      const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL
      this.store.update(taskId, {
        status: TASK_STATUS.FAILED,
        endedAt: Date.now(),
        error: { code, message: String(err?.message ?? err) },
      })
      this.send('task/end', {
        taskId,
        nodeId: this.nodeId,
        status: TASK_STATUS.FAILED,
        error: { code, message: String(err?.message ?? err) },
      })
    } finally {
      this.running.delete(taskId)
      // 队列推进：一条跑完再起下一条
      setTimeout(() => void this.pump(), 0)
    }
  }

  /**
   * 输出行心跳（提案 #15）：每 2s 检查一次行数，**有新增才发**一帧
   * phase:'output' 的进度。返回 stop() —— 调用方必须在任务收尾时调用
   * （try/finally），否则定时器会挂在已完成任务上空转。
   */
  outputHeartbeat(taskId, getLines) {
    let last = -1
    const timer = setInterval(() => {
      const n = getLines()
      if (n === last) return
      last = n
      this.send('task/progress', {
        taskId,
        nodeId: this.nodeId,
        phase: 'output',
        detail: `已输出 ${n} 行`,
        at: Date.now(),
      })
    }, 2000)
    if (timer.unref) timer.unref()
    return () => clearInterval(timer)
  }

  /** exec 模式：直接跑命令。 */
  async runExec(rec, controller) {
    const command = rec.goal
    this.store.appendLog(rec.taskId, `$ ${command}`)
    this.send('task/progress', {
      taskId: rec.taskId,
      nodeId: this.nodeId,
      phase: 'exec',
      command: command.slice(0, 500),
      at: Date.now(),
    })

    // 输出行心跳（提案 #15）：长命令跑着时每 2s 报一次"已输出 N 行"，
    // 面板不用等 handoff/终态就知道"活着且在吐东西"。只对 exec 做 ——
    // agent 任务的工具事件本身就是步骤流，别把 hub 侧 20 条的
    // progressTail 刷成纯输出心跳。
    let outLines = 0
    const stopHeartbeat = this.outputHeartbeat(rec.taskId, () => outLines)

    let res
    try {
      res = await runCommand(command, {
        cwd: rec.workspace,
        // exec 默认 10 分钟（提案 #26-1，与 tools.js 同源常量）；任务显式
        // 传 timeoutMs 时以任务为准（长遍历大目录等场景仍可显式放宽）。
        timeoutMs: rec.constraints?.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS,
        env: rec.constraints?.extraEnv ?? {},
        signal: controller.signal,
        onData: (chunk, stream) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (line.trim() !== '') {
              this.store.appendLog(rec.taskId, `[${stream}] ${line}`)
              outLines += 1
            }
          }
        },
      })
    } finally {
      stopHeartbeat()
    }

    if (res.stdout) this.store.appendLog(rec.taskId, res.stdout.slice(-2000))
    if (res.stderr) this.store.appendLog(rec.taskId, `[stderr] ${res.stderr.slice(-2000)}`)

    return {
      ok: res.ok,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      aborted: res.aborted,
      final: res.stdout.slice(-8000),
      stderr: res.stderr.slice(-4000),
      toolCalls: [],
      durationMs: res.durationMs,
      sessionId: null,
    }
  }

  /** agent 模式：在副机本地起一个真实 agent 会话。 */
  async runAgent(rec, controller) {
    this.send('task/progress', {
      taskId: rec.taskId,
      nodeId: this.nodeId,
      phase: 'agent-start',
      runner: this.runner.kind,
      at: Date.now(),
    })

    const res = await this.runner.run({
      taskId: rec.taskId,
      goal: buildTaskBrief(rec),
      cwd: rec.workspace,
      // 主机指定的模型选择（可选，protocol.normalizeModelSelection 已归一）。
      // 落盘为 null 表示未指定 → 传 undefined，让 runner 走"副机默认"路径。
      // in-process 后端会把它叠加到副机默认选择上；headless 后端会明确拒绝。
      model: rec.model ?? undefined,
      timeoutMs: rec.constraints?.timeoutMs ?? AGENT_DEFAULT_TIMEOUT_MS,
      signal: controller.signal,
      onData: (chunk, stream) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim() !== '') this.store.appendLog(rec.taskId, `[${stream}] ${line}`)
        }
      },
      onEvent: (evt) => {
        this.store.appendProgress(rec.taskId, evt)
        this.send('task/progress', {
          taskId: rec.taskId,
          nodeId: this.nodeId,
          phase: evt.kind,
          detail: evt.text ?? evt.name,
          at: Date.now(),
        })
      },
    })

    if (res.final) this.store.appendLog(rec.taskId, res.final.slice(-4000))
    if (res.stderr) this.store.appendLog(rec.taskId, `[stderr] ${res.stderr.slice(-2000)}`)

    return res
  }

  /** 取消一条任务。 */
  async cancel(taskId) {
    const live = this.running.get(taskId)
    const rec = this.store.get(taskId)
    if (!rec) {
      this.send('task/end', {
        taskId,
        nodeId: this.nodeId,
        status: TASK_STATUS.FAILED,
        error: { code: ERROR_CODE.TASK_UNKNOWN, message: 'unknown taskId' },
      })
      return false
    }

    // 从队列里摘掉（还没开始跑的）
    const qi = this.queue.indexOf(taskId)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      this.store.update(taskId, {
        status: TASK_STATUS.ABORTED,
        endedAt: Date.now(),
        error: { code: 'cancelled', message: 'cancelled before start' },
      })
      this.send('task/end', { taskId, nodeId: this.nodeId, status: TASK_STATUS.ABORTED })
      return true
    }

    if (!live) return false

    if (typeof this.runner.cancel === 'function') {
      await this.runner.cancel(taskId)
    }
    live.controller.abort()
    this.store.appendLog(taskId, '[system] cancel requested by hub')
    return true
  }

  /**
   * 工作区快照：用于计算 changed。只存 path → {bytes, mtimeMs}。
   *
   * withContent（提案 #21）：额外为**文本前像**读进内容（≤256KB、前 64 字节
   * 无 NUL、最多 64 个文件、总量 ≤4MB）—— diff 需要"任务开始前长什么样"，
   * 任务跑完再想拿前像就晚了。只对 before 侧开（after 侧的 diff 后文按需
   * 现读，避免无谓的双倍 I/O）。捕获上限保证快照成本有界：大文件/二进制/
   * 深层堆积都不进内容库，这些文件的 diff 会缺席（changed 元数据仍在）。
   */
  snapshotWorkspace(workspace, { withContent = false } = {}) {
    const map = new Map()
    const stack = [{ abs: workspace, rel: '', depth: 0 }]
    const deny = [...this.denyPaths, ...(this.store.list().flatMap((r) => r.constraints?.denyPaths ?? []))]
    let contentFiles = 0
    let contentBytes = 0
    while (stack.length > 0 && map.size < MAX_CHANGED * 4) {
      const cur = stack.pop()
      if (cur.depth > 12) continue
      let entries
      try {
        entries = fs.readdirSync(cur.abs, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const childAbs = path.join(cur.abs, e.name)
        const childRel = cur.rel === '' ? e.name : `${cur.rel}/${e.name}`
        if (isDenied(childAbs, deny, { caseInsensitive: this.caseInsensitive })) continue
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name.toLowerCase())) continue
          stack.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 })
          continue
        }
        if (!e.isFile()) continue
        try {
          const st = fs.statSync(childAbs)
          const entry = { bytes: st.size, mtimeMs: Math.round(st.mtimeMs) }
          if (withContent && contentFiles < MAX_SNAPSHOT_CONTENT_FILES && contentBytes < MAX_SNAPSHOT_CONTENT_TOTAL_BYTES && st.size > 0 && st.size <= MAX_SNAPSHOT_FILE_BYTES) {
            try {
              const buf = fs.readFileSync(childAbs)
              // 二进制挡板：前 64 字节出现 NUL 视为二进制，不进内容库
              if (!buf.subarray(0, 64).includes(0)) {
                entry.content = buf.toString('utf8')
                contentFiles += 1
                contentBytes += buf.length
              }
            } catch {
              /* 竞态：文件刚被删 */
            }
          }
          map.set(childRel, entry)
        } catch {
          /* 竞态：文件刚被删 */
        }
      }
    }
    return map
  }

  /**
   * 队列健康快照（提案 #26-3）：随资源遥测帧上报 hub。
   *
   * 背景（#26 实测事故）：两条慢 exec 占满 maxConcurrent 后，pump() 的
   * while 条件永假，后续任务全部 queued 且**在面板上不可见**——用户只知道
   * "卡了"，不知道"卡在哪"。这个快照让 hub/面板能说出一句话：
   * "队列被 N 条运行中任务阻塞，最久已等 M 分钟"。
   *
   * starved 判定：有排队 + 并发占满 + 最久排队超过 QUEUE_STARVED_AFTER_MS。
   * 纯读操作，绝不影响任务链路（与资源遥测同一条尽力而为不变式）。
   */
  queueStats(now = Date.now()) {
    const queuedAt = this.queue
      .map((id) => this.store.get(id)?.createdAt)
      .filter((t) => typeof t === 'number' && t > 0)
    const oldestQueuedMs = queuedAt.length > 0 ? Math.max(0, now - Math.min(...queuedAt)) : 0
    const saturated = this.running.size >= this.maxConcurrent
    return {
      queued: this.queue.length,
      running: this.running.size,
      maxConcurrent: this.maxConcurrent,
      oldestQueuedMs,
      starved: this.queue.length > 0 && saturated && oldestQueuedMs > QUEUE_STARVED_AFTER_MS,
    }
  }

  /** 重连后向 hub 上报全部任务状态。 */
  syncAll() {
    this.send('task/sync', {
      nodeId: this.nodeId,
      tasks: this.store.list().map((r) => this.store.view(r)),
    })
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.cache', '.tmp', 'temp', 'tmp',
  '.next', '.nuxt', '.turbo', '.parcel-cache', '.vite',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.dsh-remote-agent',
])

// 快照内容库的硬上限（提案 #21）：快照成本必须有界 —— 大文件/二进制不进
// 内容库（它们的 diff 缺席但 changed 元数据仍在），也不会把任务启动拖慢。
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024
const MAX_SNAPSHOT_CONTENT_FILES = 64
const MAX_SNAPSHOT_CONTENT_TOTAL_BYTES = 4 * 1024 * 1024

// buildDiffs 的输出上限：diff 是"证据链视图"不是全量备份，12 个文件 /
// 每个 16KB / 总 96KB 之后宁可缺席（面板显示"已截断"）。
const DIFF_MAX_FILES = 12
const DIFF_MAX_TOTAL_BYTES = 96 * 1024

/**
 * 计算工作区变更（新增 / 修改 / 删除）。
 * 这是 hub 侧"信息汇聚"最重要的输入：主电脑只想知道"到底动了什么"。
 */
export function diffSnapshots(before, after, workspace, caseInsensitive = true) {
  const changed = []
  const keyOf = (p) => (caseInsensitive ? p.toLowerCase() : p)

  const beforeByKey = new Map()
  for (const [k, v] of before) beforeByKey.set(keyOf(k), { path: k, ...v })
  const afterByKey = new Map()
  for (const [k, v] of after) afterByKey.set(keyOf(k), { path: k, ...v })

  for (const [k, a] of afterByKey) {
    const b = beforeByKey.get(k)
    if (!b) {
      changed.push({ path: a.path, op: 'add', bytes: a.bytes })
    } else if (b.bytes !== a.bytes || b.mtimeMs !== a.mtimeMs) {
      changed.push({
        path: a.path,
        op: 'modify',
        bytes: a.bytes,
        deltaBytes: a.bytes - b.bytes,
      })
    }
  }
  for (const [k, b] of beforeByKey) {
    if (!afterByKey.has(k)) changed.push({ path: b.path, op: 'delete', bytes: 0 })
  }

  changed.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  return changed.slice(0, MAX_CHANGED)
}

/**
 * 为 changed 条目生成 unified diff（提案 #21）。
 *
 * 前像来自快照内容库（snapshotWorkspace 的 withContent 捕获）；后像在任务
 * 收尾时现读（只需为进入 diff 的文件读，≤12 个）。任何一环不满足
 * （前像缺席 / 文件过大 / 二进制 / 读失败）就跳过该文件 —— diff 是
 * 增强证据，缺了不致命，绝不能因为它拖垮任务收尾。
 *
 * @param {object} o
 * @param {string} o.workspace 任务工作区（绝对路径）
 * @param {Array<{path:string, op:string}>} o.changed diffSnapshots 的输出
 * @param {Map<string, {bytes:number, mtimeMs:number, content?:string}>} o.before 任务开始前的快照
 * @param {boolean} [o.caseInsensitive] 与 diffSnapshots 同一大小写口径
 * @returns {Array<{path:string, diff:string, truncated:boolean}>}
 */
export function buildDiffs({ workspace, changed, before, caseInsensitive = true }) {
  const diffs = []
  if (!Array.isArray(changed) || changed.length === 0) return diffs
  let totalBytes = 0
  const keyOf = (p) => (caseInsensitive ? p.toLowerCase() : p)
  const beforeByKey = new Map()
  for (const [k, v] of before) beforeByKey.set(keyOf(k), { path: k, ...v })

  for (const c of changed) {
    if (diffs.length >= DIFF_MAX_FILES || totalBytes >= DIFF_MAX_TOTAL_BYTES) break
    if (!c || typeof c.path !== 'string' || c.path === '') continue
    const beforeEntry = beforeByKey.get(keyOf(c.path))
    let beforeText = ''
    if (c.op === 'modify' || c.op === 'delete') {
      // 前像缺席（文件太大 / 二进制 / 当时不在线）就放弃这个文件的 diff
      if (typeof beforeEntry?.content !== 'string') continue
      beforeText = beforeEntry.content
    }
    let afterText = ''
    if (c.op === 'modify' || c.op === 'add') {
      const text = readTextForDiff(path.join(workspace, c.path))
      if (text === null) continue
      afterText = text
    }
    let d
    try {
      d = unifiedDiff({ path: c.path, beforeText, afterText })
    } catch {
      continue // diff 生成失败不致命
    }
    if (!d) continue
    diffs.push(d)
    totalBytes += Buffer.byteLength(d.diff, 'utf8')
  }
  return diffs
}

/** 读一个文件做 diff 后像：≤256KB 且前 64 字节无 NUL；否则返回 null。 */
function readTextForDiff(abs) {
  try {
    const buf = fs.readFileSync(abs)
    if (buf.length === 0 || buf.length > MAX_SNAPSHOT_FILE_BYTES) return null
    if (buf.subarray(0, 64).includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 任务书包装。
 *
 * 关键：副机的 agent 是**独立 Agent**，它不知道自己在被远程派单。
 * 所以任务书要自带上下文，而不是指望它去猜。同时明确告诉它产物规则，
 * 让它把成品放在工作区里 —— 否则 manifest 什么也捞不到。
 */
export function buildTaskBrief(rec) {
  const lines = [
    '# 远程任务',
    '',
    '你正在一台独立机器上执行一条由远程同事派发的任务。',
    '请在这个工作区里完成它，并把**成品**留在工作区内（会被自动收集成产物清单）。',
    '',
    `工作区：${rec.workspace}`,
    '',
    '## 任务',
    '',
    rec.goal,
    '',
  ]
  if (rec.outputs?.length) {
    lines.push('## 期望产出（glob）', '', ...rec.outputs.map((o) => `- ${o}`), '')
  }
  lines.push(
    '## 约定',
    '',
    '- 编译产物、报告文档、源码变更、媒体文件会作为「成品」上报（role:final）',
    '- 日志、缓存、中间构建文件只上报元数据，不会被传回（role:intermediate）',
    '- 完成后用一段简洁的中文说明：做了什么、结果如何、遗留什么问题',
    '',
  )
  return lines.join('\n')
}

/**
 * 生成 handoff 摘要 —— 主电脑真正消费的东西。
 *
 * 设计原则：这张卡要能让主机 agent 在不看副机任何日志的情况下做决策
 * （要不要拉某个产物、要不要重派、要不要人工介入）。
 */
export function buildHandoff({ rec, nodeId, result, manifest, changed, diffs, workspace }) {
  const finalItems = manifest.items.filter((i) => i.role === ARTIFACT_ROLE.FINAL)
  const intermediateCount = manifest.items.filter((i) => i.role === ARTIFACT_ROLE.INTERMEDIATE).length

  const summaryText = (result.final ?? '').trim()
  const fallback = result.ok
    ? `任务完成，产出 ${finalItems.length} 个成品。`
    : `任务未成功：${(result.stderr ?? '').slice(0, 300) || 'no diagnostics'}`

  return {
    taskId: rec.taskId,
    nodeId,
    goal: rec.goal,
    mode: rec.mode,
    workspace,
    status: rec.status,
    runner: result.runner ?? rec.exit?.runner ?? 'unknown',
    sessionId: result.sessionId ?? null,
    durationMs: result.durationMs ?? (rec.endedAt ?? Date.now()) - (rec.startedAt ?? Date.now()),
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    exit: {
      code: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      toolCalls: result.toolCalls?.length ?? 0,
    },
    summary: {
      text: summaryText || fallback,
      sha256: hashText(summaryText || fallback),
      source: summaryText ? 'agent' : 'engine',
    },
    changed,
    diffs,
    artifacts: {
      counts: manifest.counts,
      bytesFinal: manifest.bytesFinal,
      final: finalItems.map((i) => ({
        path: i.path,
        kind: i.kind,
        bytes: i.bytes,
        sha256: i.sha256 ?? null,
      })),
      intermediateCount,
      note: '只有 role:final 可以 pull；intermediate 仅上报元数据，留在副机。',
    },
    logs: {
      tail: (rec.logs ?? []).slice(-20).map((l) => l.line),
      full: `dsh-remote-agent://tasks/${rec.taskId}/logs`,
    },
    pullHint: finalItems.length > 0
      ? `用 remote_pull 拉取，例如：${finalItems.slice(0, 3).map((i) => i.path).join(', ')}`
      : '本次没有 role:final 产物，无需 pull。',
  }
}
