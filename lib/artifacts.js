/**
 * 产物角色判定 + 清单构建（零依赖，node:fs 遍历）。
 *
 * 契约（用户 v0.1 锁定）：
 *   role:final        编译产物 / 报告文档 / 源码变更 / 媒体文件 —— 允许 hub 显式 pull
 *   role:intermediate 日志、临时缓存、中间构建文件 —— 只在副机留存，仅上报元数据
 *   role:other        未命中任何规则 —— 上报元数据，默认不可 pull
 *
 * 判定顺序（先命中先赢，后面的规则不覆盖前面的）：
 *   1. artifactRules.intermediate  显式排除优先（"logs/**" 不该被 "**" 捞成 final）
 *   2. artifactRules.final
 *   3. 内置默认表（按扩展名 / 目录名）
 *   4. 兜底 other
 *
 * 为什么 intermediate 优先：用户明确说"日志、临时缓存、中间构建文件不属于 final"。
 * 如果 final 优先，一条宽松的 `dist/**` 会把 `dist/*.log` 也捞进去。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { compileRules, extname, isAbsolutePath, isInside, matchGlob, normalizePath } from './glob.js'
import { ARTIFACT_KIND, ARTIFACT_ROLE } from './protocol.js'

/** 内置：这些是中间产物，无论在哪。 */
const INTERMEDIATE_EXT = new Set([
  '.log', '.tmp', '.temp', '.cache', '.lock', '.pid', '.swp', '.swo', '.bak',
  // 注意：这里**不含** '.obj' —— 它与 3D 模型格式（Wavefront OBJ）同名。
  // MSVC 的 .obj 中间文件默认落在 obj/ 目录，由 INTERMEDIATE_DIR 的 'obj' 规则覆盖；
  // 而 3D 渲染输出的 .obj 应能作为成品过河（用户契约把「渲染输出」列为 final）。
  // 早期版本把 '.obj' 同时放进 INTERMEDIATE_EXT 与 MEDIA_EXT，因 intermediate 优先，
  // MEDIA_EXT 那行永不生效 —— 一处死代码，也让 3D 模型里唯独 .obj 拿不回来。
  '.map', '.tsbuildinfo', '.pdb', '.ilk', '.exp', '.o', '.a',
  '.pyc', '.pyo', '.class', '.gcda', '.gcno',
])

const INTERMEDIATE_DIR = [
  'node_modules', '.git', '.cache', '.tmp', 'temp', 'tmp',
  '.next', '.nuxt', '.turbo', '.parcel-cache', '.vite', '.rollup.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'obj', 'bin/obj', 'coverage', '.nyc_output', 'target/debug',
  '.dsh-remote-agent',
]

/** 内置：报告文档。 */
const REPORT_EXT = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.md', '.txt', '.csv', '.rtf', '.odt'])

/** 内置：媒体文件。 */
const MEDIA_EXT = new Set([
  // 图片：.tif 与 .tiff 必须都在 —— 同一种格式的两种写法结果要一致
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.tiff', '.tif', '.heic', '.avif',
  // 渲染输出：HDR / EXR / DPX 是「渲染输出」类成品的常见格式
  '.exr', '.hdr', '.dpx',
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.mp3', '.wav', '.flac', '.ogg',
  '.glb', '.gltf', '.fbx', '.obj', '.stl', '.3mf', '.psd', '.ai', '.sketch',
])

/** 内置：编译产物。 */
const BUILD_EXT = new Set([
  '.exe', '.dll', '.so', '.dylib', '.node', '.wasm',
  '.zip', '.7z', '.tar', '.gz', '.tgz', '.rar', '.xz', '.bz2',
  '.msi', '.msix', '.appx', '.deb', '.rpm', '.dmg', '.apk', '.ipa',
  '.jar', '.war', '.whl', '.nupkg', '.snap',
])

/** 内置：源码变更。 */
const DIFF_EXT = new Set(['.diff', '.patch'])

/**
 * 内置：这些目录整体视为「编译产物」= final。
 *
 * 为什么需要它：用户契约把 `dist/**` 明确列为编译产物，但早期实现只按扩展名判定，
 * 于是 `dist/bundle.js`、`dist/style.css` 落到 other —— 前端 / Node 项目最常见的
 * 构建产物反而拿不回来。`dist/**` 此前只在调用方显式传 artifactRules.final 时生效，
 * 内置表本身不认目录。
 *
 * 顺序保证：本规则在内置 intermediate 之后判定，所以 `dist/app.log` 仍判 intermediate。
 * 若某个仓库把 `build/` 当源码目录，用 artifactRules.intermediate 覆盖即可。
 */
const FINAL_DIR = ['dist', 'build', 'out', 'release', 'bundle']

const DEFAULT_INTERMEDIATE_DIRS = INTERMEDIATE_DIR

/**
 * 判定单个条目的角色与种类。
 * @param {string} relPath 相对工作区的规范路径（`/` 分隔）
 * @param {{intermediate?:string[], final?:string[], caseInsensitive?:boolean}} rules
 */
export function classify(relPath, rules = {}) {
  const ci = rules.caseInsensitive === true
  const p = normalizePath(relPath, { caseInsensitive: ci })
  const ext = extname(p)
  const base = p.slice(p.lastIndexOf('/') + 1)

  const inDir = (dirs) => {
    for (const d of dirs) {
      const nd = normalizePath(d, { caseInsensitive: ci })
      if (p === nd || p.startsWith(`${nd}/`)) return true
      // 也匹配路径中间出现的目录名（如 src/node_modules/x）
      if (p.includes(`/${nd}/`)) return true
    }
    return false
  }

  // 1. 显式 intermediate 规则
  if (rules.intermediate?.length) {
    const test = compileRules(rules.intermediate, { caseInsensitive: ci })
    if (test(p)) return { role: ARTIFACT_ROLE.INTERMEDIATE, kind: kindOf(ext, p), reason: 'rule:intermediate' }
  }

  // 2. 内置 intermediate（扩展名 + 目录）
  if (INTERMEDIATE_EXT.has(ext) && !isDiffLike(p)) {
    // `.map` 属于中间；但 `*.diff`/`*.patch` 例外（那是源码变更成品）
    return { role: ARTIFACT_ROLE.INTERMEDIATE, kind: kindOf(ext, p), reason: 'builtin:ext' }
  }
  if (inDir(DEFAULT_INTERMEDIATE_DIRS)) {
    return { role: ARTIFACT_ROLE.INTERMEDIATE, kind: kindOf(ext, p), reason: 'builtin:dir' }
  }

  // 3. 显式 final 规则
  if (rules.final?.length) {
    const test = compileRules(rules.final, { caseInsensitive: ci })
    if (test(p)) return { role: ARTIFACT_ROLE.FINAL, kind: kindOf(ext, p), reason: 'rule:final' }
  }

  // 4. 内置 final 表
  // 先判目录：编译产出目录整体算成品（`dist/**` 是用户契约点名的编译产物）
  if (inDir(FINAL_DIR)) return { role: ARTIFACT_ROLE.FINAL, kind: kindOf(ext, p), reason: 'builtin:final-dir' }
  if (DIFF_EXT.has(ext)) return { role: ARTIFACT_ROLE.FINAL, kind: ARTIFACT_KIND.DIFF, reason: 'builtin:diff' }
  if (BUILD_EXT.has(ext)) return { role: ARTIFACT_ROLE.FINAL, kind: ARTIFACT_KIND.FILE, reason: 'builtin:build' }
  if (REPORT_EXT.has(ext)) return { role: ARTIFACT_ROLE.FINAL, kind: ARTIFACT_KIND.REPORT, reason: 'builtin:report' }
  if (MEDIA_EXT.has(ext)) return { role: ARTIFACT_ROLE.FINAL, kind: ARTIFACT_KIND.MEDIA, reason: 'builtin:media' }

  // 目录本身不判 final（内容由文件逐条判定）
  if (base === '') return { role: ARTIFACT_ROLE.OTHER, kind: ARTIFACT_KIND.DIR, reason: 'dir' }

  return { role: ARTIFACT_ROLE.OTHER, kind: kindOf(ext, p), reason: 'default' }
}

function isDiffLike(p) {
  const ext = extname(p)
  return DIFF_EXT.has(ext)
}

function kindOf(ext, _p) {
  if (DIFF_EXT.has(ext)) return ARTIFACT_KIND.DIFF
  if (REPORT_EXT.has(ext)) return ARTIFACT_KIND.REPORT
  if (MEDIA_EXT.has(ext)) return ARTIFACT_KIND.MEDIA
  if (BUILD_EXT.has(ext)) return ARTIFACT_KIND.FILE
  return ARTIFACT_KIND.FILE
}

/** 单文件 sha256。大文件走流式，不整块读进内存。 */
export function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = fs.createReadStream(absPath)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/** 内容 sha256（用于摘要文本等）。 */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 遍历目录，产出条目列表。
 * 硬约束：
 *   - 不跟随符号链接（避免逃出工作区）
 *   - 遵守 denyPaths
 *   - 有上限（maxEntries / maxScanMs），防止在巨型目录上把任务卡死
 */
export function walk(rootAbs, {
  caseInsensitive = false,
  denyPaths = [],
  maxEntries = 20000,
  maxDepth = 24,
  signal,
  ignoreDirs = DEFAULT_INTERMEDIATE_DIRS,
} = {}) {
  const out = []
  const rootNorm = normalizePath(rootAbs, { caseInsensitive })
  const ignored = ignoreDirs.map((d) => normalizePath(d, { caseInsensitive }))
  const stack = [{ abs: rootAbs, rel: '', depth: 0 }]

  /**
   * denyPaths 的归一化（高危修复）。
   *
   * 历史缺陷：walk 只拿**相对**工作区的 childNorm 去比 denyPaths，而所有真实调用方
   * 传的都是**绝对**路径（node/index.js 传 stateDir、task-engine 传 cfg.denyPaths）。
   * 两者永不相等 → denyPaths 被静默忽略 → 被禁目录里的文件照常进清单，
   * 若命中 final 规则还能被 remote_pull 拉回主机。同一目录写成相对路径却生效，
   * 这种"有时管用"最危险。
   *
   * 修法：把每条 deny 归一成两种形式并都参与比对 ——
   *   ① 相对形式（与 childNorm 同空间）：本身就是相对路径的，或绝对路径落在工作区内的
   *   ② 绝对形式（与 childAbs 同空间）：绝对路径一律保留
   * 两种写法都必须生效，且行为一致。
   */
  const denyRel = []
  const denyAbs = []
  for (const raw of denyPaths ?? []) {
    if (typeof raw !== 'string' || raw === '') continue
    const n = normalizePath(raw, { caseInsensitive })

    if (!isAbsolutePath(raw)) {
      // 相对写法：直接作为相对前缀使用
      denyRel.push(n)
      continue
    }

    // 绝对写法：既保留绝对形式，也尝试换算成工作区内的相对形式
    denyAbs.push(n)
    if (n === rootNorm) return out // 工作区自身被禁 → 整棵树都不扫
    if (isInside(rootNorm, n, { caseInsensitive })) {
      const rel = n.slice(rootNorm.endsWith('/') ? rootNorm.length : rootNorm.length + 1)
      if (rel !== '') denyRel.push(rel)
    }
  }

  const isDeniedEntry = (childAbs, childNorm) => {
    for (const d of denyRel) {
      if (childNorm === d || childNorm.startsWith(`${d}/`)) return true
    }
    if (denyAbs.length > 0) {
      const absNorm = normalizePath(childAbs, { caseInsensitive })
      for (const d of denyAbs) {
        if (absNorm === d || absNorm.startsWith(`${d}/`)) return true
      }
    }
    return false
  }

  while (stack.length > 0) {
    if (signal?.aborted) break
    if (out.length >= maxEntries) break
    const cur = stack.pop()
    if (cur.depth > maxDepth) continue

    let entries
    try {
      entries = fs.readdirSync(cur.abs, { withFileTypes: true })
    } catch {
      continue
    }

    for (const e of entries) {
      if (out.length >= maxEntries) break
      const childAbs = path.join(cur.abs, e.name)
      const childRel = cur.rel === '' ? e.name : `${cur.rel}/${e.name}`
      const childNorm = normalizePath(childRel, { caseInsensitive })

      if (isDeniedEntry(childAbs, childNorm)) continue

      // 不跟随符号链接：只信 Dirent 的 isSymbolicLink
      if (e.isSymbolicLink()) continue

      if (e.isDirectory()) {
        if (ignored.some((d) => childNorm === d || childNorm.startsWith(`${d}/`) || childNorm.endsWith(`/${d}`))) continue
        stack.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 })
        continue
      }

      if (!e.isFile()) continue

      let st
      try {
        st = fs.statSync(childAbs)
      } catch {
        continue
      }

      out.push({
        rel: childNorm,
        abs: childAbs,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        root: rootNorm,
      })
    }
  }

  return out
}

/**
 * 构建 manifest。
 * @param {object} o
 * @param {string} o.workspace 绝对工作区
 * @param {string[]} [o.outputs] 需要纳入清单的 glob（相对工作区）
 * @param {object} [o.artifactRules] { final:[], intermediate:[] }
 * @param {boolean} [o.caseInsensitive]
 * @param {string[]} [o.denyPaths]
 * @param {boolean} [o.includeOther] 是否把 other 也纳入清单（默认 true，只报元数据）
 * @param {boolean} [o.hashFinal] 是否对 final 计算 sha256（默认 true）
 */
export async function buildManifest(o) {
  const {
    workspace,
    outputs,
    artifactRules = {},
    caseInsensitive = false,
    denyPaths = [],
    includeOther = true,
    hashFinal = true,
    signal,
    maxEntries = 20000,
  } = o

  const files = walk(workspace, { caseInsensitive, denyPaths, signal, maxEntries })
  const outputsTest = outputs?.length
    ? compileRules(outputs, { caseInsensitive, base: '' })
    : null

  const items = []
  let totalFinal = 0
  let totalIntermediate = 0
  let totalOther = 0
  let bytesFinal = 0

  for (const f of files) {
    if (signal?.aborted) break
    if (outputsTest && !outputsTest(f.rel)) continue

    const cls = classify(f.rel, { ...artifactRules, caseInsensitive })
    if (cls.role === ARTIFACT_ROLE.OTHER && !includeOther) continue

    const item = {
      path: f.rel,
      role: cls.role,
      kind: cls.kind,
      bytes: f.bytes,
      mtimeMs: Math.round(f.mtimeMs),
      reason: cls.reason,
    }

    if (cls.role === ARTIFACT_ROLE.FINAL) {
      totalFinal += 1
      bytesFinal += f.bytes
      if (hashFinal) {
        try {
          item.sha256 = await hashFile(f.abs)
        } catch {
          item.sha256 = undefined
          item.hashError = true
        }
      }
    } else if (cls.role === ARTIFACT_ROLE.INTERMEDIATE) {
      totalIntermediate += 1
    } else {
      totalOther += 1
    }

    items.push(item)
  }

  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    workspace: normalizePath(workspace, { caseInsensitive }),
    generatedAt: Date.now(),
    counts: {
      total: items.length,
      final: totalFinal,
      intermediate: totalIntermediate,
      other: totalOther,
    },
    bytesFinal,
    items,
  }
}

/**
 * 校验一个 pull 请求是否被允许。
 * v0.1 策略：只允许 role:final，且必须命中 denyPaths 之外、大小在上限内。
 *
 * denyPaths 同样要兼容「绝对」与「相对工作区」两种写法 —— 见 walk 里的高危修复说明。
 * 这里没有工作区绝对路径可用来做归一，所以采用保守策略：
 *   任何 deny 条目，只要它等于 item.path、是 item.path 的前缀、或被 item.path 包含，
 *   一律拒绝。宁可多拒一个合法产物（用户会看到明确的 artifact-denied），
 *   也不能漏放一个被禁文件过河。
 */
export function authorizePull(manifest, relPath, { caseInsensitive = false, maxBytes = 512 * 1024 * 1024, denyPaths = [] } = {}) {
  const want = normalizePath(relPath, { caseInsensitive })
  const item = manifest.items.find((i) => normalizePath(i.path, { caseInsensitive }) === want)
  if (!item) return { ok: false, code: 'artifact-missing', message: `not in manifest: ${relPath}` }
  if (item.role !== ARTIFACT_ROLE.FINAL) {
    return {
      ok: false,
      code: 'artifact-denied',
      message: `role=${item.role} is not pullable in v0.1 (only role:final crosses the wire)`,
    }
  }

  const itemNorm = normalizePath(item.path, { caseInsensitive })
  const denied = (denyPaths ?? []).some((d) => {
    if (typeof d !== 'string' || d === '') return false
    const dn = normalizePath(d, { caseInsensitive })
    // deny 是 item 的祖先（同一路径空间）
    if (isInside(dn, itemNorm, { caseInsensitive })) return true
    // item 是 deny 的祖先（禁了整个目录，item 在其下）
    if (isInside(itemNorm, dn, { caseInsensitive })) return true
    if (dn === itemNorm) return true

    // 跨路径空间（deny 绝对、item 相对，或反之）：无法直接比较，改用路径段判定。
    //
    // 规则：把 deny 拆成路径段，取它的**每一个后缀**，只要其中某个后缀恰好是
    // item 段序列的**前缀**，就判定命中。
    //   deny …/work/secret          item secret/token.md
    //     → deny 的后缀 ['secret'] 是 item 的前缀 → 命中 ✓
    //   deny …/work/secret/token.md item secret/token.md
    //     → deny 的后缀 ['secret','token.md'] 等于 item → 命中 ✓
    //   deny …/work/src             item app.exe
    //     → 无后缀匹配（'src' ≠ 'app.exe'）→ 不命中 ✓
    //
    // 这是**保守**方向：deny 指向另一棵树但基名巧合相同时会误拒（例如
    // deny=d:/unrelated/secret 与 item=secret/x）。这是刻意的取舍 ——
    // 宁可多拒一个合法产物（用户看到明确的 artifact-denied），
    // 也不能漏放一个被禁文件过河。
    const dSegs = dn.split('/').filter(Boolean)
    const iSegs = itemNorm.split('/').filter(Boolean)
    if (dSegs.length === 0 || iSegs.length === 0) return false
    for (let start = 0; start < dSegs.length; start += 1) {
      const suffix = dSegs.slice(start)
      if (suffix.length > iSegs.length) continue
      let same = true
      for (let i = 0; i < suffix.length; i += 1) {
        if (suffix[i] !== iSegs[i]) { same = false; break }
      }
      if (same) return true
    }
    return false
  })
  if (denied) {
    return { ok: false, code: 'artifact-denied', message: `path denied: ${relPath}` }
  }

  if (item.bytes > maxBytes) {
    return { ok: false, code: 'artifact-too-large', message: `${item.bytes} bytes exceeds maxBytes=${maxBytes}` }
  }
  return { ok: true, item }
}

/** 判断一个路径是否命中 outputs 集合（用于 hub 侧二次过滤）。 */
export function matchesOutputs(relPath, outputs, opts = {}) {
  if (!outputs || outputs.length === 0) return true
  return matchGlob(relPath, outputs, opts)
}
