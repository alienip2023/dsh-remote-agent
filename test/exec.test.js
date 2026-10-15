/**
 * lib/node/exec.js 行为测试 —— Windows 优先的平台原语。
 *
 * 为什么这个文件必须存在：exec.js 是副机执行命令的地基，历史上踩过的坑
 * **全部是"看起来能跑"的那一类**（静默折成 exit 0、返回不存在的 pwsh、
 * 编码假通过），任何一条复发都不会有显式报错，只会让失败任务被上报成
 * completed。所以这里断言的重点不是"文本里出现过某个符号"，而是
 * **顺序、分支结构、以及真实执行结果**。
 *
 * 三条硬约束（对应任务书的通用要求）：
 *   1. 全部用 mkdtemp 出来的临时目录，绝不碰真实 home / ~/.dsh
 *   2. 不依赖本机装了什么 —— PATH / PATHEXT / ProgramFiles / SystemRoot /
 *      DSH_REMOTE_PWSH 全部在测试内替换成临时目录里的假可执行文件
 *   3. 需要真实 PowerShell / sh 的行为断言，在拿不到解释器时显式 skip，
 *      而不是"因为环境不同就红"或"因为环境不同就悄悄变绿"
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PLATFORM,
  buildSpawn,
  defaultRoots,
  describePowerShell,
  detectPlatform,
  isDenied,
  resolveOnPath,
  resolvePowerShell,
  resolveWorkspace,
  shellQuote,
  wrapPosix,
  wrapPowerShell,
} from '../lib/node/exec.js'
import { ERROR_CODE } from '../lib/protocol.js'

/* ───────────────────────────── 测试工具 ───────────────────────────── */

/** 建一个临时目录，测试结束自动清理。 */
function tmpdir(t, prefix = 'dsh-exec-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return dir
}

/** 应用一组环境变量改动，返回还原函数。undefined 表示删除该变量。 */
function applyEnv(vars) {
  const saved = new Map()
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Object.hasOwn(process.env, k) ? process.env[k] : undefined)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * 只在回调期间生效的环境改动（try/finally 精确还原）。
 *
 * 刻意**不用 t.after 还原**：t.after 按注册顺序执行，同一个测试里嵌套/连续调用
 * 时还原顺序会反转（第二次调用保存的是"第一次改过的值"），把变量留在错误状态
 * 并泄漏给后续测试。这里用同步还原彻底回避这个坑。
 */
function scopedEnv(vars, fn) {
  const restore = applyEnv(vars)
  try {
    return fn()
  } finally {
    restore()
  }
}

/**
 * 每个测试只保存一次的"真实环境"快照。
 *
 * 为什么需要：一个测试里可能多次调用 isolateResolution（改 PATH 看不同候选）。
 * 若每次都 t.after(restore)，node 按注册顺序执行 after 钩子 —— 第二个 restore
 * 保存的是**第一次改过之后**的值，于是第一个 restore 还原成真实值、第二个又把它
 * 写回隔离值，环境泄漏给后续测试。这里按测试对象缓存一次原始值，只注册一个还原钩子。
 */
const baselineEnv = new WeakMap()

function isolateResolution(t, pathDirs, { pathext } = {}) {
  const empty = tmpdir(t, 'dsh-exec-empty-')
  if (!baselineEnv.has(t)) {
    const keys = [
      'DSH_REMOTE_PWSH', 'PATH', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'SystemRoot',
    ]
    const saved = {}
    for (const k of keys) saved[k] = Object.hasOwn(process.env, k) ? process.env[k] : undefined
    baselineEnv.set(t, saved)
    t.after(() => {
      const snap = baselineEnv.get(t)
      for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })
  }
  const vars = {
    DSH_REMOTE_PWSH: undefined,
    PATH: pathDirs.join(path.delimiter),
    PATHEXT: pathext ?? '.COM;.EXE;.BAT;.CMD',
    ProgramFiles: path.join(empty, 'PF'),
    'ProgramFiles(x86)': path.join(empty, 'PF86'),
    LOCALAPPDATA: path.join(empty, 'LAD'),
    SystemRoot: path.join(empty, 'SR'),
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

/** 造一个假的"可执行文件"。size=0 用来模拟 Windows 应用执行别名。 */
function fakeExe(dir, name, { size = 4 } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const full = path.join(dir, name)
  fs.writeFileSync(full, size === 0 ? '' : 'MZ' + 'x'.repeat(Math.max(0, size - 2)))
  return full
}

/**
 * 路径相等判断。
 *
 * 为什么不能直接 ===：resolveOnPath 拼接的是 PATHEXT 里的字面量扩展名，
 * 而 Windows 默认 PATHEXT 是大写（'.COM;.EXE;.BAT;.CMD'），所以查询
 * 'mytool' 会返回 'mytool.EXE' 而不是文件创建时的 'mytool.exe'。
 * 这是**正确**行为（Windows 文件系统大小写不敏感，spawn 能打开它），
 * 断言不该锁死大小写 —— 否则测试会因平台默认值不同而假红。
 */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 把"本机可能装了什么"彻底隔离掉：
 * PATH 只指向给定的假目录，PowerShell 的常见绝对安装位置全部指向空临时目录，
 * 并且清掉 DSH_REMOTE_PWSH。这样 resolvePowerShell 的结果完全由测试决定。
 * （实现见上方 baselineEnv 版本。）
 */

/** 真实可用的 PowerShell；本机没有就返回 ''（调用方 skip）。 */
function realPowerShell() {
  const resolved = resolvePowerShell()
  if (path.isAbsolute(resolved)) return fs.existsSync(resolved) ? resolved : ''
  return resolveOnPath(resolved)
}

/** 用真实 PowerShell 跑一段脚本，返回 { code, stdout, stderr }。 */
function runPowerShell(ps, script, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exec-run-'))
  const file = path.join(dir, 'run.ps1')
  // 与 buildSpawn 同法：BOM + utf8
  fs.writeFileSync(file, '\uFEFF' + script, 'utf8')
  const r = spawnSync(
    ps,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...extraArgs],
    { encoding: 'utf8', timeout: 60000, windowsHide: true },
  )
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

/** 真实可用的 POSIX shell；没有就返回 ''。 */
function realShell() {
  const fromEnv = process.env.SHELL
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const n of ['sh', 'sh.exe', 'bash', 'bash.exe']) {
      const full = path.join(dir, n)
      try {
        if (fs.existsSync(full) && fs.statSync(full).size > 0) return full
      } catch {
        /* 跳过不可读目录 */
      }
    }
  }
  return ''
}

/* ─────────────────── resolveOnPath / resolvePowerShell ─────────────────── */

test('resolveOnPath：在 PATH 里找到真实存在的可执行文件', (t) => {
  const dirA = tmpdir(t, 'dsh-a-')
  const dirB = tmpdir(t, 'dsh-b-')
  const want = fakeExe(dirB, 'mytool.exe')
  isolateResolution(t, [dirA, dirB])

  assert.ok(samePath(resolveOnPath('mytool.exe'), want))
  if (process.platform === 'win32') {
    // 带扩展名时不再追加 PATHEXT 候选（PATHEXT 是 Windows 语义）
    assert.ok(samePath(resolveOnPath('mytool'), want), '不带扩展名时应命中 .EXE 候选')
  } else {
    // POSIX 分支 exts=['']：没有扩展名补全，只有**精确文件名**才命中 ——
    // 'mytool' 不存在（盘上是 mytool.exe），如实返回空串。
    // 此前无条件断言 .EXE 补全，CI 的 Ubuntu runner 上假红（实现是对的）。
    assert.equal(resolveOnPath('mytool'), '', 'POSIX 无 PATHEXT 补全：非精确名不命中')
  }
})

test('resolveOnPath：全部不存在时返回空串（不编造路径）', (t) => {
  const dir = tmpdir(t, 'dsh-none-')
  isolateResolution(t, [dir])
  assert.equal(resolveOnPath('definitely-not-here.exe'), '')
  assert.equal(resolveOnPath('definitely-not-here'), '')
})

test('resolveOnPath：目录按 PATH 声明顺序，扩展名按 PATHEXT 声明顺序（Windows）', (t) => {
  const dirA = tmpdir(t, 'dsh-ord-a-')
  const dirB = tmpdir(t, 'dsh-ord-b-')
  const first = fakeExe(dirA, 'dup.exe')
  fakeExe(dirB, 'dup.exe')
  // PATH 顺序：A 在前 → 取 A 的（带扩展名查询，两平台语义一致）
  isolateResolution(t, [dirA, dirB])
  assert.ok(samePath(resolveOnPath('dup.exe'), first), 'PATH 靠前的目录优先')

  if (process.platform !== 'win32') {
    // POSIX：无 PATHEXT 语义，无扩展名查询只认精确文件名。
    // 此前无条件断言 PATHEXT 顺序，CI 的 Ubuntu runner 上假红（实现是对的）。
    assert.equal(resolveOnPath('dup'), '', 'POSIX 无扩展名补全')
    return
  }

  // PATHEXT 顺序：.BAT 在前 → 不带扩展名的查询命中 .BAT 候选。
  // 注意返回值的扩展名大小写由 PATHEXT 决定（'order.BAT'），
  // 而 Windows 文件系统大小写不敏感 —— 用规范化比较，不锁死大小写。
  const batDir = tmpdir(t, 'dsh-ord-c-')
  fakeExe(batDir, 'order.bat')
  fakeExe(batDir, 'order.exe')
  isolateResolution(t, [batDir], { pathext: '.BAT;.EXE;.CMD' })
  const hit = resolveOnPath('order')
  assert.equal(hit.toLowerCase(), path.join(batDir, 'order.bat').toLowerCase(), 'PATHEXT 靠前的扩展名优先')
  assert.equal(path.extname(hit).toLowerCase(), '.bat')
})

test('resolveOnPath：Windows 上 0 字节候选视为不存在（应用执行别名不是真可执行文件）', (t) => {
  // 实测依据：`%LOCALAPPDATA%\\Microsoft\\WindowsApps\\pwsh.exe` 这类
  // App Execution Alias 是 0 字节的 ReparsePoint 文件。existsSync 说"有"，
  // 但 spawn 打开它抛 `Error: spawn EFTYPE`（errno -4028）。
  // 若不排除，resolveOnPath 会"成功"返回一个 spawn 用不了的文件 ——
  // 正是它当初要消灭的那类失败，只是错误码从 ENOENT 换成了 EFTYPE。
  const stubDir = tmpdir(t, 'dsh-stub-')
  const realDir = tmpdir(t, 'dsh-real-')
  fakeExe(stubDir, 'pwsh.exe', { size: 0 })
  const real = fakeExe(realDir, 'pwsh.exe', { size: 64 })
  isolateResolution(t, [stubDir, realDir])

  if (process.platform === 'win32') {
    assert.ok(samePath(resolveOnPath('pwsh.exe'), real), '0 字节别名应被跳过，回退到真实候选')
  } else {
    // 非 Windows 没有别名语义，0 字节文件照常命中（不引入平台无关的误判）
    assert.ok(samePath(resolveOnPath('pwsh.exe'), path.join(stubDir, 'pwsh.exe')))
  }
})

test('resolveOnPath：非法输入返回空串且不抛', (t) => {
  isolateResolution(t, [tmpdir(t, 'dsh-bad-')])
  for (const v of [undefined, null, '', 42, {}, []]) {
    assert.equal(resolveOnPath(v), '', String(v))
  }
})

test('resolvePowerShell：DSH_REMOTE_PWSH 原样优先（即使是错的也不静默换掉）', (t) => {
  const dir = tmpdir(t, 'dsh-env-')
  fakeExe(dir, 'powershell.exe')
  isolateResolution(t, [dir])
  // 故意指向一个不存在的路径：用户显式指定了就用它，失败了要给清晰错误，
  // 而不是被静默换成别的 shell 把配置问题掩盖掉。
  const bogus = path.join(dir, 'no-such-pwsh.exe')
  scopedEnv({ DSH_REMOTE_PWSH: bogus }, () => {
    assert.equal(resolvePowerShell(), bogus)
    const d = describePowerShell()
    assert.equal(d.fromEnv, true)
    assert.equal(d.exists, false, '应如实报告"不存在"，不掩盖')
  })
  // 空白值等于没设置
  scopedEnv({ DSH_REMOTE_PWSH: '   ' }, () => {
    assert.notEqual(resolvePowerShell(), '   ')
  })
  // 还原之后必须回到"非来自环境"的状态（防泄漏到后续用例）
  assert.equal(describePowerShell().fromEnv, false)
})

test('resolvePowerShell：声明顺序 —— 常见安装位置 > PATH 上的 pwsh > Windows PowerShell 5.1', (t) => {
  /* ① 绝对安装位置优先于 PATH */
  const pf = tmpdir(t, 'dsh-pf-')
  const installed = fakeExe(path.join(pf, 'PowerShell', '7'), 'pwsh.exe')
  const pathDir = tmpdir(t, 'dsh-path-')
  fakeExe(pathDir, 'pwsh.exe')
  fakeExe(pathDir, 'powershell.exe')
  isolateResolution(t, [pathDir])
  scopedEnv({ ProgramFiles: pf }, () => {
    assert.ok(samePath(resolvePowerShell(), installed), '绝对安装位置应先于 PATH 被检查')
  })

  /* ② 没有 pwsh 时回退到 PATH 上的 powershell.exe */
  const onlyPs = tmpdir(t, 'dsh-ps51-')
  const ps51 = fakeExe(onlyPs, 'powershell.exe')
  isolateResolution(t, [onlyPs])
  assert.ok(samePath(resolvePowerShell(), ps51), '本机只有 5.1 时必须解析到真实路径')

  /* ③ 什么都没有时回退到字面量（调用方会得到明确的 ENOENT，而不是被换成别的 shell） */
  isolateResolution(t, [tmpdir(t, 'dsh-empty-path-')])
  assert.equal(resolvePowerShell(), 'powershell.exe')
})

test('resolvePowerShell：解析结果必须是"能用"的，不是历史 ENOENT 形态', (t) => {
  // 历史缺陷：对非绝对路径候选直接 `return c`，在一台只有 PS 5.1 的机器上
  // 返回了不存在的 'pwsh.exe'，每条 exec 任务都以 ENOENT 失败。
  // 断言的是**不变量**而不是本机装了什么：在"完全隔离"的环境里，
  // 解析结果要么是真实存在的绝对路径，要么是声明列表里的最后一个兜底字面量。
  const pathDir = tmpdir(t, 'dsh-real-')
  const real = fakeExe(pathDir, 'powershell.exe')
  isolateResolution(t, [pathDir])
  const resolved = resolvePowerShell()
  assert.ok(samePath(resolved, real), '隔离环境下必须解析到临时目录里那个真实文件')
  assert.ok(fs.existsSync(resolved))
  assert.notEqual(fs.statSync(resolved).size, 0, '解析结果不能是 0 字节别名')

  // 空 PATH：落到字面量兜底，且该字面量在声明列表里
  isolateResolution(t, [])
  const fallback = resolvePowerShell()
  assert.equal(typeof fallback, 'string')
  assert.ok(fallback !== '', '兜底不能是空串')
  if (!path.isAbsolute(fallback)) {
    assert.equal(fallback, 'powershell.exe', '非绝对路径只允许是最后的兜底字面量')
  }

  // 本机真实环境：只要解析出绝对路径，它就必须真实存在且不是 0 字节别名
  const native = resolvePowerShell()
  if (path.isAbsolute(native)) {
    assert.ok(fs.existsSync(native), `本机解析出的绝对路径必须存在：${native}`)
    assert.notEqual(fs.statSync(native).size, 0, `本机解析结果不能是 0 字节别名：${native}`)
  }
})

test('describePowerShell：形状正确、字段自洽、不抛', (t) => {
  const dir = tmpdir(t, 'dsh-desc-')
  fakeExe(dir, 'pwsh.exe')
  isolateResolution(t, [dir])
  const d = describePowerShell()
  assert.deepEqual(Object.keys(d).sort(), ['exists', 'family', 'fromEnv', 'resolved'])
  assert.equal(typeof d.resolved, 'string')
  assert.equal(d.exists, true)
  assert.equal(d.fromEnv, false)
  assert.equal(d.family, 'pwsh-7', 'pwsh 应被识别为 pwsh-7')

  isolateResolution(t, [tmpdir(t, 'dsh-desc2-')])
  scopedEnv({ DSH_REMOTE_PWSH: fakeExe(dir, 'powershell.exe') }, () => {
    const d2 = describePowerShell()
    assert.equal(d2.family, 'windows-powershell-5.1')
    assert.equal(d2.fromEnv, true)
  })
  // 还原后不得残留（防环境泄漏让后续用例假绿）
  assert.equal(describePowerShell().fromEnv, false)
})

/* ───────────────────────── wrapPowerShell 退出码语义 ───────────────────────── */

test('wrapPowerShell：$? 捕获在命令执行之后，且判定顺序是 $? → LASTEXITCODE → exit 1', (t) => {
  const cmd = "Write-Output 'user-command-marker'"
  const script = wrapPowerShell(cmd, { cwd: 'C:\\work' })

  const iCmd = script.indexOf(cmd)
  const iOk = script.indexOf('$__dsh_ok = $?')
  const iOkExit = script.indexOf('if ($__dsh_ok) { exit 0 }')
  const iLast = script.indexOf('if ($LASTEXITCODE -ne $null')
  const iExit1 = script.lastIndexOf('exit 1')

  assert.notEqual(iCmd, -1, '用户命令必须在脚本里')
  assert.notEqual(iOk, -1, '必须捕获 $?')
  assert.notEqual(iLast, -1, '必须有 LASTEXITCODE 分支')
  assert.notEqual(iExit1, -1, '必须有 exit 1 兜底')

  // 顺序断言 —— 这是本函数的核心契约
  assert.ok(iCmd < iOk, '$? 必须在命令**执行之后**捕获，否则捕获的是上一条语句的状态')
  assert.ok(iOk < iOkExit, '捕获之后才判定')
  assert.ok(iOkExit < iLast, '$? 分支必须在 LASTEXITCODE 分支**之前**')
  assert.ok(iLast < iExit1, 'exit 1 是最后的兜底')

  // 分支结构断言（不只是"文本里有 $?"）
  assert.match(script, /^\$__dsh_ok = \$\?$/m, '$? 捕获必须是独立的赋值语句')
  assert.match(script, /^if \(\$__dsh_ok\) \{ exit 0 \}$/m, '成功分支必须显式 exit 0')
  assert.match(
    script,
    /^if \(\$LASTEXITCODE -ne \$null -and \$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}$/m,
    'native 非 0 必须原样传出退出码',
  )
  assert.match(script, /^exit 1$/m, 'cmdlet 失败必须落到 exit 1')
})

test('wrapPowerShell：不得用 `& { command }` 包装（会让 $? 恒真）', (t) => {
  const script = wrapPowerShell("Get-Item 'C:\\nope'")
  // 早期版本写成 `& { <command> }`，块调用本身成功会让 $? 恒为 true，
  // 于是 cmdlet 失败被静默折成 exit 0 → 失败的 exec 任务被上报成 completed。
  assert.ok(!/&\s*\{/.test(script), '不得出现 & { ... } 块调用包装')
  assert.ok(!/\|\s*Out-Null/.test(script), '不得吞掉输出')
  assert.ok(script.includes("Get-Item 'C:\\nope'"), '用户命令必须原样出现，不被包装')
})

test('wrapPowerShell：编码行 + cwd 处理 + 单引号转义', (t) => {
  const script = wrapPowerShell('Write-Output 1', { cwd: "C:\\it's a dir" })
  assert.match(script, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/, '必须强制 UTF-8 输出编码')
  assert.match(script, /\$OutputEncoding = \[System\.Text\.Encoding\]::UTF8/)
  assert.match(script, /Set-Location -LiteralPath/, 'cwd 用 LiteralPath，避免通配符展开')
  assert.ok(script.includes("'C:\\it''s a dir'"), 'cwd 里的单引号必须按 PS 规则双写转义')
  assert.ok(!/Set-Location[^\n]*C:\\it's a dir'/.test(script), '未转义的单引号会截断字符串')

  // 不给 cwd 时也要有稳定的空串判断，不能变成 undefined 文本
  const noCwd = wrapPowerShell('Write-Output 1')
  assert.ok(!noCwd.includes('undefined'), 'cwd 缺省不得渲染成 undefined')
})

test('wrapPowerShell：真实 PowerShell 下失败 cmdlet 得到非 0，成功得到 0', (t) => {
  const ps = realPowerShell()
  if (ps === '') {
    t.skip('本机没有可用的 PowerShell')
    return
  }

  const ok = runPowerShell(ps, wrapPowerShell("Write-Output 'hello'"))
  assert.equal(ok.code, 0, `成功命令应 exit 0，stderr=${ok.stderr}`)

  const bad = runPowerShell(ps, wrapPowerShell("Get-Item 'C:\\definitely\\missing\\dsh-nope'"))
  assert.equal(bad.code, 1, '失败的 cmdlet 必须得到非 0（否则失败任务会被上报成 completed）')
  assert.ok(bad.stderr.length > 0, '失败时 stderr 必须有可读信息')

  // native 非 0 退出码必须原样传出，而不是被折成 1。
  // 探针命令按平台给：cmd 只在 Windows 有；Linux 的 pwsh 用 sh。
  // （此前无条件用 `cmd /c exit 7`，CI 的 Ubuntu pwsh 上假红 —— cmd 不存在。）
  const nativeProbe = process.platform === 'win32' ? 'cmd /c exit 7' : "sh -c 'exit 7'"
  const native = runPowerShell(ps, wrapPowerShell(nativeProbe))
  assert.equal(native.code, 7, 'native 非 0 退出码应原样传出')

  // 先成功的 native 命令留下 0，不得掩盖后续 cmdlet 的失败
  const maskedProbe = process.platform === 'win32' ? 'cmd /c exit 0' : "sh -c 'exit 0'"
  const masked = runPowerShell(ps, wrapPowerShell(`${maskedProbe}\nGet-Item 'C:\\definitely\\missing\\dsh-nope'`))
  assert.equal(masked.code, 1, '先前的 $LASTEXITCODE=0 不得把后续 cmdlet 失败掩盖成成功')

  // 反向对照（negative control）：`& { }` 形态确实会把失败折成 0。
  // 这条证明上面的断言有牙齿 —— 若哪天有人"好心"加回块包装，上面那条会红。
  const wrapped = runPowerShell(
    ps,
    ['& { Get-Item \'C:\\definitely\\missing\\dsh-nope\' }', '$__dsh_ok = $?', 'if ($__dsh_ok) { exit 0 }', 'exit 1'].join('\n'),
  )
  assert.equal(wrapped.code, 0, '对照：& { } 包装确实会吞掉失败 —— 这正是被修掉的形态')
})

/* ───────────────────────────── buildSpawn ───────────────────────────── */

test('buildSpawn（Windows）：临时 .ps1 带 BOM，且用 -File 而非 -EncodedCommand', (t) => {
  const dir = tmpdir(t, 'dsh-bom-')
  scopedEnv({ DSH_REMOTE_PWSH: fakeExe(dir, 'pwsh.exe') }, () => {
    const sp = buildSpawn("Write-Output '中文路径测试'", { platform: PLATFORM.WINDOWS, cwd: undefined })
    t.after(() => sp.cleanup?.())

    // -File，不是 -EncodedCommand：后者会把 stderr 整体包成 `#< CLIXML` XML，
    // 副机 agent 无法据此判断失败原因。
    assert.ok(sp.args.includes('-File'), '必须用 -File')
    assert.ok(!sp.args.includes('-EncodedCommand'), '不得用 -EncodedCommand')
    assert.deepEqual(sp.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    assert.equal(sp.args[5], sp.args[sp.args.length - 1], '-File 之后必须紧跟脚本路径')

    const scriptFile = sp.args[sp.args.length - 1]
    assert.ok(scriptFile.endsWith('.ps1'), '脚本必须是 .ps1')
    assert.ok(fs.existsSync(scriptFile), '脚本必须真的写出来了')

    // 读前 3 字节验证 BOM：PS 5.1 靠它判定 UTF-8，否则按 GBK 读、中文字面量乱码
    const buf = fs.readFileSync(scriptFile)
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '必须以 UTF-8 BOM 开头')

    // 脚本内容 = BOM + wrapPowerShell 的输出
    assert.equal(buf.subarray(3).toString('utf8'), wrapPowerShell("Write-Output '中文路径测试'", { cwd: undefined }))

    const scriptDir = path.dirname(scriptFile)
    sp.cleanup()
    assert.equal(fs.existsSync(scriptDir), false, 'cleanup 必须回收临时脚本目录')
  })
})

test('buildSpawn（Windows）：脚本目录在系统临时目录下，每次调用互不覆盖', (t) => {
  const dir = tmpdir(t, 'dsh-two-')
  scopedEnv({ DSH_REMOTE_PWSH: fakeExe(dir, 'pwsh.exe') }, () => {
    const a = buildSpawn('Write-Output a', { platform: PLATFORM.WINDOWS })
    const b = buildSpawn('Write-Output b', { platform: PLATFORM.WINDOWS })
    t.after(() => {
      a.cleanup?.()
      b.cleanup?.()
    })
    const fa = a.args[a.args.length - 1]
    const fb = b.args[b.args.length - 1]
    assert.notEqual(fa, fb, '并发任务不能共用同一个脚本文件')
    assert.notEqual(path.dirname(fa), path.dirname(fb))
    assert.equal(fs.readFileSync(fa).subarray(3).toString('utf8'), wrapPowerShell('Write-Output a'))
    assert.equal(fs.readFileSync(fb).subarray(3).toString('utf8'), wrapPowerShell('Write-Output b'))
  })
})

test('buildSpawn（POSIX）：走 shell -c + wrapPosix，无临时文件', (t) => {
  const sp = buildSpawn('echo hi', { platform: PLATFORM.POSIX, cwd: '/tmp' })
  assert.equal(typeof sp.file, 'string')
  assert.ok(sp.file.length > 0)
  assert.deepEqual(sp.args.slice(0, 1), ['-c'])
  assert.equal(sp.args[1], wrapPosix('echo hi', { cwd: '/tmp' }))
  assert.equal(sp.cleanup, undefined, 'posix 分支不产生临时文件，不需要 cleanup')
})

/* ───────────────────────── shellQuote / wrapPosix ───────────────────────── */

test('shellQuote：空格 / 单引号 / $ / 反引号 / 换行都被安全包裹', (t) => {
  assert.equal(shellQuote('plain'), "'plain'")
  assert.equal(shellQuote('a b'), "'a b'")
  assert.equal(shellQuote('$HOME'), "'$HOME'", '单引号内 $ 不展开')
  assert.equal(shellQuote('`tick`'), "'`tick`'", '单引号内反引号不执行')
  assert.equal(shellQuote("it's"), "'it'\\''s'", '单引号按 POSIX 规则闭合-转义-重开')
  assert.equal(shellQuote('a"b'), "'a\"b'", '双引号在单引号内无需转义')
  assert.equal(shellQuote('a\\b'), "'a\\b'", '反斜杠在单引号内是字面量')
  assert.equal(shellQuote(''), "''")
  // 每个结果都必须以单引号开头结尾，且内部的单引号都已闭合转义
  for (const s of ['x y', "a'b'c", '$(whoami)', '`id`', 'a\nb']) {
    const q = shellQuote(s)
    assert.ok(q.startsWith("'") && q.endsWith("'"), `必须被单引号包裹：${q}`)
    // 去掉转义序列后，剩下的单引号数量必须为偶数（成对）
    const stripped = q.replace(/'\\''/g, '')
    assert.equal((stripped.match(/'/g) ?? []).length % 2, 0, `引号必须成对：${q}`)
  }
})

test('wrapPosix：cd 失败即 exit 127、pipefail、退出码直传', (t) => {
  const script = wrapPosix('echo hi', { cwd: '/tmp/some dir' })
  assert.match(script, /^cd '\/tmp\/some dir' \|\| exit 127\n/, 'cwd 必须被 shellQuote 包裹，失败即 127')
  assert.match(script, /set -o pipefail/)
  assert.match(script, /__dsh_rc=\$\?/)
  assert.match(script, /exit \$__dsh_rc/)
  assert.ok(script.indexOf('echo hi') > script.indexOf('set -o pipefail'), '用户命令在环境准备之后')
  assert.ok(script.indexOf('echo hi') < script.indexOf('__dsh_rc=$?'), '退出码捕获在用户命令之后')

  const noCwd = wrapPosix('echo hi')
  assert.ok(!noCwd.startsWith('cd '), '不给 cwd 时不得插入 cd')
})

test('wrapPosix：真实 sh 下退出码与转义行为正确', (t) => {
  const sh = realShell()
  if (sh === '') {
    t.skip('本机没有可用的 sh/bash')
    return
  }
  const run = (script) => spawnSync(sh, ['-c', script], { encoding: 'utf8', timeout: 30000 })

  assert.equal(run(wrapPosix('exit 9')).status, 9, '退出码必须直传')
  assert.equal(run(wrapPosix('false')).status, 1)
  assert.equal(run(wrapPosix('true')).status, 0)
  assert.equal(run(wrapPosix(`cd ${shellQuote('/no/such/dir/dsh')} || exit 127`)).status, 127, 'cd 失败即 127')

  // 含空格 / $ / 反引号的参数必须原样传出去，不被展开或截断
  const probe = wrapPosix(`printf '%s\\n' ${shellQuote('a b')} ${shellQuote('$HOME')} ${shellQuote('`id`')} ${shellQuote("q'q")}`)
  const r = run(probe)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trimEnd().split('\n'), ['a b', '$HOME', '`id`', "q'q"], '参数必须原样到达，不被展开/截断')
})

/* ─────────────────────── resolveWorkspace / isDenied ─────────────────────── */

test('resolveWorkspace：允许根内通过，根外与相对路径被拒', (t) => {
  const root = tmpdir(t, 'dsh-ws-')
  const inside = path.join(root, 'proj')
  fs.mkdirSync(inside)
  const ci = process.platform === 'win32'

  assert.equal(resolveWorkspace(inside, { roots: [root], caseInsensitive: ci }), fs.realpathSync.native(inside))

  const outside = tmpdir(t, 'dsh-out-')
  assert.throws(
    () => resolveWorkspace(outside, { roots: [root], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED && /outside allowed roots/.test(e.message),
  )

  // 兄弟目录前缀不能算"在里面"（C:/work 不应包含 C:/work2）
  const sibling = `${root}2`
  fs.mkdirSync(sibling, { recursive: true })
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }))
  assert.throws(
    () => resolveWorkspace(sibling, { roots: [root], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED,
  )

  assert.throws(
    () => resolveWorkspace('relative/path', { roots: [root], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED && /must be absolute/.test(e.message),
  )

  assert.throws(
    () => resolveWorkspace(inside, { roots: [], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED && /no allowed roots/.test(e.message),
    '没有配置允许根时必须拒绝一切，而不是放行',
  )

  assert.throws(
    () => resolveWorkspace('', { roots: [root], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED && /no workspace given/.test(e.message),
  )
})

test('resolveWorkspace：roots 的别名形态（符号链接 / 8.3 短名）必须与 target 的 realpath 口径一致', (t) => {
  // 根因回归：target 被 realpath（展开符号链接与 8.3 短名）而 roots 只做
  // 字面归一 —— 两边形态不同 → 前缀比对假阳性拒绝。真实触发场景：
  // GH Actions Windows runner 的 TEMP 是 `C:\Users\RUNNER~1\...`（8.3 短名），
  // os.tmpdir() 派生的 roots 保持短名，而子路径 realpath 成 runneradmin 长名，
  // 明明在根内却被判 workspace-denied（CI 上 5 条测试假红的同一根因）。
  // 用户配置符号链接目录 / 8.3 形态路径同理。用符号链接别名复现同一错位。
  const base = tmpdir(t, 'dsh-alias-')
  const real = path.join(base, 'real')
  fs.mkdirSync(real)
  const link = path.join(base, 'link')
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('当前环境无法创建符号链接/junction')
    return
  }
  const inside = path.join(real, 'proj')
  fs.mkdirSync(inside)
  // roots 用别名、workspace 用真身 —— 修复前这里抛 workspace-denied
  assert.equal(
    resolveWorkspace(inside, { roots: [link], caseInsensitive: true }),
    fs.realpathSync.native(inside),
  )
  // 反向同样要过：roots 用真身、workspace 从别名进入
  const viaLink = path.join(link, 'proj2')
  fs.mkdirSync(viaLink)
  assert.equal(
    resolveWorkspace(viaLink, { roots: [real], caseInsensitive: true }),
    fs.realpathSync.native(viaLink),
  )
})

/**
 * 8.3 短名形态回归（KNOWN-ISSUES §3 的模拟版）。
 *
 * 为什么是模拟而不是真实短名：本机 C: / D: 两个卷的 8.3 生成均关闭
 * （构造 `DOT3PR~1` 后 `statSync` 得 ENOENT，实测确认），且
 * `fsutil 8dot3name query` 需要管理员权限（拒绝访问）、
 * `fsutil file setShortName` 同样需要提权 —— 开发机上**无法构造真实短名**。
 * 但短名向量的代码路径与符号链接向量完全相同：`resolveWorkspace` 对
 * roots 与 target 都调 `fs.realpathSync.native`（短名与 junction 都由它
 * 展开），比对双方归一后的形态。
 *
 * 因此这里把 `fs.realpathSync.native` 换成映射表函数，模拟"启用 8.3 的卷上
 * GetFinalPathNameByHandle 把短名展开成长名"的行为，精确复现 GH Actions
 * Windows runner 的 TEMP 形态（`C:\Users\RUNNER~1\...`）：
 *   ① roots 配短名、workspace 用长名 → 修复前假阳性拒绝（CI 假红根因）
 *   ② roots 配长名、workspace 从短名进入 → 镜像方向同样必须放行
 *   ③ 短名展开到允许根之外 → 必须拒绝（短名不是偷渡通道）
 *   ④ 返回值必须是长名形态 —— 下游 mkdir / cwd 拿到短名，在禁用 8.3 的
 *      卷上会直接 ENOENT
 * 真实卷上的复核仍记在 KNOWN-ISSUES §3（残留风险已随本次模拟大幅下降）。
 */
test('resolveWorkspace：8.3 短名形态（模拟启用 8.3 的卷）与 target 同归 realpath 口径', (t) => {
  const base = tmpdir(t, 'dsh-83-')
  const longDir = path.join(base, 'verylongdirectoryname12345')
  const shortDir = path.join(base, 'VERYLON~1') // 8.3 确定性算法：前 6 字符大写 + ~1
  fs.mkdirSync(path.join(longDir, 'proj'), { recursive: true })

  const realNative = fs.realpathSync.native
  // 模拟卷：短名 → 长名；未映射的路径原样返回（真实 realpath 对其余输入的行为）。
  const fakeNative = (p) => {
    const s = String(p)
    const lower = s.toLowerCase()
    const shortLower = shortDir.toLowerCase()
    if (lower === shortLower) return longDir
    if (lower.startsWith(shortLower + path.sep)) return longDir + s.slice(shortDir.length)
    return s
  }
  fs.realpathSync.native = fakeNative
  t.after(() => {
    fs.realpathSync.native = realNative
  })

  const ci = true // 模拟 Windows 的大小写不敏感

  // ① roots 配短名、workspace 用长名 —— GH runner TEMP 假红的确切形态
  assert.equal(
    resolveWorkspace(path.join(longDir, 'proj'), { roots: [shortDir], caseInsensitive: ci }),
    path.join(longDir, 'proj'),
    'roots 是短名时必须展开后比对，不能假阳性拒绝',
  )

  // ② roots 配长名、workspace 从短名进入 —— 镜像方向，且返回值不带短名（④）
  assert.equal(
    resolveWorkspace(path.join(shortDir, 'proj'), { roots: [longDir], caseInsensitive: ci }),
    path.join(longDir, 'proj'),
    'workspace 是短名时必须展开成同一长名，返回值不能漏短名形态给下游',
  )

  // ③ 短名展开到允许根之外 → 拒绝。短名只是目录项，卷上完全可能指向
  //    与字面预期不同的位置（长名重建后旧项复用），判定必须以 realpath 为准。
  const outside = path.join(base, 'elsewhere')
  fs.mkdirSync(outside, { recursive: true })
  const escaping = path.join(base, 'ESCAPE~1')
  const fakeEscape = (p) => {
    const s = String(p)
    const lower = s.toLowerCase()
    const escLower = escaping.toLowerCase()
    if (lower === escLower) return outside
    if (lower.startsWith(escLower + path.sep)) return outside + s.slice(escaping.length)
    return fakeNative(p)
  }
  fs.realpathSync.native = fakeEscape
  try {
    assert.throws(
      () => resolveWorkspace(path.join(escaping, 'proj'), { roots: [longDir], caseInsensitive: ci }),
      (e) => e.code === ERROR_CODE.WORKSPACE_DENIED,
      '短名解析到根外时必须按 realpath 结果拒绝，字面前缀不算数',
    )
  } finally {
    fs.realpathSync.native = fakeNative
  }
})

test('resolveWorkspace：允许"尚不存在但父目录合法"的工作区（任务可能要创建它）', (t) => {
  const root = tmpdir(t, 'dsh-ws2-')
  const ci = process.platform === 'win32'

  // 父目录存在、目标本身不存在 → 放行（任务自己要建它）。
  // 返回值与 target 比较必须走 realpath 口径：GH runner 的 TEMP 是 8.3 短名
  // （RUNNER~1），macOS 的 /var 是 /private/var 的别名 —— resolveWorkspace
  // 返回的是 realpath 形态，与字面 target 相比必然不等（假红）。
  const parent = path.join(root, 'brand')
  fs.mkdirSync(parent)
  const target = path.join(parent, 'new')
  assert.equal(fs.existsSync(target), false)
  const parentReal = fs.realpathSync.native ? fs.realpathSync.native(parent) : fs.realpathSync(parent)
  assert.ok(
    samePath(resolveWorkspace(target, { roots: [root], caseInsensitive: ci }), path.join(parentReal, 'new')),
    '返回值必须是"realpath(parent) + 目标名"',
  )

  // 父目录本身也不可达 → 拒绝（"not reachable" 是刻意的深度限制：
  // 只允许最后一段不存在，不允许整条链凭空捏造）
  assert.throws(
    () => resolveWorkspace(path.join(root, 'a', 'b', 'c', 'd'), { roots: [root], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED && /not reachable/.test(e.message),
  )

  // 父目录存在但在允许根之外 → 仍必须被 roots 拦下（不能靠"不存在"绕过白名单）
  const outside = tmpdir(t, 'dsh-ws2-out-')
  assert.throws(
    () => resolveWorkspace(path.join(outside, 'new'), { roots: [root], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED && /outside allowed roots/.test(e.message),
  )
})

test('resolveWorkspace：根路径带尾分隔符 / 大小写差异仍正确判定', (t) => {
  const root = tmpdir(t, 'dsh-ws3-')
  const inside = path.join(root, 'sub')
  fs.mkdirSync(inside)
  const ci = process.platform === 'win32'

  assert.equal(resolveWorkspace(inside, { roots: [root + path.sep], caseInsensitive: ci }), fs.realpathSync.native(inside))
  if (process.platform === 'win32') {
    assert.equal(
      resolveWorkspace(inside.toUpperCase(), { roots: [root], caseInsensitive: true }),
      fs.realpathSync.native(inside),
      'Windows 下大小写不同不应被判成越界',
    )
  }
})

test('resolveWorkspace：工作区指向普通文件必须报 workspace-denied，而不是让后续 mkdir 抛内部错误', (t) => {
  // 缺陷背景：task-engine.accept() 在 resolveWorkspace 之后立刻
  // `fs.mkdirSync(workspace, { recursive: true })`，而 mkdir 对已存在的普通文件
  // 抛 EEXIST（recursive 只吞 EEXIST 的**目录**情形）。异常穿过 accept()，
  // 在 node/index.js 被折成 ERROR_CODE.INTERNAL ——
  // "workspace 写成了文件"这个纯输入错误被上报成"副机内部错误"，排查方向跑偏。
  const root = tmpdir(t, 'dsh-ws4-')
  const ci = process.platform === 'win32'
  const file = path.join(root, 'a-file.txt')
  fs.writeFileSync(file, 'x')

  assert.throws(
    () => resolveWorkspace(file, { roots: [root], caseInsensitive: ci }),
    (e) => e.code === ERROR_CODE.WORKSPACE_DENIED && /not a directory/.test(e.message),
  )

  // 对照：确认后续那步 mkdir 确实会抛（证明上面这条拦截是有意义的）
  assert.throws(() => fs.mkdirSync(file, { recursive: true }), (e) => e.code === 'EEXIST')
})

test('isDenied：绝对条目按段边界匹配，兄弟前缀不算命中', (t) => {
  const ci = process.platform === 'win32'
  const root = tmpdir(t, 'dsh-deny-')
  const secret = path.join(root, 'secret')
  const secretish = path.join(root, 'secretish')

  assert.equal(isDenied(secret, [secret], { caseInsensitive: ci }), true, '等于 deny 条目 → 命中')
  assert.equal(isDenied(path.join(secret, 'token.md'), [secret], { caseInsensitive: ci }), true, '在 deny 目录下 → 命中')
  assert.equal(isDenied(secretish, [secret], { caseInsensitive: ci }), false, '前缀相同的兄弟目录不算命中')
  assert.equal(isDenied(path.join(root, 'public', 'a.md'), [secret], { caseInsensitive: ci }), false)
  assert.equal(isDenied(secret, [], { caseInsensitive: ci }), false, '空 deny 表不拒任何东西')

  // 盘符 / 根路径
  assert.equal(isDenied('C:\\work\\a.txt', ['C:\\work'], { caseInsensitive: true }), true)
  assert.equal(isDenied('C:\\work2\\a.txt', ['C:\\work'], { caseInsensitive: true }), false)
  assert.equal(isDenied('/etc/passwd', ['/etc'], {}), true)
  assert.equal(isDenied('/etc/passwd', ['/'], {}), true, 'deny 根路径应拒掉一切')
  assert.equal(isDenied('/etcx/passwd', ['/etc'], {}), false)
})

test('isDenied：相对条目必须生效（历史上与绝对路径比前缀，被静默忽略）', (t) => {
  // 真实调用方 task-engine.snapshotWorkspace 传进来的是**绝对** childAbs，
  // 而 cfg.denyPaths / constraints.denyPaths 可以是相对写法。
  // 旧实现只做 `p === nd || p.startsWith(nd + '/')`，相对条目永不相等 →
  // 相对 denyPaths 被静默忽略，被禁路径的内容照常上报给 hub。
  // 与 artifacts.js 修过的 D1 完全同类：同一份配置"有时管用"最危险。
  const root = process.platform === 'win32' ? 'C:\\work' : '/work'
  const denied = process.platform === 'win32' ? 'C:\\work\\secret\\token.md' : '/work/secret/token.md'
  const ci = process.platform === 'win32'

  assert.equal(isDenied(denied, ['secret'], { caseInsensitive: ci }), true, '相对条目应匹配任意段边界')
  assert.equal(isDenied(denied, ['secret/token.md'], { caseInsensitive: ci }), true, '多段相对条目')
  assert.equal(isDenied(denied, ['work/secret'], { caseInsensitive: ci }), true, '跨多段相对条目')
  assert.equal(isDenied(path.join(root, 'public', 'a.md'), ['secret'], { caseInsensitive: ci }), false)
  assert.equal(
    isDenied(process.platform === 'win32' ? 'C:\\work\\secretary\\a' : '/work/secretary/a', ['secret'], { caseInsensitive: ci }),
    false,
    '相对条目也必须按段边界匹配，不能命中 secretary',
  )
})

test('isDenied：空串 / 非字符串条目必须被跳过（否则两种平台给出相反的极端行为）', (t) => {
  // 缺陷背景：normalizePath('') / (null) / (42) 都返回 ''，而空条目的比对是
  // `p === '' || p.startsWith('/')`：
  //   POSIX  ('/etc/passwd') → startsWith('/') 恒真 → 整张表变成"全部拒绝"
  //   Windows('c:/work/a')  → 不以 '/' 开头     → 变成"什么都不拒"
  // 同一个非法输入在两种平台上给出**相反**的极端行为，而且两边都是静默的。
  const posixPath = '/etc/passwd'
  const winPath = 'C:\\work\\a.txt'

  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    assert.equal(isDenied(posixPath, [bad], {}), false, `POSIX 路径不应被 ${JSON.stringify(bad)} 全拒`)
    assert.equal(isDenied(winPath, [bad], { caseInsensitive: true }), false, `Windows 路径不应被 ${JSON.stringify(bad)} 影响`)
  }

  // 混入非法条目时，合法的 deny 条目仍须正常生效
  assert.equal(isDenied(winPath, ['', 'C:\\work'], { caseInsensitive: true }), true)
  assert.equal(isDenied('/etc/passwd', ['', '/etc'], {}), true)

  /**
   * 【判别性断言 —— 纯空白条目】
   *
   * 为什么必须单独写这一组：上面那批断言里的**路径不含纯空白段**，
   * 所以「跳过纯空白条目」这条守卫在不在，结果都是 false —— 断言恒真。
   * 实测：把 `if (raw.trim() === '') continue` 删掉，上面全部断言仍然通过。
   *
   * 根因是 normalizePath **不做 trim**：normalizePath('   ') === '   '，
   * 于是纯空白条目会走到相对分支、被当成一个合法的路径段参与匹配。
   * 只有让**被测路径本身含纯空白段**，这条守卫的存在与否才可观测：
   *   有守卫 → 纯空白条目被忽略 → false
   *   无守卫 → 它匹配上路径里的空白段 → true
   * 后一种行为是错的：用户误配一个空白条目不该变成"拒绝一切含空白段的路径"。
   */
  assert.equal(isDenied('/work/   /x', ['   '], {}), false, '纯空白条目必须被忽略（不能被当成路径段匹配上）')
  assert.equal(isDenied('/work/\t/x', ['\t'], {}), false, '制表符条目同样必须被忽略')
  assert.equal(isDenied('C:/w/   /a', ['   '], { caseInsensitive: true }), false, 'Windows 侧同样')
  assert.equal(isDenied('/work/   /x', ['   ', '/etc'], {}), false, '混入空白条目不影响其他条目判定')
  assert.equal(isDenied('/etc/passwd', ['   ', '/etc'], {}), true, '空白条目不得让同表的合法条目失效')

  // 正向对照：同样的路径形态，用**非空白**条目必须能命中。
  // 这条证明上面的 false 是"条目被忽略"而不是"路径根本没被检查"。
  assert.equal(isDenied('/work/   /x', ['work'], {}), true, '对照：非空白条目对同一路径能命中')
  assert.equal(isDenied('/work/\t/x', ['work'], {}), true, '对照：制表符路径同样能被正常条目命中')
})

/* ─────────────────── defaultRoots / detectPlatform ─────────────────── */

test('detectPlatform：返回冻结枚举之一，与 process.platform 一致', (t) => {
  const p = detectPlatform()
  assert.ok(p === PLATFORM.WINDOWS || p === PLATFORM.POSIX, `未知平台：${p}`)
  assert.equal(p, process.platform === 'win32' ? PLATFORM.WINDOWS : PLATFORM.POSIX)
  assert.equal(Object.isFrozen(PLATFORM), true, 'PLATFORM 必须是冻结的')
})

test('defaultRoots：返回单个绝对路径且目录真的被建出来，不抛', (t) => {
  // 用假 home 隔离：绝不碰用户的真实 home
  const fakeHome = tmpdir(t, 'dsh-home-')
  const orig = os.homedir
  os.homedir = () => fakeHome
  t.after(() => {
    os.homedir = orig
  })

  const roots = defaultRoots()
  assert.ok(Array.isArray(roots), '必须返回数组')
  assert.equal(roots.length, 1)
  assert.equal(typeof roots[0], 'string')
  assert.ok(path.isAbsolute(roots[0]), `必须是绝对路径：${roots[0]}`)
  assert.equal(roots[0], path.join(fakeHome, 'dsh-remote-work'))
  assert.equal(fs.existsSync(roots[0]), true, '返回的默认根必须真实存在')
  assert.equal(fs.statSync(roots[0]).isDirectory(), true)

  // 首选目录建不出来时退回 home 本身，而不是抛
  const blocker = path.join(fakeHome, 'blocker')
  fs.writeFileSync(blocker, 'x')
  os.homedir = () => path.join(blocker, 'nope')
  const fallback = defaultRoots()
  assert.ok(Array.isArray(fallback) && fallback.length === 1, '失败路径也必须返回可用形状')
  assert.ok(path.isAbsolute(fallback[0]))
})
