/**
 * 副机侧的产物服务：清单构建 + 按需分块外发。
 *
 * 三条硬规则（来自用户锁定的契约）：
 *   1. manifest 先于字节 —— 任务结束只回清单，hub 显式 pull 才传输
 *   2. 只有 role:final 过河 —— intermediate 永不出网
 *   3. sha256 校验 —— 传输前后各算一次，不一致就报错，不静默接受
 *
 * 背压：分块前查写缓冲，超过高水位就等 drain。没有这个，一个 200MB 产物
 * 会把 node 进程内存和中继的转发队列一起顶爆。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  ARTIFACT_CHUNK_BYTES,
  ERROR_CODE,
  RemoteAgentError,
} from '../protocol.js'
import { authorizePull, buildManifest, hashFile } from '../artifacts.js'
import { isDenied } from './exec.js'

/** 单次 pull 的默认上限：512 MiB。 */
const DEFAULT_MAX_PULL_BYTES = 512 * 1024 * 1024
/** 写缓冲高水位：超过就等，别把内存交给 socket。 */
const HIGH_WATER_BYTES = 2 * 1024 * 1024

export class ArtifactService {
  constructor({ nodeId, caseInsensitive = true, maxPullBytes = DEFAULT_MAX_PULL_BYTES, onEvent }) {
    this.nodeId = nodeId
    this.caseInsensitive = caseInsensitive
    this.maxPullBytes = maxPullBytes
    this.onEvent = onEvent
    /** 在跑的 pull：pullId → { aborted } */
    this.active = new Map()
  }

  log(msg, extra) {
    if (typeof this.onEvent === 'function') this.onEvent({ kind: 'artifact', msg, ...extra, at: Date.now() })
  }

  /** 构建清单（任务结束时调用一次）。 */
  async build({ workspace, outputs, artifactRules, denyPaths = [], signal, hashFinal = true }) {
    const manifest = await buildManifest({
      workspace,
      outputs,
      artifactRules,
      caseInsensitive: this.caseInsensitive,
      denyPaths,
      hashFinal,
      signal,
      includeOther: true,
    })
    this.log('manifest built', {
      workspace: manifest.workspace,
      counts: manifest.counts,
    })
    return manifest
  }

  /**
   * 分块外发一个产物。
   *
   * @param {object} o
   * @param {object} o.manifest 已构建的清单（授权依据）
   * @param {string} o.pullId
   * @param {string} o.relPath 清单内的相对路径
   * @param {string} o.workspace 工作区绝对路径
   * @param {(header:object, payload:Buffer)=>Promise<boolean>} o.emit 发送一帧（返回 false 表示连接断了）
   * @param {() => Promise<void>} [o.drain] 背压等待
   * @param {AbortSignal} [o.signal]
   */
  async pull(o) {
    const { manifest, pullId, relPath, workspace, emit, drain, signal } = o

    const auth = authorizePull(manifest, relPath, {
      caseInsensitive: this.caseInsensitive,
      maxBytes: this.maxPullBytes,
      denyPaths: [],
    })
    if (!auth.ok) {
      throw new RemoteAgentError(auth.message, auth.code)
    }
    const item = auth.item

    const abs = path.join(workspace, ...item.path.split('/'))
    // 二次校验：清单是快照，路径可能已被替换（符号链接/改名）
    let real
    try {
      real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs)
    } catch {
      throw new RemoteAgentError(`artifact vanished: ${item.path}`, ERROR_CODE.ARTIFACT_MISSING)
    }
    if (isDenied(real, [workspace], { caseInsensitive: this.caseInsensitive }) === false) {
      throw new RemoteAgentError(`artifact escaped workspace: ${item.path}`, ERROR_CODE.ARTIFACT_DENIED)
    }

    const st = fs.statSync(real)
    if (!st.isFile()) {
      throw new RemoteAgentError(`not a regular file: ${item.path}`, ERROR_CODE.ARTIFACT_DENIED)
    }
    if (st.size > this.maxPullBytes) {
      throw new RemoteAgentError(
        `${st.size} bytes exceeds maxPullBytes=${this.maxPullBytes}`,
        ERROR_CODE.ARTIFACT_TOO_LARGE,
      )
    }

    const token = { aborted: false }
    this.active.set(pullId, token)
    if (signal) {
      if (signal.aborted) token.aborted = true
      else signal.addEventListener('abort', () => {
        token.aborted = true
      }, { once: true })
    }

    // 传输前重新算 hash：清单生成与 pull 之间文件可能被改过。
    // 报错优于"发一份和清单不符的字节过去"。
    const preHash = await hashFile(real)
    if (item.sha256 && preHash !== item.sha256) {
      this.active.delete(pullId)
      throw new RemoteAgentError(
        `hash mismatch before transfer: manifest=${item.sha256} actual=${preHash}`,
        ERROR_CODE.HASH_MISMATCH,
      )
    }

    const digest = createHash('sha256')
    const stream = fs.createReadStream(real, { highWaterMark: ARTIFACT_CHUNK_BYTES })
    let offset = 0
    let sent = 0

    try {
      for await (const chunk of stream) {
        if (token.aborted) break
        digest.update(chunk)
        if (drain) await drain()
        const ok = await emit({
          v: 1,
          t: 'artifact/chunk',
          pullId,
          path: item.path,
          offset,
          total: st.size,
          sha256: item.sha256,
          nodeId: this.nodeId,
        }, chunk)
        if (!ok) break
        offset += chunk.length
        sent += chunk.length
      }

      if (token.aborted) {
        this.log('pull aborted', { pullId, path: item.path, sent })
        return { ok: false, aborted: true, sent, path: item.path }
      }

      const actual = digest.digest('hex')
      const verifyOk = !item.sha256 || actual === item.sha256
      await emit({
        v: 1,
        t: 'artifact/done',
        pullId,
        path: item.path,
        bytes: sent,
        sha256: actual,
        expected: item.sha256 ?? null,
        verified: verifyOk,
        role: item.role,
        kind: item.kind,
        mtimeMs: item.mtimeMs,
        nodeId: this.nodeId,
      }, Buffer.alloc(0))

      if (!verifyOk) {
        this.log('hash mismatch after transfer', { pullId, path: item.path, expected: item.sha256, actual })
        return { ok: false, hashMismatch: true, sent, path: item.path, sha256: actual }
      }

      this.log('pull complete', { pullId, path: item.path, bytes: sent })
      return { ok: true, sent, path: item.path, sha256: actual }
    } finally {
      this.active.delete(pullId)
      stream.destroy()
    }
  }

  cancel(pullId) {
    const t = this.active.get(pullId)
    if (!t) return false
    t.aborted = true
    return true
  }

  cancelAll() {
    for (const t of this.active.values()) t.aborted = true
    this.active.clear()
  }

  static get highWaterBytes() {
    return HIGH_WATER_BYTES
  }
}
