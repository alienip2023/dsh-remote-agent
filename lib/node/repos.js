/**
 * 仓库清单扫描（提案 #13）：副机把 roots 下的 git 仓库报给 hub，hub 由此
 * 建立 repo→node 索引，`remote_task` 的 `repo:` 参数据此路由（多节点时
 * "把任务派给有这个仓库的那台机器"不再需要人肉记 nodeId）。
 *
 * 三条设计边界：
 *   - **零子进程**：只 `readdir` + 读 `.git/config` 文本，不 spawn git。
 *     扫描在副机常驻进程里跑，起子进程既慢又会在某些环境下挂住。
 *   - **凭证不离开副机**：`.git/config` 的 remote url 可能内嵌
 *     `https://user:token@host/...`（CI 推送的常见写法）。上报前一律剥掉
 *     userinfo —— hub 只需要"这台机器有这个仓库"，不需要能推它的凭证。
 *   - **有界**：深度 ≤3、数量 ≤50、跳过 node_modules 等已知噪音目录；
 *     单目录读失败静默跳过（权限不足的目录在扫描里是常态而非异常）。
 *
 * `.git` 只认**目录**（常规 clone）。worktree/submodule 的 `.git` 是文件，
 * 指针解析留 v2 —— 误报比漏报更伤路由（把任务派到没有仓库的机器上）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 扫描深度：root 本身算第 0 层，最多下钻 3 层（root/a/b/repo）。 */
const MAX_DEPTH = 3
/** 上报上限：超出的仓库直接丢弃（索引是路由提示，不是全量清单）。 */
export const MAX_REPOS = 50
/** 下降时跳过的目录名（小写比较）：已知噪音，进去纯属浪费时间。 */
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information'])

/**
 * 剥掉 remote url 里的 userinfo（凭证打码）。
 *
 * - `https://user:token@github.com/a/b.git` → `https://github.com/a/b.git`
 * - `git@github.com:a/b.git`（scp 形态）原样保留 —— "@" 前是公开用户名，不是凭证
 * - 非 URL 形态（`new URL` 解析失败）原样返回，宁可多报不可误报
 *
 * @param {string} raw .git/config 里的原始 url
 * @returns {string} 打码后的 url
 */
export function sanitizeRepoUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return ''
  try {
    const u = new URL(s)
    if (u.username === '' && u.password === '') return s
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return s
  }
}

/**
 * 解析 `.git/config`，取出优先级最高的 remote url（origin 优先，其次第一个
 * remote）。没有 remote（纯本地仓库）返回空字符串 —— 仓库仍上报，靠 name/path
 * 一样能路由。
 *
 * @param {string} repoPath 仓库根目录（其下有 .git/config）
 * @returns {Promise<string>} 打码后的 url；读不到/解析不出都是 ''
 */
export async function readGitRemote(repoPath) {
  const urls = []
  let current = ''
  let text
  try {
    text = await fs.readFile(path.join(repoPath, '.git', 'config'), 'utf8')
  } catch {
    return ''
  }
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[(?:remote\s+"([^"]+)"|.+?)\]\s*$/)
    if (section) {
      current = section[1] ?? '' // 任何其他节头（core/branch/...）都把 remote 上下文清掉
      continue
    }
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/)
    if (url && current !== '') urls.push({ remote: current, url: url[1] })
  }
  const pick = urls.find((u) => u.remote === 'origin') ?? urls[0]
  return pick ? sanitizeRepoUrl(pick.url) : ''
}

/**
 * 扫描 roots 下的 git 仓库。
 *
 * @param {string[]} roots 工作区根（绝对路径）；与 hello.roots 同源
 * @param {object} [o]
 * @param {number} [o.maxDepth] 下钻层数（root=0 层）
 * @param {number} [o.maxRepos] 上报上限
 * @returns {Promise<Array<{name: string, url: string, path: string}>>}
 */
export async function scanRepos(roots, { maxDepth = MAX_DEPTH, maxRepos = MAX_REPOS } = {}) {
  const out = []
  const rootArr = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r.trim() !== '') : []

  const walk = async (dir, depth) => {
    if (out.length >= maxRepos) return
    let isRepo = false
    try {
      isRepo = (await fs.stat(path.join(dir, '.git'))).isDirectory()
    } catch {
      /* 不是仓库或不可读 —— 都按"继续下钻"处理 */
    }
    if (isRepo) {
      const name = path.basename(dir) || dir
      const url = await readGitRemote(dir)
      out.push({ name, url, path: dir })
      return // 仓库内不再下钻（嵌套 clone 不是路由目标）
    }
    if (depth >= maxDepth) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // 权限/IO 错误：这一枝放弃
    }
    for (const e of entries) {
      if (out.length >= maxRepos) return
      if (!e.isDirectory()) continue
      const lower = e.name.toLowerCase()
      if (lower.startsWith('.') || SKIP_DIRS.has(lower)) continue
      await walk(path.join(dir, e.name), depth + 1)
    }
  }

  for (const root of rootArr) {
    if (out.length >= maxRepos) return out
    await walk(root, 0)
  }
  return out
}
