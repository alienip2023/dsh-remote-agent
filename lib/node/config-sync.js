/**
 * M2：节点侧配置同步——接收 hub/config-push，合并写入 patch + credentials，
 * 落盘 revision，回执，再按需重启。
 *
 * 零外部依赖。所有文件操作都是原子写（临时文件 + rename）。
 *
 * 安全约束（合同 m2-contract.md §72-83）：
 *  - revision 先落盘，再回执，再重启（否则重启后重连会再推→死循环）
 *  - patch 与 credentials 合并写，不整文件覆盖
 *  - 密钥只写 apiKeyEnv ref 名，明文只进 .credentials.yaml（0600）
 *  - 写盘前快照两个文件；任一步失败→恢复→回滚 revision→回 ok:false
 *  - 错误文案与日志不得包含 apiKey / baseURL 明文
 *  - provider 集合没变就不重启
 *
 * P1b-1 增量（合同 §P1b.2/.4/.6）：
 *  - schema:2 载荷的 plugins[]：只认 config-managed.js 里的白名单 entryId，
 *    校验失败在写盘之前返回（plugin-not-allowed / plugin-config-invalid）
 *  - 只替换主控托管的条目（replaceManagedEntry），其它条目与注释逐字节保留
 *  - 凭据所有权：config-sync.json 记 ownedRefs / ownedEntries；主控撤销 → 节点删除；节点自配的永不动
 *  - 写盘前后都校验：现有 patch 是截断/非法 YAML 就拒绝；落盘后回读不一致就恢复快照
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import {
  ConfigSyncError, validatePlugins, buildPluginEntry, replaceManagedEntry,
  validatePatchYaml, removeManagedEntry, checkMergedPatch, findEntryRange, ensureLoaderArray, isEmptyProvidersShell,
} from './config-managed.js'

const PI_ENTRY = 'llm-pi-ai'

const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 明文里没有特殊字符的 token 原样写（与旧行为一致）；其它一律 JSON 引号，防 YAML 注入。 */
const fmtRefValue = (v) => (/^[A-Za-z0-9._~+\/=-]+$/.test(v) ? v : JSON.stringify(v))

/** 读取 JSON 文件，不存在或解析失败返回 null。 */
function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/** 原子写文件：先写临时文件再 rename，保证不留半截文件。 */
function atomicWrite(filePath, content) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp-' + Date.now()
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, filePath)
}

/** 原子写二进制（credentials 用），带权限设置。 */
function atomicWriteSecure(filePath, content) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp-' + Date.now()
  // 建文件即 0600：先按默认权限建（0644）再 chmod 会留一个「密钥已写入、他人可读」的窗口。
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, filePath)
}

/**
 * 从 payload 中提取 provider 指纹列表（id + baseURL + apiKeyEnv），用于判断是否需要重启。
 * 网关 token 轮换只改 apiKeyEnv，id 集合不变但指纹变 → 必须重启。
 * @param {any} payload
 * @returns {string[]} 排序后的指纹字符串列表
 */
function extractProviderFingerprints(payload) {
  if (!payload || !Array.isArray(payload.providers)) return []
  return payload.providers
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => {
      // Include a digest of the apiKey value so a key rotation (apiKeyEnv unchanged) triggers restart.
      // DSH worker reads credentials.yaml once at startup, so a changed key needs a restart to take effect.
      // We store only a prefix of the sha256 — never the key itself — in the state file.
      // When reading from state file, keyDigest is already computed; when reading from incoming payload, compute from apiKey.
      const keyDigest = p.keyDigest || (p.apiKey ? createHash('sha256').update(String(p.apiKey)).digest('hex').slice(0, 16) : '')
      return [p.id || '', p.baseURL || '', p.apiKeyEnv || '', keyDigest].join('\x00')
    })
    .sort()
}

const sha16 = (x) => createHash('sha256').update(String(x)).digest('hex').slice(0, 16)

/** 稳定序列化（键排序），给插件 config 取摘要用。 */
function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

/**
 * 插件条目指纹：entryId + config 摘要 + 各 ref 的 key 摘要。
 * 入参既可以是已校验的 plugins（带 creds/config），也可以是状态文件里存的摘要形态（带 cfgDigest/keyDigests）。
 */
function extractPluginFingerprints(plugins) {
  if (!Array.isArray(plugins)) return []
  return plugins.map((p) => {
    const cfg = p.cfgDigest ?? sha16(stableJson(p.config ?? {}))
    const keys = p.keyDigests ?? Object.fromEntries((p.creds || []).map((c) => [c.ref, sha16(c.apiKey)]))
    return [p.entryId, cfg, ...Object.keys(keys).sort().map((k) => `${k}=${keys[k]}`)].join('\x00')
  }).sort()
}

/** 状态文件里存的插件摘要（只有摘要，没有 key / config 明文）。 */
function pluginDigests(plugins) {
  return plugins.map((p) => ({
    entryId: p.entryId,
    cfgDigest: sha16(stableJson(p.config)),
    keyDigests: Object.fromEntries(p.creds.map((c) => [c.ref, sha16(c.apiKey)])),
  }))
}

/**
 * 比较两组 provider 指纹是否完全相同。
 */
function sameFingerprints(a, b) {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/**
 * 检测旧状态文件是否使用了仅含 id 的旧格式（缺少 baseURL/apiKeyEnv 字段）。
 * 旧状态下 baseURL 和 apiKeyEnv 均为空串，无法区分「真的为空」和「字段缺失」。
 * 保守处理：只要存在 providers 且全部缺少 baseURL 和 apiKeyEnv，视为旧格式。
 */
/**
 * Detect legacy state file format (no schema field = pre-schema-2).
 * We use a schema version marker to avoid repeated restarts: legacy → one restart → schema:2 written → stable.
 */
function isLegacyState(syncState) {
  // syncState.schema === 2 means it was written by this version or later
  // If lastPayload exists but schema is missing, it is a pre-v2 state file → one-time legacy restart
  return (syncState.lastPayload != null) && (syncState.schema !== 2)
}

/**
 * 清洗错误文案：移除可能包含密钥或 baseURL 的内容。
 * 只保留消息中的错误类型信息，不包含原始数据值。
 */
function sanitizeError(err) {
  const msg = String(err?.message ?? err ?? 'unknown error')
  // 移除可能泄漏的 apiKey (sk-...) 和 baseURL (http...)
  return msg
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-***')
    .replace(/https?:\/\/[^\s'"]+/g, '***')
    .slice(0, 200)
}

/** 解析 credentials 文本里 refs: 段的「名 → 文本里的原样值」。 */
function readRefsFromText(raw) {
  const refs = {}
  let inRefs = false
  for (const line of String(raw).split('\n')) {
    if (/^refs:\s*$/.test(line.trimEnd())) { inRefs = true; continue }
    if (inRefs && /^[A-Za-z_]/.test(line) && !line.startsWith(' ')) { inRefs = false }
    const m = inRefs ? /^ {2}([A-Za-z0-9_]+):\s*(.+)$/.exec(line) : null
    if (m) refs[m[1]] = m[2].trim()
  }
  return refs
}

/**
 * 读取现有 credentials.yaml，在 refs: 段合并新 key（并删除 removeRefs），其余（version/records）原样保留。
 *
 * 策略：
 *  - 只操作 refs: 段，其余行原样输出
 *  - 文件不存在时从头建：version:1 + refs:
 *  - records 段逐行保留，不重新序列化（防止丢内容）
 *  - 新值按 fmtRefValue 写（普通 token 原样，特殊字符 JSON 引号）；已有值保持原样文本
 *
 * @param {string} credPath credentials 文件路径
 * @param {Record<string,string>} newRefs 新的 ref → 明文 value 映射
 * @param {string[]} [removeRefs] 要从 refs: 段删除的 ref 名（只会是节点上由同步写入的）
 * @returns {string} 合并后的文件内容
 */
function mergeCredentials(credPath, newRefs, removeRefs = []) {
  const remove = new Set(removeRefs)
  const fresh = Object.fromEntries(Object.entries(newRefs).map(([k, v]) => [k, fmtRefValue(v)]))
  const refsBlock = (refs) => (Object.keys(refs).length > 0
    ? ['refs:', ...Object.entries(refs).map(([k, v]) => `  ${k}: ${v}`)]
    : ['refs: {}'])

  if (!existsSync(credPath)) {
    return ['version: 1', ...(Object.keys(fresh).length > 0 ? refsBlock(fresh) : []), ''].join('\n')
  }

  const raw = readFileSync(credPath, 'utf-8')
  const lines = raw.split('\n')
  const merged = { ...readRefsFromText(raw), ...fresh }
  for (const r of remove) delete merged[r]

  const out = []
  let inRefsOut = false
  let hasRefsSection = false
  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (/^refs:\s*$/.test(trimmed) || /^refs:\s*\{\s*\}\s*$/.test(trimmed)) {
      if (!hasRefsSection) out.push(...refsBlock(merged))
      hasRefsSection = true
      inRefsOut = /^refs:\s*$/.test(trimmed)
      continue
    }
    if (inRefsOut && line !== '' && !line.startsWith(' ') && !line.startsWith('#')) inRefsOut = false
    if (inRefsOut) continue
    out.push(line)
  }

  // 原文件没有 refs: 段：有内容才插入，放在 records: 之前（没有就追加到末尾）
  if (!hasRefsSection && Object.keys(merged).length > 0) {
    const recordsIdx = out.findIndex((l) => /^records:\s*$/.test(l.trimEnd()))
    if (recordsIdx >= 0) out.splice(recordsIdx, 0, ...refsBlock(merged), '')
    else out.push(...refsBlock(merged))
  }
  return out.join('\n')
}

/** 校验写出的 credentials 文本：该有的 ref 在、该删的 ref 不在。返回 null 表示通过。 */
function checkCredentialsText(text, expectRefs, removedRefs) {
  const have = readRefsFromText(text)
  for (const [k, v] of Object.entries(expectRefs)) if (have[k] !== fmtRefValue(v)) return 'credentials-ref-mismatch'
  for (const k of removedRefs) if (Object.hasOwn(have, k)) return 'credentials-ref-still-present'
  return null
}

/**
 * 读取现有 cordis.patch.yml，替换主控托管的条目：llm-pi-ai（providers 段）以及 schema:2 的 plugins[]。
 * 保留 remote-agent 与 agent-preset-registry 等其他条目和注释（逐字节）。
 * @param {string} patchPath patch 文件路径
 * @param {any} payload config-push 载荷
 * @param {{ plugins?: object[], removeEntries?: string[], writePi?: boolean }} [managed] 已校验的插件条目、要撤销的条目 id、
 *   是否写 llm-pi-ai 条目（载荷没有 provider 时不写：不留 `providers: null` 的空壳）
 * @returns {string} 合并后的文件内容（保证是 loader 认的顶层数组）
 */
function mergePatch(patchPath, payload, managed = {}) {
  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf-8') : ''
  // 现有文件已经是截断/非法的：在它上面合并只会把坏文件写成另一份坏文件。
  const broken = validatePatchYaml(existing)
  if (broken) throw new ConfigSyncError('patch-existing-invalid', 'line ' + broken.line)

  const providers = {}
  for (const p of (payload.providers || [])) {
    providers[p.id] = {
      apiKeyEnv: p.apiKeyEnv || p.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY',
      api: p.api || 'openai-completions',
      baseURL: p.baseURL || '',
      // 模型字段补全（contextWindow 等）在 P1b-2 才由节点落盘；这里仍只写 {id,name}。
      models: (p.models || []).map((m) => ({ id: m.id, name: m.name || m.id })),
    }
  }
  let text = managed.writePi === false ? existing : replaceManagedEntry(existing, PI_ENTRY, buildPatchEntry(providers, payload.defaultModel))
  for (const plugin of managed.plugins || []) {
    text = replaceManagedEntry(text, plugin.entryId, buildPluginEntry(plugin))
  }
  for (const entryId of managed.removeEntries || []) text = removeManagedEntry(text, entryId)
  // 全部条目都撤销后只剩注释的文件，loader 会拒绝启动：补 `[]`，注释保留。
  return ensureLoaderArray(text)
}

/**
 * 构建单个 patch 条目的 YAML 文本。
 * 所有标量值用 JSON.stringify 转义，防止含 # 或 `: ` 的字符串破坏 YAML。
 * provider id 必须匹配 ^[A-Za-z0-9._-]+$，否则抛出。
 */
function buildPatchEntry(providers, defaultModel) {
  let yaml = '- id: llm-pi-ai\n'
  yaml += '  name: ' + JSON.stringify('@deepseek-ai/dsh-llm-pi-ai') + '\n'
  yaml += '  config:\n'
  yaml += '    providers:\n'
  for (const [id, cfg] of Object.entries(providers)) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error('invalid-provider-id: ' + id.slice(0, 40))
    }
    yaml += `      ${id}:\n`
    yaml += '        apiKeyEnv: ' + JSON.stringify(cfg.apiKeyEnv) + '\n'
    yaml += '        api: ' + JSON.stringify(cfg.api) + '\n'
    if (cfg.baseURL) yaml += '        baseURL: ' + JSON.stringify(cfg.baseURL) + '\n'
    if (cfg.models && cfg.models.length > 0) {
      yaml += '        models:\n'
      for (const m of cfg.models) {
        yaml += '          - id: ' + JSON.stringify(m.id) + '\n'
        yaml += '            name: ' + JSON.stringify(m.name) + '\n'
      }
    }
  }
  if (defaultModel) {
    yaml += '    defaultModel: ' + JSON.stringify(defaultModel) + '\n'
  }
  return yaml.trimEnd()
}

/**
 * 简单 YAML 解析：只提取 version / refs / records 段。
 * credentials.yaml 格式固定，不做通用 YAML 解析。
 */
function parseSimpleYaml(raw) {
  const result = { version: 1, refs: {}, records: {} }
  const lines = raw.split('\n')
  let section = null
  for (const line of lines) {
    if (/^version:\s*(\d+)/.test(line)) {
      result.version = parseInt(RegExp.$1, 10) || 1
      continue
    }
    if (/^refs:\s*$/.test(line.trimEnd())) { section = 'refs'; continue }
    if (/^records:\s*$/.test(line.trimEnd())) { section = 'records'; continue }
    if (/^[A-Za-z]/.test(line) && !line.startsWith(' ') && !line.startsWith('#')) {
      section = null
      continue
    }
    if (section === 'refs' && /^\s{2,}([A-Za-z0-9_]+):\s*(.+)$/.test(line)) {
      result.refs[RegExp.$1] = RegExp.$2.trim()
    }
  }
  return result
}

/** 序列化 credentials YAML。 */
function serializeCredentialsYaml(data) {
  let yaml = `version: ${data.version || 1}\n`
  if (data.refs && Object.keys(data.refs).length > 0) {
    yaml += 'refs:\n'
    for (const [k, v] of Object.entries(data.refs)) {
      yaml += `  ${k}: ${v}\n`
    }
  }
  if (data.records && Object.keys(data.records).length > 0) {
    yaml += 'records:\n'
    for (const [k, v] of Object.entries(data.records)) {
      yaml += `  ${k}:\n`
      // records 结构复杂，保留原始内容较安全，这里只简单输出
      yaml += `    ${String(v)}\n`
    }
  }
  return yaml
}

/**
 * 有任务在跑就推迟重启，排空后再发。重启本身仍由 restart 执行（生产里是
 * scheduleRestart），这里只决定时机：running() 返回 0 才发，否则每 waitMs 再看
 * 一次，并打一条日志说明在等。boundMs 到了还没排空，把决定交回调用方（返回的
 * 函数），不在这里静默重启、也不静默放弃。
 * @returns {() => void} 到了上界仍可调用，强制发出这次重启
 */
export function drainRestart({ delayMs, restart, running, log, waitMs = 1000, boundMs = 10 * 60 * 1000, now = Date.now }) {
  const started = now()
  const pending = () => restart(delayMs)
  const tick = () => {
    let left = 0
    try { left = running() } catch { left = 0 }
    if (left <= 0) { pending(); return }
    if (now() - started >= boundMs) {
      log?.('warn', 'config-sync: drain bound reached, restart still held', { running: left })
      return
    }
    log?.('info', 'config-sync: restart held, draining running tasks', { running: left })
    setTimeout(tick, waitMs)
  }
  tick()
  return pending
}

/**
 * 执行 systemctl restart（延迟调用，由调用方控制时机）。
 * --no-block 防止从服务内部重启时卡住自身。
 */
export function scheduleRestart(delayMs, logger) {
  setTimeout(() => {
    try {
      const child = spawn('systemctl', ['restart', '--no-block', 'dsh-worker'], {
        detached: true,
        stdio: 'ignore',
      })
      // spawn 找不到可执行文件（macOS / Windows / 容器里没有 systemctl）时不抛，而是在子进程对象上发 'error'；
      // 没有监听器就是未处理的 'error' 事件，整个节点进程直接退出（exit 1）。
      child.on('error', (err) => logger?.('warn', 'config-sync: restart not possible, restart the node manually', { code: err?.code ?? 'ERROR' }))
      child.unref()
      logger?.('info', 'config-sync: restart issued')
    } catch (err) {
      logger?.('warn', 'config-sync: restart failed', { error: sanitizeError(err) })
    }
  }, delayMs)
}

/** 本机是否由 systemd 管着（sd_booted 的判据）。只有这时才自动重启；否则回执 restartMode:'manual'，由人重启节点 DSH。 */
export function systemdAvailable() {
  return process.platform === 'linux' && existsSync('/run/systemd/system')
}

/** 本节点理解的载荷版本（回执里带上，hub 据此判断节点是否懂 v2）。 */
export const SUPPORTED_SCHEMA = 2

/** fork.54/55 留下的状态（有 ownedEntries、没有 adoptedEntries）+ 已存在的 adopted-<id>.yml 备份文件 = 早已接管过。 */
function legacyAdopted(syncState, bakDir, id) {
  if (Array.isArray(syncState.adoptedEntries) || !Array.isArray(syncState.ownedEntries)) return false
  try { return statSync(join(bakDir, `adopted-${id}.yml`)).isFile() } catch { return false }
}

/**
 * 主入口：处理 hub/config-push 帧。
 * E2E 校验由 transport.checkE2EGate 在分发前单点负责，此处不再重复。
 *
 * @param {object} opts
 * @param {any} opts.data 帧载荷
 * @param {string} opts.dshHome DSH home 目录（如 /root/.dsh）
 * @param {string} opts.profileDir profile 目录（如 /root/.dsh/profiles/web）
 * @param {function} [opts.send] 发送回执的函数 (type, data) => void
 * @param {function} [opts.logger] 日志函数 (level, msg, extra) => void
 * @param {function} [opts._restartFn] 重启函数（仅测试注入，生产不传）
 * @param {boolean} [opts._systemd] 强制「是否 systemd」（仅测试注入；缺省：注入了 _restartFn 视为 true，否则探测本机）
 * @param {function} [opts._afterWrite] 每次写盘后的钩子 (kind, path)（仅测试注入：模拟落盘后文件被截断）
 * @returns {object} { ok: boolean, appliedRevision?: number, error?: string, rollbackRevision?: number, shouldRestart?: boolean }
 */
export function handleConfigPush({
  data,
  dshHome,
  profileDir,
  send,
  logger,
  _restartFn,
  _afterWrite,
  _systemd,
}) {
  const log = logger || (() => {})
  const ack = (result) => { send?.('hub/config-ack', { ...result, schema: SUPPORTED_SCHEMA }); return result }

  // 1. revision 校验
  const revision = data?.revision
  if (!Number.isInteger(revision)) return ack({ ok: false, error: 'invalid-revision' })

  // 读取已应用的 revision
  const syncStatePath = join(dshHome, 'config-sync.json')
  const syncState = readJson(syncStatePath) || {}
  const appliedRevision = syncState.appliedRevision ?? 0

  // stale revision → 静默丢弃，不回执（只有完全相同的内容哈希才算已应用）
  if (revision === appliedRevision) {
    log('warn', 'config-sync: stale revision discarded', { revision, appliedRevision })
    return { ok: true, appliedRevision, stale: true }
  }

  // 2. 提取并校验 payload。plugins[] 只在 schema:2 下生效；校验失败在碰任何文件之前返回。
  const providers = Array.isArray(data.providers) ? data.providers : []
  const credPath = join(dshHome, '.credentials.yaml')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const bakDir = join(dshHome, 'config-sync.bak')

  let plugins = []
  if (data.schema === 2) {
    try {
      plugins = validatePlugins(data.plugins)
    } catch (err) {
      const code = err instanceof ConfigSyncError ? err.code : 'plugin-config-invalid'
      log('warn', 'config-sync: plugins rejected', { revision, code, path: err?.path ?? '' })
      return ack({ ok: false, error: code, ...(err?.path ? { path: err.path } : {}), rollbackRevision: appliedRevision })
    }
  } else if (Array.isArray(data.plugins) && data.plugins.length > 0) {
    log('warn', 'config-sync: plugins ignored (payload is not schema 2)', { revision, count: data.plugins.length })
  }

  // 3. 写盘前快照（记住文件原本在不在：回滚时「原本没有」要删掉，而不是留下新写的）
  const had = { cred: existsSync(credPath), patch: existsSync(patchPath) }
  try {
    if (!existsSync(bakDir)) mkdirSync(bakDir, { recursive: true, mode: 0o700 })
    if (had.cred) { const f = join(bakDir, '.credentials.yaml.bak'); copyFileSync(credPath, f); chmodSync(f, 0o600) }
    if (had.patch) copyFileSync(patchPath, join(bakDir, 'cordis.patch.yml.bak'))
  } catch (err) {
    return ack({ ok: false, error: 'snapshot-failed: ' + sanitizeError(err), rollbackRevision: appliedRevision })
  }

  // 4. 计算合并内容（全部在内存里；任何一步抛错都还没动文件）
  let newCredsContent = ''
  let newPatchContent = ''
  const payloadRefs = {}
  let removedRefs = []
  let ownedRefs = []
  let removeEntries = []
  const ownedEntries = []
  const adoptedEntries = []
  const adoptedStill = []
  const adoptedTexts = {}
  try {
    // 构建 ref 映射：providers 的 apiKeyEnv + 插件的 credentialRefs
    for (const p of providers) {
      if (p.apiKey && typeof p.apiKey === 'string') {
        const refName = p.apiKeyEnv || p.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY'
        payloadRefs[refName] = p.apiKey
      }
    }
    for (const plugin of plugins) {
      for (const { ref, apiKey } of plugin.creds) {
        if (Object.hasOwn(payloadRefs, ref) && payloadRefs[ref] !== apiKey) throw new ConfigSyncError('plugin-config-invalid', 'credentialRefs.conflict')
        payloadRefs[ref] = apiKey
      }
    }

    // 所有权：只有「同步写入的」ref 才能被同步删除。
    const ownedOld = (Array.isArray(syncState.ownedRefs) ? syncState.ownedRefs : []).filter((r) => typeof r === 'string' && REF_NAME.test(r))
    const existingRefs = existsSync(credPath) ? readRefsFromText(readFileSync(credPath, 'utf-8')) : {}
    removedRefs = ownedOld.filter((r) => !Object.hasOwn(payloadRefs, r))
    // 节点上本来就有、且不是同步写的 ref：被覆盖值，但仍归节点（撤销时不删）。
    ownedRefs = [...new Set([
      ...ownedOld.filter((r) => Object.hasOwn(payloadRefs, r)),
      ...Object.keys(payloadRefs).filter((r) => !Object.hasOwn(existingRefs, r) || ownedOld.includes(r)),
    ])].sort()

    // 条目的所有权与 ref 同一条规则：只有「同步新建的」条目才归同步，撤销时才删。
    // 节点上本来就有（手写）的同 id 条目：首次推送会被主控内容替换，但仍归节点——撤销时不删，
    // 首次接管前的原文另存一份（adopted-<id>.yml），回执 adoptedEntries 告诉 hub / 界面发生了接管。
    // 已接管的 id 记进状态文件 adoptedEntries：后续推送不再当「手写」重新接管（否则备份会被主控上次推下去的内容覆盖）。
    // llm-pi-ai 条目走同一套规则；载荷没有 provider 时不写它，撤销后它若是我们建的就删，若只剩空壳也删，其余不动。
    const list = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string')
    const ownedEntriesOld = list(syncState.ownedEntries)
    const adoptedOld = list(syncState.adoptedEntries)
    // fork.54/55 的状态文件没有 adoptedEntries：当时 llm-pi-ai 一律由同步写入，视为同步所有。
    if (!Array.isArray(syncState.adoptedEntries) && !ownedEntriesOld.includes(PI_ENTRY) && (syncState.lastPayload?.providers?.length ?? 0) > 0) ownedEntriesOld.push(PI_ENTRY)
    const entryIds = plugins.map((p) => p.entryId)
    const writePi = providers.length > 0
    const wanted = [...(writePi ? [PI_ENTRY] : []), ...entryIds]
    const patchBefore = had.patch ? readFileSync(patchPath, 'utf-8') : ''
    removeEntries = ownedEntriesOld.filter((id) => !wanted.includes(id))
    if (!writePi && !removeEntries.includes(PI_ENTRY)) {
      const piRange = findEntryRange(patchBefore, PI_ENTRY)
      if (piRange && isEmptyProvidersShell(piRange.lines.slice(piRange.start, piRange.end).join('\n'))) removeEntries.push(PI_ENTRY)
    }
    for (const id of wanted) {
      if (ownedEntriesOld.includes(id)) { ownedEntries.push(id); continue }
      const range = findEntryRange(patchBefore, id)
      if (!range) { ownedEntries.push(id); continue }
      if (adoptedOld.includes(id)) { adoptedStill.push(id); continue }
      // fork.54/55 的状态文件没有 adoptedEntries，但 fork.55 接管时已经存过 adopted-<id>.yml：
      // 这是同一次接管，不是新的——不再存 -r<revision> 备份、不再回执 adoptedEntries，只把它记成「已接管」。
      if (legacyAdopted(syncState, bakDir, id)) { adoptedStill.push(id); continue }
      adoptedEntries.push(id)
      adoptedStill.push(id)
      adoptedTexts[id] = range.lines.slice(range.start, range.end).join('\n') + '\n'
    }

    newCredsContent = mergeCredentials(credPath, payloadRefs, removedRefs)
    const credProblem = checkCredentialsText(newCredsContent, payloadRefs, removedRefs)
    if (credProblem) throw new ConfigSyncError(credProblem)

    const before = had.patch ? readFileSync(patchPath, 'utf-8') : ''
    newPatchContent = mergePatch(patchPath, data, { plugins, removeEntries, writePi })
    const expected = Object.fromEntries(plugins.map((p) => [p.entryId, buildPluginEntry(p)]))
    const patchProblem = checkMergedPatch(before, newPatchContent, [PI_ENTRY, ...entryIds, ...removeEntries], { ...expected })
    if (patchProblem) throw new ConfigSyncError(patchProblem)
  } catch (err) {
    const code = err instanceof ConfigSyncError ? err.code : 'merge-failed: ' + sanitizeError(err)
    return ack({ ok: false, error: code, ...(err?.path ? { path: err.path } : {}), rollbackRevision: appliedRevision })
  }

  // 5. 先落盘 revision（在写文件之前，这样即使重启在中途发生也不会再被推一遍）。保留状态文件里的其它字段。
  try {
    atomicWrite(syncStatePath, JSON.stringify({ ...syncState, appliedRevision: revision }, null, 2) + '\n')
    chmodSync(syncStatePath, 0o600)
  } catch (err) {
    return ack({ ok: false, error: 'revision-persist-failed: ' + sanitizeError(err), rollbackRevision: appliedRevision })
  }

  const fail = (error) => {
    rollback({ bakDir, credPath, patchPath, syncStatePath, syncState, had, log })
    return ack({ ok: false, error, rollbackRevision: appliedRevision })
  }

  // 接管了节点手写的条目：原文先另存（0600，不在 patch 里），存不下就整次回滚——不能一边覆盖一边没留底。
  try {
    for (const [id, text] of Object.entries(adoptedTexts)) {
      // 绝不覆盖已有的接管备份（主控撤销后再次接管同一个 id 时，条目里是主控上次推的内容，不是手写原文）。
      let f = join(bakDir, `adopted-${id}.yml`)
      if (existsSync(f)) f = join(bakDir, `adopted-${id}-r${revision}.yml`)
      writeFileSync(f, text, { encoding: 'utf-8', mode: 0o600 })
      chmodSync(f, 0o600)
    }
  } catch (err) {
    return fail('adopted-backup-failed: ' + sanitizeError(err))
  }

  // 6. 写 credentials.yaml（合并写，0600），再回读核对
  try {
    atomicWriteSecure(credPath, newCredsContent)
    _afterWrite?.('credentials', credPath)
    if (readFileSync(credPath, 'utf-8') !== newCredsContent) return fail('credentials-verify-failed')
  } catch (err) {
    return fail('credentials-write-failed: ' + sanitizeError(err))
  }

  // 7. 写 cordis.patch.yml（合并写），再回读核对
  try {
    atomicWrite(patchPath, newPatchContent)
    _afterWrite?.('patch', patchPath)
    if (readFileSync(patchPath, 'utf-8') !== newPatchContent) return fail('patch-verify-failed')
  } catch (err) {
    return fail('patch-write-failed: ' + sanitizeError(err))
  }

  // 8. 是否需要重启：provider 指纹或插件指纹变了，或撤销了 ref。
  const oldFingerprints = extractProviderFingerprints(syncState.lastPayload || {})
  const newFingerprints = extractProviderFingerprints(data)
  const oldPluginFp = extractPluginFingerprints(syncState.lastPayload?.plugins)
  const newPluginFp = extractPluginFingerprints(plugins)
  const legacy = isLegacyState(syncState)
  const shouldRestart = legacy || !sameFingerprints(oldFingerprints, newFingerprints) || !sameFingerprints(oldPluginFp, newPluginFp) || removedRefs.length > 0
  if (legacy) {
    log('warn', 'config-sync: restart due to legacy-fingerprint (old state file missing schema:2)')
  }

  // 9. 每次成功应用都写 lastPayload（无论是否重启），避免切回去时误重启；同时记所有权。
  try {
    const keyDigest = (p) => p.apiKey ? sha16(p.apiKey) : ''
    atomicWrite(syncStatePath, JSON.stringify({
      schema: 2,
      appliedRevision: revision,
      lastPayload: {
        providers: data.providers?.map(p => ({ id: p.id, baseURL: p.baseURL || '', apiKeyEnv: p.apiKeyEnv || '', keyDigest: keyDigest(p) })),
        plugins: pluginDigests(plugins),
      },
      ownedRefs,
      ownedEntries: [...ownedEntries].sort(),
      adoptedEntries: [...adoptedStill].sort(),
    }, null, 2) + '\n')
    chmodSync(syncStatePath, 0o600)
  } catch { /* 非致命 */ }

  // 10. 回执 ok:true。需要重启时带 restartMode：systemd → 节点自己重启；其它（macOS / Windows / 容器）→ 'manual'，
  //     界面提示「请重启节点 DSH」，节点不去 spawn 一个不存在的 systemctl。
  const systemd = typeof _systemd === 'boolean' ? _systemd : (typeof _restartFn === 'function' ? true : systemdAvailable())
  const result = ack({
    ok: true, appliedRevision: revision, shouldRestart,
    ...(shouldRestart ? { restartMode: systemd ? 'systemd' : 'manual' } : {}),
    ...(adoptedEntries.length > 0 ? { adoptedEntries: [...adoptedEntries] } : {}),
  })

  // 11. 回执后延迟 ≥300ms 再重启（只在 systemd 下）
  if (shouldRestart && systemd) {
    const restartFn = typeof _restartFn === 'function' ? _restartFn : scheduleRestart
    restartFn(300, log)
  } else if (shouldRestart) {
    log('warn', 'config-sync: restart needed but this node is not under systemd; restart the node DSH manually')
  }

  // 日志只记 id 与数量，绝不带 key / baseURL。
  log('info', 'config-sync: applied', {
    revision, shouldRestart, providerCount: newFingerprints.length,
    pluginIds: plugins.map((p) => p.entryId), removedRefCount: removedRefs.length, adoptedEntryCount: adoptedEntries.length,
  })
  return result
}

/**
 * 从快照恢复文件并回滚 revision。快照里没有的（写之前文件不存在）就删掉新写的；
 * 状态文件整体还原（保留 lastPayload / ownedRefs，否则回滚后下一次推送会被当成「旧格式」多重启一次）。
 */
function rollback({ bakDir, credPath, patchPath, syncStatePath, syncState, had, log }) {
  try {
    const credBak = join(bakDir, '.credentials.yaml.bak')
    const patchBak = join(bakDir, 'cordis.patch.yml.bak')
    if (had.cred) { copyFileSync(credBak, credPath); chmodSync(credPath, 0o600) } else if (existsSync(credPath)) unlinkSync(credPath)
    if (had.patch) copyFileSync(patchBak, patchPath); else if (existsSync(patchPath)) unlinkSync(patchPath)
    atomicWrite(syncStatePath, JSON.stringify(syncState, null, 2) + '\n')
    chmodSync(syncStatePath, 0o600)
    log('warn', 'config-sync: rollback completed', { rollbackRevision: syncState.appliedRevision ?? 0 })
  } catch (err) {
    log('error', 'config-sync: rollback failed', { error: sanitizeError(err) })
  }
}

/**
 * 节点重连后发送 config-sync-request。
 * @param {object} opts
 * @param {string} opts.dshHome DSH home 目录
 * @param {function} opts.send 发送函数 (type, data) => void
 * @param {function} [opts.logger]
 */
export function sendConfigSyncRequest({ dshHome, send, logger }) {
  const log = logger || (() => {})
  const syncStatePath = join(dshHome, 'config-sync.json')
  const syncState = readJson(syncStatePath) || {}
  const appliedRevision = syncState.appliedRevision ?? 0
  try {
    send('hub/config-sync-request', { appliedRevision })
    log('info', 'config-sync: sync-request sent', { appliedRevision })
  } catch (err) {
    log('warn', 'config-sync: sync-request failed', { error: sanitizeError(err) })
  }
}

/**
 * hub 侧：处理节点发来的 config-sync-request。
 * 如果节点 revision < 主控 currentRevision，推全量。
 *
 * @param {object} opts
 * @param {any} opts.data 帧载荷 { appliedRevision }
 * @param {number} opts.currentRevision 主控当前 revision
 * @param {function} opts.getPayload 获取全量 payload 的函数
 * @param {function} opts.sendPush 向节点推送的函数 (nodeId, payload) => void
 * @param {string} opts.nodeId 节点 ID
 * @param {function} [opts.logger]
 */
export function handleConfigSyncRequest({
  data,
  currentRevision,
  getPayload,
  sendPush,
  nodeId,
  logger,
}) {
  const log = logger || (() => {})
  const nodeRevision = data?.appliedRevision ?? 0

  if (nodeRevision === currentRevision) {
    log('info', 'config-sync: node already up-to-date', { nodeId, nodeRevision, currentRevision })
    return { ok: true, skipped: true }
  }

  // 推全量
  try {
    const payload = getPayload()
    if (!payload) {
      log('warn', 'config-sync: no payload available', { nodeId })
      return { ok: false, error: 'no-payload' }
    }
    payload.revision = currentRevision
    sendPush(nodeId, payload)
    log('info', 'config-sync: push sent on sync-request', { nodeId, revision: currentRevision })
    return { ok: true, pushed: true }
  } catch (err) {
    log('error', 'config-sync: push failed', { nodeId, error: sanitizeError(err) })
    return { ok: false, error: sanitizeError(err) }
  }
}
