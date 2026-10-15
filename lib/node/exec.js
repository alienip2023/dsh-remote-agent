/**
 * 命令执行后端。
 *
 * v0.1 目标平台是 Windows 副机，所以：
 *   - 默认 shell 是 PowerShell（pwsh 优先，退回 powershell.exe）
 *   - 用 `-NoProfile -NonInteractive -Command` 避免用户 profile 干扰与卡在交互提示
 *   - 退出码：`$LASTEXITCODE` 在 native 命令后才有意义，所以脚本尾部显式 `exit`
 *   - 编码：强制 UTF-8 输出，否则中文路径/输出在 cp936 下会乱码
 *   - 进程树：Windows 用 `taskkill /T /F`，POSIX 用进程组 kill
 *
 * posix 分支保留并同样可用（Linux/macOS 副机后续直接跑），不是占位代码。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RemoteAgentError, ERROR_CODE } from '../protocol.js'
import { isAbsolutePath, normalizePath } from '../glob.js'

export const PLATFORM = Object.freeze({ WINDOWS: 'windows', POSIX: 'posix' })

export function detectPlatform() {
  return process.platform === 'win32' ? PLATFORM.WINDOWS : PLATFORM.POSIX
}

/**
 * 在 PATH 里解析一个可执行文件名。
 *
 * 为什么必须自己做：早期版本对非绝对路径候选直接 `return c`（"交给 PATH 解析"），
 * 结果在一台只有 Windows PowerShell 5.1 的机器上返回了不存在的 'pwsh.exe'，
 * 每一条 exec 任务都以 ENOENT 失败。判断"这个可执行文件到底存不存在"
 * 是这里唯一的职责，不能推给 spawn 事后暴露。
 *
 * "存在"必须按 spawn 的判据来算，不能只用 existsSync：
 *   Windows 的**应用执行别名**（App Execution Alias，如
 *   `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`）是一个 **0 字节**的
 *   重解析点文件。existsSync 返回 true，但 spawn 打开它时抛
 *   `EFTYPE`（实测：0 字节 .exe → Error: spawn EFTYPE，errno -4028）。
 *   于是 resolveOnPath 会"成功"解析出一个 spawn 用不了的文件 ——
 *   正是它当初要消灭的那类失败，只是错误码从 ENOENT 变成了 EFTYPE。
 *   真实的 PE 文件不可能 0 字节，所以在 Windows 上把 0 字节候选视为不存在。
 *   （别名是目录形式的占位，正确解析需要解析 reparse point；这里选择
 *   继续往下找下一个候选 —— 与"不存在就回退"的语义一致。）
 */
/**
 * 一个候选路径是否**可执行**（存在 + 非 0 字节）。
 *
 * 为什么需要 0 字节守卫：Windows 上 App Execution Alias（`WindowsApps\*.exe`）
 * 常见形态是 0 字节 reparse point —— `existsSync()` 说"有"，但 spawn 打开时抛
 * `EFTYPE`(errno -4028)。也就是说，光看"存在"会把一个必然失败的解释器当成可用的。
 *
 * 判据必须**单一来源**：这个函数被 `resolveOnPath` 与 `resolvePowerShell` 的
 * 绝对路径分支共同调用。历史上后者只有 `existsSync`、没有 0 字节守卫，于是同一个
 * 0 字节 pwsh.exe 在 PATH 分支被跳过、在绝对路径分支被采用，行为自相矛盾
 * （describePowerShell 报 exists:true/family:'pwsh-7'，spawn 却抛 EFTYPE）。
 *
 * 读不了（EACCES 等）一律视为不可用 —— 与"不存在就继续找下一个候选"同义。
 */
export function isUsableExecutable(full) {
  try {
    if (!fs.existsSync(full)) return false
    if (process.platform === 'win32' && fs.statSync(full).size === 0) return false
    return true
  } catch {
    return false
  }
}

export function resolveOnPath(name) {
  if (typeof name !== 'string' || name === '') return ''
  const isWindows = process.platform === 'win32'
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const hasExt = /\.[A-Za-z0-9]+$/.test(name)
  const names = hasExt ? [name] : [name, ...exts.map((e) => name + e)]
  for (const dir of dirs) {
    for (const n of names) {
      const full = path.join(dir, n)
      if (isUsableExecutable(full)) return full
    }
  }
  return ''
}

/**
 * 找出可用的 PowerShell。
 *
 * 顺序：显式覆盖 → PowerShell 7 常见安装位置 → PATH 上的 pwsh →
 *       Windows PowerShell 5.1（几乎每台 Windows 都有，作为兜底）。
 *
 * 显式设置的 DSH_REMOTE_PWSH 一律原样采用（即使是错的）—— 用户明确指定了就用它，
 * 失败了要给出清晰错误，而不是被静默换成别的 shell 掩盖掉配置问题。
 */
export function resolvePowerShell() {
  const explicit = process.env.DSH_REMOTE_PWSH
  if (explicit && explicit.trim() !== '') return explicit.trim()

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? ''

  const ordered = [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : '',
    'pwsh.exe',
    'pwsh',
    // 兜底：Windows PowerShell 5.1
    'powershell.exe',
    'powershell',
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].filter(Boolean)

  for (const c of ordered) {
    if (isAbsolutePath(c)) {
      // 必须用与 resolveOnPath 相同的判据（含 0 字节守卫），不能只 existsSync。
      // 历史不一致：绝对安装位置分支只有 existsSync，而 PATH 分支有 0 字节守卫 ——
      // 于是 WindowsApps 下的 0 字节 pwsh.exe（App Execution Alias 的常见形态）
      // 会被这里采用，describePowerShell() 报 exists:true / family:'pwsh-7'，
      // 但真正 spawn 时抛 EFTYPE(errno -4028)。同一条规则在两处必须一致。
      if (isUsableExecutable(c)) return c
      continue
    }
    const hit = resolveOnPath(c)
    if (hit) return hit
  }
  return 'powershell.exe'
}

/** 当前解析结果，供诊断/状态接口展示（不缓存，环境变了要能立刻反映）。 */
export function describePowerShell() {
  const resolved = resolvePowerShell()
  const isPwsh = /pwsh(\.exe)?$/i.test(resolved)
  return {
    resolved,
    family: isPwsh ? 'pwsh-7' : 'windows-powershell-5.1',
    fromEnv: Boolean(process.env.DSH_REMOTE_PWSH),
    exists: isAbsolutePath(resolved) ? fs.existsSync(resolved) : Boolean(resolveOnPath(resolved)),
  }
}

/**
 * 把一段用户命令包成"退出码可靠 + 输出 UTF-8"的 PowerShell 脚本。
 *
 * 关键点：
 *  - `$ProgressPreference='SilentlyContinue'` 去掉进度条噪声
 *  - `[Console]::OutputEncoding` + `$OutputEncoding` 强制 UTF-8
 *  - 结尾把 `$LASTEXITCODE`（native）或 `$?`（cmdlet）折成 0/1 退出码
 */
export function wrapPowerShell(command, { cwd } = {}) {
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    'try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    `if ('${escapePsSingle(cwd ?? '')}' -ne '' -and (Test-Path -LiteralPath '${escapePsSingle(cwd ?? '')}')) { Set-Location -LiteralPath '${escapePsSingle(cwd ?? '')}' }`,
    // 用户命令不加 & {} 包装 —— $? 必须反映最后一条真实语句的状态。
    // 早期版本写成 `& { <command> }`，块调用本身成功会让 $? 恒为 true，
    // 于是 cmdlet 失败被静默折成 exit 0（实测 Get-Item 不存在的路径 → 退出码 0，
    // 这会让所有失败的 exec 任务被上报成 completed）。
    command,
    // 判定顺序：只看最后一条语句的成败，与 shell 的 $? 语义一致。
    // 先查 $LASTEXITCODE 是错的 —— 一条先前成功的 native 命令会留下 0，
    // 把后续 cmdlet 的失败掩盖成成功。
    '$__dsh_ok = $?',
    'if ($__dsh_ok) { exit 0 }',
    'if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'exit 1',
  ]
  return lines.join('\n')
}

function escapePsSingle(s) {
  return String(s).replace(/'/g, "''")
}

/** POSIX 包装：保证 set -o pipefail 语义与退出码直传。 */
export function wrapPosix(command, { cwd } = {}) {
  const cd = cwd ? `cd ${shellQuote(cwd)} || exit 127\n` : ''
  return `${cd}set -o pipefail 2>/dev/null || true\n${command}\n__dsh_rc=$?\nexit $__dsh_rc\n`
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * 决定最终 spawn 的 argv。
 *
 * Windows 侧调用形式经过 2×2 因子实测（PS 5.1），结论与直觉相反，必须按数据来：
 *
 *   OutputEncoding 行   BOM    形式              结果
 *   -----------------   ----   ---------------   --------------------------
 *   无                  无     -File             "通过" —— 但这是假通过
 *   无                  有     -File             乱码
 *   有                  无     -File             乱码
 *   有                  有     -File             ✓ 正确
 *   有                  n/a    -EncodedCommand   ✓ 正确（但 stderr 被包成 CLIXML）
 *
 * 两个反直觉点：
 *   1. **BOM 是必需的。** PS 5.1 对无 BOM 的 .ps1 按 ANSI(GBK) 读，中文字面量当场乱码。
 *   2. **"无编码行 + 无 BOM"会假通过** —— 按 GBK 读进来、又按 GBK 写出去，
 *      字节绕一圈变回原样。这依赖控制台码页，换台机器或换个 locale 就崩，
 *      是最危险的一种"能跑"，绝不能依赖。
 *
 * 为什么不选 `-EncodedCommand`（它也正确）：它会把子进程 stderr 整体包成
 * `#< CLIXML` XML，错误信息变成不可读的 XML 噪声，副机 agent 无法据此判断失败原因。
 * `-File` + BOM 的 stderr 是干净纯文本（实测 `Get-Item : 找不到路径"..."`）。
 */
export function buildSpawn(command, { platform, cwd }) {
  if (platform === PLATFORM.WINDOWS) {
    const ps = resolvePowerShell()
    const script = wrapPowerShell(command, { cwd })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exec-'))
    const file = path.join(dir, 'run.ps1')
    // 必须带 BOM：PS 5.1 靠它判定 UTF-8，否则按 GBK 读、中文字面量乱码
    fs.writeFileSync(file, '\uFEFF' + script, 'utf8')
    return {
      file: ps,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      cleanup: () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // 临时目录清理失败不该影响任务结果
        }
      },
    }
  }
  return {
    file: process.env.SHELL || '/bin/sh',
    args: ['-c', wrapPosix(command, { cwd })],
  }
}

/** 校验工作区：必须在允许根内，且真实存在。 */
export function resolveWorkspace(requested, { roots, caseInsensitive, defaultDir }) {
  const target = requested && requested !== '' ? requested : defaultDir
  if (!target) {
    throw new RemoteAgentError('no workspace given and no default configured', ERROR_CODE.WORKSPACE_DENIED)
  }
  if (!isAbsolutePath(target)) {
    throw new RemoteAgentError(`workspace must be absolute: ${target}`, ERROR_CODE.WORKSPACE_DENIED)
  }
  let resolved
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target)
  } catch {
    // 允许"尚不存在但父目录合法"的工作区：任务本身可能要创建它
    const parent = path.dirname(target)
    try {
      const parentReal = fs.realpathSync.native ? fs.realpathSync.native(parent) : fs.realpathSync(parent)
      resolved = path.join(parentReal, path.basename(target))
    } catch {
      throw new RemoteAgentError(`workspace not reachable: ${target}`, ERROR_CODE.WORKSPACE_DENIED)
    }
  }

  /**
   * 已存在但不是目录 → 绝不是合法工作区。
   *
   * 不拦的后果是**错误码错位**：task-engine.accept() 紧接着会执行
   * `fs.mkdirSync(workspace, { recursive: true })`，而 mkdir 对已存在的普通文件
   * 抛 EEXIST（recursive 只吞掉 EEXIST 的**目录**情形）—— 这个异常会穿过
   * accept()，在 node/index.js 里被折成 ERROR_CODE.INTERNAL。
   * 于是一个"workspace 参数写成了文件"的输入被上报成"副机内部错误"，
   * 调用方的排查方向完全跑偏，而正确答案本该是 workspace-denied。
   *
   * 放在 roots 校验之前：这是"输入根本不是目录"的事实判断，与白名单无关。
   */
  let st
  try {
    st = fs.statSync(resolved)
  } catch {
    // stat 失败（权限 / 竞态）不在这里判死，交给后续步骤报更具体的错
    st = null
  }
  if (st && !st.isDirectory()) {
    throw new RemoteAgentError(`workspace is not a directory: ${resolved}`, ERROR_CODE.WORKSPACE_DENIED)
  }

  // roots 与 target 必须走**同一套归一**：target 上面已经 realpath 过
  // （展开 8.3 短名与符号链接），roots 不 realpath 的话两边形态不同 →
  // 前缀比对假阳性拒绝。真实触发场景：GH Actions 的 Windows runner TEMP 是
  // `C:\Users\RUNNER~1\AppData\Local\Temp`（8.3 短名），`os.tmpdir()` 派生的
  // 默认 roots 保持短名，而任务里引用的子路径被 realpath 展开成长名 ——
  // 明明在根内却被判 workspace-denied。用户配 8.3 形态或符号链接目录同理。
  const allowed = (roots ?? []).map((r) => {
    let base = r
    try {
      base = fs.realpathSync.native ? fs.realpathSync.native(r) : fs.realpathSync(r)
    } catch {
      // 根不存在 / 不可达：保持原样交给你 normalizePath ——
      // 不存在的根后面照样拒绝一切子路径，不影响安全语义。
    }
    return normalizePath(base, { caseInsensitive })
  })
  if (allowed.length === 0) {
    throw new RemoteAgentError('no allowed roots configured; refusing every workspace', ERROR_CODE.WORKSPACE_DENIED)
  }
  const norm = normalizePath(resolved, { caseInsensitive })
  const ok = allowed.some((r) => norm === r || norm.startsWith(`${r}/`))
  if (!ok) {
    throw new RemoteAgentError(
      `workspace outside allowed roots: ${resolved} (allowed: ${allowed.join(', ')})`,
      ERROR_CODE.WORKSPACE_DENIED,
    )
  }
  return resolved
}

/**
 * 判断路径是否被 denyPaths 拦下。
 *
 * 两种写法都必须生效（与 artifacts.js 的 walk 同一条规则）：
 *   - 绝对条目：直接与 absPath 比前缀
 *   - 相对条目：在 absPath 的**任意段边界**上做连续段匹配
 *
 * 为什么相对条目要单独处理：本函数的真实调用方（task-engine.snapshotWorkspace）
 * 传进来的 absPath 是绝对路径，而 cfg.denyPaths / 任务 constraints.denyPaths 都是
 * 任意字符串。相对条目与绝对路径永不相等 → 相对 denyPaths 被**静默忽略** ——
 * 与 artifacts.js 修过的 D1 完全同类（"有时管用"最危险）。方向取保守：
 * 宁可多拒一条变更记录，也不能让被禁路径的内容照常上报给 hub。
 */
export function isDenied(absPath, denyPaths, { caseInsensitive = false } = {}) {
  const p = normalizePath(absPath, { caseInsensitive })
  if (p === '') return false
  for (const raw of denyPaths ?? []) {
    // 非字符串 / 空串条目必须**显式跳过**，不能交给 normalizePath 兜。
    // 历史缺陷：normalizePath('') / (null) / (42) 都返回 ''，而空条目的比对是
    // `p === '' || p.startsWith('/')` ——
    //   POSIX：归一化结果是 '/etc/passwd'，startsWith('/') 恒真 → 一个空条目
    //          把整张 deny 表变成"全部拒绝"（变更报告静默变空）
    //   Windows：归一化结果是 'c:/work/a'，不以 '/' 开头 → 同一个空条目变成
    //          "什么都不拒"（禁路径静默失效）
    // 同一个非法输入在两种平台上给出相反的极端行为，且两边都是静默的。
    if (typeof raw !== 'string') continue
    if (raw.trim() === '') continue
    const nd = normalizePath(raw, { caseInsensitive })
    // ⚠ 这一行（L3）是**行为不可观测**的纵深防御，不是可被测试证明的守卫。
    //
    // 穷举 928 组输入逐层移除的实测结论（captain + verifier 各自独立得出）：
    //   L1 `typeof` 守卫   → 可观测（移除后 180 处行为差异）
    //   L2 `trim()` 守卫   → 可观测（移除后 6 处差异；`'   '` 是唯一只有它能拦的形态，
    //                        因为 normalizePath **不做 trim**）
    //   L3 本行           → **不可观测**：所有能让 nd === '' 的输入，要么已被 L1 拦下，
    //                        要么会在紧接着的 `if (segs.length === 0) continue` 被拦。
    //
    // 所以：**任何测试都无法证明本行存在**（删掉它测试仍全绿）。保留它是为了在
    // "normalizePath 将来改了行为"或"上面几层被调整"时仍有兜底。请勿以"测试全过"
    // 当作它有效的证据 —— 也不要因为它删掉不掉测试而误判它是死代码就移除。
    if (nd === '') continue

    if (isAbsolutePath(raw)) {
      // 根路径：deny '/' 就该拒掉一切，否则 '/etc/passwd' 因 '//' 前缀比不中而漏过
      if (nd === '/') return true
      if (p === nd || p.startsWith(`${nd}/`)) return true
      continue
    }

    const segs = nd.split('/').filter(Boolean)
    if (segs.length === 0) continue
    const pSegs = p.split('/').filter(Boolean)
    for (let start = 0; start + segs.length <= pSegs.length; start += 1) {
      let same = true
      for (let i = 0; i < segs.length; i += 1) {
        if (pSegs[start + i] !== segs[i]) {
          same = false
          break
        }
      }
      if (same) return true
    }
  }
  return false
}

/**
 * 跑一条命令，收集输出，返回结构化结果。
 * 不做超时软处理：超时就是杀进程树，然后如实报 timedOut。
 */
export function runCommand(command, {
  platform = detectPlatform(),
  cwd,
  timeoutMs = 60 * 60 * 1000,
  env = {},
  signal,
  onData,
  maxOutputBytes = 4 * 1024 * 1024,
} = {}) {
  const { file, args, cleanup } = buildSpawn(command, { platform, cwd })
  const startedAt = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX 下独立进程组，便于整组 kill
        detached: platform === PLATFORM.POSIX,
      })
    } catch (err) {
      // spawn 失败也要清临时脚本目录，否则每次失败漏一个目录
      try {
        cleanup?.()
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: String(err?.message ?? err),
        durationMs: Date.now() - startedAt,
        spawnError: true,
      })
      return
    }

    const out = []
    const errOut = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false

    const capture = (buf, sink) => {
      const s = buf.toString('utf8')
      if (sink === out) {
        outBytes += buf.length
        if (outBytes <= maxOutputBytes) out.push(s)
        else truncated = true
      } else {
        errBytes += buf.length
        if (errBytes <= maxOutputBytes) errOut.push(s)
        else truncated = true
      }
      if (typeof onData === 'function') onData(s, sink === out ? 'stdout' : 'stderr')
    }

    child.stdout?.on('data', (b) => capture(b, out))
    child.stderr?.on('data', (b) => capture(b, errOut))

    const killTree = () => {
      try {
        if (platform === PLATFORM.WINDOWS) {
          // /T 杀整棵树，/F 强制。即使 child 已退出也无害。
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已经退出 */
        }
      }
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        killTree()
      }, timeoutMs)
      : undefined
    if (timer?.unref) timer.unref()

    const onAbort = () => {
      aborted = true
      killTree()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (code, signalName) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      // Windows 临时脚本目录在这里回收：进程已 close，脚本不再被读
      try {
        cleanup?.()
      } catch {
        /* 清理失败不影响结果 */
      }
      resolve({
        ok: code === 0 && !timedOut && !aborted,
        exitCode: code,
        signal: signalName,
        timedOut,
        aborted,
        truncated,
        stdout: out.join(''),
        stderr: errOut.join(''),
        durationMs: Date.now() - startedAt,
      })
    }

    child.on('error', (err) => {
      errOut.push(String(err?.message ?? err))
      finish(null, null)
    })
    child.on('close', (code, signalName) => finish(code, signalName))
  })
}

/** 默认工作区根：用户没配 roots 时给一个保守的默认（home 下的工作目录）。 */
export function defaultRoots() {
  const home = os.homedir()
  const candidates = [path.join(home, 'dsh-remote-work'), path.join(home, 'work')]
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true })
      return [c]
    } catch {
      /* 试下一个 */
    }
  }
  return [home]
}
