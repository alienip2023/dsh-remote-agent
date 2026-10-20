/**
 * 独立配置文件（2026-10-18，解决"配置被 DSH 重写冲掉"的根因）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 实测事故（2026-10-18）：
 *
 *   01:44  cordis.patch.yml = 3962B / 15 条（含我们的 role + webserver）
 *   12:05  cordis.patch.yml = 696B  /  4 条（**我们的段整段消失**）
 *
 * 12:05 前后用户在 DSH 里**卸载重装了插件**，同时 pnpm-lock.yaml 被更新。
 * 结论：**DSH 的插件管理器在改动依赖时会重写 `cordis.patch.yml`，只保留它
 * 自己管理的条目** —— 手工写的段会被冲掉。
 *
 * 这正是"每次设置完重启又回到引导页"的真正根因（不是版本旧、不是写错 profile）：
 *
 *   用户选角色 → 写入 cordis.patch.yml → 某次插件操作 → 我们的段被冲掉
 *   → 重启 → role 消失 → 面板又显示引导
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 方案：配置分两层（本文件 = 不会被冲掉的那层）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · **第 1 层**：`cordis.patch.yml` 里的 `- id: remote-agent` 行
 *     —— 只负责"让 loader 加载这个插件"，内容可以极简（甚至只有 id + name）
 *   · **第 2 层**：`<stateDir>/instance.json`（本文件管的这个）
 *     —— 存 role / hubUrl / roots 等**真正的配置**
 *
 * loader 传进来的 config 与这里的值**合并**，后者在关键字段上**优先**
 * （因为它是用户明确设置过、且不会被外力冲掉的）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全与边界
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · 文件权限 0600（可能含 token）
 *   · 原子写（tmp → rename），与 templates.js 同一套做法
 *   · **绝不抛**：读失败/损坏时返回 null，让调用方退回 loader config
 *     （配置读不出来不该让 DSH 起不来）
 *   · 只存**白名单字段**，不存任意用户输入（防配置注入）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 独立配置文件名（放在 stateDir 下）。 */
export const INSTANCE_FILE_NAME = 'instance.json'

/**
 * 允许持久化的字段白名单。
 *
 * 为什么不直接存整个 config：config 里可能有 DSH 注入的东西（未知字段会
 * 被 schemastery passthrough 保留），把它们写回磁盘等于把 loader 的中间态
 * 固化下来。只存我们**真正需要跨重启保留**的。
 *
 * ⚠ 2026-10-20 补齐（v0.9.3 审查 H2/M2）：此前少了 `listenHost` /
 * `listenPort` / `relay` —— 于是架构承诺"配置不会再被 DSH 冲掉"，
 * 而 0.9.3 新增的两个关键字段恰好不在保护范围内，`relay`（跨 NAT 必需）
 * 更是从来没有落过盘。用户配了它们，一次重启就静默回默认。
 */
const PERSISTED_KEYS = Object.freeze([
  'role',
  'nodeId',
  'transportMode',
  'hubUrl',
  'relayUrl',
  'roots',
  'nodeToken',
  'uiPullRoot',
  'agentMode',
  'pair',
  // 0.9.3 独立监听的绑定意图（自动选地址会挑 Tailscale，用户可能想钉死局域网）
  'listenHost',
  'listenPort',
  // hub 侧中继凭证（跨 NAT 场景的唯一通路）
  'relay',
])

/** 值是对象的白名单字段（当前只有 relay：{ url, token }）。 */
const OBJECT_KEYS = Object.freeze({
  relay: ['url', 'token'],
})

/**
 * 解析 stateDir（与 lib/node/index.js 的 resolveStateDir 同口径）。
 * @param {object} [config]
 * @returns {string}
 */
export function resolveStateDir(config) {
  const c = config && typeof config === 'object' ? config : {}
  const explicit = typeof c.stateDir === 'string' ? c.stateDir.trim() : ''
  if (explicit !== '') {
    try {
      return path.resolve(explicit)
    } catch {
      /* 落到默认 */
    }
  }
  try {
    return path.join(os.homedir(), '.dsh-remote-agent')
  } catch {
    return path.join(os.tmpdir(), '.dsh-remote-agent')
  }
}

/** 独立配置文件的绝对路径。 */
export function instanceFilePath(config) {
  return path.join(resolveStateDir(config), INSTANCE_FILE_NAME)
}

/**
 * 字段级清洗（读与写共用，保证两侧对称）。
 *
 * 2026-10-20 扩展：支持 number（listenPort）与白名单对象（relay）。
 * 早先只接受 string，于是 `listenPort: 19388` 这种合法配置会被静默丢弃。
 *
 * @param {Map<string, unknown>} src
 * @returns {object|null} 清洗后的对象；没有任何有效字段时返回 null
 */
function sanitizeFields(src) {
  const out = {}
  for (const k of PERSISTED_KEYS) {
    if (!src.has(k)) continue
    const v = src.get(k)
    if (v === null || v === undefined) continue

    // roots：数组，去空去重前的简单清洗（真正的规范化在 normalizeRoots）
    if (k === 'roots') {
      if (Array.isArray(v)) {
        const arr = v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
        if (arr.length > 0) out.roots = arr
      }
      continue
    }

    // relay：{ url, token } —— 只取白名单子键，且至少有一个非空
    if (OBJECT_KEYS[k]) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const sub = {}
      for (const sk of OBJECT_KEYS[k]) {
        const sv = v[sk]
        if (typeof sv === 'string' && sv.trim() !== '') sub[sk] = sv.trim()
      }
      if (Object.keys(sub).length > 0) out[k] = sub
      continue
    }

    // listenPort：数字（0 合法 —— 表示显式关闭独立监听）
    if (k === 'listenPort') {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN)
      if (Number.isInteger(n) && n >= 0 && n < 65536) out.listenPort = n
      continue
    }

    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 读独立配置。
 *
 * @param {object} [config] 用于解析 stateDir
 * @returns {object|null} 读不到/损坏时返回 null（**不抛**）
 */
export function readInstanceConfig(config) {
  const file = instanceFilePath(config)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    // ENOENT = 还没写过，是最常见的正常情况
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 损坏：返回 null 让调用方退回 loader config（不让 DSH 起不来）
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return sanitizeFields(new Map(Object.entries(parsed)))
}

/**
 * 写独立配置（原子写 + 0600）。
 *
 * @param {object} values 要写的字段（按白名单过滤）
 * @param {object} [config] 用于解析 stateDir —— **必须传**，否则写默认目录、
 *   而读的一方按 `config.stateDir` 找，两边对不上（v0.9.3 审查 M1 的成因）
 * @returns {{ok:boolean, file:string, error?:string}}
 */
export function writeInstanceConfig(values, config) {
  const dir = resolveStateDir(config)
  const file = path.join(dir, INSTANCE_FILE_NAME)
  const src = values && typeof values === 'object' ? values : {}
  const out = sanitizeFields(new Map(Object.entries(src))) ?? {}

  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
    return { ok: true, file }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    return { ok: false, file, error: String(err?.message ?? err) }
  }
}

/**
 * 把独立配置**合并进** loader 传进来的 config。
 *
 * ── 优先级（关键设计）──────────────────────────────────────────────────
 *
 * **独立配置优先** —— 因为：
 *   · 它是用户通过面板明确设置过的值
 *   · 它不会被 DSH 重写冲掉
 *   · loader config 在"被冲掉"之后只剩包内默认（role: auto），
 *     那正是"重启回引导页"的成因
 *
 * 例外：如果独立配置里**没有**某个字段，就用 loader config 的值。
 *
 * ⚠ 这个优先级有一个副作用（v0.9.3 审查 M3）：用户手改 `cordis.patch.yml`
 * 或 DSH 插件 UI 之后，**同名字段永远不生效**，而且没有任何提示 ——
 * 与项目反复强调的"面板说 A、插件实际做 B 是最难排查的撕裂"同型。
 * 所以这里把"被覆盖了哪些字段"回报给调用方，由它记日志/在面板展示。
 *
 * @param {object} loaderConfig
 * @param {object} [opts]
 * @param {object} [opts.overlay] 读到的独立配置（避免重复读盘）
 * @returns {{config:object, source:object|null, shadowed:string[]}}
 *   `shadowed` = 独立配置压住 loader 值的字段名（值本身不回报，避免日志泄密）
 */
export function mergeInstanceConfig(loaderConfig, { overlay } = {}) {
  const base = loaderConfig && typeof loaderConfig === 'object' ? loaderConfig : {}
  let saved = overlay
  if (saved === undefined) saved = readInstanceConfig(base)
  if (!saved) return { config: base, source: null, shadowed: [] }

  const shadowed = []
  for (const k of Object.keys(saved)) {
    if (!(k in base)) continue // loader 没有 → 不算"覆盖"，是补全
    const a = base[k]
    const b = saved[k]
    // 只在**值真的不同**时记 —— 否则每次启动都刷一堆无意义的"覆盖"
    const differ = (typeof a === 'object' || typeof b === 'object')
      ? JSON.stringify(a) !== JSON.stringify(b)
      : a !== b
    if (differ) shadowed.push(k)
  }
  return { config: { ...base, ...saved }, source: saved, shadowed }
}
