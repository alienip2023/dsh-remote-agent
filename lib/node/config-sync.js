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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'

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
  writeFileSync(tmp, content, 'utf-8')
  chmodSync(tmp, 0o600)
  renameSync(tmp, filePath)
}

/**
 * 从 payload 中提取 provider id 列表（用于判断集合是否变化）。
 * @param {any} payload
 * @returns {string[]} provider id 列表
 */
function extractProviderIds(payload) {
  if (!payload || !Array.isArray(payload.providers)) return []
  return payload.providers
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => p.id)
    .sort()
}

/**
 * 比较两组 provider id 是否相同。
 */
function sameProviderSet(a, b) {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
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

/**
 * 读取现有 credentials.yaml，在 refs: 段合并新 key，其余（version/records）原样保留。
 *
 * 策略：
 *  - 只操作 refs: 段，其余行原样输出
 *  - 文件不存在时从头建：version:1 + refs: + records:
 *  - records 段逐行保留，不重新序列化（防止丢内容）
 *
 * @param {string} credPath credentials 文件路径
 * @param {Record<string,string>} newRefs 新的 ref → value 映射
 * @returns {string} 合并后的文件内容
 */
function mergeCredentials(credPath, newRefs) {
  if (!existsSync(credPath)) {
    // 从头建：version + refs + empty records
    let yaml = 'version: 1\n'
    if (Object.keys(newRefs).length > 0) {
      yaml += 'refs:\n'
      for (const [k, v] of Object.entries(newRefs)) {
        yaml += `  ${k}: ${v}\n`
      }
    }
    return yaml
  }

  const raw = readFileSync(credPath, 'utf-8')
  const lines = raw.split('\n')

  // 解析现有 refs: 段（key → value）
  const existingRefs = {}
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line.trimEnd())) { inRefs = true; continue }
    if (inRefs && /^[A-Za-z_]/.test(line) && !line.startsWith(' ')) { inRefs = false }
    if (inRefs && /^ {2}([A-Za-z0-9_]+):\s*(.+)$/.test(line)) {
      existingRefs[RegExp.$1] = RegExp.$2.trim()
    }
  }

  // 合并新 refs（新的覆盖旧的，旧的保留）
  const mergedRefs = { ...existingRefs, ...newRefs }

  // 重建文件：按行扫描，替换 refs: 段，其余原样
  const out = []
  let refsWritten = false
  let inRefsOut = false
  let hasRefsSectionInInput = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimEnd()

    // 检测是否进入 refs: 段
    if (/^refs:\s*$/.test(trimmed)) {
      hasRefsSectionInInput = true
      if (!refsWritten) {
        out.push('refs:')
        for (const [k, v] of Object.entries(mergedRefs)) {
          out.push(`  ${k}: ${v}`)
        }
        refsWritten = true
      }
      inRefsOut = true
      continue
    }

    // 检测离开 refs: 段（顶层 key 或顶层 YAML 列表项）
    if (inRefsOut && line !== '' && !line.startsWith(' ') && !line.startsWith('#')) {
      inRefsOut = false
    }

    // 在 refs: 段内的行：跳过（已重写）
    if (inRefsOut) continue

    out.push(line)
  }

  // 如果原文件没有 refs: 段，在 records: 之前插入
  if (!hasRefsSectionInInput && Object.keys(mergedRefs).length > 0) {
    const recordsIdx = out.findIndex((l) => /^records:\s*$/.test(l.trimEnd()))
    const refsBlock = ['refs:', ...Object.entries(mergedRefs).map(([k, v]) => `  ${k}: ${v}`), '']
    if (recordsIdx >= 0) {
      out.splice(recordsIdx, 0, ...refsBlock)
    } else {
      // 追加到末尾
      out.push('refs:')
      for (const [k, v] of Object.entries(mergedRefs)) {
        out.push(`  ${k}: ${v}`)
      }
    }
  }

  return out.join('\n')
}

/**
 * 读取现有 cordis.patch.yml，合并 llm-pi-ai 的 providers 段。
 * 保留 remote-agent 与 agent-preset-registry 等其他条目和注释。
 * @param {string} patchPath patch 文件路径
 * @param {any} payload config-push 载荷
 * @returns {string} 合并后的文件内容
 */
function mergePatch(patchPath, payload) {
  let existing = ''
  if (existsSync(patchPath)) {
    existing = readFileSync(patchPath, 'utf-8')
  }
  // 构建 llm-pi-ai 条目
  const providers = {}
  for (const p of (payload.providers || [])) {
    providers[p.id] = {
      apiKeyEnv: p.apiKeyEnv || p.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY',
      api: p.api || 'openai-completions',
      baseURL: p.baseURL || '',
      models: (p.models || []).map((m) => ({ id: m.id, name: m.name || m.id })),
    }
  }
  const patchEntry = buildPatchEntry(providers, payload.defaultModel)

  // 检查是否已有 llm-pi-ai 条目
  if (/\n- id:\s*llm-pi-ai\b/.test(existing) || /^-\s*id:\s*llm-pi-ai\b/.test(existing)) {
    // 替换现有 llm-pi-ai 条目
    return existing.replace(
      /(\n?-\s*id:\s*llm-pi-ai\n[\s\S]*?)(?=\n- id:|\n#$|\Z)/,
      '\n' + patchEntry
    )
  }
  // 追加新条目
  return existing.trimEnd() + '\n\n' + patchEntry + '\n'
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
 * 执行 systemctl restart（延迟调用，由调用方控制时机）。
 * --no-block 防止从服务内部重启时卡住自身。
 */
function scheduleRestart(delayMs, logger) {
  setTimeout(() => {
    try {
      spawn('systemctl', ['restart', '--no-block', 'dsh-worker'], {
        detached: true,
        stdio: 'ignore',
      }).unref()
      logger?.('info', 'config-sync: restart issued')
    } catch (err) {
      logger?.('warn', 'config-sync: restart failed', { error: sanitizeError(err) })
    }
  }, delayMs)
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
 * @returns {object} { ok: boolean, appliedRevision?: number, error?: string, rollbackRevision?: number, shouldRestart?: boolean }
 */
export function handleConfigPush({
  data,
  dshHome,
  profileDir,
  send,
  logger,
  _restartFn,
}) {
  const log = logger || (() => {})

  // 1. revision 校验
  const revision = data?.revision
  if (!Number.isInteger(revision)) {
    const result = { ok: false, error: 'invalid-revision' }
    send?.('hub/config-ack', result)
    return result
  }

  // 读取已应用的 revision
  const syncStatePath = join(dshHome, 'config-sync.json')
  const syncState = readJson(syncStatePath) || {}
  const appliedRevision = syncState.appliedRevision ?? 0

  // stale revision → 静默丢弃，不回执
  if (revision <= appliedRevision) {
    log('info', 'config-sync: stale revision discarded', { revision, appliedRevision })
    return { ok: true, appliedRevision, stale: true }
  }

  // 3. 提取 payload 数据
  const providers = Array.isArray(data.providers) ? data.providers : []
  const credPath = join(dshHome, '.credentials.yaml')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const bakDir = join(dshHome, 'config-sync.bak')

  // 4. 写盘前快照
  try {
    if (!existsSync(bakDir)) mkdirSync(bakDir, { recursive: true })
    if (existsSync(credPath)) copyFileSync(credPath, join(bakDir, '.credentials.yaml.bak'))
    if (existsSync(patchPath)) copyFileSync(patchPath, join(bakDir, 'cordis.patch.yml.bak'))
  } catch (err) {
    const result = { ok: false, error: 'snapshot-failed: ' + sanitizeError(err), rollbackRevision: appliedRevision }
    send?.('hub/config-ack', result)
    return result
  }

  // 5. 计算合并内容
  let newCredsContent = ''
  let newPatchContent = ''
  let newRefs = {}

  try {
    // 构建 ref 映射：providerId → apiKey value
    for (const p of providers) {
      if (p.apiKey && typeof p.apiKey === 'string') {
        const refName = p.apiKeyEnv || p.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_API_KEY'
        newRefs[refName] = p.apiKey
      }
    }
    newCredsContent = mergeCredentials(credPath, newRefs)
    newPatchContent = mergePatch(patchPath, data)
  } catch (err) {
    // 合并计算失败 → 回滚
    const result = { ok: false, error: 'merge-failed: ' + sanitizeError(err), rollbackRevision: appliedRevision }
    send?.('hub/config-ack', result)
    return result
  }

  // 6. 先落盘 revision（在写文件之前，这样即使写文件失败 revision 已记录）
  //    合同要求：revision 先落盘再回执再重启
  //    但如果文件写入失败，需要回滚 revision
  try {
    atomicWrite(syncStatePath, JSON.stringify({ appliedRevision: revision }, null, 2) + '\n')
    chmodSync(syncStatePath, 0o600)
  } catch (err) {
    const result = { ok: false, error: 'revision-persist-failed: ' + sanitizeError(err), rollbackRevision: appliedRevision }
    send?.('hub/config-ack', result)
    return result
  }

  // 7. 写 credentials.yaml（合并写，0600）
  try {
    atomicWriteSecure(credPath, newCredsContent)
  } catch (err) {
    // 写 credentials 失败 → 恢复快照 + 回滚 revision
    rollback(bakDir, credPath, patchPath, syncStatePath, appliedRevision, log)
    const result = { ok: false, error: 'credentials-write-failed: ' + sanitizeError(err), rollbackRevision: appliedRevision }
    send?.('hub/config-ack', result)
    return result
  }

  // 8. 写 cordis.patch.yml（合并写）
  try {
    atomicWrite(patchPath, newPatchContent)
  } catch (err) {
    // 写 patch 失败 → 恢复快照 + 回滚 revision
    rollback(bakDir, credPath, patchPath, syncStatePath, appliedRevision, log)
    const result = { ok: false, error: 'patch-write-failed: ' + sanitizeError(err), rollbackRevision: appliedRevision }
    send?.('hub/config-ack', result)
    return result
  }

  // 计算是否需要重启（provider 集合是否变化）
  const oldProviderIds = extractProviderIds(syncState.lastPayload || {})
  const newProviderIds = extractProviderIds(data)
  const shouldRestart = !sameProviderSet(oldProviderIds, newProviderIds)

  // 9. 每次成功应用都写 lastPayload（无论是否重启），避免切回去时误重启
  try {
    atomicWrite(syncStatePath, JSON.stringify({ appliedRevision: revision, lastPayload: { providers: data.providers?.map(p => ({ id: p.id })) } }, null, 2) + '\n')
    chmodSync(syncStatePath, 0o600)
  } catch { /* 非致命 */ }

  // 10. 回执 ok:true
  const result = { ok: true, appliedRevision: revision, shouldRestart }
  send?.('hub/config-ack', result)

  // 11. 回执后延迟 ≥300ms 再重启
  if (shouldRestart) {
    const restartFn = typeof _restartFn === 'function' ? _restartFn : scheduleRestart
    restartFn(300, log)
  }

  log('info', 'config-sync: applied', { revision, shouldRestart, providerCount: newProviderIds.length })
  return result
}

/**
 * 从快照恢复文件并回滚 revision。
 */
function rollback(bakDir, credPath, patchPath, syncStatePath, oldRevision, log) {
  try {
    const credBak = join(bakDir, '.credentials.yaml.bak')
    const patchBak = join(bakDir, 'cordis.patch.yml.bak')
    if (existsSync(credBak)) copyFileSync(credBak, credPath)
    if (existsSync(patchBak)) copyFileSync(patchBak, patchPath)
    // 回滚 revision
    atomicWrite(syncStatePath, JSON.stringify({ appliedRevision: oldRevision }, null, 2) + '\n')
    chmodSync(syncStatePath, 0o600)
    log('warn', 'config-sync: rollback completed', { rollbackRevision: oldRevision })
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

  if (nodeRevision >= currentRevision) {
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
