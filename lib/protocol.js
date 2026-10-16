/**
 * dsh-remote-agent 协议层（零外部依赖）。
 *
 * 设计要点：
 *  - 单向凭证：模型 key / 会话日志 / 插件只存在于各自机器，协议里永远不出现模型凭证。
 *  - 任务幂等：taskId 由 hub 生成，node 按 id 去重，重连重发不重复执行。
 *  - 清单先于字节：产物先回 manifest，hub 显式 pull 才传输字节。
 *  - 版本协商：hello/welcome 里带 protocol，不匹配时 node 主动拒绝而不是半懂半不懂地跑。
 */

export const PROTOCOL_VERSION = 1

/** 帧类型。hub→node 与 node→hub 分列，避免拼写漂移。 */
export const HUB_TO_NODE = Object.freeze({
  WELCOME: 'welcome',
  /**
   * hub 身份帧（P2-11）。direct 模式的身份证明放在 welcome 里；relay 模式
   * 副机的"在线"信号来自中继的 accepted，hub 在握手期对副机静默，只能
   * 在节点上线后**追发**这一帧补上身份证明。副机未验证通过前拒绝执行任务。
   */
  IDENTITY: 'hub/identity',
  TASK_START: 'task/start',
  TASK_CANCEL: 'task/cancel',
  TASK_QUERY: 'task/query',
  ARTIFACT_LIST: 'artifact/list',
  ARTIFACT_PULL: 'artifact/pull',
  ARTIFACT_CANCEL: 'artifact/cancel',
  PING: 'ping',
  ERROR: 'error',
})

export const NODE_TO_HUB = Object.freeze({
  HELLO: 'hello',
  /** 重连后主动上报本机全部任务状态 —— 任务状态的真身在副机，不在 hub。 */
  TASK_SYNC: 'task/sync',
  TASK_ACCEPT: 'task/accept',
  TASK_PROGRESS: 'task/progress',
  TASK_SUMMARY: 'task/summary',
  TASK_END: 'task/end',
  ARTIFACT_MANIFEST: 'artifact/manifest',
  ARTIFACT_CHUNK: 'artifact/chunk',
  ARTIFACT_DONE: 'artifact/done',
  /** 资源遥测（CPU/内存/负载，~30s 一次）：派发前先看节点负载。尽力而为，字段可缺。 */
  RESOURCE: 'node/resource',
  /**
   * 仓库清单上报（提案 #13）：副机把 roots 下扫到的 git 仓库（名字/远端
   * url/本机路径）报给 hub，hub 建 repo→node 索引供 remote_task 的 repo:
   * 参数路由。接入后与每 10min 各发一次；尽力而为，旧 hub 会按未知帧忽略。
   */
  REPOS: 'node/repos',
  PONG: 'pong',
  ERROR: 'error',
})

/** 中继层信封（relay 只做寻址与转发，不理解业务帧）。 */
export const RELAY_FRAME = Object.freeze({
  UP: 'up', // node → relay → hub
  DOWN: 'down', // hub → relay → node
  NODE_ONLINE: 'node/online',
  NODE_OFFLINE: 'node/offline',
  NODE_LIST: 'node/list',
  HELLO_NODE: 'hello/node',
  HELLO_HUB: 'hello/hub',
  // 中继级错误（鉴权失败、nodeId 冲突、目标离线、被吊销）。
  // 早期版本漏定义此常量，而 relay.js 有 8 处 sendJson(conn, RELAY_FRAME.ERROR, ...)：
  // t 为 undefined → JSON.stringify 丢弃该字段 → 对端 decodeFrame 报 missing-type，
  // 于是**所有中继错误帧都送不到**，transport.js / node-registry.js 的 ERROR 分支
  // 也因 `frame.t === undefined` 永假而永不触发。
  ERROR: 'error',
})

export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
  INTERRUPTED: 'interrupted',
})

export const TERMINAL_STATUS = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.ABORTED,
  TASK_STATUS.INTERRUPTED,
])

export const TASK_MODE = Object.freeze({
  /** 副机本机起一个真实 DSH agent 会话，独立模型上下文，任务在副机持久运行。 */
  AGENT: 'agent',
  /** 副机直接执行一段命令（调试 / 简单活）。 */
  EXEC: 'exec',
})

export const ARTIFACT_ROLE = Object.freeze({
  /** 成品：允许 hub 显式 pull。 */
  FINAL: 'final',
  /** 中间产物：只在副机留存，仅上报元数据。 */
  INTERMEDIATE: 'intermediate',
  /** 未归类：上报元数据，默认不可 pull。 */
  OTHER: 'other',
})

export const ARTIFACT_KIND = Object.freeze({
  FILE: 'file',
  DIR: 'dir',
  DIFF: 'diff',
  REPORT: 'report',
  MEDIA: 'media',
})

export const ERROR_CODE = Object.freeze({
  PROTOCOL_MISMATCH: 'protocol-mismatch',
  UNAUTHORIZED: 'unauthorized',
  DUPLICATE_NODE: 'duplicate-node',
  TASK_DUPLICATE: 'task-duplicate',
  TASK_UNKNOWN: 'task-unknown',
  WORKSPACE_DENIED: 'workspace-denied',
  ARTIFACT_DENIED: 'artifact-denied',
  ARTIFACT_MISSING: 'artifact-missing',
  ARTIFACT_TOO_LARGE: 'artifact-too-large',
  HASH_MISMATCH: 'hash-mismatch',
  /** hub 身份验证失败：指纹不匹配 / 签名无效 / nonce 对不上 / 时间戳超窗。 */
  HUB_IDENTITY_MISMATCH: 'hub-identity-mismatch',
  /** relay 模式下 hub 身份帧尚未到达（宽限窗口内），任务暂不执行。 */
  HUB_IDENTITY_PENDING: 'hub-identity-pending',
  INTERNAL: 'internal',
})

export const DEFAULT_HEARTBEAT_MS = 15_000
export const DEFAULT_ACK_TIMEOUT_MS = 60_000
export const DEFAULT_PULL_TIMEOUT_MS = 30 * 60 * 1000
/** 单帧二进制分块上限：256 KiB（base64 回退时约 341 KiB）。 */
export const ARTIFACT_CHUNK_BYTES = 256 * 1024
/** 中继/控制帧的单帧文本上限，防止畸形帧吃内存。 */
export const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024
export const MAX_ARTIFACT_FRAME_BYTES = 8 * 1024 * 1024

let counter = 0

/** 生成一个短小、无依赖、可读的 id。 */
export function newId(prefix = 'x') {
  counter = (counter + 1) & 0xffffff
  const t = Date.now().toString(36)
  const r = Math.floor(Math.random() * 0x10000).toString(36)
  return `${prefix}-${t}${r}${counter.toString(36)}`
}

export function newTaskId() {
  return newId('t')
}

export function newPullId() {
  return newId('p')
}

/** 构造一个协议信封。 */
export function envelope(type, data, opts = {}) {
  const frame = { v: PROTOCOL_VERSION, t: type, id: opts.id ?? newId('m'), d: data ?? {} }
  if (opts.replyTo) frame.r = opts.replyTo
  return frame
}

export function encodeFrame(frame) {
  return JSON.stringify(frame)
}

/**
 * 二进制帧：`[u16 BE 头部长度][头部 JSON][净荷字节]`。
 *
 * 为什么不用 base64 塞进 JSON：产物分块是纯字节流，base64 有 33% 膨胀，
 * 而且中继必须能只读头部就完成路由 —— 净荷一个字节都不该被解码。
 */
export function encodeBinaryFrame(header, payload) {
  const head = Buffer.from(JSON.stringify(header), 'utf8')
  if (head.length > 0xffff) throw new RemoteAgentError('binary frame header too large', ERROR_CODE.INTERNAL)
  const out = Buffer.allocUnsafe(2 + head.length + payload.length)
  out.writeUInt16BE(head.length, 0)
  head.copy(out, 2)
  payload.copy(out, 2 + head.length)
  return out
}

/** 解析二进制帧。失败返回 {ok:false}，绝不抛。 */
export function decodeBinaryFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return { ok: false, error: 'binary-frame-too-short' }
  const headLen = buf.readUInt16BE(0)
  if (buf.length < 2 + headLen) return { ok: false, error: 'binary-frame-header-truncated' }
  let header
  try {
    header = JSON.parse(buf.subarray(2, 2 + headLen).toString('utf8'))
  } catch {
    return { ok: false, error: 'binary-frame-header-malformed' }
  }
  if (!header || typeof header !== 'object') return { ok: false, error: 'binary-frame-header-not-object' }
  return { ok: true, header, payload: buf.subarray(2 + headLen) }
}

/**
 * 把二进制编解码器注入传输层，避免 ws.js ↔ transport.js 的模块初始化期循环依赖。
 * 在 node/transport.js 加载时自动完成；单独使用 protocol.js 时不需要调用。
 */
export function bindBinaryCodecInto(transportModule) {
  transportModule.bindBinaryCodec(encodeBinaryFrame, decodeBinaryFrame)
}

/**
 * 解析并校验一个信封。
 * @returns {{ok:true, frame:object} | {ok:false, error:string}}
 */
export function decodeFrame(raw) {
  let parsed
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    return { ok: false, error: 'malformed-json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'malformed-envelope' }
  }
  if (typeof parsed.t !== 'string' || parsed.t === '') {
    return { ok: false, error: 'missing-type' }
  }
  if (parsed.v !== PROTOCOL_VERSION) {
    return { ok: false, error: ERROR_CODE.PROTOCOL_MISMATCH }
  }
  return { ok: true, frame: parsed }
}

/** 一个协议错误，携带稳定 code，便于上层映射到工具错误。 */
export class RemoteAgentError extends Error {
  constructor(message, code = ERROR_CODE.INTERNAL, details = undefined) {
    super(message)
    this.name = 'RemoteAgentError'
    this.code = code
    this.details = details
  }
}

/**
 * 校验 hello 帧。node 与 hub 共用，保证双方对"什么是合法节点"理解一致。
 * @returns {{ok:true, hello:object} | {ok:false, error:string}}
 */
export function validateHello(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'hello-missing' }
  if (typeof d.nodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d.nodeId)) {
    return { ok: false, error: 'hello-nodeId-invalid' }
  }
  if (d.protocol !== PROTOCOL_VERSION) {
    return { ok: false, error: ERROR_CODE.PROTOCOL_MISMATCH }
  }
  const os = d.os === 'windows' || d.os === 'linux' || d.os === 'darwin' ? d.os : undefined
  if (!os) return { ok: false, error: 'hello-os-invalid' }
  return {
    ok: true,
    hello: {
      nodeId: d.nodeId,
      protocol: d.protocol,
      os,
      arch: typeof d.arch === 'string' ? d.arch : 'unknown',
      hostname: typeof d.hostname === 'string' ? d.hostname : d.nodeId,
      dshVersion: typeof d.dshVersion === 'string' ? d.dshVersion : '',
      shells: Array.isArray(d.shells) ? d.shells.filter((s) => typeof s === 'string') : [],
      roots: Array.isArray(d.roots) ? d.roots.filter((s) => typeof s === 'string') : [],
      caps: Array.isArray(d.caps) ? d.caps.filter((s) => typeof s === 'string') : [],
      profile: typeof d.profile === 'string' ? d.profile : '',
      agentMode: d.agentMode === true,
      // P2-11：本次连接的挑战随机数（hex）。hub 把它签进 welcome/hub-identity
      // 的身份证明，副机核对一致 —— 防"录一帧旧 welcome 重放给新连接"。
      // 缺失（旧版副机）时为空串，hub 退化成自拟 nonce + 时间戳窗口。
      nonce: typeof d.nonce === 'string' && /^[0-9a-f]{16,128}$/.test(d.nonce) ? d.nonce : '',
      time: typeof d.time === 'number' ? d.time : Date.now(),
    },
  }
}

/**
 * 归一化 `artifactRules`，**含内层形状校验**。
 *
 * 合法形状：`{ final?: string[], intermediate?: string[], caseInsensitive?: boolean }`
 * （见 lib/artifacts.js 的 `classify()` —— 它读 `rules.intermediate?.length` /
 * `rules.final?.length` 后交给 `compileRules`，后者要求数组）。
 *
 * 为什么必须校验内层：`typeof x === 'object'` 只挡住 null/undefined/数字/布尔，
 * **字符串与数组也能通过**。而 `'dist/**'.length` 是真值，于是：
 *   - 传 `{ final: 'dist/**' }` → `rules.final?.length` 为 7（真）→
 *     `compileRules('dist/**')` 把字符串按可迭代对象处理 → 逐字符编译成规则，
 *     得到 `["d","i","s","t","/","*","*"]` 这类垃圾。
 *   - 实测后果：单字符文件被误判为可 pull 的 final，而真正的 `dist/app.js`
 *     反而漏掉，**无异常、无日志**。
 *
 * 非数组一律丢弃（与 outputs / denyPaths 的处理方式一致），而不是静默透传。
 * `caseInsensitive` 只接受真正的布尔。
 */
export function normalizeArtifactRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const pick = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p !== '') : undefined)
  const out = {}
  const final = pick(raw.final)
  const intermediate = pick(raw.intermediate)
  if (final !== undefined) out.final = final
  if (intermediate !== undefined) out.intermediate = intermediate
  if (typeof raw.caseInsensitive === 'boolean') out.caseInsensitive = raw.caseInsensitive
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 归一化一个模型选择（可选）。
 *
 * 接受三种写法（对小白最友好到最精确）：
 *   - `'gpt-4o'`                  → `{ model: 'gpt-4o' }`（provider 用副机默认）
 *   - `'openai/gpt-4o'`           → `{ provider: 'openai', model: 'gpt-4o' }`
 *   - `{ provider, model, reasoningEffort? }` → 逐字段过滤后原样保留
 *
 * 其他输入（数字 / 数组 / 空串 / 字段类型不对）一律返回 undefined，
 * 与 outputs / denyPaths 的处理方式一致 —— 宁可丢掉一个坏参数回到
 * "副机默认模型"，也不能把垃圾透传给 runner。
 *
 * 注意：这里只传**选择**，不传凭证 —— 模型 key 始终在副机（核心不变式 1）。
 * 副机拿到选择后用自己的 provider 配置去跑；指定的 provider/model 在副机
 * 不存在时，错误会经 agent/error 监听如实进入 handoff（2026-10-15 修复后
 * 错误不再被静默吞掉）。
 */
export function normalizeModelSelection(raw) {
  if (raw === undefined || raw === null) return undefined

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return undefined
    // 'provider/model'：provider 段不含 '/'，model 段允许再带（如 openrouter 的 org/model）
    const slash = s.indexOf('/')
    if (slash > 0 && slash < s.length - 1) {
      return { provider: s.slice(0, slash).slice(0, 64), model: s.slice(slash + 1).slice(0, 128) }
    }
    return { model: s.slice(0, 128) }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  if (typeof raw.provider === 'string' && raw.provider !== '') out.provider = raw.provider.slice(0, 64)
  if (typeof raw.model === 'string' && raw.model !== '') out.model = raw.model.slice(0, 128)
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== '') {
    out.reasoningEffort = raw.reasoningEffort.slice(0, 32)
  }
  // 没有 model 的选择不是合法选择（provider 必须配 model，单独 provider 无效）——
  // 与 outputs / denyPaths 一致：坏参数丢掉，回到副机默认。
  if (out.model === undefined) return undefined
  return out
}

/**
 * 校验 task/start 帧。
 * @returns {{ok:true, spec:object} | {ok:false, error:string}}
 */
export function validateTaskStart(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'task-missing' }
  if (typeof d.taskId !== 'string' || d.taskId === '') return { ok: false, error: 'task-taskId-missing' }
  if (typeof d.goal !== 'string' || d.goal.trim() === '') return { ok: false, error: 'task-goal-missing' }
  const mode = d.mode === TASK_MODE.EXEC ? TASK_MODE.EXEC : TASK_MODE.AGENT
  const c = d.constraints && typeof d.constraints === 'object' ? d.constraints : {}
  return {
    ok: true,
    spec: {
      taskId: d.taskId,
      goal: d.goal,
      workspace: typeof d.workspace === 'string' && d.workspace ? d.workspace : undefined,
      mode,
      model: normalizeModelSelection(d.model),
      constraints: {
        timeoutMs: Number.isFinite(c.timeoutMs) ? Math.max(1000, c.timeoutMs) : 60 * 60 * 1000,
        maxBytesWritten: Number.isFinite(c.maxBytesWritten) ? c.maxBytesWritten : 2 * 1024 * 1024 * 1024,
        allowNetwork: c.allowNetwork !== false,
        denyPaths: Array.isArray(c.denyPaths) ? c.denyPaths.filter((p) => typeof p === 'string') : [],
        extraEnv: c.extraEnv && typeof c.extraEnv === 'object' ? c.extraEnv : {},
      },
      outputs: Array.isArray(d.outputs) ? d.outputs.filter((p) => typeof p === 'string') : [],
      artifactRules: normalizeArtifactRules(d.artifactRules),
      summaryPolicy: d.summaryPolicy === 'stream' ? 'stream' : 'on-complete',
      requestedAt: typeof d.requestedAt === 'number' ? d.requestedAt : Date.now(),
      origin: typeof d.origin === 'string' ? d.origin : 'hub',
    },
  }
}
