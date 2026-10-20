/**
 * 独立监听端口（2026-10-18，解决"副机永远连不上"的架构级问题）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么不再用 ctx.webServer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原实现把副机拨入端点注册在 DSH 的 `ctx.webServer` 上：
 *
 *     ctx.webServer.registerUpgrade({ path: '/api/remote-agent/node', handler })
 *
 * 于是副机必须能访问 **DSH 的 webserver 端口**。而那个端口的绑定地址来自
 * DSH 自己的配置，带来两个无法绕开的死结：
 *
 *   1. **DSH 每次启动都重写 `<profile>/cordis.patch.yml`**（实测：写进去的
 *      `webserver` 段在下一次启动时被删掉，只留 3 个 `ui-*` 条目）→ 绑回
 *      `127.0.0.1` → 副机连不上。
 *   2. `webServer` 服务**激活即 listen**，没有 rebind 方法 → 插件运行时改不了。
 *
 * 而且新版 `dsh-host-webserver` 硬拒绝 `0.0.0.0`（会直接让 DSH 启动崩溃）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 现在的做法：插件自己开一个端口
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用 `node:http` 起一个独立的 server，自己处理 WebSocket 升级
 * （复用 `lib/ws.js` 的 `acceptUpgrade` —— 和 DSH 内部用的是同一套底层实现）。
 *
 * 好处：
 *   · **完全不依赖 DSH 的 webserver 配置**，DSH 怎么重写 patch 都不影响
 *   · host/port 由插件自己的配置决定，可以持久化到 instance.json
 *   · 不碰 DSH 的任何文件
 *
 * 代价：
 *   · 多一个监听端口（默认 19387）
 *   · 需要用户/配置告诉它绑哪个具体 IP（新版规则不允许 0.0.0.0，这本身是好事：
 *     只绑用户指定的那张网卡，暴露面最小）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 绑定地址怎么定（关键设计）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 无法绑 `0.0.0.0`（与新版 DSH 同一考量：通配地址把服务暴露到所有网卡）。
 * 所以按以下优先级选一个**具体 IP**：
 *
 *   1. 配置里的 `listenHost`（用户显式指定，最高优先）
 *   2. **Tailscale IP**（100.64.0.0/10 段）—— 本插件的目标场景就是跨机，
 *      Tailscale 地址固定不变、跨网可达，是最合理的选择
 *   3. 第一个私网 IPv4（192.168/10./172.16-31）
 *   4. `127.0.0.1`（兜底：至少本机能连，同机 both 模式可用）
 *
 * **自动选 IP 是刻意的**：不让用户为了一个"该绑哪张网卡"去查 ipconfig。
 */

import http from 'node:http'
import os from 'node:os'

import { acceptUpgrade } from './ws.js'

/** 默认端口：与历史行为一致（文档、配对码、用户既有配置都指向它）。 */
export const DEFAULT_LISTEN_PORT = 19387

/** Tailscale 的 CGNAT 段（100.64.0.0/10）。 */
function isTailscaleIp(ip) {
  if (typeof ip !== 'string') return false
  const m = /^100\.(\d+)\./.exec(ip)
  if (!m) return false
  const second = Number(m[1])
  // 100.64.0.0/10 → 第二段 64..127
  return second >= 64 && second <= 127
}

/** 私网段。 */
function isPrivateIp(ip) {
  if (typeof ip !== 'string') return false
  return (
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  )
}

/**
 * 判定一个主机名/字面量地址是不是回环。
 *
 * ⚠ 这是**唯一的**回环判据（2026-10-20 收口）。此前 `lib/env-check.js` 的
 * `isLoopbackOrigin`、`lib/hub/index.js` 的内联判断、`lib/client.js` 的前端
 * 判断各写一份 —— 三份判据迟早分叉（C2 就是"两套地址分类"分叉的直接后果）。
 * 新增调用方一律用这个，别再内联。
 *
 * @param {string} host 形如 `127.0.0.1` / `localhost` / `::1` / `[::1]`
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false
  const h = host.trim().toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

/** 一个地址的"可信程度"（0 最高）：Tailscale > RFC1918 > 其它。 */
function scoreOf(address) {
  if (isTailscaleIp(address)) return 0
  if (isPrivateIp(address)) return 1
  return 2
}

/**
 * 列出本机所有非内网回环的 IPv4（按优先级排序）。
 *
 * @returns {Array<{address:string, family:string, iface:string, score:number}>}
 */
export function listCandidateAddresses() {
  const out = []
  let ifaces
  try {
    ifaces = os.networkInterfaces()
  } catch {
    return out
  }
  for (const [iface, list] of Object.entries(ifaces)) {
    if (!Array.isArray(list)) continue
    for (const info of list) {
      if (!info || info.internal === true) continue
      const family = info.family === 'IPv4' || info.family === 4 ? 'IPv4' : String(info.family)
      if (family !== 'IPv4') continue
      const address = typeof info.address === 'string' ? info.address : ''
      if (address === '' || address.startsWith('169.254.')) continue // APIPA
      // 优先级：Tailscale(0) > 私网(1) > 其它(2)
      out.push({ address, family, iface, score: scoreOf(address) })
    }
  }
  // 稳定排序（L6，2026-10-20）：同 score 时不能依赖 `os.networkInterfaces()`
  // 的返回顺序 —— 那是平台相关的，同一台机器两次启动可能不同 → 绑定地址漂移。
  // 用「接口名 → 地址」做次级键，保证同一台机器每次选出同一个地址。
  out.sort((a, b) => (a.score - b.score)
    || String(a.iface).localeCompare(String(b.iface))
    || String(a.address).localeCompare(String(b.address)))
  return out
}

/**
 * 决定监听地址。
 *
 * @param {object} [o]
 * @param {string} [o.listenHost] 用户显式配置的地址
 * @param {string[]} [o.candidates] 覆盖候选列表（测试用）
 * @returns {{host:string, source:string, candidates:Array}}
 */
export function resolveListenHost({ listenHost, candidates } = {}) {
  const list = Array.isArray(candidates) ? candidates : listCandidateAddresses()

  // 1. 用户显式指定（且不是通配地址 —— 新版规则不允许）
  if (typeof listenHost === 'string') {
    const h = listenHost.trim()
    if (h !== '' && h !== '0.0.0.0' && h !== '::' && h !== '[::]') {
      return { host: h, source: 'config', candidates: list }
    }
  }

  // 2. Tailscale IP
  const ts = list.find((x) => isTailscaleIp(x.address))
  if (ts) return { host: ts.address, source: 'tailscale', candidates: list }

  // 3. 私网 IP
  const priv = list.find((x) => isPrivateIp(x.address))
  if (priv) return { host: priv.address, source: 'private', candidates: list }

  // 4. 任意非回环
  if (list.length > 0) return { host: list[0].address, source: 'any', candidates: list }

  // 5. 兜底：本机回环（同机 both 模式仍可用）
  return { host: '127.0.0.1', source: 'loopback', candidates: list }
}

/**
 * 启动一个只服务本插件 WS 端点的小 HTTP server。
 *
 * 只做两件事：
 *   · `GET <healthPath>` → 200 JSON（运维自检用，不泄露敏感信息）
 *   · `Upgrade: websocket` → 交给 `onUpgrade`（副机拨入）
 *
 * 其它路径一律 404 —— 这不是通用 web server，只承载节点端点。
 *
 * @param {object} o
 * @param {string} o.host 绑定的具体 IP
 * @param {number} o.port 端口（0 = 随机）
 * @param {string} o.path WS 升级路径（必须精确匹配）
 * @param {(conn:import('./ws.js').WSConnection, req:import('node:http').IncomingMessage)=>void} o.onUpgrade
 * @param {string} [o.healthPath] 健康检查路径
 * @param {object|((req:import('node:http').IncomingMessage)=>object)} [o.healthBody]
 *   健康检查返回体；传函数可按调用者身份分级（匿名只回 `{ ok: true }`）
 * @param {(level:string,msg:string,extra?:object)=>void} [o.log]
 * @returns {Promise<{server:import('node:http').Server, host:string, port:number, close:()=>Promise<void>}>}
 */
export function startListenServer({
  host,
  port = DEFAULT_LISTEN_PORT,
  path: upgradePath,
  onUpgrade,
  healthPath = '/healthz',
  healthBody = { ok: true },
  log = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const sockets = new Set()

    const server = http.createServer((req, res) => {
      // 健康检查：给运维/体检一个"端口真的活着"的判据
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        if (req.method === 'GET' && url.pathname === healthPath) {
          // healthBody 可以是对象，也可以是 `(req) => object`。
          // 后者用于**按调用者身份分级**：匿名只回 `{ ok: true }`，
          // 带正确口令才给插件名/角色/计数（v0.9.3 审查 L4 —— 这个端点
          // 本来是无鉴权的，回 "plugin: dsh-remote-agent, role: hub"
          // 等于给扫描器送指纹）。
          let payload = healthBody
          if (typeof healthBody === 'function') {
            try {
              payload = healthBody(req)
            } catch (err) {
              log('warn', 'health body threw', { error: String(err?.message ?? err) })
              payload = { ok: false }
            }
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(payload === undefined ? { ok: true } : payload))
          return
        }
      } catch {
        /* URL 解析失败：落到 404 */
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found\n')
    })

    // 追踪连接，close 时能强制断干净（否则旧连接会拖住 server.close）
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })

    server.on('upgrade', (req, socket, head) => {
      let pathname
      try {
        pathname = new URL(req.url || '/', 'http://localhost').pathname
      } catch {
        socket.destroy()
        return
      }
      // ⚠ 路径必须**精确匹配**：这个 server 只承载节点端点，
      // 不开任何"顺手兼容一下"的口子（越宽的攻击面越难守）。
      if (pathname !== upgradePath) {
        socket.destroy()
        return
      }
      const conn = acceptUpgrade(req, socket, head)
      if (!conn) return
      try {
        onUpgrade(conn, req)
      } catch (err) {
        log('warn', 'upgrade handler threw', { error: String(err?.message ?? err) })
        try {
          conn.close(1011, 'internal error')
        } catch {
          /* 已关 */
        }
      }
    })

    // listen 失败要 reject（调用方会 log 并降级）；listen **之后**的错误则
    // 只能用日志 —— 那个 Promise 早已 resolve，再 reject 是空操作。
    // 2026-10-20 修（L1）：原实现无条件 reject，导致运行期 socket 错误全被吞掉。
    let settled = false

    server.on('error', (err) => {
      // listen 失败（端口占用 / 地址不可用）要**明确报出来** ——
      // 静默失败会让"副机连不上"变成又一个无头案。
      if (!settled) {
        settled = true
        reject(err)
        return
      }
      log('error', 'listen server error (runtime)', {
        host,
        port,
        error: String(err?.message ?? err),
        code: String(err?.code ?? ''),
      })
    })

    server.listen(port, host, () => {
      settled = true
      const addr = server.address()
      const actualPort = addr && typeof addr === 'object' ? addr.port : port
      log('info', 'node endpoint listening', { host, port: actualPort, path: upgradePath })

      const close = () => new Promise((done) => {
        try {
          server.close(() => done())
        } catch {
          done()
        }
        // 强制断开存量连接：server.close 只是"停止接受新连接"，
        // 已有 WS 连接会一直挂着，插件卸载时不能留悬挂句柄。
        for (const s of sockets) {
          try {
            s.destroy()
          } catch {
            /* 已关 */
          }
        }
        sockets.clear()
        // 兜底超时：某些平台 close 回调可能不触发
        setTimeout(done, 2000).unref?.()
      })

      resolve({ server, host, port: actualPort, close })
    })
  })
}
