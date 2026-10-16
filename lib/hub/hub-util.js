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
 * 值级凭证打码（真机验证发现，见 docs/verification-repos-routing-real.md §4③）：
 * 键名打码只覆盖 "这个字段叫 token"，而 goal / 命令正文里内嵌凭证是常态
 * （`curl -H "Authorization: Bearer sk-..."`、`mysql -p<password>`）——
 * 审计是长期留存的证据文件，值里的凭证形态字符串必须同样打掉。
 *
 * 四类高精度形态（宁缺勿滥：误伤正文比漏掉凭证更难排查，所以只收
 * "几乎不可能是正常文本"的形状）：
 *   - 常见 token 前缀：sk-… / ghp_… / gho_… / github_pat_…（≥8 位实体）
 *   - `Bearer <token>`（Authorization 头标准形态）
 *   - `api_key=/token=/password=/…=值` 与冒号变体（键名已在 REDACT_KEY_RE 口径内）
 *   - URL userinfo：`://user:pass@`（与 repos.js 的 sanitizeRepoUrl 同一威胁）
 */
const REDACT_VALUE_RES = [
  /(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:api[_-]?key|apikey|token|password|passwd|secret|credential)\s*[=:]\s*\S+/gi,
  /:\/\/[^/\s:@]+:[^/\s@]+@/g,
]

export function redactValueTokens(s) {
  let out = s
  for (const re of REDACT_VALUE_RES) out = out.replace(re, '***')
  return out
}

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
  if (typeof extra !== 'object') return typeof extra === 'string' ? clip(redactValueTokens(extra)) : extra
  const out = {}
  for (const [k, v] of Object.entries(extra)) {
    if (REDACT_KEY_RE.test(k)) {
      out[k] = '***'
      continue
    }
    if (v === null || v === undefined) continue
    // 字符串值做**值级**打码（键名打码之外的第二道网，见 redactValueTokens）
    if (typeof v === 'string') out[k] = clip(redactValueTokens(v))
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
