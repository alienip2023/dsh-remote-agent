#!/usr/bin/env node
/**
 * 打包自洽性检查：`package.json` 的 `files` / `exports` / `bin` / `dsh.bundle.patch`
 * 指向的路径必须**真实存在**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这条
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 本包没有构建步骤：`lib/**` 就是 DSH 实际加载的产物。所以"文件是否在包里"
 * 完全由 `package.json` 的 `files` 字段与 git 追踪状态决定 —— 而这两个地方
 * 都容易漏：
 *
 *   - 新增一个 `lib/foo.js` 但忘了加进 `files` → 从 git 装的人拿到一个缺文件的包
 *   - `exports` 里写了一个已删除的路径 → `import 'dsh-remote-agent/hub'` 报错
 *   - `dsh.bundle.patch` 指向不存在的 yml → loader 读不到 patch，插件行永不插入
 *     （**这是 v0.1 的一个真实 blocker**，由独立验证发现）
 *
 * 这些错误在开发机上都不会暴露（本地有完整目录树），只有用户安装时才炸。
 * 所以必须在 CI 里挡。
 *
 * 退出码：0 = 全部一致；1 = 有缺失（打印每一条）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const pkgPath = path.join(ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

/** 把 glob 简化成"存在性检查"：只处理 `dir` 与 `dir/**` 两种形态。 */
const exists = (rel) => {
  const abs = path.join(ROOT, rel)
  return fs.existsSync(abs)
}

const problems = []
const notes = []

// ── 1) files 字段 ────────────────────────────────────────────────────────────
const files = Array.isArray(pkg.files) ? pkg.files : []
if (files.length === 0) {
  problems.push('package.json 没有 files 字段 —— 从 git 安装会带上一堆无关文件')
} else {
  for (const f of files) {
    // files 里的条目可以是目录或文件；不接受 glob（npm 的 files 也不支持 ** 语义）
    if (!exists(f)) problems.push(`files 里的路径不存在: ${f}`)
  }
  notes.push(`files: ${files.length} 项，全部存在`)
}

// ── 2) exports ───────────────────────────────────────────────────────────────
const exportsMap = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {}
for (const [key, target] of Object.entries(exportsMap)) {
  // 目标可以是字符串或条件对象
  const targets = typeof target === 'string' ? [target] : Object.values(target ?? {})
  for (const t of targets) {
    if (typeof t !== 'string') continue
    if (!exists(t)) problems.push(`exports["${key}"] 指向不存在的路径: ${t}`)
  }
}
notes.push(`exports: ${Object.keys(exportsMap).length} 项`)

// ── 3) main / bin ────────────────────────────────────────────────────────────
if (typeof pkg.main === 'string' && !exists(pkg.main)) {
  problems.push(`main 指向不存在的路径: ${pkg.main}`)
}
for (const [name, target] of Object.entries(pkg.bin ?? {})) {
  if (!exists(target)) problems.push(`bin["${name}"] 指向不存在的路径: ${target}`)
}

// ── 3b) 发布清单里的文件名必须全是 ASCII ─────────────────────────────────────
//
// npm 打包成 **tar 归档**，而 tar 层的文件名编码不可靠：非 ASCII 名字解压后
// 会变成乱码。这不是理论问题 —— 0.4.0 实际发布出去的 tarball 里躺着
//
//     package/bin/˫������-������.cmd
//
// 原名是 `双击运行-配置向导.cmd`（NTFS 上完全正常，问题只在 tar 层）。
// 结果：Windows 用户解压后看到一个乱码文件，双击入口等于不存在。
//
// 所以这里扫一遍 `files` 列出的每个目录，任何非 ASCII 文件名都算问题。
{
  const ascii = /^[\x20-\x7E]+$/
  const scan = (relDir, out = []) => {
    const abs = path.join(ROOT, relDir)
    if (!fs.existsSync(abs)) return out
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const rel = path.posix.join(relDir.replace(/\\/g, '/'), e.name)
      if (!ascii.test(e.name)) out.push(rel)
      if (e.isDirectory()) scan(rel, out)
    }
    return out
  }
  const bad = []
  for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
    const abs = path.join(ROOT, entry)
    if (!fs.existsSync(abs)) continue
    if (fs.statSync(abs).isDirectory()) scan(entry, bad)
    else if (!ascii.test(path.basename(entry))) bad.push(entry)
  }
  if (bad.length > 0) {
    problems.push(
      `发布清单里有 ${bad.length} 个非 ASCII 文件名（npm 打成 tar 后必然乱码）：\n`
      + bad.map((b) => `      ${b}`).join('\n'),
    )
  } else {
    notes.push('files 清单里的文件名全是 ASCII（tar 编码安全）')
  }
}

// ── 4) dsh.bundle.patch（DSH 专用：loader 靠它插入插件行）────────────────────
const patch = pkg.dsh?.bundle?.patch
if (typeof patch !== 'string') {
  problems.push('dsh.bundle.patch 缺失 —— loader 读不到 patch，插件行永不插入')
} else if (!exists(patch)) {
  problems.push(`dsh.bundle.patch 指向不存在的路径: ${patch}`)
} else {
  // patch 必须真的是一条 insert（不能是空文件）
  const body = fs.readFileSync(path.join(ROOT, patch), 'utf8')
  if (!/insert:/.test(body)) {
    problems.push(`dsh.bundle.patch (${patch}) 里没有 insert: —— loader 不会插入任何行`)
  }
  if (!/dsh-remote-agent/.test(body)) {
    problems.push(`dsh.bundle.patch (${patch}) 里没有引用 dsh-remote-agent`)
  }
  notes.push(`dsh.bundle.patch: ${patch}（含 insert）`)
}

// ── 5) dsh.client 声明 ───────────────────────────────────────────────────────
if (!pkg.dsh?.client) {
  problems.push('dsh.client 缺失 —— Web 面板不会加载')
} else {
  if (pkg.dsh.client.platform !== 'web') {
    problems.push(`dsh.client.platform 应为 "web"，实际 ${JSON.stringify(pkg.dsh.client.platform)}`)
  }
  // client 半边必须真实存在
  const clientEntry = pkg.exports?.['./client']
  if (typeof clientEntry === 'string' && !exists(clientEntry)) {
    problems.push(`dsh.client 声明了 web 半边，但 exports["./client"] 指向的文件不存在`)
  }
}

// ── 6) scripts 引用的脚本文件 ────────────────────────────────────────────────
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  // 只检查 `node scripts/xxx.mjs` 这种直接形态
  const m = /^node\s+(scripts\/[\w.-]+)/.exec(cmd)
  if (m && !exists(m[1])) {
    problems.push(`scripts["${name}"] 引用了不存在的文件: ${m[1]}`)
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
console.log('打包自洽性检查')
console.log('─'.repeat(60))
for (const n of notes) console.log(`  ✓ ${n}`)

if (problems.length === 0) {
  console.log('─'.repeat(60))
  console.log(`  ✓ 全部一致（${notes.length} 项通过）`)
  process.exit(0)
}

console.log('─'.repeat(60))
console.log(`  ✗ 发现 ${problems.length} 个问题：`)
for (const p of problems) console.log(`    - ${p}`)
process.exit(1)
