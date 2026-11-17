import { readFile as read, readdir as list, stat as fileStat } from 'node:fs/promises'
import netModule from 'node:net'
import path from 'node:path'

const portNumber = value => Number.isInteger(value) && value > 0 && value <= 65535
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
const endpoint = (host, port) => `${host.includes(':') ? `[${host}]` : host}:${port}`

/** Deliberately small TOML reader: never interpret expressions or unrelated settings. */
export function parseFrpcToml(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false }
  const common = {}, proxies = []
  let section = common
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^\[common\]\s*(?:#.*)?$/.test(line)) { section = common; continue }
    if (/^\[\[proxies\]\]\s*(?:#.*)?$/.test(line)) {
      section = {}
      proxies.push(section)
      continue
    }
    if (/^\[.*\]\s*(?:#.*)?$/.test(line)) { section = null; continue }
    const assignment = /^([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!assignment) return { ok: false }
    const [, key, rawValue] = assignment
    if (!section || !['serverAddr', 'serverPort', 'localPort', 'remotePort', 'local_port', 'remote_port'].includes(key)) continue
    const value = /^(?:"([^"\\]*)"|'([^']*)'|(\d+))\s*(?:#.*)?$/.exec(rawValue)
    if (!value) return { ok: false }
    const name = key === 'local_port' ? 'localPort' : key === 'remote_port' ? 'remotePort' : key
    section[name] = value[3] === undefined ? (value[1] ?? value[2]) : Number(value[3])
  }
  // Server settings live at the root in current frpc TOML, or in [common].
  const proxy = proxies.find(p => portNumber(p.localPort) && portNumber(p.remotePort))
  if (typeof common.serverAddr !== 'string' || !common.serverAddr.trim()
    || /[\s/\\?#@]/.test(common.serverAddr) || !portNumber(common.serverPort) || !proxy) return { ok: false }
  return { ok: true, server: endpoint(common.serverAddr.replace(/^\[|\]$/g, ''), common.serverPort),
    localPort: proxy.localPort, remotePort: proxy.remotePort }
}

/** Missing/unreadable directories reject here; the collector isolates that failure. */
export async function readSakuraState(logDir, { readdir = list, readFile = read, stat = fileStat, tailLines = 200 } = {}) {
  const pathApi = /^[A-Za-z]:\\/.test(logDir) ? path.win32 : path
  const entries = await readdir(logDir, { withFileTypes: true })
  let newest
  for (const entry of entries) {
    if (typeof entry !== 'string' && !entry.isFile()) continue
    const file = pathApi.join(logDir, typeof entry === 'string' ? entry : entry.name)
    try {
      const { mtimeMs } = await stat(file)
      if (Number.isFinite(mtimeMs) && (!newest || mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs }
    } catch { /* A rotated log can disappear between listing and sampling. */ }
  }
  const result = { kind: 'sakura', state: 'configured', summary: '' }
  if (!newest) return result
  const text = String(await readFile(newest.file, 'utf8'))
  for (const line of text.trimEnd().split(/\r?\n/).slice(-Math.floor(positive(tailLines, 200)))) {
    const hit = /\b(started tunnel|tunnel started|error)\b.*/i.exec(line)
    if (!hit) continue
    result.state = /^error\b/i.test(hit[0]) ? 'error' : 'ready'
    result.summary = hit[0].replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g, '[path]').trim()
  }
  return result
}

function tcpTarget(target) {
  if (typeof target !== 'string') return null
  const match = /^(?:\[([^\]]+)\]|([^\s:[\]/?#@]+)):(\d+)$/.exec(target)
  if (!match || !portNumber(Number(match[3]))) return null
  return { host: match[1] ?? match[2], port: Number(match[3]) }
}

/** The explicit deadline covers DNS as well as connecting; no socket survives it. */
export function probeTcp(target, { timeoutMs = 800, net = netModule } = {}) {
  const started = performance.now()
  return new Promise(resolve => {
    let socket, timer, settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.destroy() } catch { /* Best effort cleanup of injected sockets. */ }
      resolve({ result, rttMs: Math.max(0, Math.round(performance.now() - started)) })
    }
    const options = tcpTarget(target)
    if (!options) { finish('closed'); return }
    timer = setTimeout(() => finish('timeout'), positive(timeoutMs, 800))
    try {
      socket = net.connect(options)
      socket.once('connect', () => finish('open'))
      socket.on('error', error => finish(error?.code === 'ETIMEDOUT' ? 'timeout' : 'closed'))
      socket.once('close', () => finish('closed'))
    } catch { finish('closed') }
  })
}

/** Only filesystem reads and TCP connects; each optional source fails independently. */
export async function collectConnectivity({ config = {}, dshHome = process.env.DSH_HOME || '', platform = process.platform,
  readFile = read, readdir = list, stat = fileStat, net = netModule, now = Date.now } = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const result = { transportMode: cfg.transportMode === 'relay' ? 'relay' : 'direct',
    tunnel: null, tunnelState: 'none', probes: [], sampledAt: Date.now() }
  const pathApi = platform === 'win32' ? path.win32 : path
  const paths = Array.isArray(cfg.tunnelConfigPaths) ? cfg.tunnelConfigPaths : ['.runtime/frpc/frpc.toml']
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !candidate) continue
    if (!pathApi.isAbsolute(candidate) && !dshHome) continue
    try {
      const parsed = parseFrpcToml(await readFile(pathApi.resolve(dshHome, candidate), 'utf8'))
      if (!parsed.ok) continue
      const { server, localPort, remotePort } = parsed
      result.tunnel = { kind: 'frpc', server, localPort, remotePort }
      result.tunnelState = 'configured'
      break
    } catch { /* Missing config is an unconfigured source. */ }
  }
  try {
    const logDir = platform === 'win32' ? 'C:\\ProgramData\\SakuraFrpService\\Logs' : '/var/log/sakurafrp'
    const sakura = await readSakuraState(logDir, { readdir, readFile, stat, tailLines: cfg.sakuraLogTailLines })
    // An actual log signal wins; an empty directory does not hide a frpc config.
    if (!result.tunnel || sakura.state !== 'configured') {
      result.tunnel = { kind: sakura.kind, summary: sakura.summary }
      result.tunnelState = sakura.state
    }
  } catch { /* No readable Sakura source; retain any frpc configuration. */ }
  const targets = new Set()
  try {
    const hub = new URL(cfg.hubUrl || cfg.relayUrl)
    if (['ws:', 'wss:', 'http:', 'https:'].includes(hub.protocol)) {
      targets.add(endpoint(hub.hostname.replace(/^\[|\]$/g, ''), hub.port || (['wss:', 'https:'].includes(hub.protocol) ? 443 : 80)))
    }
  } catch { /* No usable hub address. */ }
  for (const target of Array.isArray(cfg.probeHosts) ? cfg.probeHosts : []) {
    if (tcpTarget(target)) targets.add(target)
  }
  result.probes = await Promise.all([...targets].map(async target => ({ target,
    ...await probeTcp(target, { timeoutMs: cfg.probeTimeoutMs, net }) })))
  try { const at = now(); if (Number.isFinite(at)) result.sampledAt = at } catch { /* Keep the real clock fallback. */ }
  return result
}
