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
 */
export function resolveOnPath(name) {
  if (typeof name !== 'string' || name === '') return ''
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const hasExt = /\.[A-Za-z0-9]+$/.test(name)
  const names = hasExt ? [name] : [name, ...exts.map((e) => name + e)]
  for (const dir of dirs) {
    for (const n of names) {
      const full = path.join(dir, n)
      try {
        if (fs.existsSync(full)) return full
      } catch {
        // PATH 里可能有当前用户无权限读取的目录，跳过继续找
      }
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
      if (fs.existsSync(c)) return c
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

  const allowed = (roots ?? []).map((r) => normalizePath(r, { caseInsensitive }))
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

/** 判断路径是否被 denyPaths 拦下。 */
export function isDenied(absPath, denyPaths, { caseInsensitive = false } = {}) {
  const p = normalizePath(absPath, { caseInsensitive })
  return (denyPaths ?? []).some((d) => {
    const nd = normalizePath(d, { caseInsensitive })
    return p === nd || p.startsWith(`${nd}/`)
  })
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
