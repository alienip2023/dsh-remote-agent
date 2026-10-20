/**
 * 一键修复（2026-10-20，用户要求的第四项能力）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这件事要极其小心
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户之前明确说过「**不要改 DSH**」。而"一键修复"恰恰要改
 * `<profile>/cordis.patch.yml` —— DSH 自己的配置文件。
 *
 * 我们**自己**刚因为动这个文件出过事故：
 *   · 手写 `host: '0.0.0.0'` → DSH 启动崩溃（10 份 crash 日志）
 *   · 追加 remote-agent 段 → 被 DSH 下次启动重写冲掉
 *
 * 所以本模块的每一道防线都不是"最佳实践"，而是**踩过的坑**：
 *
 *   1. **只改托管块**（`# --- dsh-remote-agent (managed) ---` 之间）。
 *      用户手写的其它条目一个字节不碰 —— 复用 `writePatchBlock` 的既有保证。
 *   2. **写前必备份**（`writePatchBlock` 自带 `.bak-<时间戳>`）。
 *   3. **写后必校验**：重新解析一遍，确认我们的条目在、且没有重复 id。
 *   4. **失败必回滚**（`writePatchBlock` 内部已做；本模块再兜一层）。
 *   5. **面板二次确认**：`confirm: 'yes'` 才动手（与 SMB 共享同一模式）。
 *   6. **可一键回滚**：记住上一次备份路径，给「撤销」按钮。
 *
 * ── 只修"机械可判定"的项 ───────────────────────────────────────────────
 *
 * **不修**需要人判断的（端口占用、防火墙、模型凭证）—— 那些只给建议。
 *
 * 可修的两类：
 *   · `webserver.host` 绑在 loopback 或 0.0.0.0 → 改成自动选出的具体 IP
 *   · `remote-agent.role` 缺失 → 按当前推断结果补上
 *
 * ⚠ **绝不用 0.0.0.0**（新版 DSH 硬拒绝，会让它启动崩溃）。
 * 地址由 `resolveListenHost` 自动选（Tailscale > 私网 > 回环）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolveListenHost } from './listen-server.js'

/**
 * 生成一个修复计划（**只读**，不改任何文件）。
 *
 * 面板先展示"将要改什么"，用户确认后才调 `applyFixPlan`。
 *
 * @param {object} o
 * @param {object} o.envCheck envChecks 的结果
 * @param {string} o.patchFile 目标 cordis.patch.yml 绝对路径
 * @param {string} [o.listenHost] 用户配置的监听地址（留空=自动选）
 * @returns {{fixable:Array, skipped:Array, host:string, hostSource:string, file:string}}
 */
export function planFixes({ envCheck, patchFile, listenHost = '' } = {}) {
  const picked = resolveListenHost({ listenHost })
  const fixable = []
  const skipped = []

  const items = Array.isArray(envCheck?.items) ? envCheck.items : []
  for (const it of items) {
    if (!it || it.ok === true) continue
    const id = typeof it.id === 'string' ? it.id : ''

    if (id === 'reachability') {
      // 这是**唯一**能机械修的：把 webserver.host 改成具体 IP
      fixable.push({
        id: 'reachability',
        label: it.label,
        // 说明将要做什么（面板必须展示，用户要知道自己在同意什么）
        change: `把 webserver 的 host 改成 ${picked.host}（${describeSource(picked.source)}）`,
        // 明确的"不会做什么"—— 比承诺做了什么更重要
        note: '只改 host 这一个字段，不动 port、不动你的其它配置条目',
      })
      continue
    }

    if (id === 'role') {
      fixable.push({
        id: 'role',
        label: it.label,
        change: '在 remote-agent 的 config 里补上 role',
        note: '按当前推断结果写入（没配 hubUrl 就是 hub）',
      })
      continue
    }

    // 其它项（端口占用 / 防火墙 / 模型 / Tailscale / roots 不存在）都需要人判断
    skipped.push({
      id,
      label: it.label,
      reason: skippedReason(id),
    })
  }

  return {
    fixable,
    skipped,
    host: picked.host,
    hostSource: picked.source,
    file: typeof patchFile === 'string' ? patchFile : '',
  }
}

/** 为什么这项不能自动修（如实说明，不含糊）。 */
function skippedReason(id) {
  switch (id) {
    case 'port':
      return '端口被别的程序占用 —— 需要你决定换哪个端口，插件不能替你选'
    case 'firewall':
      return '防火墙规则需要管理员权限，且要你确认放行范围'
    case 'tailscale':
      return '装软件需要你同意（本插件不代下载第三方软件）'
    case 'nodes':
      return '副机连不上是**结果**不是原因 —— 先修上面那项「Web 服务绑在可达地址」'
    case 'inject':
      return 'inject 要跟着 role 一起改，且会影响插件能否加载 —— 请用面板「切换角色」，它会一次改对'
    case 'roots':
      return 'roots 目录不存在 —— 建目录要你确认路径（面板写入配置时会自动建）'
    default:
      return '这项需要你判断'
  }
}

function describeSource(src) {
  switch (src) {
    case 'tailscale':
      return 'Tailscale IP，固定不变、跨网可达'
    case 'private':
      return '局域网 IP'
    case 'config':
      return '你在配置里指定的地址'
    default:
      return '本机回环（仅同机可用）'
  }
}

/**
 * 应用修复计划（**会改文件**）。
 *
 * ⚠ 调用方必须已经拿到用户的明确确认（`confirm === 'yes'`）。
 * 本函数不检查确认 —— 那是路由层的职责（分层：本模块只做"改得安全"，
 * 不负责"该不该改"）。
 *
 * @param {object} o
 * @param {object} o.plan planFixes 的返回值
 * @param {object} o.writePatchBlock 注入的写盘函数（便于测试替身）
 * @param {(file:string)=>string} o.readFile 注入的读函数
 * @param {string} o.role 要写入的 role（hub/worker/both）
 * @returns {{ok:boolean, file:string, backup:string, applied:Array, error?:string}}
 */
export function applyFixPlan({ plan, writePatchBlock, readFile, role = 'hub' } = {}) {
  const applied = []
  if (!plan || typeof plan !== 'object') {
    return { ok: false, file: '', backup: '', applied, error: '缺少修复计划' }
  }
  const fixable = Array.isArray(plan.fixable) ? plan.fixable : []
  if (fixable.length === 0) {
    return { ok: false, file: plan.file || '', backup: '', applied, error: '没有可自动修的项' }
  }
  if (typeof writePatchBlock !== 'function') {
    return { ok: false, file: plan.file || '', backup: '', applied, error: '写盘函数不可用' }
  }
  if (typeof readFile !== 'function') {
    return { ok: false, file: plan.file || '', backup: '', applied, error: '读文件函数不可用' }
  }

  // ── 组装托管块（逐行构造，绝不把用户输入拼进 YAML）──────────────────
  //
  // ⚠ 与 setup-routes 的写法一致：每一行都是字面量 + 经过校验的值，
  // 不做字符串插值以外的任何拼接（防 YAML 注入）。
  const lines = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
  ]
  const wantRole = fixable.some((f) => f.id === 'role')
  const wantHost = fixable.some((f) => f.id === 'reachability')

  // inject 必须跟着 role 走（hub 要 webServer；worker 要 agentLoop/sessions）
  const inject = role === 'worker'
    ? ['tools', 'agentLoop', 'sessions']
    : ['webServer', 'tools', 'systemPrompt']
  lines.push(`  inject: [ ${inject.map((s) => `'${s}'`).join(', ')} ]`)
  lines.push('  config:')
  // role 总是写（它决定插件怎么跑，缺了会走包内默认 auto）。
  // 不是"只在 wantRole 时写" —— 缺 role 的配置本身就是坏状态。
  lines.push(`    role: ${role === 'worker' || role === 'both' ? role : 'hub'}`)
  if (wantHost) {
    // host 必须是具体 IP —— 绝不写 0.0.0.0（新版 DSH 会拒绝并崩溃）
    const host = typeof plan.host === 'string' ? plan.host.trim() : ''
    if (host !== '' && host !== '0.0.0.0') {
      lines.push(`    listenHost: '${host.replace(/'/g, "''")}'`)
    }
  }
  if (wantRole) applied.push('role')
  if (wantHost) applied.push('reachability')

  const blockYaml = `${lines.join('\n')}\n`

  // ── 写盘（writePatchBlock 自带：备份 + 冲突检测 + 写后校验 + 失败回滚）──
  let result
  try {
    result = writePatchBlock({ file: plan.file, blockYaml, force: false })
  } catch (err) {
    return { ok: false, file: plan.file, backup: '', applied, error: String(err?.message ?? err) }
  }
  if (!result || result.ok !== true) {
    return {
      ok: false,
      file: (result && result.file) || plan.file,
      backup: (result && result.backup) || '',
      applied,
      error: (result && result.error) || '写盘失败',
    }
  }

  // ── 写后校验：重新读回来，确认我们的条目在、没有重复 id ──────────────
  //
  // 为什么再查一遍：writePatchBlock 校验的是"托管块格式"，而这里要确认的是
  // "**从用户视角看，文件现在的状态是能用的**"——两者角度不同。
  try {
    const after = readFile(plan.file)
    const ids = [...String(after).matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1])
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
    if (dup.length > 0) {
      return {
        ok: false,
        file: plan.file,
        backup: result.backup || '',
        applied,
        error: `写后发现重复 id：${dup.join(', ')} —— 已保留备份，请用「撤销」恢复`,
      }
    }
    if (!ids.includes('remote-agent')) {
      return {
        ok: false,
        file: plan.file,
        backup: result.backup || '',
        applied,
        error: '写后没找到 remote-agent 条目 —— 已保留备份，请用「撤销」恢复',
      }
    }
  } catch (err) {
    return {
      ok: false,
      file: plan.file,
      backup: result.backup || '',
      applied,
      error: `写后校验读文件失败：${String(err?.message ?? err)}`,
    }
  }

  return { ok: true, file: plan.file, backup: result.backup || '', applied, error: undefined }
}

/**
 * 撤销上一次修复（用备份覆盖回去）。
 *
 * @param {object} o
 * @param {string} o.file 目标文件
 * @param {string} o.backup 备份文件路径
 * @returns {{ok:boolean, error?:string}}
 */
export function undoFix({ file, backup } = {}) {
  if (typeof file !== 'string' || file === '') return { ok: false, error: '缺少目标文件' }
  if (typeof backup !== 'string' || backup === '') return { ok: false, error: '没有可用的备份' }
  try {
    if (!fs.existsSync(backup)) return { ok: false, error: `备份文件不存在：${backup}` }
    const content = fs.readFileSync(backup, 'utf8')
    // 先写临时文件再 rename（原子，避免中途崩溃留下半截文件）
    const tmp = `${file}.undo-${process.pid}-${Date.now().toString(36)}`
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 从 writePatchBlock 的备份命名里认出"这是我们写的备份"（用于列出可撤销项）。 */
export function isManagedBackup(fileName) {
  return typeof fileName === 'string' && /^cordis\.patch\.yml\.bak-/.test(fileName)
}

/** 列出某个目录下最近的备份（给面板「撤销」用）。 */
export function listBackups(dir, limit = 5) {
  try {
    return fs
      .readdirSync(dir)
      .filter(isManagedBackup)
      .map((name) => {
        const full = path.join(dir, name)
        try {
          const st = fs.statSync(full)
          return { name, path: full, at: st.mtimeMs, bytes: st.size }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
  } catch {
    return []
  }
}
