/**
 * 小白向导的纯逻辑层（零外部依赖，交互壳在 bin/dsh-remote-setup.js）。
 *
 * 职责：把"配一台 hub / worker 需要想的所有事"收敛成四个纯函数 +
 * 一个异步探活。设计原则：
 *   - **生成可粘贴的配置**，而不是让用户从零写 YAML —— 副机最大的坑
 *     （必须写 `inject: []`，否则该行永远 PENDING 且无任何报错）直接
 *     在生成的片段里替用户填好。
 *   - **每条 doctor 检查都带"怎么修"**，只报问题不给修法等于没查。
 *   - 纯函数便于测试；所有 fs/网络副作用留给调用方。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { randomBytes } from 'node:crypto'

/** 与 hub 侧 newNodeToken 完全同构（nt_ 前缀 + 24 字节 base64url）。 */
export function newNodeToken() {
  return `nt_${randomBytes(24).toString('base64url')}`
}

/** 与 protocol.validateHello 的 nodeId 规则一致。 */
export const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 枚举本机局域网 IPv4（排除 loopback / 链路本地 / 虚拟接口）。
 * 返回 [{ name, address, private }]，private = RFC1918。
 */
export function detectLanIps() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('169.254.')) continue // 链路本地：没拿到 DHCP 的假地址
      const [o1, o2] = a.address.split('.').map(Number)
      const priv = o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)
      out.push({ name, address: a.address, private: priv })
    }
  }
  // 私网优先，稳定的地址排前面
  out.sort((x, y) => (x.private === y.private ? 0 : x.private ? -1 : 1))
  return out
}

/**
 * 归一化 roots：绝对路径化、去重、去掉尾分隔符；标出不存在的目录。
 * @returns {{clean: string[], missing: string[]}}
 */
export function normalizeRoots(roots) {
  const seen = new Set()
  const clean = []
  for (const raw of roots ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    let p = raw.trim()
    // Windows 用户常把 "D:\work\" 带尾斜杠粘进来
    p = p.replace(/[\\/]+$/, '')
    // 相对路径按 home 解析（~/work、work 都比"悄悄变成无效配置"好）
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1))
    if (!path.isAbsolute(p)) p = path.join(os.homedir(), p)
    const norm = path.normalize(p)
    if (seen.has(norm.toLowerCase())) continue
    seen.add(norm.toLowerCase())
    clean.push(norm)
  }
  const missing = clean.filter((p) => !fs.existsSync(p))
  return { clean, missing }
}

/**
 * 生成 hub 侧要粘进 cordis 配置的 YAML 行。
 *
 * hub 依赖包内 cordis.patch.yml 自动插入的那一行（含 inject），这里生成
 * 等价的显式配置 —— 两条路径任选其一，写出来的这份覆盖 patch 的默认值
 * （nodeToken / uiPullRoot 是 patch 默认里没有的）。
 */
export function buildHubYaml({ token = '', roots = [] } = {}) {
  const lines = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    "  inject: ['webServer', 'tools', 'systemPrompt']",
    '  config:',
    '    role: hub',
  ]
  if (token !== '') lines.push(`    nodeToken: ${yq(token)}`)
  if (roots.length > 0) {
    lines.push('    uiPullRoot: ' + yq(roots[0])) // 面板拉取产物落地的目录（第一根）
  }
  return lines.join('\n')
}

/**
 * 生成 worker 侧的完整 profile YAML。
 *
 * ⚠ `inject: []` 是小白部署失败的头号原因：包内 patch 给该行声明了
 * hub 需要的三个服务，副机没有这些服务 —— 不清空的话这一行永远停在
 * PENDING，副机永远不拨入，且**没有任何报错**。生成的片段替用户填好。
 */
export function buildWorkerYaml({ hubUrl = '', token = '', nodeId = '', roots = [] } = {}) {
  const lines = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    '  inject: []                    # ← 副机必须清空，否则永远 PENDING（生成器已替你填好）',
    '  config:',
    '    role: worker',
  ]
  if (nodeId !== '') lines.push(`    nodeId: ${yq(nodeId)}`)
  lines.push("    transportMode: direct")
  lines.push(`    hubUrl: ${yq(hubUrl)}`)
  if (token !== '') lines.push(`    token: ${yq(token)}`)
  if (roots.length > 0) {
    lines.push('    roots:')
    for (const r of roots) lines.push(`      - ${yq(r)}`)
  }
  return lines.join('\n')
}

/** YAML 标量：含特殊字符时加单引号（单引号翻倍转义）。 */
function yq(v) {
  const s = String(v)
  return /^[\w./:\\ -]+$/.test(s) && s.trim() === s && s !== '' ? s : `'${s.replace(/'/g, "''")}'`
}

/**
 * 拼一个 direct 模式的 hubUrl。
 * host 不带协议时补 ws://；路径缺省补 /api/remote-agent/node。
 */
export function buildHubUrl(host, port = 19387) {
  let s = String(host ?? '').trim()
  if (s === '') return ''
  if (!/^wss?:\/\//i.test(s)) {
    if (/^https:\/\//i.test(s)) s = `wss://${s.slice(8)}`
    else if (/^http:\/\//i.test(s)) s = `ws://${s.slice(7)}`
    else s = `ws://${s}`
  }
  try {
    const u = new URL(s)
    if (u.port === '') u.port = String(port)
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/api/remote-agent/node'
    return u.toString()
  } catch {
    return ''
  }
}

/**
 * TCP 探活（不完成 WebSocket 握手，只确认端口有人听）。
 * @returns {Promise<{ok:boolean, ms:number, error:string|undefined}>}
 */
export function probeTcp(host, port, { timeoutMs = 3000 } = {}) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (r) => {
      socket.destroy()
      resolve({ ok: r.ok, ms: Date.now() - startedAt, error: r.error })
    }
    socket.setTimeout(timeoutMs, () => done({ ok: false, error: `超时（${timeoutMs}ms 内无人应答）` }))
    socket.once('connect', () => done({ ok: true }))
    socket.once('error', (err) => done({ ok: false, error: friendlyConnectError(err, { host, port }) }))
  })
}

/**
 * 把底层连接错误翻译成"哪里没对 + 怎么修"。
 * 从 worker 的 error 事件到 doctor 都用这一份，口径一致。
 */
export function friendlyConnectError(err, { host = '', port = '' } = {}) {
  const code = err?.code ?? ''
  const where = host !== '' ? `${host}${port ? `:${port}` : ''}` : '主机'
  switch (code) {
    case 'ECONNREFUSED':
      return `${where} 端口没人听 —— 检查：① 主机的 DSH 是否在跑；② IP/端口是否写对；③ 主机防火墙是否放行该端口`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `${where} 的主机名解析不了 —— hubUrl 里应写 IP（如 192.168.x.x）或能解析的主机名`
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${where} 连不上（超时/不可达）—— 检查两台机器是否在同一网段、IP 是否写对、路由器是否开了 AP 隔离`
    case 'EACCES':
    case 'EPERM':
      return `${where} 连接被系统拒绝 —— 端口可能被策略占用，换个端口试试`
    default:
      return err?.message ?? String(err ?? '未知错误')
  }
}

/** 一个检查结果：ok + 人话 + 怎么修。 */
function chk(ok, label, fix) {
  return { ok: Boolean(ok), label, fix: ok ? '' : fix }
}

/**
 * doctor 的静态检查（不碰网络；网络探活由调用方在结果后追加）。
 * @param {object} o
 * @param {'hub'|'worker'} o.role
 * @param {object} o.config 用户写的 config（原始对象，容错解析）
 * @param {string[]} [o.lanIps] 本机 IP（用于"公网暴露"判定）
 */
export function doctorChecks({ role, config, lanIps = [] } = {}) {
  const c = config && typeof config === 'object' ? config : {}
  const out = []
  const isWorker = role === 'worker'

  // ── Node 版本 ────────────────────────────────────────────────
  const [maj, min, pat] = process.versions.node.split('.').map(Number)
  const nodeOk = (maj === 22 && (min > 19 || (min === 19 && pat >= 0))) || maj >= 24
  out.push(chk(nodeOk, `Node 版本 ${process.versions.node}`, '需要 ^22.19.0 或 >=24.0.0，请升级 Node'))

  if (isWorker) {
    // ── hubUrl ─────────────────────────────────────────────────
    const urlRaw = typeof c.hubUrl === 'string' ? c.hubUrl.trim() : ''
    out.push(chk(urlRaw !== '', '已配置 hubUrl（副机拨入地址）', 'config.hubUrl 必填，形如 ws://192.168.x.x:19387/api/remote-agent/node —— 用向导生成'))
    let u = null
    if (urlRaw !== '') {
      try { u = new URL(/^wss?:\/\//i.test(urlRaw) ? urlRaw : `ws://${urlRaw}`) } catch { /* 保持 null */ }
      out.push(chk(u !== null, 'hubUrl 是合法的 ws:// 地址', `当前值 "${urlRaw}" 解析不了；正确示例 ws://192.168.1.10:19387/api/remote-agent/node`))
      // token 与公网暴露
      const token = typeof c.token === 'string' ? c.token.trim() : ''
      const hostIsPrivate = (() => {
        const h = u?.hostname ?? ''
        const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
        if (!m) return true // 主机名/回环按私网处理
        const [o1, o2] = m.slice(1).map(Number)
        return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || o1 === 127
      })()
      if (token === '') {
        out.push(chk(
          hostIsPrivate,
          'token 未配置（目标地址是私网/回环，暂可接受）',
          '主机与副机的 token 必须一致；目标不是私网时，不配 token 等于把副机门打开 —— 用向导生成 nt_ 开头的强 token',
        ))
      } else {
        out.push(chk(true, 'token 已配置'))
      }
    }
    // ── roots（与 hubUrl 无关，单独检查 —— 缺 hubUrl 时 roots 问题也要报）──
    const { clean, missing } = normalizeRoots(Array.isArray(c.roots) ? c.roots : [])
    out.push(chk(clean.length > 0, 'roots 非空', 'config.roots 必须至少给一个真实存在的绝对路径（副机的安全边界），例如 D:\\work'))
    for (const m of missing) {
      out.push(chk(false, `roots 里的目录存在：${m}`, '目录不存在 —— 先创建它，或改成一个真实存在的路径'))
    }
    // ── nodeId ───────────────────────────────────────────────
    const nid = typeof c.nodeId === 'string' ? c.nodeId.trim() : ''
    if (nid !== '') {
      out.push(chk(NODE_ID_RE.test(nid), `nodeId "${nid}" 合法`, '只能字母数字 . _ -，以字母或数字开头，≤64 字符（留空则自动取主机名）'))
    }
  } else {
    // hub 侧
    const token = typeof c.nodeToken === 'string' ? c.nodeToken.trim() : ''
    const hasPublic = lanIps.some((i) => !i.private)
    out.push(chk(token !== '', 'nodeToken 已配置（副机入网口令）', '不配置时直连端点不校验任何凭证 —— 仅限 Tailscale/同机等完全可信网络；公网部署必须配。用向导生成 nt_ 开头的强 token'))
    if (token === '' && hasPublic) {
      out.push(chk(false, '本机有公网地址但 token 为空', '立即配置 nodeToken，或确认本机只暴露在可信内网'))
    }
    const pullRoot = typeof c.uiPullRoot === 'string' ? c.uiPullRoot.trim() : ''
    out.push(chk(pullRoot !== '', 'uiPullRoot 已配置（面板拉取产物落地的目录）', '不配置时 Web 面板的"拉取"按钮是禁用的 —— 建议给一个专门目录，如 D:\\remote-works'))
    if (pullRoot !== '' && !fs.existsSync(pullRoot)) {
      out.push(chk(false, `uiPullRoot 目录存在：${pullRoot}`, '目录不存在 —— 先创建它'))
    }
  }

  return out
}

/** 渲染 doctor 结果为可打印文本（✓/✗ + 修法）。 */
export function renderDoctor(checks, { title = 'doctor 体检结果' } = {}) {
  const lines = [title, '']
  let bad = 0
  for (const c of checks) {
    if (!c.ok) bad += 1
    lines.push(`${c.ok ? '✓' : '✗'} ${c.label}`)
    if (!c.ok && c.fix) lines.push(`    ↳ 怎么修：${c.fix}`)
  }
  lines.push('')
  lines.push(bad === 0 ? '全部通过。' : `共 ${bad} 项需要处理。`)
  return { text: lines.join('\n'), failed: bad }
}
