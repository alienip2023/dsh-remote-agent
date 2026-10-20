/**
 * 远程文件工具集（提案 #25）的副机本地实现 —— 四个只读操作：
 *   ls / read / grep / tree
 *
 * 安全模型（与任务链路同一条底线，缺一不可）：
 *  - **只读**。整个模块没有任何写路径 —— fs-service 拿不到"写"这个动词。
 *  - **roots 边界**：每个入口路径先 realpathSync.native（展开 8.3 短名与符号
 *    链接，与 exec.js resolveWorkspace 同款口径），再与 roots 前缀比对。
 *  - **denyPaths 生效**：isDenied 与 artifacts.js / task-engine 同一条规则，
 *    被禁路径在枚举与读取两层都被拦（枚举层拦是为了连名字都不上报）。
 *  - **符号链接不跟随**：tree/grep 遍历时 withFileTypes 发现的链接只列条目
 *    本身、绝不深入 —— 否则 roots 内一个指向 C:\Users 的链接就是逃逸口。
 *
 * 上限（防御 50GB 级文件夹被一次请求拖死副机）：
 *  - read：文本模式仅支持 ≤ READABLE_FILE_MAX (8MB) 的文件按行分段；二进制
 *    只回 sha256/size/头部预览；单次响应文本量 ≤ READ_TEXT_MAX (256KB)。
 *  - grep：文件数 ≤ GREP_MAX_FILES (2000)、单文件 ≤ GREP_FILE_MAX (2MB)、
 *    命中 ≤ maxMatches (200)、总时长 ≤ GREP_TIME_MS (10s)。
 *  - tree：深度 ≤ depth、总条目 ≤ maxEntries (2000)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDenied } from './exec.js'
import { normalizePath, extname } from '../glob.js'
import { ERROR_CODE } from '../protocol.js'

/** 文本模式 read 的文件大小上限：超过就拒绝（建议 grep 定位后再读片段）。 */
export const READABLE_FILE_MAX = 8 * 1024 * 1024
/** 单次 read 响应携带的文本量上限（字节）。 */
export const READ_TEXT_MAX = 256 * 1024
/** grep 递归扫描的文件数上限。 */
export const GREP_MAX_FILES = 2000
/** grep 单文件大小上限：更大的文件直接跳过（防止二进制/巨型日志拖死）。 */
export const GREP_FILE_MAX = 2 * 1024 * 1024
/** grep 默认总时长上限（ms）：超时停下并如实报告 truncated。 */
export const GREP_TIME_MS = 10 * 1000
/** grep 默认命中上限。 */
export const GREP_MAX_MATCHES = 200
/** tree 默认最大深度与条目数。 */
export const TREE_DEFAULT_DEPTH = 3
export const TREE_MAX_ENTRIES = 2000
/** ls 单页条目上限。 */
export const LS_PAGE_MAX = 2000
/**
 * 单次 write 的内容上限（2026-10-20）。
 *
 * 为什么要有：写操作是本插件第二个主动放宽边界的能力。没有上限的话，
 * 一次 `remote_write` 就能把副机磁盘写满 —— 而副机是常驻进程，
 * 磁盘满会让任务、日志、状态文件全部失败。
 *
 * 8MB 与 `READABLE_FILE_MAX` 同量级：能覆盖绝大多数配置文件/脚本/文档，
 * 又不至于一次写爆磁盘。
 */
export const WRITE_MAX_BYTES = 8 * 1024 * 1024
/** 二进制嗅探窗口：前 64 字节出现 NUL 即视为二进制。 */
const SNIFF_BYTES = 64

/** 复用任务链路的错误形态（code 会被 hub 工具层原样透出）。 */
export class FsError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'FsError'
    this.code = code
  }
}

/**
 * 解析**待写入**的路径（2026-10-20，写操作专用）。
 *
 * 与 `resolveAny` 的关键区别：**目标可以不存在**。
 *
 * ── 为什么不能用 resolveAny ─────────────────────────────────────────────
 *
 * `resolveAny` 先 `realpathSync(requested)` —— 那要求路径已经存在。
 * 只读工具这样做是对的（"读一个不存在的文件没有借口"），但写操作的目标
 * **本来就是要新建的**，用同一套解析会让 `remote_write` 100% 失败。
 * （第一版就是这么写的，实测立刻暴露：`path not found: .../a.txt`。）
 *
 * ── 安全怎么做 ──────────────────────────────────────────────────────────
 *
 * 目标不存在 → 从它**向上找到第一个存在的祖先**，对那个祖先做 realpath，
 * 再校验它在 roots 内。这样：
 *   · `D:\work\new.txt`（不存在）→ 校验 `D:\work` 在 roots 内 → 允许
 *   · `D:\work\link\to\outside.txt`（link 指向 roots 外）→ 祖先 realpath
 *     解析到 roots 外 → 拒绝
 *   · `D:\etc\passwd` → 祖先 `D:\etc` 不在 roots 内 → 拒绝
 *
 * 目标**已存在** → 直接用 realpath（与只读工具同口径，防软链逃逸）。
 *
 * @param {string} requested 绝对路径
 * @param {object} cfg { roots, caseInsensitive, denyPaths }
 * @returns {string} 规范化后的绝对路径（可能是尚不存在的路径）
 */
function resolveWritable(requested, cfg) {
  const { roots, caseInsensitive } = cfg
  if (typeof requested !== 'string' || requested === '') {
    throw new FsError('path is required', ERROR_CODE.WORKSPACE_DENIED)
  }
  if (!path.isAbsolute(requested)) {
    throw new FsError(`path must be absolute: ${requested}`, ERROR_CODE.WORKSPACE_DENIED)
  }
  // denyPaths 先查原始形态（防"通过不存在的路径绕过 denyPaths"）
  if (entryDenied(requested, cfg)) {
    throw new FsError(`path denied: ${requested}`, ERROR_CODE.WORKSPACE_DENIED)
  }

  const real = (p) => (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p))

  let checkPath
  if (fs.existsSync(requested)) {
    // 已存在：走 realpath（与只读同口径，能识破软链逃逸）
    try {
      checkPath = real(requested)
    } catch {
      throw new FsError(`cannot resolve path: ${requested}`, ERROR_CODE.WORKSPACE_DENIED)
    }
  } else {
    // 不存在：向上找第一个存在的祖先，对它 realpath，再把剩余段接回去
    let probe = path.dirname(requested)
    const tail = [path.basename(requested)]
    // 上限 64 层，防止异常深的路径拖慢
    for (let i = 0; i < 64; i += 1) {
      if (fs.existsSync(probe)) break
      const parent = path.dirname(probe)
      if (parent === probe) {
        throw new FsError(`no existing ancestor for: ${requested}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      tail.unshift(path.basename(probe))
      probe = parent
    }
    let probeReal
    try {
      probeReal = real(probe)
    } catch {
      throw new FsError(`cannot resolve ancestor: ${probe}`, ERROR_CODE.WORKSPACE_DENIED)
    }
    checkPath = path.join(probeReal, ...tail)
  }

  const allowed = (roots ?? []).map((r) => {
    let base = r
    try {
      base = real(r)
    } catch {
      // 与 resolveWorkspace 同口径：不可达的根保持原样，后面照样拒一切子路径
    }
    return normalizePath(base, { caseInsensitive })
  })
  const norm = normalizePath(checkPath, { caseInsensitive })
  const ok = allowed.some((r) => norm === r || norm.startsWith(`${r}/`))
  if (!ok) {
    throw new FsError(
      `path outside allowed roots: ${checkPath}`,
      ERROR_CODE.WORKSPACE_DENIED,
    )
  }
  return checkPath
}

/**
 * 解析"可以是文件也可以是目录"的路径：realpath + roots 前缀 + denyPaths。
 * 与 resolveWorkspace 的差异只在两点：不要求是目录；不存在时直接拒
 * （读一个不存在的文件没有"任务会创建它"的借口）。
 */
function resolveAny(requested, cfg) {
  const { roots, caseInsensitive } = cfg
  if (typeof requested !== 'string' || requested === '') {
    throw new FsError('path is required', ERROR_CODE.WORKSPACE_DENIED)
  }
  if (!path.isAbsolute(requested)) {
    throw new FsError(`path must be absolute: ${requested}`, ERROR_CODE.WORKSPACE_DENIED)
  }
  let resolved
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(requested) : fs.realpathSync(requested)
  } catch {
    throw new FsError(`path not found: ${requested}`, ERROR_CODE.ARTIFACT_MISSING)
  }
  const allowed = (roots ?? []).map((r) => {
    let base = r
    try {
      base = fs.realpathSync.native ? fs.realpathSync.native(r) : fs.realpathSync(r)
    } catch {
      // 与 resolveWorkspace 同口径：不可达的根保持原样，后面照样拒一切子路径
    }
    return normalizePath(base, { caseInsensitive })
  })
  const norm = normalizePath(resolved, { caseInsensitive })
  const ok = allowed.some((r) => norm === r || norm.startsWith(`${r}/`))
  if (!ok) {
    throw new FsError(
      `path outside allowed roots: ${resolved}`,
      ERROR_CODE.WORKSPACE_DENIED,
    )
  }
  if (isDenied(resolved, cfg.denyPaths ?? [], { caseInsensitive })) {
    throw new FsError(`path denied by denyPaths: ${resolved}`, ERROR_CODE.WORKSPACE_DENIED)
  }
  return resolved
}

/** 枚举层拒绝：条目级 denyPaths（连名字都不上报给 hub）。 */
function entryDenied(absPath, cfg) {
  return isDenied(absPath, cfg.denyPaths ?? [], { caseInsensitive: cfg.caseInsensitive })
}

/** 目录条目排序：目录优先，同级按名字（locale 感知，大小写不敏感）。 */
function sortEntries(list) {
  return list.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })
}

/** 文件是否疑似二进制：前 SNIFF_BYTES 字节出现 NUL。 */
function looksBinary(fd) {
  const buf = Buffer.alloc(SNIFF_BYTES)
  // ⚠ fs.readSync 直接返回 bytesRead 数字（不是 {bytesRead, buffer} 对象 ——
  // 那是 fs.read 的 promise 版）。解构会得到 undefined，subarray(0, undefined)
  // 变成整个缓冲，而 alloc 未写区域全零 → **任何文件都被误判二进制**。
  const bytesRead = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0)
  return buf.subarray(0, bytesRead).includes(0)
}

/**
 * 建一个 fs-service 实例。roots/denyPaths 来自副机配置（与任务链路同源），
 * caseInsensitive 跟随 Windows 语义。
 */
export function createFsService(cfg) {
  const { roots, caseInsensitive = false } = cfg
  const conf = { roots, caseInsensitive, denyPaths: cfg.denyPaths ?? [] }

  return {
    /** 列目录（单层，分页）。 */
    ls({ path: p, limit = 500, offset = 0 } = {}) {
      const dir = resolveAny(p, conf)
      let st
      try {
        st = fs.statSync(dir)
      } catch {
        throw new FsError(`path not found: ${dir}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      if (!st.isDirectory()) {
        throw new FsError(`not a directory: ${dir}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      const limitN = Math.min(Math.max(Number(limit) || 500, 1), LS_PAGE_MAX)
      const offsetN = Math.max(Number(offset) || 0, 0)
      const all = []
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name)
        if (entryDenied(abs, conf)) continue
        let type = 'file'
        let size = 0
        let mtimeMs = 0
        if (ent.isSymbolicLink()) {
          // 链接只报条目本身，不深入也不解引用 —— 防止 roots 内链接逃逸
          type = 'link'
        } else if (ent.isDirectory()) {
          type = 'dir'
        } else if (ent.isFile()) {
          try {
            const s = fs.statSync(abs)
            size = s.size
            mtimeMs = s.mtimeMs
          } catch {
            // 竞态（文件刚被删）：仍上报名字，大小/时间留空
          }
        } else {
          continue // socket/fifo 等非常规条目不上报
        }
        all.push({ name: ent.name, type, size, mtimeMs })
      }
      sortEntries(all)
      return {
        path: dir,
        total: all.length,
        offset: offsetN,
        truncated: offsetN + limitN < all.length,
        entries: all.slice(offsetN, offsetN + limitN),
      }
    },

    /**
     * 读文件。文本模式：≤ READABLE_FILE_MAX 的文件按行分段（offset/limit），
     * 单次文本量 ≤ READ_TEXT_MAX；二进制模式：只回 sha256/size/头部预览。
     */
    read({ path: p, offset = 0, limit = 500 } = {}) {
      const file = resolveWritable(p, conf)
      let st
      try {
        st = fs.statSync(file)
      } catch {
        throw new FsError(`path not found: ${file}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      if (!st.isFile()) {
        throw new FsError(`not a regular file: ${file}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      let fd
      try {
        fd = fs.openSync(file, 'r')
        if (looksBinary(fd)) {
          // 二进制：hash 全文件 + 头部预览（hex），绝不回原始字节
          const buf = Buffer.alloc(Math.min(st.size, SNIFF_BYTES))
          fs.readSync(fd, buf, 0, buf.length, 0)
          const hash = createHash('sha256')
          const chunk = Buffer.alloc(1024 * 1024)
          for (;;) {
            const n = fs.readSync(fd, chunk, 0, chunk.length, null)
            if (n <= 0) break
            hash.update(chunk.subarray(0, n))
          }
          return {
            path: file,
            binary: true,
            size: st.size,
            sha256: hash.digest('hex'),
            ext: extname(normalizePath(file, { caseInsensitive })),
            head: buf.toString('hex'),
          }
        }
        if (st.size > READABLE_FILE_MAX) {
          throw new FsError(
            `file too large for text read (${st.size} > ${READABLE_FILE_MAX}); use grep to locate then read a narrower path`,
            ERROR_CODE.ARTIFACT_TOO_LARGE,
          )
        }
        const raw = fs.readFileSync(file)
        const text = raw.toString('utf8')
        const lines = text.split('\n')
        // 尾部空行是 split 的伪影：文件以 \n 结尾时多出一个空串
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        const offsetN = Math.max(Number(offset) || 0, 0)
        const limitN = Math.min(Math.max(Number(limit) || 500, 1), 5000)
        const slice = []
        let bytes = 0
        let truncated = false
        for (let i = offsetN; i < lines.length; i++) {
          const line = lines[i]
          // 单行超长截断：一行 1MB 的压缩 JSON 会独自顶爆响应
          const clipped = line.length > 2000 ? `${line.slice(0, 2000)}…[line truncated]` : line
          const cost = Buffer.byteLength(clipped, 'utf8') + 1
          if (bytes + cost > READ_TEXT_MAX) {
            truncated = true
            break
          }
          slice.push(clipped)
          bytes += cost
          if (slice.length >= limitN) {
            truncated = i < lines.length - 1
            break
          }
        }
        return {
          path: file,
          binary: false,
          size: st.size,
          totalLines: lines.length,
          offset: offsetN,
          truncated: truncated || offsetN + slice.length < lines.length,
          lines: slice,
        }
      } finally {
        try {
          if (fd !== undefined) fs.closeSync(fd)
        } catch {
          // 关闭失败不影响结果
        }
      }
    },

    /**
     * 副机本地全文搜索：递归扫 roots 内目录，文本文件逐行匹配。
     * 纯 JS（Windows 没有外部 grep 可 spawn）；上限见模块头注释。
     */
    grep({ path: p, pattern, regex = false, ignoreCase = true, glob = '', maxMatches = GREP_MAX_MATCHES } = {}) {
      if (typeof pattern !== 'string' || pattern === '') {
        throw new FsError('pattern is required', ERROR_CODE.WORKSPACE_DENIED)
      }
      let re
      try {
        re = regex
          ? new RegExp(pattern, ignoreCase ? 'i' : '')
          : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '')
      } catch (err) {
        throw new FsError(`invalid pattern: ${err.message}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      const dir = resolveAny(p, conf)
      let st
      try {
        st = fs.statSync(dir)
      } catch {
        throw new FsError(`path not found: ${dir}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      const maxN = Math.min(Math.max(Number(maxMatches) || GREP_MAX_MATCHES, 1), GREP_MAX_MATCHES)
      const matches = []
      let filesScanned = 0
      let filesSkipped = 0
      let truncatedByTime = false
      let truncatedByLimit = false
      const started = Date.now()

      const isGlobMatch = (name) => {
        if (!glob) return true
        // 极简 glob：* 任意（不含 /）、? 单字符 —— 覆盖 *.txt / src* 之类
        const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
        return new RegExp(`^${esc}$`, caseInsensitive ? 'i' : '').test(name)
      }

      const scan = (dirAbs) => {
        if (matches.length >= maxN) {
          truncatedByLimit = true
          return
        }
        if (Date.now() - started > GREP_TIME_MS) {
          truncatedByTime = true
          return
        }
        let ents
        try {
          ents = fs.readdirSync(dirAbs, { withFileTypes: true })
        } catch {
          filesSkipped++
          return
        }
        for (const ent of ents) {
          if (matches.length >= maxN) {
            truncatedByLimit = true
            return
          }
          if (Date.now() - started > GREP_TIME_MS) {
            truncatedByTime = true
            return
          }
          const abs = path.join(dirAbs, ent.name)
          if (entryDenied(abs, conf)) continue
          if (ent.isDirectory()) {
            scan(abs)
            continue
          }
          // 链接与非常规文件跳过：不跟随、不读
          if (!ent.isFile()) {
            filesSkipped++
            continue
          }
          if (!isGlobMatch(ent.name)) continue
          let fst
          try {
            fst = fs.statSync(abs)
          } catch {
            filesSkipped++
            continue
          }
          if (fst.size > GREP_FILE_MAX || fst.size === 0) {
            filesSkipped++
            continue
          }
          let fd
          try {
            fd = fs.openSync(abs, 'r')
            if (looksBinary(fd)) {
              filesSkipped++
              continue
            }
            const content = fs.readFileSync(abs)
            filesScanned++
            const text = content.toString('utf8')
            const lines = text.split('\n')
            for (let i = 0; i < lines.length && matches.length < maxN; i++) {
              if (re.test(lines[i])) {
                matches.push({
                  file: abs,
                  line: i + 1,
                  text: lines[i].length > 500 ? `${lines[i].slice(0, 500)}…` : lines[i],
                })
                // 达到全局上限即如实报告截断 —— 即使恰好在最后一个文件结束，
                // 未报出的命中大概率还存在（用户视角"还有更多"才是事实）
                if (matches.length >= maxN) truncatedByLimit = true
              }
            }
          } catch {
            filesSkipped++
          } finally {
            try {
              if (fd !== undefined) fs.closeSync(fd)
            } catch {
              // 忽略关闭失败
            }
          }
        }
      }

      if (st.isDirectory()) {
        scan(dir)
      } else if (st.isFile()) {
        // 单文件 grep：直接匹配该文件。
        //
        // ⚠ 必须有大小护栏（2026-10-17 修）。目录扫描路径有 `GREP_FILE_MAX`
        // （2MB）与 `GREP_TIME_MS`（10s）双护栏，但**这个分支原来什么都没查**：
        // 直接 `readFileSync` 全文。触发形态是 `remote_grep` 的 path 指向工作区
        // 内一个巨大文本文件（应用日志 / 数据库转储 / core dump）：
        //
        //   · 巨文件整体进内存 → 副机 OOM（副机是常驻进程，OOM 即全部任务中断）
        //   · `readFileSync` 同步阻塞事件循环 → 期间 ws 帧、心跳、其他任务的
        //     输出全部停摆
        //
        // 而且这条路径是**可达的**：agent 会自主选择 grep 目标。属于 DoS 面。
        //
        // 现在与扫描路径同口径：超 `GREP_FILE_MAX` 就跳过并计入 filesSkipped
        // （而不是静默读爆内存，也不是报错中断整个 grep —— 用户可能只是想
        // 在目录里搜，其中恰好有个大文件）。
        let fd
        try {
          fd = fs.openSync(dir, 'r')
          if (st.size > GREP_FILE_MAX) {
            // 跳过超大文件，与目录扫描分支的判定一致（那边也是跳过不报错）
            filesSkipped++
          } else if (!looksBinary(fd)) {
            filesScanned++
            const lines = fs.readFileSync(dir).toString('utf8').split('\n')
            for (let i = 0; i < lines.length && matches.length < maxN; i++) {
              if (re.test(lines[i])) {
                matches.push({ file: dir, line: i + 1, text: lines[i].slice(0, 500) })
              }
            }
          }
        } catch {
          filesSkipped++
        } finally {
          try {
            if (fd !== undefined) fs.closeSync(fd)
          } catch {
            // 忽略
          }
        }
      } else {
        throw new FsError(`not a directory or file: ${dir}`, ERROR_CODE.WORKSPACE_DENIED)
      }

      return {
        path: dir,
        pattern,
        filesScanned,
        filesSkipped,
        matches,
        matchCount: matches.length,
        truncated: truncatedByTime || truncatedByLimit,
        truncatedBy: truncatedByTime ? 'time' : truncatedByLimit ? 'maxMatches' : undefined,
      }
    },

    /** 目录树摘要：扫描在副机跑完只回结构（50GB 也不搬家）。 */
    tree({ path: p, depth = TREE_DEFAULT_DEPTH, maxEntries = TREE_MAX_ENTRIES } = {}) {
      const rootDir = resolveAny(p, conf)
      let st
      try {
        st = fs.statSync(rootDir)
      } catch {
        throw new FsError(`path not found: ${rootDir}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      if (!st.isDirectory()) {
        throw new FsError(`not a directory: ${rootDir}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      const depthN = Math.min(Math.max(Number(depth) || TREE_DEFAULT_DEPTH, 1), 6)
      const maxN = Math.min(Math.max(Number(maxEntries) || TREE_MAX_ENTRIES, 1), TREE_MAX_ENTRIES)
      let used = 0
      let truncated = false

      const build = (dirAbs, level) => {
        if (level > depthN || used >= maxN) {
          if (used >= maxN) truncated = true
          return []
        }
        let ents
        try {
          ents = fs.readdirSync(dirAbs, { withFileTypes: true })
        } catch {
          return [{ name: '(unreadable)', type: 'error' }]
        }
        const items = []
        const dirs = []
        const files = []
        for (const ent of ents) {
          const abs = path.join(dirAbs, ent.name)
          if (entryDenied(abs, conf)) continue
          if (ent.isDirectory()) dirs.push(ent.name)
          else if (ent.isFile()) files.push(ent.name)
          // 链接只报名字标注 link，不深入（与 ls 同口径）
          else if (ent.isSymbolicLink()) files.push(ent.name)
        }
        const collator = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
        dirs.sort(collator)
        files.sort(collator)
        for (const name of dirs) {
          if (used >= maxN) {
            truncated = true
            break
          }
          used++
          const node = { name, type: 'dir', children: build(path.join(dirAbs, name), level + 1) }
          items.push(node)
        }
        for (const name of files) {
          if (used >= maxN) {
            truncated = true
            break
          }
          used++
          items.push({ name, type: 'file' })
        }
        return items
      }

      const items = build(rootDir, 1)
      return {
        path: rootDir,
        depth: depthN,
        entries: used,
        maxEntries: maxN,
        truncated: truncated || used >= maxN,
        items,
      }
    },

    /* ═══════════════════════════════════════════════════════════════════════
     * 写操作（2026-10-20，用户要求"更多工具 = 文件写操作"）
     * ═══════════════════════════════════════════════════════════════════════
     *
     * ⚠⚠ **这是本插件第二个主动放宽边界的能力**（第一个是 SMB 共享）。
     * 前四个 fs 工具全是只读；从这里开始会**改副机的文件**。
     *
     * ── 护栏（每一道都对应一种真实事故）────────────────────────────────
     *
     *   1. **路径必须在 roots 内** —— 复用 resolveAny（realpath 展开 8.3 短名
     *      与符号链接，再比 roots 前缀）。写操作**额外**要求目标父目录也
     *      在 roots 内（防"roots 内的路径经过软链写到外面"）。
     *   2. **默认不覆盖** —— write 遇到已存在的文件直接拒绝，要覆盖必须显式
     *      传 `overwrite: true`。这条防"AI 手滑清空已有文件"。
     *   3. **单次写入有大小上限** —— 防一次 write 把副机磁盘写满。
     *   4. **delete 只删文件/空目录** —— 不做递归删除。递归删除太容易造成
     *      不可逆损失，真有需要让用户用 exec 显式 rm。
     *   5. **denyPaths 生效** —— 与只读工具同一条规则。
     */

    /** 写文件（默认不覆盖）。 */
    write({ path: p, content, encoding = 'utf8', overwrite = false } = {}) {
      if (typeof content !== 'string') {
        throw new FsError('content must be a string', ERROR_CODE.WORKSPACE_DENIED)
      }
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > WRITE_MAX_BYTES) {
        throw new FsError(
          `content too large: ${bytes} bytes (max ${WRITE_MAX_BYTES})`,
          ERROR_CODE.ARTIFACT_TOO_LARGE,
        )
      }
      const file = resolveWritable(p, conf)
      // 目标**父目录**也必须在 roots 内：防"roots 内的路径经软链写到外面"
      const dir = path.dirname(file)
      let dirReal
      try {
        dirReal = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir)
      } catch {
        throw new FsError(`parent directory not found: ${dir}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      if (entryDenied(dirReal, conf)) {
        throw new FsError(`parent directory denied: ${dirReal}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      const exists = fs.existsSync(file)
      if (exists && overwrite !== true) {
        throw new FsError(
          `file already exists: ${file}（如需覆盖请显式传 overwrite: true）`,
          ERROR_CODE.ARTIFACT_DENIED,
        )
      }
      if (exists) {
        let st
        try {
          st = fs.statSync(file)
        } catch {
          st = null
        }
        if (st && st.isDirectory()) {
          throw new FsError(`target is a directory: ${file}`, ERROR_CODE.WORKSPACE_DENIED)
        }
      }
      // 原子写：临时文件 + rename（与 templates.js 同款，避免半截文件）
      const tmp = `${file}.dshra-tmp-${process.pid}-${Date.now().toString(36)}`
      try {
        fs.writeFileSync(tmp, content, { encoding, mode: 0o600 })
        fs.renameSync(tmp, file)
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* 清理失败不掩盖原错误 */
        }
        throw new FsError(`write failed: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL)
      }
      return { path: file, bytes, overwritten: exists }
    },

    /** 建目录（递归）。已存在视为成功（幂等）。 */
    mkdir({ path: p } = {}) {
      const dir = resolveWritable(p, conf)
      const existed = fs.existsSync(dir)
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (err) {
        throw new FsError(`mkdir failed: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL)
      }
      return { path: dir, created: !existed }
    },

    /** 移动/重命名（同盘 rename；跨盘明确报错，不做静默复制）。 */
    move({ from, to, overwrite = false } = {}) {
      const src = resolveWritable(from, conf)
      const dst = resolveWritable(to, conf)
      const dstDir = path.dirname(dst)
      let dstDirReal
      try {
        dstDirReal = fs.realpathSync.native ? fs.realpathSync.native(dstDir) : fs.realpathSync(dstDir)
      } catch {
        throw new FsError(`target directory not found: ${dstDir}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      if (entryDenied(dstDirReal, conf)) {
        throw new FsError(`target directory denied: ${dstDirReal}`, ERROR_CODE.WORKSPACE_DENIED)
      }
      if (!fs.existsSync(src)) {
        throw new FsError(`source not found: ${src}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      if (fs.existsSync(dst) && overwrite !== true) {
        throw new FsError(
          `target already exists: ${dst}（如需覆盖请显式传 overwrite: true）`,
          ERROR_CODE.ARTIFACT_DENIED,
        )
      }
      try {
        fs.renameSync(src, dst)
      } catch (err) {
        // EXDEV = 跨设备。不做静默复制 —— 大文件会卡住且语义不同
        if (err?.code === 'EXDEV') {
          throw new FsError(
            `cross-device move not supported: ${src} -> ${dst}（请改用 exec 的 cp/mv）`,
            ERROR_CODE.INTERNAL,
          )
        }
        throw new FsError(`move failed: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL)
      }
      return { from: src, to: dst }
    },

    /**
     * 删除**单个文件或空目录**。
     *
     * ⚠ 刻意**不做递归删除** —— 那太容易造成不可逆损失。
     * 真有需要让用户用 exec 自己跑 rm -rf（那是显式动作，有命令可查）。
     */
    delete({ path: p } = {}) {
      const target = resolveWritable(p, conf)
      let st
      try {
        st = fs.lstatSync(target)
      } catch {
        throw new FsError(`path not found: ${target}`, ERROR_CODE.ARTIFACT_MISSING)
      }
      // 符号链接只删链接本身（lstat 不跟随）—— 防"删链接把目标删了"
      if (st.isDirectory()) {
        let entries
        try {
          entries = fs.readdirSync(target)
        } catch (err) {
          throw new FsError(`readdir failed: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL)
        }
        if (entries.length > 0) {
          throw new FsError(
            `directory not empty: ${target}（只删空目录；非空目录请用 exec 显式删除）`,
            ERROR_CODE.ARTIFACT_DENIED,
          )
        }
        try {
          fs.rmdirSync(target)
        } catch (err) {
          throw new FsError(`rmdir failed: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL)
        }
        return { path: target, kind: 'dir' }
      }
      try {
        fs.unlinkSync(target)
      } catch (err) {
        throw new FsError(`unlink failed: ${String(err?.message ?? err)}`, ERROR_CODE.INTERNAL)
      }
      return { path: target, kind: st.isSymbolicLink() ? 'link' : 'file' }
    },
  }
}
