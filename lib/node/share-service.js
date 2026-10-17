/**
 * 工作区 SMB 共享（2026-10-17）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个模块做什么
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 在**副机**上把一个工作区目录通过 SMB 共享出去，让主机可以：
 *
 *     net use X: \\<副机IP>\dsh-work
 *
 * 像本地盘一样浏览/编辑 —— 这是"用本地 IDE 打开副机项目"的唯一现实路径。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ 安全模型变化（**必须让用户知情**，这是本模块存在的最大风险）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 开启共享后，**插件的安全边界被完全绕过**：
 *
 *   · `roots` 不再生效 —— Windows 内核直接读写，插件无法拦截
 *   · `denyPaths` 不再生效 —— 同上
 *   · 「清单先于字节」失效 —— 中间产物、日志、`.env`、`.git` 里的密钥
 *     全部对主机可见（不再只有 `role:final` 能过河）
 *   · **新增凭证面** —— 主机需要副机的 Windows 账号（或副机建一个共享账号），
 *     这比模型 key 更敏感（能读写整个共享目录）
 *
 * 所以本模块的每个入口都要求**显式二次确认**（`confirm: 'yes'`），
 * 且面板上必须显示完整风险说明。这是产品决策：**让用户知情地选择，
 * 而不是偷偷放宽边界**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 权限模型：只读 / 读写
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   `read`  → `New-SmbShare -ReadAccess`   只读：主机能看、不能改
 *   `write` → `New-SmbShare -ChangeAccess` 读写：能看能改（不给 FullAccess ——
 *             那会连共享的 ACL 一起给出，主机能改权限）
 *
 * **默认只读**：绝大多数"用 IDE 打开看代码"的需求，只读就够；写权限要额外
 * 一次确认。这是最小权限原则的落点。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 需要管理员权限（**这是硬约束**）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `New-SmbShare` / `Remove-SmbShare` 都需要管理员。而 DSH 通常以普通用户
 * 运行。所以本模块**不自己提权**（在 Node 里弹 UAC 不可靠且会被杀软拦），
 * 而是：
 *
 *   · 探测当前是否管理员 → 不是就返回一条**可复制的提权命令**
 *   · 用户自己开管理员 PowerShell 跑那一条 → 再回来点「已开启」确认
 *
 * 这比"假装能一键"诚实：一次 UAC 提权失败的表现（静默失败、被拦、
 * 权限半生效）比让用户手动跑一条命令难排查得多。
 */

import { spawnSync } from 'node:child_process'

/** 共享名前缀 —— 固定前缀便于识别与清理（不会误删用户的其它共享）。 */
export const SHARE_NAME_PREFIX = 'dsh-work'

/** 共享名上限（Windows 限制 80 字符，留余量）。 */
const SHARE_NAME_MAX = 64

/** 访问级别。 */
export const SHARE_ACCESS = Object.freeze({
  READ: 'read',
  WRITE: 'write',
})

/**
 * 由工作区路径生成一个**稳定**的共享名。
 *
 * 为什么要稳定：用户可能对同一个目录反复开关共享，共享名必须一致，
 * 否则每次都会留下一个孤儿共享。用路径的短哈希做后缀。
 *
 * @param {string} dir 工作区绝对路径
 * @returns {string} 例如 `dsh-work-a1b2c3`
 */
export function shareNameFor(dir) {
  const base = SHARE_NAME_PREFIX
  // 简单稳定哈希（FNV-1a 32bit）—— 不需要密码学强度，只要同一路径同名
  let h = 0x811c9dc5
  const s = String(dir)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${base}-${h.toString(16).padStart(8, '0')}`.slice(0, SHARE_NAME_MAX)
}

/**
 * 判断当前进程是否管理员（Windows）。
 *
 * 非 Windows 恒 false —— 本功能是 Windows 专属（SMB 共享）。
 */
export function isAdmin() {
  if (process.platform !== 'win32') return false
  try {
    // `net session` 需要管理员，成功即管理员。比读 token 简单可靠。
    const r = spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * 列出本机所有 SMB 共享。
 *
 * `net share` 不需要管理员（只读查询），所以即使非管理员也能用于**展示**。
 *
 * ⚠ 2026-10-17 修（v0.9.0 审查 L2）：优先用 `Get-SmbShare` 取**结构化**路径。
 *
 * 原来只解析 `net share` 的文本输出，正则 `[A-Za-z]:\\[^\s]*` 在路径含空格时
 * 会截断 —— `D:\Deepseek Harness file` → `D:\Deepseek`。而 Windows 工作区路径
 * 带空格很常见（本项目自己的目录就叫 `D:\Deepseek Harness file`！）。
 *
 * 截断的后果不是崩溃，而是**比对失败**：`findShareForDir` 找不到已存在的共享
 * → 面板把已共享目录显示为未共享 → 用户再点一次才看到"共享名已存在"。
 * 属"可见错误而非静默 corruption"，但体验很差。
 *
 * 修法：`Get-SmbShare | ConvertTo-Json` 返回 `{Name, Path}` 精确值，
 * 完全避开文本解析。拿不到（PowerShell 缺失/被禁）时回退 `net share`。
 *
 * @returns {Array<{name:string, path:string}>}
 */
export function listShares() {
  if (process.platform !== 'win32') return []

  // ── 路径 1：Get-SmbShare（结构化，路径不截断）────────────────────
  try {
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-SmbShare | Select-Object Name,Path | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    )
    if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() !== '') {
      const parsed = JSON.parse(r.stdout)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      const out = []
      for (const x of arr) {
        if (!x || typeof x.Name !== 'string' || x.Name === '') continue
        out.push({ name: x.Name, path: typeof x.Path === 'string' ? x.Path : '' })
      }
      if (out.length > 0) return out
    }
  } catch {
    /* 回退到 net share */
  }

  // ── 路径 2：net share 文本解析（回退；含空格路径可能截断）──────────
  try {
    const r = spawnSync('net', ['share'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (r.status !== 0 || typeof r.stdout !== 'string') return []
    const out = []
    for (const line of r.stdout.split(/\r?\n/)) {
      // 形如：`dsh-work-a1b2c3  D:\work                        `
      //
      // 共享名不含空格（我们的 dsh-work-<hash> 与系统 C$/ADMIN$ 都是），
      // 所以 `^(\S+)\s+(.+?)\s*$` 里第一段是名、**剩下的整段**是路径 ——
      // 不要把路径按空白截断（L2 的原 bug）。
      const m = /^(\S+)\s+([A-Za-z]:\\.*?)\s*$/.exec(line.trim())
      if (m) out.push({ name: m[1], path: m[2].trim() })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 查某个目录是否已被共享（返回共享名）。
 * @param {string} dir
 * @returns {string|null}
 */
export function findShareForDir(dir) {
  const want = String(dir).replace(/[\\/]+$/, '').toLowerCase()
  for (const s of listShares()) {
    if (s.path.replace(/[\\/]+$/, '').toLowerCase() === want) return s.name
  }
  return null
}

/**
 * 生成**可复制的提权命令**（非管理员时给用户）。
 *
 * 为什么返回命令而不是自己提权：
 *   · Node 里弹 UAC 需要额外依赖或 PowerShell 间接调用，且被安全软件拦时
 *     表现为静默失败 —— 比手动跑一条命令难排查得多
 *   · 用户自己开管理员 PowerShell 跑一条命令，失败时**能看到真实错误**
 *
 * @param {object} o
 * @param {string} o.dir 要共享的目录
 * @param {'read'|'write'} o.access
 * @returns {{shareName:string, command:string}}
 */
export function buildShareCommand({ dir, access = SHARE_ACCESS.READ }) {
  const shareName = shareNameFor(dir)
  const accessFlag = access === SHARE_ACCESS.WRITE ? 'ChangeAccess' : 'ReadAccess'
  // 用户名：用当前用户（`$env:USERNAME`）。共享给"本机这个账号"，
  // 主机侧用同一套凭证连（或副机另建账号 —— 那是用户的事，文档里说明）。
  const cmd = [
    'New-SmbShare',
    `-Name '${shareName}'`,
    `-Path '${String(dir).replace(/'/g, "''")}'`,
    `-${accessFlag} "$env:USERNAME"`,
  ].join(' ')
  return { shareName, command: cmd }
}

/**
 * 生成卸载命令。
 * @param {string} shareName
 */
export function buildUnshareCommand(shareName) {
  return `Remove-SmbShare -Name '${String(shareName).replace(/'/g, "''")}' -Force`
}

/**
 * 生成主机侧的映射命令（面板展示给用户复制）。
 *
 * @param {object} o
 * @param {string} o.host 副机地址（IP 或主机名）
 * @param {string} o.shareName
 * @param {string} [o.drive] 盘符，默认 X:
 * @returns {string}
 */
export function buildMountCommand({ host, shareName, drive = 'X:' }) {
  const d = String(drive).replace(/:?$/, ':')
  return `net use ${d} \\\\${host}\\${shareName} /persistent:yes`
}

/**
 * 探测状态：当前是否管理员 + 哪些 dsh-work 共享已存在。
 *
 * @param {object} [o]
 * @param {string[]} [o.dirs] 要查的工作区目录
 * @returns {{platform:string, admin:boolean, supported:boolean, shares:Array, perDir:object}}
 */
export function probeShareState({ dirs = [] } = {}) {
  const supported = process.platform === 'win32'
  if (!supported) {
    return { platform: process.platform, admin: false, supported: false, shares: [], perDir: {} }
  }
  const shares = listShares().filter((s) => s.name.startsWith(SHARE_NAME_PREFIX))
  const perDir = {}
  for (const d of dirs) {
    if (typeof d !== 'string' || d === '') continue
    perDir[d] = findShareForDir(d)
  }
  return { platform: process.platform, admin: isAdmin(), supported, shares, perDir }
}
