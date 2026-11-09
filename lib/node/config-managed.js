/**
 * P1b-1：受管 patch 条目 / 插件白名单 / 受管凭据的纯函数。
 *
 * 为什么单独成文件：这些函数决定「主控能往节点的 cordis.patch.yml 写什么」，写坏会让节点 DSH
 * 起不来，所以它们必须无副作用、可单测，config-sync.js 只负责编排（快照、落盘、回滚、回执）。
 *
 * 约束（合同 §P1b.2 / §P1b.4）：
 *  - 只认白名单 entryId；其它一律 plugin-not-allowed，且在写盘之前返回
 *  - 条目 name 用节点自己的常量，不信载荷里的 name
 *  - 条目 config 先按字段白名单 + 类型校验（与插件自己的 schema 一致，否则插件启动时抛错），
 *    再用 JSON.stringify 序列化标量（防 YAML 注入）
 *  - 错误只带错误码和字段路径，不带值（值里可能有 baseURL / key）
 */

/** 错误码即 ack.error；details 只放字段路径，不放值。 */
export class ConfigSyncError extends Error {
  constructor(code, path = '') {
    super(path ? `${code}: ${path}` : code)
    this.name = 'ConfigSyncError'
    this.code = code
    this.path = path
  }
}

const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENTRY_ID = /^[A-Za-z0-9._-]+$/
const MAX_TIMER_DELAY_MS = 2147483647
const MAX_KEY_LENGTH = 4096

const bad = (path) => { throw new ConfigSyncError('plugin-config-invalid', path) }
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v, max = 2000) => typeof v === 'string' && v.length > 0 && v.length <= max
const isPosInt = (v) => Number.isSafeInteger(v) && v >= 1

function onlyKeys(obj, allowed, path) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${path}.${k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 40)}`)
}

function validateRetryPolicy(p, path) {
  if (!isPlain(p)) bad(path)
  const backoff = (b, bp) => {
    if (!isPlain(b)) bad(bp)
    onlyKeys(b, ['initialDelayMs', 'maxDelayMs', 'jitterRatio'], bp)
    for (const k of ['initialDelayMs', 'maxDelayMs']) {
      if (b[k] !== undefined && !(Number.isFinite(b[k]) && b[k] >= 0 && b[k] <= MAX_TIMER_DELAY_MS)) bad(`${bp}.${k}`)
    }
    if (b.jitterRatio !== undefined && !(Number.isFinite(b.jitterRatio) && b.jitterRatio >= 0 && b.jitterRatio <= 1)) bad(`${bp}.jitterRatio`)
    return { ...b }
  }
  if (p.mode === 'always') {
    onlyKeys(p, ['mode', 'backoff'], path)
    return { mode: 'always', ...(p.backoff !== undefined ? { backoff: backoff(p.backoff, `${path}.backoff`) } : {}) }
  }
  if (p.mode === 'normal') {
    onlyKeys(p, ['mode', 'maxRetries', 'retryableCodes', 'backoff'], path)
    if (p.maxRetries !== undefined && !(Number.isSafeInteger(p.maxRetries) && p.maxRetries >= 0)) bad(`${path}.maxRetries`)
    if (p.retryableCodes !== undefined && !(Array.isArray(p.retryableCodes) && p.retryableCodes.length <= 64 && p.retryableCodes.every((c) => isStr(c, 100)))) bad(`${path}.retryableCodes`)
    return {
      mode: 'normal',
      ...(p.maxRetries !== undefined ? { maxRetries: p.maxRetries } : {}),
      ...(p.retryableCodes !== undefined ? { retryableCodes: [...p.retryableCodes] } : {}),
      ...(p.backoff !== undefined ? { backoff: backoff(p.backoff, `${path}.backoff`) } : {}),
    }
  }
  return bad(`${path}.mode`)
}

const MODEL_KEYS = ['id', 'name', 'description', 'contextWindow', 'maxTokens', 'inputModalities', 'systemPromptUpdate', 'toolUpdate']

function validateDeepseekModels(models, path) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 64) bad(path)
  const seen = new Set()
  return models.map((m, i) => {
    const mp = `${path}[${i}]`
    if (!isPlain(m)) bad(mp)
    onlyKeys(m, MODEL_KEYS, mp)
    if (!isStr(m.id, 200)) bad(`${mp}.id`)
    if (seen.has(m.id)) bad(`${mp}.id`)
    seen.add(m.id)
    const out = { id: m.id }
    if (m.name !== undefined) { if (!isStr(m.name)) bad(`${mp}.name`); out.name = m.name }
    if (m.description !== undefined) { if (!isStr(m.description)) bad(`${mp}.description`); out.description = m.description }
    if (m.contextWindow !== undefined) { if (!isPosInt(m.contextWindow)) bad(`${mp}.contextWindow`); out.contextWindow = m.contextWindow }
    if (m.maxTokens !== undefined) { if (!isPosInt(m.maxTokens)) bad(`${mp}.maxTokens`); out.maxTokens = m.maxTokens }
    if (m.inputModalities !== undefined) {
      const ok = Array.isArray(m.inputModalities) && m.inputModalities.length >= 1 && m.inputModalities.every((x) => x === 'text' || x === 'image') && new Set(m.inputModalities).size === m.inputModalities.length
      if (!ok) bad(`${mp}.inputModalities`)
      out.inputModalities = [...m.inputModalities]
    }
    if (m.systemPromptUpdate !== undefined) { if (m.systemPromptUpdate !== 'in-history') bad(`${mp}.systemPromptUpdate`); out.systemPromptUpdate = m.systemPromptUpdate }
    if (m.toolUpdate !== undefined) { if (m.toolUpdate !== 'in-history' && m.toolUpdate !== 'addition-only') bad(`${mp}.toolUpdate`); out.toolUpdate = m.toolUpdate }
    return out
  })
}

/** llm-deepseek-api-key 条目的 config（字段与 dsh-llm-deepseek 的 schema 对齐，见 deepSeekConfigFields）。 */
function validateDeepseekConfig(config) {
  if (!isPlain(config)) bad('config')
  onlyKeys(config, ['models', 'thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'streamIdleTimeoutMs', 'retryPolicy', 'baseURL'], 'config')
  const out = {}
  if (config.baseURL !== undefined) {
    if (!isStr(config.baseURL, 2048)) bad('config.baseURL')
    let u
    try { u = new URL(config.baseURL) } catch { bad('config.baseURL') }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) bad('config.baseURL')
    out.baseURL = config.baseURL
  }
  if (config.thinking !== undefined) { if (config.thinking !== 'enabled' && config.thinking !== 'disabled') bad('config.thinking'); out.thinking = config.thinking }
  if (config.reasoningEffort !== undefined) {
    if (!['off', 'low', 'high', 'max'].includes(config.reasoningEffort)) bad('config.reasoningEffort')
    out.reasoningEffort = config.reasoningEffort
  }
  // 插件启动时会抛：thinking 关闭时只允许 reasoningEffort=off。
  if (out.thinking === 'disabled' && out.reasoningEffort !== undefined && out.reasoningEffort !== 'off') bad('config.reasoningEffort')
  if (config.maxTokens !== undefined) { if (!isPosInt(config.maxTokens)) bad('config.maxTokens'); out.maxTokens = config.maxTokens }
  if (config.defaultContextWindow !== undefined) { if (!isPosInt(config.defaultContextWindow)) bad('config.defaultContextWindow'); out.defaultContextWindow = config.defaultContextWindow }
  if (config.streamIdleTimeoutMs !== undefined) {
    const v = config.streamIdleTimeoutMs
    if (!(Number.isFinite(v) && v > 0 && v <= MAX_TIMER_DELAY_MS)) bad('config.streamIdleTimeoutMs')
    out.streamIdleTimeoutMs = v
  }
  if (config.retryPolicy !== undefined) out.retryPolicy = validateRetryPolicy(config.retryPolicy, 'config.retryPolicy')
  if (config.models !== undefined) out.models = validateDeepseekModels(config.models, 'config.models')
  return out
}

/**
 * 白名单。name 是节点上该插件包的名字——loader 对「id 对但 name 不符」的 patch 会跳过并告警，
 * 所以必须写节点自己的名字，不能用载荷里的。refs 是该插件允许同步的凭据 ref 名。
 */
export const MANAGED_PLUGINS = Object.freeze({
  'llm-deepseek': Object.freeze({
    name: '@deepseek-ai/dsh-llm-deepseek-api-key',
    refs: Object.freeze(['DEEPSEEK_API_KEY']),
    validate: validateDeepseekConfig,
  }),
})

const safeId = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 40)

/**
 * 校验并规整 plugins[]。任何一项不合格都整体拒绝（调用方在写盘之前返回）。
 * @returns {{ entryId: string, name: string, config: object, creds: Array<{ref: string, apiKey: string}> }[]}
 */
export function validatePlugins(plugins) {
  if (plugins === undefined || plugins === null) return []
  if (!Array.isArray(plugins) || plugins.length > 8) throw new ConfigSyncError('plugin-config-invalid', 'plugins')
  const seen = new Set()
  const out = []
  for (const [i, p] of plugins.entries()) {
    const entryId = p?.entryId
    if (typeof entryId !== 'string' || !Object.hasOwn(MANAGED_PLUGINS, entryId)) throw new ConfigSyncError('plugin-not-allowed', safeId(entryId))
    if (seen.has(entryId)) throw new ConfigSyncError('plugin-config-invalid', `plugins[${i}].entryId`)
    seen.add(entryId)
    const spec = MANAGED_PLUGINS[entryId]
    const config = spec.validate(p.config ?? {})
    const refs = p.credentialRefs ?? []
    if (!Array.isArray(refs) || refs.length > 4) throw new ConfigSyncError('plugin-config-invalid', `plugins[${i}].credentialRefs`)
    const creds = refs.map((r, j) => {
      const path = `plugins[${i}].credentialRefs[${j}]`
      if (!isPlain(r) || typeof r.ref !== 'string' || !REF_NAME.test(r.ref) || !spec.refs.includes(r.ref)) throw new ConfigSyncError('plugin-config-invalid', `${path}.ref`)
      // 控制字符（尤其换行）会让 credentials.yaml 多出一行 → 注入。
      if (typeof r.apiKey !== 'string' || r.apiKey === '' || r.apiKey.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(r.apiKey)) throw new ConfigSyncError('plugin-config-invalid', `${path}.apiKey`)
      return { ref: r.ref, apiKey: r.apiKey }
    })
    out.push({ entryId, name: spec.name, config, creds })
  }
  return out
}

// ── YAML 序列化（只覆盖白名单会出现的形状：对象 / 数组 / 标量） ──────────────

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function scalar(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  throw new ConfigSyncError('plugin-config-invalid', 'scalar')
}

function emit(value, indent, lines) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isPlain(item)) {
        const keys = Object.keys(item)
        keys.forEach((k, idx) => {
          if (!KEY.test(k)) throw new ConfigSyncError('plugin-config-invalid', 'key')
          const prefix = idx === 0 ? `${pad}- ` : `${pad}  `
          const v = item[k]
          if (isPlain(v) || Array.isArray(v)) {
            lines.push(`${prefix}${k}:`)
            emit(v, indent + 4, lines)
          } else lines.push(`${prefix}${k}: ${scalar(v)}`)
        })
      } else lines.push(`${pad}- ${scalar(item)}`)
    }
    return
  }
  for (const [k, v] of Object.entries(value)) {
    if (!KEY.test(k)) throw new ConfigSyncError('plugin-config-invalid', 'key')
    if (isPlain(v) || Array.isArray(v)) {
      lines.push(`${pad}${k}:`)
      emit(v, indent + 2, lines)
    } else lines.push(`${pad}${k}: ${scalar(v)}`)
  }
}

/** 一个受管插件条目的 YAML 文本（无结尾换行）。 */
export function buildPluginEntry({ entryId, name, config }) {
  const lines = [`- id: ${entryId}`, `  name: ${JSON.stringify(name)}`]
  if (Object.keys(config).length > 0) {
    lines.push('  config:')
    emit(config, 4, lines)
  }
  return lines.join('\n')
}

// ── 受管条目替换 ───────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 在 cordis.patch.yml 文本里找 `- id: <entryId>` 条目所在的行区间 [start, end)。
 * 条目结束于下一个顶层 `- `；紧贴下一条目之前的空行 / 顶层注释不算本条目（原样保留）。
 */
export function findEntryRange(text, entryId) {
  const lines = String(text).split('\n')
  const head = new RegExp(`^-[ \\t]+id:[ \\t]*["']?${escapeRe(entryId)}["']?[ \\t]*(#.*)?$`)
  const starts = []
  lines.forEach((l, i) => { if (head.test(l)) starts.push(i) })
  if (starts.length > 1) throw new ConfigSyncError('patch-duplicate-entry', safeId(entryId))
  if (starts.length === 0) return null
  const start = starts[0]
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-(\s|$)/.test(lines[i])) { end = i; break }
  }
  while (end > start + 1 && (lines[end - 1].trim() === '' || /^#/.test(lines[end - 1]))) end--
  return { lines, start, end }
}

/**
 * 只替换（或追加）一个受管条目，其它条目与注释逐字节保留。
 * @param {string} existing 现有 patch 文本（可为空）
 * @param {string} entryId
 * @param {string} entryYaml 新条目文本（以 `- id:` 开头，无结尾换行）
 */
export function replaceManagedEntry(existing, entryId, entryYaml) {
  const text = String(existing ?? '')
  const range = findEntryRange(text, entryId)
  if (!range) {
    // 新 profile 的模板是 `# 注释…\n[]`：追加条目前必须去掉 `[]`（否则 `[]` 后跟 `- id:` 不是合法 YAML）。
    const base = withoutEmptyFlow(text).trimEnd()
    return (base === '' ? '' : base + '\n\n') + entryYaml + '\n'
  }
  const { lines, start, end } = range
  return [...lines.slice(0, start), ...entryYaml.split('\n'), ...lines.slice(end)].join('\n')
}

/** 受管条目是否原样出现在 text 里（落盘后回读校验用）。 */
export function containsEntry(text, entryId, entryYaml) {
  const range = findEntryRange(text, entryId)
  if (!range) return false
  return range.lines.slice(range.start, range.end).join('\n') === entryYaml
}

const EMPTY_FLOW = /^\[\s*\]\s*(#.*)?$/
// 一个顶层条目的头一行必须像 YAML 映射（loader：每个条目必须是 mapping）：
//   `- key: …`、`- "key": …`、`- {…}`、`-` 单独成行（映射在下面缩进行）、`- &anchor` / `- !tag` / `- <<: *x`。
// 纯标量（`- foo`、`- "str"`）不是映射 → 拒收。
const ENTRY_HEAD = /^-(?:\s*|\s+(?:\{.*|[&!*].*|<<:.*|"(?:[^"\\]|\\.)*"\s*:(?:\s.*)?|'[^']*'\s*:(?:\s.*)?|[^\s:#"'\[\]{}&!*|>-][^:#]*:(?:\s.*)?))\s*(#.*)?$/

/**
 * 逐行扫描 patch 文本：数顶层条目、找 `[]`、找结构问题。
 * @returns {{ entries: number, emptyFlow: boolean, problem: null | { code: string, line: number } }}
 */
function scanPatch(raw) {
  const out = { entries: 0, emptyFlow: false, problem: null }
  if (raw.includes('\u0000')) { out.problem = { code: 'patch-invalid', line: 0 }; return out }
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      if (/^(---|\.\.\.)\s*$/.test(line)) continue
      if (EMPTY_FLOW.test(line)) {
        if (out.emptyFlow || out.entries > 0) { out.problem = { code: 'patch-invalid', line: i + 1 }; return out }
        out.emptyFlow = true
        continue
      }
      if (out.emptyFlow || !/^-(\s|$)/.test(line) || !ENTRY_HEAD.test(line)) { out.problem = { code: 'patch-invalid', line: i + 1 }; return out }
      out.entries++
    }
    const unterminated = /^\s*(?:-\s+)*(?:[^\s:"']+:\s+)?"(?:[^"\\]|\\.)*$/.test(line)
    if (unterminated) { out.problem = { code: 'patch-invalid', line: i + 1 }; return out }
  }
  return out
}

/**
 * patch 文本的结构校验（不是完整 YAML 解析：ra 零依赖）。拦的是「截断 / 乱码 / 形状不对」：
 *  - 非空文本必须是顶层数组：每个顶层非空非注释行都以 `- ` 开头，或整个文件只有一个 `[]`（DSH 新 profile 的模板）
 *  - 每个顶层条目的头一行必须像映射。条目不要求有 `id:`：DSH loader 认 `- insert: [...]`，
 *    以及「无 id 的非 insert 条目」（只告警跳过）——这些不是我们管的条目，原样保留、不报错
 *  - 双引号标量必须在同一行闭合（我们生成的、以及 DSH 自己写的 patch 都是单行引号标量）
 * 通过返回 null；否则返回 `{ code, line }`（行号 1 起，不带内容）。
 * 注意：纯注释 / 空文本在这里算「可以往里合并」；「结果必须是数组」由 isLoaderArray 把关。
 */
export function validatePatchYaml(text) {
  return scanPatch(String(text ?? '')).problem
}

/**
 * 真实 loader（dsh-app-boot parsePatchList）要求顶层是 YAML 数组：纯注释或空文件会让节点拒绝启动
 * （`must be a top-level YAML array of loader patch entries`）。这里：结构合法，且至少一个顶层条目或一个 `[]`。
 */
export function isLoaderArray(text) {
  const scan = scanPatch(String(text ?? ''))
  return scan.problem === null && (scan.entries > 0 || scan.emptyFlow)
}

/** 去掉顶层 `[]` 行（往里追加条目之前必须去掉：`[]` 后面跟 `- id:` 不是合法 YAML）。 */
export function withoutEmptyFlow(text) {
  return String(text ?? '').split('\n').filter((l) => !EMPTY_FLOW.test(l)).join('\n')
}

/** 保证结果是 loader 认的数组：没有任何条目时补一行 `[]`（注释保留）。已经是数组原样返回。 */
export function ensureLoaderArray(text) {
  const raw = String(text ?? '')
  if (isLoaderArray(raw)) return raw
  const base = raw.trimEnd()
  return (base === '' ? '' : base + '\n') + '[]\n'
}

/** `llm-pi-ai` 条目是不是撤销后留下的空壳：`providers:` 下面没有任何 provider。 */
export function isEmptyProvidersShell(entryText) {
  const lines = String(entryText).split('\n')
  const i = lines.findIndex((l) => /^ {4}providers:\s*(null|~|\{\s*\})?\s*(#.*)?$/.test(l))
  if (i < 0) return false
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue
    return !/^ {5,}\S/.test(lines[j])
  }
  return true
}

/** 删除一个受管条目（主控不再托管它）。条目不在则原样返回。 */
export function removeManagedEntry(text, entryId) {
  const range = findEntryRange(text, entryId)
  if (!range) return text
  const { lines, start, end } = range
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

/** 去掉若干受管条目后的文本（比较「受管条目之外有没有被动过」用）。 */
export function stripEntries(text, entryIds) {
  let out = text
  for (const id of entryIds) out = removeManagedEntry(out, id)
  return out.trimEnd()
}

/**
 * 合并结果自检（写盘之前）：新文本结构合法、每个受管条目原样在、受管条目之外与原文件逐字节一致。
 * 返回 null 通过，否则返回错误码。
 */
export function checkMergedPatch(before, after, managedIds, expectedEntries) {
  if (validatePatchYaml(after)) return 'patch-invalid'
  if (!isLoaderArray(after)) return 'patch-not-array'
  for (const [id, yaml] of Object.entries(expectedEntries)) {
    if (!containsEntry(after, id, yaml)) return 'patch-entry-missing'
  }
  // `[]` 是我们为「保证是数组」加减的，不算受管条目之外的改动。
  if (stripEntries(withoutEmptyFlow(before), managedIds) !== stripEntries(withoutEmptyFlow(after), managedIds)) return 'patch-collateral'
  return null
}
