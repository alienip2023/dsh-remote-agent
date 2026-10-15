/**
 * 主机侧产物拉取管理器（零外部依赖）。
 *
 * 契约（用户锁定的 v0.1）：
 *   1. **清单先于字节** —— 任务结束只回 manifest + handoff；文件要 hub 显式 pull 才过河。
 *   2. **只有 role:final 过河** —— intermediate 在副机留存，hub 侧连字节都拿不到。
 *   3. **hash 先声明后校验** —— 分块帧头带 manifest 里的 sha256；hub 边写边算，
 *      收 done 时比对。不一致就删掉临时文件并报 hash-mismatch，绝不静默接受半截字节。
 *
 * 落盘策略：先写 `<dest>/.dsh-remote-agent-<pullId>.part`，校验通过才 rename 到最终路径。
 * rename 在同一目录内是原子的，所以 dest 里要么是完整正确的文件，要么什么都没有。
 *
 * 资源纪律：每个 pull 一个 fd + 一个定时器；超时、取消、节点掉线、插件卸载
 * 四条路径都必须把 fd 关掉、把临时文件删掉。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  ARTIFACT_ROLE,
  DEFAULT_PULL_TIMEOUT_MS,
  ERROR_CODE,
  HUB_TO_NODE,
  RemoteAgentError,
  newPullId,
} from '../protocol.js'
import { normalizePath } from '../glob.js'

/** 临时文件前缀：一眼能看出是远程产物拉取的中间态。 */
const TMP_PREFIX = '.dsh-remote-agent-'

/**
 * Windows 保留设备名（DOS 时代遗留，至今仍在 Win32 层生效）。
 * `dest\con` 这类路径会被解析成设备而非文件；在部分 API 上会失败或产生怪异行为。
 * 当前实测 openSync 落成普通文件，不构成逃逸，但跨机器可移植性隐患真实存在，
 * 所以统一加前缀规避 —— 代价只是文件名多几个字符。
 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * 把产物相对路径收敛成一个安全的落盘文件名。
 *
 * 只取最后一段：清单里的 `dist/app.exe` 落到 `dest/app.exe`。
 * 这样 `../../etc/passwd` 这种路径在 hub 侧就被折平，dest 之外一个字节都写不出去。
 */
export function safeDestName(relPath) {
  const norm = normalizePath(String(relPath ?? ''))
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  // eslint-disable-next-line no-control-regex -- 控制字符正是要清洗的对象（0x00-0x1f 落盘会截断/乱码）
  let cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+$/, '')

  // 去掉尾部空格与点：Windows 会在创建时静默剥掉，导致落盘名与清单名不一致
  cleaned = cleaned.replace(/[ .]+$/, '')

  // 保留设备名：`con.txt` 同样命中（Win32 只看扩展名之前的基名）
  const stem = cleaned.split('.')[0].toLowerCase()
  if (WINDOWS_RESERVED.has(stem)) cleaned = `_${cleaned}`

  return cleaned === '' ? `artifact-${Date.now().toString(36)}` : cleaned
}

export class PullManager {
  /**
   * @param {object} o
   * @param {import('./node-registry.js').NodeRegistry} o.registry
   * @param {(level:string,msg:string,extra?:object)=>void} o.log
   * @param {object} [o.limits]
   */
  constructor({ registry, log, limits = {} }) {
    this.registry = registry
    this.log = log ?? (() => {})
    this.limits = {
      pullTimeoutMs: DEFAULT_PULL_TIMEOUT_MS,
      maxPullBytes: 512 * 1024 * 1024,
      ...limits,
    }
    /** pullId → session */
    this.sessions = new Map()
    /** taskId → Set<pullId>，便于按任务取消 */
    this.byTask = new Map()
    this.closed = false
  }

  get activeCount() {
    return this.sessions.size
  }

  /**
   * 拉一个产物。
   *
   * @param {object} o
   * @param {string} o.nodeId
   * @param {string} o.taskId
   * @param {string} o.relPath 清单内的相对路径
   * @param {string} o.dest 本机目标目录（绝对路径）
   * @param {AbortSignal} [o.signal]
   * @param {number} [o.timeoutMs]
   * @param {object|null} [o.manifest] 已知清单，用于 hub 侧先拦一次
   * @returns {Promise<{path:string, bytes:number, sha256:string|null, dest:string}>}
   */
  pull(o) {
    const { nodeId, taskId, relPath, dest, signal, manifest } = o
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : this.limits.pullTimeoutMs

    if (this.closed) {
      return Promise.reject(new RemoteAgentError('pull manager closed', ERROR_CODE.INTERNAL))
    }

    // hub 侧预检：清单已知时先拦掉 intermediate / 不存在 / 超限的路径。
    // 副机侧还有一次权威校验（authorizePull），这里是省一次往返。
    if (manifest && Array.isArray(manifest.final)) {
      const item = manifest.final.find((i) => normalizePath(i.path) === normalizePath(relPath))
      if (!item) {
        return Promise.reject(
          new RemoteAgentError(`artifact not in manifest: ${relPath}`, ERROR_CODE.ARTIFACT_MISSING),
        )
      }
      if (typeof item.bytes === 'number' && item.bytes > this.limits.maxPullBytes) {
        return Promise.reject(
          new RemoteAgentError(`${item.bytes} bytes exceeds maxPullBytes=${this.limits.maxPullBytes}`, ERROR_CODE.ARTIFACT_TOO_LARGE),
        )
      }
    }

    const rec = this.registry.getNode(nodeId)
    if (!rec) {
      return Promise.reject(new RemoteAgentError(`unknown node: ${nodeId}`, ERROR_CODE.TASK_UNKNOWN))
    }
    if (!rec.online) {
      return Promise.reject(new RemoteAgentError(`node offline: ${nodeId}`, ERROR_CODE.INTERNAL))
    }

    let destDir
    try {
      destDir = path.resolve(dest)
      fs.mkdirSync(destDir, { recursive: true })
    } catch (err) {
      return Promise.reject(
        new RemoteAgentError(`cannot create dest dir ${dest}: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL),
      )
    }

    const finalPath = path.join(destDir, safeDestName(relPath))
    const pullId = newPullId()
    const tmpPath = path.join(destDir, `${TMP_PREFIX}${pullId}.part`)

    let fd
    try {
      fd = fs.openSync(tmpPath, 'wx')
    } catch (err) {
      return Promise.reject(
        new RemoteAgentError(`cannot create temp file ${tmpPath}: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL),
      )
    }

    const session = {
      pullId,
      nodeId,
      taskId,
      relPath,
      destDir,
      finalPath,
      tmpPath,
      fd,
      hash: createHash('sha256'),
      received: 0,
      total: null,
      declaredSha256: null,
      expectedBytes: null,
      // 本条 pull 的空闲超时预算。**每块重置时必须用它自己这份**，
      // 不能回退到 limits.pullTimeoutMs —— 否则调用方传进来的自定义
      // 短超时在第一个分块之后就静默失效（实测踩过）。
      timeoutMs,
      done: false,
      settled: false,
      timer: undefined,
      signal,
      onAbort: undefined,
      resolve: undefined,
      reject: undefined,
      startedAt: Date.now(),
    }

    const promise = new Promise((resolve, reject) => {
      session.resolve = resolve
      session.reject = reject
    })

    this.sessions.set(pullId, session)
    const set = this.byTask.get(taskId) ?? new Set()
    set.add(pullId)
    this.byTask.set(taskId, set)
    rec.pendingPulls.set(pullId, session)

    if (signal) {
      session.onAbort = () => this.failSession(pullId, new RemoteAgentError('pull aborted by caller', 'aborted'), true)
      if (signal.aborted) {
        session.onAbort()
        return promise
      }
      signal.addEventListener('abort', session.onAbort, { once: true })
    }

    this.armTimeout(pullId, timeoutMs)

    const sent = this.registry.send(nodeId, HUB_TO_NODE.ARTIFACT_PULL, {
      pullId,
      taskId,
      path: relPath,
      timeoutMs,
    })
    if (!sent) {
      this.failSession(pullId, new RemoteAgentError(`node unreachable: ${nodeId}`, ERROR_CODE.INTERNAL), false)
      return promise
    }
    this.log('info', 'artifact pull requested', { pullId, taskId, nodeId, path: relPath, dest: finalPath })
    return promise
  }

  /** 空闲超时：每收到一块就重置。大文件慢传不会被误杀，卡死会被收掉。 */
  armTimeout(pullId, timeoutMs) {
    const s = this.sessions.get(pullId)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      this.failSession(
        pullId,
        new RemoteAgentError(`pull timeout: no chunk for ${timeoutMs}ms`, ERROR_CODE.INTERNAL),
        true,
      )
    }, timeoutMs)
    if (s.timer.unref) s.timer.unref()
  }

  /**
   * 收一个二进制分块帧。顺序错、长度超限、pullId 未知一律按失败处理并清理。
   */
  ingestBinary(header, payload) {
    const pullId = header?.pullId
    if (typeof pullId !== 'string') {
      this.log('warn', 'artifact chunk without pullId')
      return
    }
    const s = this.sessions.get(pullId)
    if (!s) {
      // 已经超时/取消的 pull 还在收字节：丢弃即可，不能抛
      return
    }
    if (s.settled) return

    // offset 必填：副机的 artifact-service 总是带 offset/total 发块（同一份包
    // 一起发版，协议 v1 内没有"不带 offset 的对端"）。缺 offset 只可能来自
    // 畸形帧 / 第三方实现 —— 按"顺序无法确认"处理，与注释声明的语义一致，
    // 而不是静默跳过校验继续写盘。
    const offset = Number(header.offset)
    if (!Number.isFinite(offset)) {
      this.failSession(
        pullId,
        new RemoteAgentError('artifact chunk missing offset (malformed frame)', ERROR_CODE.HASH_MISMATCH),
        true,
      )
      return
    }
    if (offset !== s.received) {
      this.failSession(
        pullId,
        new RemoteAgentError(
          `artifact chunk out of order: expected offset ${s.received}, got ${offset}`,
          ERROR_CODE.HASH_MISMATCH,
        ),
        true,
      )
      return
    }

    const declared = typeof header.sha256 === 'string' ? header.sha256 : null
    if (declared) s.declaredSha256 = declared
    if (Number.isFinite(header.total)) s.total = header.total
    if (s.expectedBytes !== null && s.received + payload.length > s.expectedBytes) {
      this.failSession(
        pullId,
        new RemoteAgentError(`artifact larger than declared: ${s.received + payload.length} > ${s.expectedBytes}`, ERROR_CODE.HASH_MISMATCH),
        true,
      )
      return
    }
    if (s.received + payload.length > this.limits.maxPullBytes) {
      this.failSession(
        pullId,
        new RemoteAgentError(`artifact exceeds maxPullBytes=${this.limits.maxPullBytes}`, ERROR_CODE.ARTIFACT_TOO_LARGE),
        true,
      )
      return
    }

    try {
      // ⚠ `writeSync` **可能部分写**，必须检查返回值。
      //
      // 原来忽略了它 —— 部分写会让文件缺字节，虽然最终 sha256 校验会兜住
      // （不会把坏文件当成品），但代价是**白传一整份产物**才失败。
      // 明确失败更早、更省，也让"为什么失败"可诊断。
      //
      // 注意 `writeSync(fd, buf, offset, length)` 可能写不完就返回，
      // 所以这里循环直到写完或明确失败。
      let written = 0
      while (written < payload.length) {
        const n = fs.writeSync(s.fd, payload, written, payload.length - written)
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`short write: wrote ${written}/${payload.length} bytes`)
        }
        written += n
      }
    } catch (err) {
      this.failSession(
        pullId,
        new RemoteAgentError(`write failed: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL),
        true,
      )
      return
    }
    s.hash.update(payload)
    s.received += payload.length
    s.lastChunkAt = Date.now()
    // 用**本条 pull 自己的**预算重臂（见 session.timeoutMs 的说明）。
    this.armTimeout(pullId, s.timeoutMs)
  }

  /**
   * 收 artifact/done（文本帧或二进制帧头都走这里）：校验 sha256 后收尾。
   */
  ingestDone(header) {
    const pullId = header?.pullId
    if (typeof pullId !== 'string') return
    const s = this.sessions.get(pullId)
    if (!s || s.settled) return

    const declared = typeof header.sha256 === 'string' ? header.sha256 : null
    const expected = typeof header.expected === 'string' ? header.expected : null
    const declaredTotal = Number.isFinite(header.total) ? header.total : s.total
    const expectedBytes = Number.isFinite(header.bytes) ? header.bytes : declaredTotal

    const actual = s.hash.digest('hex')
    const want = s.declaredSha256 ?? expected ?? null

    // 三重比对：hub 本地算出的、副机声明的、分块头声明的，必须彼此一致。
    if (declared && actual !== declared) {
      this.failSession(
        pullId,
        new RemoteAgentError(
          `hash-mismatch: node reported ${declared} but hub computed ${actual}`,
          ERROR_CODE.HASH_MISMATCH,
        ),
        true,
      )
      return
    }
    if (want && actual !== want) {
      this.failSession(
        pullId,
        new RemoteAgentError(
          `hash-mismatch: declared ${want} but received bytes hash to ${actual}`,
          ERROR_CODE.HASH_MISMATCH,
        ),
        true,
      )
      return
    }
    if (Number.isFinite(expectedBytes) && expectedBytes !== s.received) {
      this.failSession(
        pullId,
        new RemoteAgentError(
          `size-mismatch: declared ${expectedBytes} bytes, received ${s.received}`,
          ERROR_CODE.HASH_MISMATCH,
        ),
        true,
      )
      return
    }
    if (header.verified === false && want) {
      this.failSession(
        pullId,
        new RemoteAgentError('node-side hash verification failed', ERROR_CODE.HASH_MISMATCH),
        true,
      )
      return
    }

    this.settleSuccess(pullId, actual)
  }

  settleSuccess(pullId, sha256) {
    const s = this.sessions.get(pullId)
    if (!s || s.settled) return
    s.settled = true
    this.clearSession(s)
    try {
      fs.closeSync(s.fd)
    } catch {
      /* 已关闭 */
    }
    s.fd = undefined

    let renamed = false
    try {
      fs.renameSync(s.tmpPath, s.finalPath)
      renamed = true
    } catch (err) {
      // 目标已存在时 rename 在 Windows 上会失败：先删目标再 rename，仍然失败就报错
      try {
        fs.unlinkSync(s.finalPath)
        fs.renameSync(s.tmpPath, s.finalPath)
        renamed = true
      } catch (err2) {
        this.log('warn', 'artifact rename failed', {
          pullId,
          error: String(err2?.message ?? err2 ?? err),
        })
      }
    }

    if (!renamed) {
      this.cleanupTemp(s)
      s.reject(new RemoteAgentError(`cannot finalize artifact at ${s.finalPath}`, ERROR_CODE.INTERNAL))
      return
    }

    this.log('info', 'artifact pulled', { pullId, path: s.relPath, bytes: s.received, dest: s.finalPath })
    s.resolve({
      path: s.relPath,
      bytes: s.received,
      sha256: sha256 ?? null,
      dest: s.finalPath,
    })
  }

  /** 失败收尾：清临时文件、关 fd、清定时器，然后 reject。 */
  failSession(pullId, err, notifyNode) {
    const s = this.sessions.get(pullId)
    if (!s || s.settled) return
    s.settled = true
    this.clearSession(s)
    try {
      fs.closeSync(s.fd)
    } catch {
      /* 已关闭 */
    }
    s.fd = undefined
    this.cleanupTemp(s)
    if (notifyNode) {
      try {
        this.registry.send(s.nodeId, HUB_TO_NODE.ARTIFACT_CANCEL, { pullId, reason: err?.code ?? 'error' })
      } catch {
        /* 节点可能已断 */
      }
    }
    this.log('warn', 'artifact pull failed', { pullId, path: s.relPath, code: err?.code, message: err?.message })
    s.reject(err)
  }

  cleanupTemp(s) {
    try {
      fs.unlinkSync(s.tmpPath)
    } catch {
      /* 临时文件可能已经不在了 */
    }
  }

  clearSession(s) {
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = undefined
    }
    if (s.onAbort && s.signal) {
      try {
        s.signal.removeEventListener('abort', s.onAbort)
      } catch {
        /* signal 已失效 */
      }
    }
    this.sessions.delete(s.pullId)
    const set = this.byTask.get(s.taskId)
    if (set) {
      set.delete(s.pullId)
      if (set.size === 0) this.byTask.delete(s.taskId)
    }
    const rec = this.registry.getNode(s.nodeId)
    rec?.pendingPulls?.delete(s.pullId)
  }

  /** 取消一个任务名下所有在途 pull。 */
  cancelTask(taskId) {
    const set = this.byTask.get(taskId)
    if (!set) return 0
    let n = 0
    for (const pullId of [...set]) {
      this.failSession(pullId, new RemoteAgentError('pull cancelled', 'aborted'), true)
      n += 1
    }
    return n
  }

  /** 取消单个 pull（供内部/调试使用）。 */
  cancel(pullId) {
    if (!this.sessions.has(pullId)) return false
    this.failSession(pullId, new RemoteAgentError('pull cancelled', 'aborted'), true)
    return true
  }

  /** 节点掉线：该节点所有在途 pull 立即失败，临时文件清掉。 */
  onNodeOffline(nodeId) {
    for (const s of [...this.sessions.values()]) {
      if (s.nodeId !== nodeId) continue
      this.failSession(s.pullId, new RemoteAgentError(`node offline: ${nodeId}`, ERROR_CODE.INTERNAL), false)
    }
  }

  /** 插件卸载 / hub 关闭。 */
  dispose() {
    if (this.closed) return
    this.closed = true
    for (const s of [...this.sessions.values()]) {
      this.failSession(s.pullId, new RemoteAgentError('hub shutting down', 'aborted'), true)
    }
    this.sessions.clear()
    this.byTask.clear()
  }

  /** 从 handoff/manifest 里挑出可 pull 的成品（工具描述与提示用）。 */
  static finalPathsOf(manifest) {
    if (!manifest || !Array.isArray(manifest.final)) return []
    return manifest.final
      .filter((i) => !i.role || i.role === ARTIFACT_ROLE.FINAL)
      .map((i) => i.path)
  }
}
