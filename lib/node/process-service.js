/**
 * 进程与端口诊断（2026-10-20，用户要求"更多工具 = 进程与端口诊断"）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要（来自真实排查经历）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这两天排查"副机连不上"时，最耗时的几步全靠手工：
 *
 *     netstat -ano | findstr :19387          # 谁占着端口
 *     Get-NetTCPConnection -LocalPort 19387  # 同上，更结构化
 *     Get-Process -Id 12345                  # 那个 PID 是什么
 *     taskkill /PID 12345 /F                 # 杀掉卡住的进程
 *
 * 而这些恰恰是**远程排查时最需要**的：用户不在副机前面，看不见任务管理器。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 能力边界（哪一半是只读，哪一半会改状态）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · `list`（列进程）—— **只读**，安全
 *   · `port`（查端口占用）—— **只读**，安全
 *   · `kill`（杀进程）—— **改状态，不可逆** → 必须 confirm: 'yes'
 *
 * kill 的危险性：
 *   · 杀错进程会让副机上的任务全崩（甚至把 DSH 自己杀掉）
 *   · Windows 上误杀系统进程可能导致蓝屏
 *
 * 所以 kill 有三道约束（见 `killProcess`）：
 *   1. 必须显式 `confirm: 'yes'`
 *   2. **默认拒绝杀本进程及其父进程**（防"AI 把自己杀了"）
 *   3. 拒绝杀一批关键系统进程（System / csrss / wininit / services / lsass）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 实现选择：用 node 原生 + PowerShell，不引依赖
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 零依赖是核心卖点，所以：
 *   · Windows 走 PowerShell（`Get-Process` / `Get-NetTCPConnection`），
 *     回退 `netstat`（老系统没有 Get-NetTCPConnection）
 *   · 其它平台走 `ps` / `ss`（或 `lsof`）
 *
 * **所有命令都是写死的常量**，唯一的外部输入（PID、端口）经过严格校验后
 * 作为数字/白名单参数传入 —— 没有字符串拼接注入面。
 */

import { spawnSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'
const DEFAULT_TIMEOUT_MS = 8000

/**
 * 一批**绝不允许**被 kill 的进程名（Windows）。
 *
 * 为什么需要：这些是系统关键进程，杀掉会导致蓝屏或系统不可用。
 * 注意这里只防"手滑/误判"，不防恶意 —— 有管理员权限的人总能绕过。
 */
const PROTECTED_PROCESS_NAMES = new Set([
  'system',
  'system idle process',
  'registry',
  'memory compression',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'smss.exe',
  'svchost.exe',
  'dwm.exe',
  'explorer.exe',
  'fontdrvhost.exe',
  'sihost.exe',
  'ctfmon.exe',
])

/** 跑一个命令，返回 { ok, stdout, stderr, code }。不抛。 */
function run(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      shell: false,
      maxBuffer: 8 * 1024 * 1024,
    })
    return {
      ok: r.status === 0,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      code: typeof r.status === 'number' ? r.status : -1,
      error: r.error ? String(r.error.message ?? r.error) : '',
    }
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', code: -1, error: String(err?.message ?? err) }
  }
}

/** 校验 PID：必须是正整数。 */
export function normalizePid(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 0x7fffffff) return 0
  return n
}

/** 校验端口：1-65535。 */
export function normalizePort(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) return 0
  return n
}

/**
 * 列进程。
 *
 * @param {object} [o]
 * @param {number} [o.limit] 最多返回多少个（默认 200，按 CPU/内存排序前的原始顺序）
 * @param {string} [o.filter] 按进程名子串过滤（不区分大小写）
 * @returns {{platform:string, processes:Array, truncated:boolean, error?:string}}
 */
export function listProcesses({ limit = 200, filter = '' } = {}) {
  const max = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  const needle = typeof filter === 'string' ? filter.trim().toLowerCase() : ''

  if (IS_WIN) {
    // PowerShell 输出 JSON，比解析 netstat/tasklist 的表格稳得多。
    //
    // ⚠ 多行脚本用 `;` 拼接，**不能只 join(' ')** —— 那样 `$ErrorActionPreference="Stop"`
    // 和 `Get-Process` 之间没有分隔符，PowerShell 会报 UnexpectedToken。
    // （第一版就是这么写的，实测立刻暴露。）
    const script = [
      '$ErrorActionPreference="Stop";',
      'Get-Process | Select-Object Id,ProcessName,',
      '@{N="cpuSec";E={try{[math]::Round($_.CPU,1)}catch{0}}},',
      '@{N="memMb";E={try{[math]::Round($_.WorkingSet64/1MB,1)}catch{0}}},',
      '@{N="startedAt";E={try{$_.StartTime.ToString("o")}catch{""}}} |',
      'ConvertTo-Json -Compress -Depth 3',
    ].join(' ')
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15000 })
    if (!r.ok || r.stdout.trim() === '') {
      return { platform: process.platform, processes: [], truncated: false, error: r.error || r.stderr || '无法枚举进程' }
    }
    let arr
    try {
      const parsed = JSON.parse(r.stdout)
      arr = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return { platform: process.platform, processes: [], truncated: false, error: '进程列表解析失败' }
    }
    let list = arr.map((p) => ({
      pid: Number(p?.Id) || 0,
      name: String(p?.ProcessName ?? ''),
      cpuSec: Number(p?.cpuSec) || 0,
      memMb: Number(p?.memMb) || 0,
      startedAt: String(p?.startedAt ?? ''),
    }))
    if (needle !== '') list = list.filter((p) => p.name.toLowerCase().includes(needle))
    const truncated = list.length > max
    return { platform: process.platform, processes: list.slice(0, max), truncated }
  }

  // POSIX：ps 的字段在不同系统上略有差异，用最保守的集合
  const r = run('ps', ['-eo', 'pid=,comm=,%cpu=,rss=,lstart='], { timeoutMs: 10000 })
  if (!r.ok) {
    return { platform: process.platform, processes: [], truncated: false, error: r.error || r.stderr || 'ps 不可用' }
  }
  let list = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    const m = /^(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(t)
    if (!m) continue
    list.push({
      pid: Number(m[1]),
      name: m[2],
      cpuSec: Number(m[3]) || 0,
      // ps 的 rss 是 KB
      memMb: Math.round((Number(m[4]) || 0) / 1024 * 10) / 10,
      startedAt: m[5].trim(),
    })
  }
  if (needle !== '') list = list.filter((p) => p.name.toLowerCase().includes(needle))
  const truncated = list.length > max
  return { platform: process.platform, processes: list.slice(0, max), truncated }
}

/**
 * 查端口占用（哪个 PID 在监听/连接这个端口）。
 *
 * @param {number} port
 * @returns {{port:number, listeners:Array, error?:string}}
 */
export function portUsage(port) {
  const p = normalizePort(port)
  if (p === 0) return { port: 0, listeners: [], error: '端口必须是 1-65535 的整数' }

  if (IS_WIN) {
    // 首选结构化命令
    const script = [
      '$ErrorActionPreference="SilentlyContinue"',
      `Get-NetTCPConnection -LocalPort ${p} |`,
      '  Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess |',
      '  ConvertTo-Json -Compress -Depth 3',
    ].join(' ')
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 12000 })
    if (r.ok && r.stdout.trim() !== '') {
      try {
        const parsed = JSON.parse(r.stdout)
        const arr = Array.isArray(parsed) ? parsed : [parsed]
        return {
          port: p,
          listeners: arr.map((x) => ({
            localAddress: String(x?.LocalAddress ?? ''),
            localPort: Number(x?.LocalPort) || p,
            remoteAddress: String(x?.RemoteAddress ?? ''),
            remotePort: Number(x?.RemotePort) || 0,
            state: String(x?.State ?? ''),
            pid: Number(x?.OwningProcess) || 0,
          })),
        }
      } catch {
        /* 落到 netstat 回退 */
      }
    }
    // 回退：netstat（老系统 / Get-NetTCPConnection 不可用）
    const n = run('netstat', ['-ano'], { timeoutMs: 12000 })
    if (!n.ok) return { port: p, listeners: [], error: n.error || n.stderr || 'netstat 不可用' }
    const listeners = []
    for (const line of n.stdout.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.toUpperCase().startsWith('TCP')) continue
      const cols = t.split(/\s+/)
      // TCP  local  foreign  state  pid
      if (cols.length < 5) continue
      const local = cols[1]
      const idx = local.lastIndexOf(':')
      if (idx < 0) continue
      if (Number(local.slice(idx + 1)) !== p) continue
      const pid = Number(cols[cols.length - 1]) || 0
      listeners.push({
        localAddress: local.slice(0, idx),
        localPort: p,
        remoteAddress: '',
        remotePort: 0,
        state: cols[3] ?? '',
        pid,
      })
    }
    return { port: p, listeners }
  }

  // POSIX：ss 优先，回退 lsof
  const ss = run('ss', ['-lntp'], { timeoutMs: 10000 })
  if (ss.ok) {
    const listeners = []
    for (const line of ss.stdout.split(/\r?\n/)) {
      if (!line.includes(`:${p} `) && !line.includes(`:${p}\t`)) continue
      const cols = line.trim().split(/\s+/)
      const local = cols[3] ?? ''
      const idx = local.lastIndexOf(':')
      if (idx < 0 || Number(local.slice(idx + 1)) !== p) continue
      const pidM = /pid=(\d+)/.exec(line)
      listeners.push({
        localAddress: local.slice(0, idx),
        localPort: p,
        remoteAddress: '',
        remotePort: 0,
        state: cols[0] ?? '',
        pid: pidM ? Number(pidM[1]) : 0,
      })
    }
    return { port: p, listeners }
  }
  const lsof = run('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { timeoutMs: 10000 })
  if (!lsof.ok) return { port: p, listeners: [], error: 'ss 与 lsof 都不可用' }
  const listeners = []
  for (const line of lsof.stdout.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 2) continue
    listeners.push({
      localAddress: '',
      localPort: p,
      remoteAddress: '',
      remotePort: 0,
      state: 'LISTEN',
      pid: Number(cols[1]) || 0,
    })
  }
  return { port: p, listeners }
}

/**
 * 杀掉一个进程。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三道约束（每一道都防一种真实事故）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. **必须 confirm: 'yes'** —— 调用方（通常是 AI）要显式表示知情
 *   2. **拒绝杀本进程与父进程** —— 防"AI 把自己杀了"导致副机失联，
 *      那会让用户彻底失去远程修复能力（最坏的结果）
 *   3. **拒绝杀关键系统进程** —— 防蓝屏
 *
 * @param {object} o
 * @param {number} o.pid
 * @param {string} o.confirm 必须 'yes'
 * @param {number} [o.selfPid] 本进程 PID（默认 process.pid）
 * @param {number} [o.parentPid] 父进程 PID（默认 process.ppid）
 * @returns {{ok:boolean, pid:number, name?:string, error?:string}}
 */
export function killProcess({ pid, confirm, selfPid = process.pid, parentPid = process.ppid } = {}) {
  if (confirm !== 'yes') {
    return { ok: false, pid: 0, error: '杀进程需要显式传 confirm: "yes"（不可逆操作）' }
  }
  const n = normalizePid(pid)
  if (n === 0) return { ok: false, pid: 0, error: 'pid 必须是正整数' }

  // 约束 2：绝不杀自己或父进程 —— 否则副机失联，用户失去远程修复能力
  if (n === selfPid) {
    return { ok: false, pid: n, error: '拒绝：这是本插件自己的进程（杀掉会让副机失联）' }
  }
  if (n === parentPid) {
    return { ok: false, pid: n, error: '拒绝：这是本插件的父进程（通常是 DSH 本体，杀掉会让副机失联）' }
  }

  // 先查进程名（用于关键进程保护 + 返回信息）
  let name
  try {
    if (IS_WIN) {
      const r = run('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${n} -ErrorAction SilentlyContinue).ProcessName`,
      ], { timeoutMs: 8000 })
      name = r.ok ? r.stdout.trim() : ''
    } else {
      const r = run('ps', ['-p', String(n), '-o', 'comm='], { timeoutMs: 6000 })
      name = r.ok ? r.stdout.trim() : ''
    }
  } catch {
    name = ''
  }

  // 约束 3：关键系统进程
  const lower = name.toLowerCase()
  if (lower !== '' && PROTECTED_PROCESS_NAMES.has(lower)) {
    return { ok: false, pid: n, name, error: `拒绝：${name} 是系统关键进程，杀掉可能导致系统不可用` }
  }

  // 执行
  if (IS_WIN) {
    const r = run('taskkill', ['/PID', String(n), '/F'], { timeoutMs: 10000 })
    if (!r.ok) {
      return { ok: false, pid: n, name, error: (r.stderr || r.error || 'taskkill 失败').trim().slice(0, 200) }
    }
    return { ok: true, pid: n, name }
  }
  const r = run('kill', ['-TERM', String(n)], { timeoutMs: 8000 })
  if (!r.ok) {
    return { ok: false, pid: n, name, error: (r.stderr || r.error || 'kill 失败').trim().slice(0, 200) }
  }
  return { ok: true, pid: n, name }
}

/** 渲染进程列表（人读）。 */
export function renderProcesses(result) {
  if (!result || !Array.isArray(result.processes)) return '（无数据）'
  if (result.error) return `枚举失败：${result.error}`
  const lines = [`进程（${result.processes.length} 个${result.truncated ? '，已截断' : ''}）`, '']
  lines.push('PID\t内存\tCPU秒\t名称')
  for (const p of result.processes) {
    lines.push(`${p.pid}\t${p.memMb}MB\t${p.cpuSec}\t${p.name}`)
  }
  return lines.join('\n')
}

/** 渲染端口占用（人读）。 */
export function renderPortUsage(result) {
  if (!result) return '（无数据）'
  if (result.error) return `查询失败：${result.error}`
  if (!Array.isArray(result.listeners) || result.listeners.length === 0) {
    return `端口 ${result.port}：没有进程在监听或连接。`
  }
  const lines = [`端口 ${result.port}：${result.listeners.length} 条连接`, '']
  for (const l of result.listeners) {
    lines.push(`  ${l.state || '?'}\t${l.localAddress}:${l.localPort}\tPID ${l.pid}`)
  }
  return lines.join('\n')
}

/**
 * 创建进程服务对象（与 `createFsService` 同款工厂形态）。
 *
 * 为什么用工厂而不是直接导出函数对象：
 *   · 与 `fsService` 保持一致的调用形态（副机侧按 `svc[fn](d)` 分发）
 *   · 将来若要加"允许杀哪些进程"的白名单配置，这里能接 cfg，
 *     而不用改副机侧的调用点
 *
 * 当前不接任何配置 —— 少一个配置面就少一类配置错误。
 */
export function createProcessService() {
  return {
    ps: (d) => listProcesses(d ?? {}),
    port: (d) => portUsage(d?.port),
    kill: (d) => killProcess(d ?? {}),
  }
}
