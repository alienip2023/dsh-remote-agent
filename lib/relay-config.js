/**
 * relay CLI 的配置层（零外部依赖）。
 *
 * 职责边界：
 *   - 只做「参数解析 + 凭证落盘 + 输出格式化」三件事，不碰网络、不起服务。
 *   - 明文 token 只允许出现在 stdout 的显式打印路径上；日志/ready 行一律用指纹。
 *
 * 凭证文件：<data-dir>/tokens.json
 *   { "version": 1, "hubToken": "rt_...", "enrollToken": "en_...", "createdAt": "..." }
 *   POSIX 上 chmod 0600；Windows 上 chmod 无意义，改用 icacls 收窄到当前用户（best effort）。
 *   已存在但内容损坏时**不静默轮换**（静默轮换会让已发出去的副机全部掉线），而是抛可读错误。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newRelayToken, tokenFingerprint } from './relay.js'

export const DEFAULT_PORT = 8890
export const DEFAULT_HOST = '0.0.0.0'
export const TOKENS_FILE = 'tokens.json'
export const TOKENS_FILE_VERSION = 1

/** 默认凭证目录：~/.dsh-remote-agent-relay */
export function defaultDataDir() {
  return path.join(os.homedir(), '.dsh-remote-agent-relay')
}

/**
 * 收窄文件权限到「只有本人可读写」。
 * POSIX：chmod 0600（目录 0700）。
 * Windows：chmod 是空操作，用 icacls 去掉继承并只授权当前用户；失败只忽略，不影响主流程。
 */
export function restrictPermissions(target, { isDir = false } = {}) {
  try {
    fs.chmodSync(target, isDir ? 0o700 : 0o600)
  } catch {
    /* 某些文件系统（FAT/网络盘）不支持 mode，忽略 */
  }
  if (process.platform !== 'win32') return

  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME
  if (!user) return
  try {
    spawnSync(
      'icacls',
      [target, '/inheritance:r', '/grant:r', isDir ? `${user}:(OI)(CI)F` : `${user}:F`],
      { stdio: 'ignore', timeout: 5000, windowsHide: true },
    )
  } catch {
    /* icacls 不存在或被策略拦住：保持默认 ACL */
  }
}

/**
 * 读 tokens.json；不存在则生成并写入（0600）。
 * @param {string} [dataDir] 凭证目录，默认 ~/.dsh-remote-agent-relay
 * @returns {{ hubToken: string, enrollToken: string, created: boolean, path: string }}
 */
export function loadOrCreateTokens(dataDir = defaultDataDir()) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new Error('loadOrCreateTokens: dataDir 必须是非空字符串')
  }
  const dir = path.resolve(dataDir)
  const file = path.join(dir, TOKENS_FILE)

  if (fs.existsSync(file)) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`凭证文件不是合法 JSON：${file}（${err.message}）。请修复或删除后重跑以重新生成。`)
    }
    const hubToken = typeof parsed?.hubToken === 'string' ? parsed.hubToken.trim() : ''
    const enrollToken = typeof parsed?.enrollToken === 'string' ? parsed.enrollToken.trim() : ''
    if (hubToken === '' || enrollToken === '') {
      throw new Error(`凭证文件缺少 hubToken / enrollToken：${file}。请修复或删除后重跑以重新生成。`)
    }
    restrictPermissions(file)
    return { hubToken, enrollToken, created: false, path: file }
  }

  const hubToken = newRelayToken('rt')
  const enrollToken = newRelayToken('en')
  const body = `${JSON.stringify(
    { version: TOKENS_FILE_VERSION, hubToken, enrollToken, createdAt: new Date().toISOString() },
    null,
    2,
  )}\n`

  fs.mkdirSync(dir, { recursive: true })
  restrictPermissions(dir, { isDir: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    restrictPermissions(tmp)
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不影响报错 */
    }
    throw new Error(`写入凭证文件失败：${file}（${err.message}）`)
  }
  restrictPermissions(file)
  return { hubToken, enrollToken, created: true, path: file }
}

function parsePortValue(raw, flag) {
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(`${flag} 需要 0-65535 的整数端口，收到 "${raw}"`)
  }
  const n = Number.parseInt(text, 10)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${flag} 需要 0-65535 的整数端口，收到 "${raw}"（0 表示随机端口）`)
  }
  return n
}

function parseHostValue(raw, flag) {
  const text = String(raw).trim()
  if (text === '') throw new Error(`${flag} 需要非空的监听地址，例如 0.0.0.0 或 127.0.0.1`)
  if (/\s/.test(text)) throw new Error(`${flag} 里不能有空白字符，收到 "${raw}"`)
  return text
}

/**
 * 布尔开关的取值。
 *
 * 为什么需要：`--print-tokens=false` / `--help=no` 这种写法里，`=value` 部分
 * 此前被**完全忽略**，一律当成"开关被打开"。对 `--print-tokens` 来说，
 * 这个静默方向恰好是最敏感的那一边 —— 用户显式写了 `=false`（不想打印明文
 * token），程序却照样把明文打到 stdout。要么按值执行，要么明确拒绝，
 * 绝不能默默反转。
 */
function parseBoolValue(inline, flag) {
  if (inline === null) return true
  const t = String(inline).trim().toLowerCase()
  if (t === '' || t === 'true' || t === '1' || t === 'yes' || t === 'on') return true
  if (t === 'false' || t === '0' || t === 'no' || t === 'off') return false
  throw new Error(`${flag} 只接受 true/false（或 1/0、yes/no、on/off），收到 "${inline}"`)
}

function envPort(env) {
  const raw = env?.DSH_RELAY_PORT
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT
  try {
    return parsePortValue(raw, 'DSH_RELAY_PORT')
  } catch (err) {
    throw new Error(`环境变量 DSH_RELAY_PORT 非法：${err.message}`)
  }
}

function envText(env, name, fallback) {
  const raw = env?.[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  return String(raw).trim()
}

/**
 * 解析 CLI 参数，带环境变量回退。非法参数抛带可读信息的 Error（调用方打 stderr + exit 2）。
 *
 * 优先级：**CLI > 环境变量 > 默认值**。这条必须靠"按需回退"实现，不能在函数开头
 * 就把 env 全部求值一遍 —— 历史缺陷正是后者：`port` / `host` 在解析 argv **之前**
 * 无条件从 env 读取并校验，于是一个陈旧的 `DSH_RELAY_PORT=abc`（或
 * `DSH_RELAY_HOST='a b'`）会让 `--port 1234 --host 127.0.0.1` 这样完全正确的
 * 调用也直接抛错退出 —— 用户明明显式给了值，却因为一个被覆盖的环境变量起不来。
 * 现在 env 只在"命令行确实没给这个键"时才被读取和校验。
 *
 * @param {string[]} argv 不含 node 与脚本名
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ port:number, host:string, hubToken:string, enrollToken:string, dataDir:string, printTokens:boolean, help:boolean }}
 */
export function parseArgs(argv = [], env = process.env) {
  // undefined = 命令行没给；由 env 回退填充。CLI 给过的键永不被 env 覆盖。
  const out = {
    port: undefined,
    host: undefined,
    hubToken: undefined,
    enrollToken: undefined,
    dataDir: undefined,
    printTokens: false,
    help: false,
  }
  const list = Array.isArray(argv) ? argv : []

  for (let i = 0; i < list.length; i += 1) {
    const raw = String(list[i])
    if (raw === '') throw new Error('收到空参数（检查脚本里的变量展开是否为空）')

    let key = raw
    let inline = null
    const eq = raw.indexOf('=')
    if (raw.startsWith('--') && eq > 2) {
      key = raw.slice(0, eq)
      inline = raw.slice(eq + 1)
    }

    if (key === '--help' || raw === '-h') {
      out.help = parseBoolValue(inline, raw === '-h' ? '-h' : '--help')
      continue
    }
    if (key === '--print-tokens') {
      out.printTokens = parseBoolValue(inline, key)
      continue
    }

    const need = () => {
      if (inline !== null) return inline
      const next = list[i + 1]
      if (next === undefined || String(next).startsWith('--')) {
        throw new Error(`${key} 需要一个取值（写法：${key}=VALUE）`)
      }
      i += 1
      return String(next)
    }

    switch (key) {
      case '--port':
        out.port = parsePortValue(need(), '--port')
        break
      case '--host':
        out.host = parseHostValue(need(), '--host')
        break
      case '--hub-token': {
        const v = need().trim()
        if (v === '') throw new Error('--hub-token 不能为空字符串')
        out.hubToken = v
        break
      }
      case '--enroll-token': {
        const v = need().trim()
        if (v === '') throw new Error('--enroll-token 不能为空字符串')
        out.enrollToken = v
        break
      }
      case '--data-dir': {
        const v = need().trim()
        if (v === '') throw new Error('--data-dir 不能为空字符串')
        out.dataDir = v
        break
      }
      default:
        if (raw.startsWith('-')) throw new Error(`未知参数：${raw}（用 --help 看用法）`)
        throw new Error(`不支持的位置参数：${raw}（所有配置都走 --key=value）`)
    }
  }

  /* 环境变量回退：只填命令行没给过的键 ------------------------------- */
  if (out.port === undefined) out.port = envPort(env)
  if (out.host === undefined) out.host = envText(env, 'DSH_RELAY_HOST', DEFAULT_HOST)
  if (out.hubToken === undefined) out.hubToken = envText(env, 'DSH_RELAY_HUB_TOKEN', '')
  if (out.enrollToken === undefined) out.enrollToken = envText(env, 'DSH_RELAY_ENROLL_TOKEN', '')
  if (out.dataDir === undefined) out.dataDir = envText(env, 'DSH_RELAY_DATA_DIR', defaultDataDir())

  // 参数化后再兜一次：--host 可能来自环境变量
  out.host = parseHostValue(out.host, '--host / DSH_RELAY_HOST')
  return out
}

/**
 * 机器可读的 ready 行。**只放指纹，不放明文 token。**
 * @param {{url:string, hubFingerprint:string, enrollFingerprint:string}} o
 */
export function formatReadyLine(o = {}) {
  const { url, hubFingerprint, enrollFingerprint } = o
  if (typeof url !== 'string' || url === '') throw new Error('formatReadyLine: url 必填')
  if (typeof hubFingerprint !== 'string' || hubFingerprint === '') throw new Error('formatReadyLine: hubFingerprint 必填')
  if (typeof enrollFingerprint !== 'string' || enrollFingerprint === '') throw new Error('formatReadyLine: enrollFingerprint 必填')
  return `RELAY_READY url=${url} hub=${hubFingerprint} enroll=${enrollFingerprint}`
}

/**
 * 明文 token 行。只给 `--print-tokens` / 首次生成 / 交互式终端这三条路径用，
 * 绝不能进任何持久日志。
 */
export function formatTokensLine({ hubToken, enrollToken, source, file } = {}) {
  if (typeof hubToken !== 'string' || hubToken === '') throw new Error('formatTokensLine: hubToken 必填')
  if (typeof enrollToken !== 'string' || enrollToken === '') throw new Error('formatTokensLine: enrollToken 必填')
  const tail = [
    source ? `source=${source}` : '',
    file ? `file=${file}` : '',
  ].filter(Boolean).join(' ')
  return `RELAY_TOKENS hub=${hubToken} enroll=${enrollToken}${tail ? ` ${tail}` : ''}`
}

/**
 * 只有指纹的凭证行（不泄露明文，可安全进日志）。
 *
 * 与 formatReadyLine / formatTokensLine 保持一致：缺少凭证时**报错**，不静默。
 * 历史缺陷：这里对缺失/空 token 直接 `tokenFingerprint(hubToken ?? '')`，
 * 于是 `{}` 或 `{hubToken:'', enrollToken:''}` 会输出
 * `RELAY_TOKENS_SOURCE hub=e3b0c44298fc enroll=e3b0c44298fc` ——
 * 这是空串的 sha256 前缀，**看起来和一个真实指纹毫无区别**。
 * 非交互式路径（systemd/journald）默认只打这一行，一旦凭证真的没取到，
 * 日志里留下的是一对"看起来正常"的假指纹，事后排查会以为 token 存在。
 * 三个格式化函数对同一个输入必须给同一种态度：要么都抛，要么都静默。
 */
export function formatTokenFingerprintLine({ hubToken, enrollToken, source, file } = {}) {
  if (typeof hubToken !== 'string' || hubToken === '') {
    throw new Error('formatTokenFingerprintLine: hubToken 必填')
  }
  if (typeof enrollToken !== 'string' || enrollToken === '') {
    throw new Error('formatTokenFingerprintLine: enrollToken 必填')
  }
  return [
    'RELAY_TOKENS_SOURCE',
    source ? `source=${source}` : '',
    file ? `file=${file}` : '',
    `hub=${tokenFingerprint(hubToken)}`,
    `enroll=${tokenFingerprint(enrollToken)}`,
  ].filter(Boolean).join(' ')
}
