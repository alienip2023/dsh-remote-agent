/**
 * hub 内共享小工具 + 插件日志器（零外部依赖）。
 *
 * 从 node-registry.js 拆出（P1-4）：日志器当年住在 registry 是因为 registry
 * 是 hub 目录的依赖叶子、放这里最省事；拆分后这些工具与注册表不再是同一
 * 职责，归位到独立文件。errText / numOr / clip / safeDispose 是 registry 与
 * relay-link 共用的底层小函数 —— 单一真身，不再各自持拷贝（numOr 曾因
 * 「本地必须持拷贝」的约束漏抄过一次，参考 93af7ca）。
 */
export const REDACT_KEY_RE = /(token|secret|password|passwd|credential|apikey|api_key|authorization)/i
const MAX_LOG_STRING = 400

/**
 * 构造一个插件日志器。
 *
 * 两条硬规则：
 *   - 日志本身绝不抛（拿不到 logger 就退化成 console）
 *   - 凭证形态的字段一律打码 —— 协议与日志里都不该出现模型凭证 / 节点 token
 */
export function createPluginLogger(ctx, scope = 'remote-agent') {
  return (level, msg, extra) => {
    const line = `[${scope}] ${msg}`
    const payload = sanitizeExtra(extra)
    try {
      const logger = ctx?.logger
      const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined
      if (fn) {
        fn(line, payload)
        return
      }
      if (logger && typeof logger.info === 'function') {
        logger.info(line, payload)
        return
      }
      if (level === 'warn' || level === 'error') console.warn(line, payload ?? '')
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }
}

/** 打码 + 截断，避免凭证与超长内容进日志。 */
export function sanitizeExtra(extra) {
  if (extra === undefined || extra === null) return undefined
  if (typeof extra !== 'object') return typeof extra === 'string' ? clip(extra) : extra
  const out = {}
  for (const [k, v] of Object.entries(extra)) {
    if (REDACT_KEY_RE.test(k)) {
      out[k] = '***'
      continue
    }
    if (v === null || v === undefined) continue
    if (typeof v === 'string') out[k] = clip(v)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (Array.isArray(v)) out[k] = v.length
    else out[k] = '[object]'
  }
  return out
}

function clip(s) {
  return s.length > MAX_LOG_STRING ? `${s.slice(0, MAX_LOG_STRING)}…` : s
}

export function errText(err) {
  return String(err?.message ?? err ?? 'unknown error')
}

/**
 * 数值兜底：与 lib/hub/index.js 的同名帮助函数同实现（叶子不能反向 import
 * index.js，会成环）。曾因漏掉这份拷贝，task/sync 清理分支一走到就
 * ReferenceError（eslint no-undef 抓到，测试此前没覆盖这条路径）。
 */
export function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 调用一个 disposer，绝不抛。 */
export function safeDispose(fn) {
  if (typeof fn !== 'function') return false
  try {
    fn()
    return true
  } catch {
    return false
  }
}
