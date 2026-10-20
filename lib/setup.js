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
import { expandPairConfig } from './pairing.js'
// 地址枚举**必须只有一份实现**（2026-10-20 收口）：
// 此前 detectLanIps（私网优先）与 resolveListenHost（Tailscale 优先）各写一套，
// 排序方向相反 → 面板生成的配对码第一条必定不是实际绑定地址（C2）。
import { listCandidateAddresses } from './listen-server.js'

/** 与 hub 侧 newNodeToken 完全同构（nt_ 前缀 + 24 字节 base64url）。 */
export function newNodeToken() {
  return `nt_${randomBytes(24).toString('base64url')}`
}

/** 与 protocol.validateHello 的 nodeId 规则一致。 */
export const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 枚举本机局域网 IPv4（排除 loopback / 链路本地 / 虚拟接口）。
 * 返回 [{ name, address, private }]，private = RFC1918 或 Tailscale（可信内网）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-10-20 改为复用 `listCandidateAddresses()`（v0.9.3 审查 C2）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原来这里自己实现了"枚举 + 私网优先排序"，而 `lib/listen-server.js` 的
 * `resolveListenHost()` 实现了"Tailscale 优先"。两套判据方向**相反**，于是：
 *
 *   独立监听实际绑   → 100.86.48.54（Tailscale）
 *   面板配对码第一条 → ws://10.239.22.41:56594/...（WLAN，私网优先排第一）
 *
 * 用户复制第一条 → 连不上，而两端都不报错。
 *
 * 现在**一份实现**：排序 / 私网判定 / APIPA 过滤全部交给 listen-server，
 * 这里只做字段名适配（它返回 iface，历史调用方要 name）。
 *
 * @returns {Array<{name:string, address:string, private:boolean, score:number}>}
 */
export function detectLanIps() {
  try {
    return listCandidateAddresses().map((c) => ({
      name: c.iface,
      address: c.address,
      // Tailscale（100.64/10）在语义上属于"可信内网"，与 RFC1918 同等看待：
      // 面板用它区分"要不要提示公网风险"，把它算公网会给出错误警告。
      private: c.score <= 1,
      score: c.score,
    }))
  } catch {
    return []
  }
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
export function buildWorkerYaml({ hubUrl = '', token = '', nodeId = '', roots = [], pair = '', pinnedHubFingerprint = '' } = {}) {
  const lines = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    '  inject: []                    # ← 副机必须清空，否则永远 PENDING（生成器已替你填好）',
    '  config:',
    '    role: worker',
  ]
  if (nodeId !== '') lines.push(`    nodeId: ${yq(nodeId)}`)
  if (pair !== '') {
    // 配对码模式：一行替代 transportMode/hubUrl/token（运行时展开，见 lib/pairing.js）。
    // ⚠ 配对码含 token，等同凭证 —— 提醒用户别贴公开渠道。
    lines.push(`    pair: ${yq(pair)}`)
  } else {
    lines.push('    transportMode: direct')
    lines.push(`    hubUrl: ${yq(hubUrl)}`)
    if (token !== '') lines.push(`    token: ${yq(token)}`)
  }
  // P2-11：显式钉住 hub 指纹（配对码模式不需要这行 —— 指纹在码里，运行时展开）。
  if (pinnedHubFingerprint !== '') lines.push(`    pinnedHubFingerprint: ${yq(pinnedHubFingerprint)}`)
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
  const raw = config && typeof config === 'object' ? config : {}
  const out = []
  const isWorker = role === 'worker'

  // ── 配对码：有 pair 就先展开，后续检查全部基于展开后的配置 ──
  const hasPair = typeof raw.pair === 'string' && raw.pair.trim() !== ''
  const expansion = hasPair ? expandPairConfig(raw) : { config: raw, error: '' }
  const c = expansion.config
  if (hasPair) {
    out.push(expansion.error === ''
      ? chk(true, '配对码（pair）解析成功')
      : chk(false, '配对码（pair）解析失败', expansion.error))
  }

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

/* ════════════════════════════════════════════════════════════════
 * 写盘（cordis.patch.yml 托管块）——零终端小白的"最后一公里"。
 *
 * 侦查结论（2026-10-15，对照本机 DSH 0.2.0-rc.2 实测）：
 *   - 真正的配置文件是 ~/.dsh/profiles/<profile>/cordis.patch.yml
 *     （cordis.yml 是空壳，头注释明说 "Edit cordis.patch.yml, not this file"）
 *   - dsh 自己改这个文件时留 .bak-<后缀>-<时间戳> 备份 → 照抄该惯例
 *   - 托管块先例：remote-web-ui 用 "# --- ... (managed - do not edit) ---"
 *     标记实现幂等更新 → 照抄该模式
 *
 * 铁律：
 *   1. 只动标记之间的内容，用户的其它配置一个字节不碰。
 *   2. 写前必备份，写失败必回滚。
 *   3. 已有**无标记**的 remote-agent 条目（手写的）绝不静默重复追加 ——
 *      同 id 两行 = 插件挂载两次 = 路由重复注册 = 启动失败。
 * ════════════════════════════════════════════════════════════════ */

export const MANAGED_BEGIN = '# --- dsh-remote-agent (managed by dsh-remote-setup - do not edit) ---'
export const MANAGED_END = '# --- end dsh-remote-agent managed block ---'
/** 手写 remote-agent 条目的检测（排除托管块内部）。 */
const RA_ENTRY_RE = /^\s*-\s+id:\s*remote-agent\b/m

/** 默认 profile 的 cordis.patch.yml 绝对路径。 */
export function patchFilePath(profile = 'desktop') {
  const p = String(profile ?? 'desktop').trim() || 'desktop'
  // profile 名做一次防路径穿越清洗（只允许字母数字 - _）
  const safe = p.replace(/[^A-Za-z0-9_-]/g, '') || 'desktop'
  return path.join(os.homedir(), '.dsh', 'profiles', safe, 'cordis.patch.yml')
}

/** 列出本机已有的 dsh profiles（含 cordis.patch.yml 的才算）。root 参数供测试注入。 */
export function listDshProfiles(root = path.join(os.homedir(), '.dsh', 'profiles')) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .filter((name) => fs.existsSync(path.join(root, name, 'cordis.patch.yml')))
  } catch {
    return []
  }
}

/**
 * 把生成的 YAML 块合并进 patch 文本（纯函数，幂等）。
 *
 * @param {string} fileText
 * @param {string} blockYaml
 * @param {boolean} [replaceHandWritten] 是否**先移除**托管块之外的手写
 *   remote-agent 条目（连同它上方的注释块），再写托管块。
 *
 *   ⚠ 这个参数是 2026-10-15 修 bug 时加的。原 `force` 只跳过冲突检测却
 *   仍走"追加"路径 —— 结果是**手写条目留着 + 托管块又写一条**，
 *   两条同 id → 插件挂载两次 → 启动失败。**正是 force 声称要防的事。**
 *   而且写完之后文件里永久同时存在两者，下一次写入会被冲突检测挡住，
 *   **再也改不了**（实测：force 一次之后就死锁）。
 *
 *   正确语义：force = "我确认要用托管块接管，请把手写那条替换掉"。
 *   所以必须真的移除手写条目，而不是在旁边追加。
 *
 * @returns {{text:string, mode:'created'|'replaced'|'replaced-handwritten'}}
 */
export function upsertManagedBlock(fileText, blockYaml, replaceHandWritten = false) {
  const src = typeof fileText === 'string' ? fileText : ''
  const block = `${MANAGED_BEGIN}\n${String(blockYaml ?? '').trim()}\n${MANAGED_END}`

  // 需要移除手写条目时：先把"托管块之外"的部分做一次剔除。
  let base = src
  if (replaceHandWritten === true) {
    const i0 = src.indexOf(MANAGED_BEGIN)
    const j0 = src.indexOf(MANAGED_END)
    if (i0 === -1 || j0 === -1 || j0 < i0) {
      base = stripHandWrittenEntries(src)
    } else {
      // 分别处理块前与块后，避免碰到托管块自身
      const before = stripHandWrittenEntries(src.slice(0, i0))
      const after = stripHandWrittenEntries(src.slice(j0 + MANAGED_END.length))
      base = `${before}${src.slice(i0, j0 + MANAGED_END.length)}${after}`
    }
  }

  const i = base.indexOf(MANAGED_BEGIN)
  const j = base.indexOf(MANAGED_END)
  if (i !== -1 && j !== -1 && j > i) {
    // 替换标记之间的内容（保留标记前后的原文）
    const before = base.slice(0, i)
    const after = base.slice(j + MANAGED_END.length)
    return {
      text: `${before}${block}${after}`,
      mode: replaceHandWritten === true && base !== src ? 'replaced-handwritten' : 'replaced',
    }
  }
  // 追加到文件尾（前面隔一个空行，保证不粘连上一条目）
  const sep = base === '' ? '' : (base.endsWith('\n') ? '\n' : '\n\n')
  return {
    text: `${base}${sep}${block}\n`,
    mode: replaceHandWritten === true && base !== src ? 'replaced-handwritten' : 'created',
  }
}

/**
 * 移除**托管块之外**的手写 remote-agent 条目（含它上方连续的注释块）。
 *
 * 条目边界怎么定：从 `- id: remote-agent` 那一行开始，向下吃到
 * **下一个顶层 `- ` 开头的行**（那是下一条 loader 条目）或文件末尾。
 * 中间的缩进行（`  name:` / `  config:` / 更深缩进）都算这一条的。
 *
 * 为什么连上方注释一起删：手写条目通常带着用户自己的说明注释
 * （"本机是主机（派活方）"之类），只删条目会留下孤立的注释，读起来莫名其妙。
 *
 * @param {string} text 不含托管块的文本片段
 * @returns {string} 剔除后的文本
 */
function stripHandWrittenEntries(text) {
  const src = typeof text === 'string' ? text : ''
  const lines = src.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!/^\s*-\s+id:\s*remote-agent\b/.test(line)) {
      out.push(line)
      i += 1
      continue
    }
    // 命中条目头：先回退掉上方紧邻的注释行（含空注释与纯空行前的注释）
    while (out.length > 0) {
      const prev = out[out.length - 1]
      if (/^\s*#/.test(prev) || prev.trim() === '') out.pop()
      else break
    }
    // 吃掉条目本身：直到下一个顶层 `- ` 或末尾
    i += 1
    while (i < lines.length) {
      const cur = lines[i]
      if (/^-\s/.test(cur) || /^-\s*$/.test(cur)) break
      i += 1
    }
  }
  // 折叠连续空行（剔除后容易留一串）
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 检测写盘冲突：托管块之外是否已有手写的 remote-agent 条目。
 * 有 → 写盘会产生同 id 重复条目（插件挂载两次 → 启动失败），必须先拦下。
 * @returns {boolean} true = 有冲突（不能直接写）
 */
export function hasUnmanagedRemoteAgent(fileText) {
  const src = typeof fileText === 'string' ? fileText : ''
  const i = src.indexOf(MANAGED_BEGIN)
  if (i === -1) return RA_ENTRY_RE.test(src)
  // 托管块内部自身含 remote-agent 条目，先挖掉块体再检测
  const j = src.indexOf(MANAGED_END)
  if (j === -1) return RA_ENTRY_RE.test(src)
  return RA_ENTRY_RE.test(src.slice(0, i) + src.slice(j + MANAGED_END.length))
}

/**
 * 面板 setup 表单**管辖**的顶层 config 键。
 *
 * 只有这些字段允许被"整块重写"覆盖；其余（`nodeToken` / `uiPullRoot` /
 * `listenHost` / `listenPort` / `relay` / `pair` / `token` …）一律原样保留。
 *
 * 放在这里而不是 setup-routes.js：它是「哪些字段归表单管」这个**领域事实**，
 * CLI 向导与测试也要按同一份清单判断（两处各写一份就会分叉 —— 本版审查里
 * C2/L2 就是这么来的）。
 */
export const FORM_OWNED_KEYS = Object.freeze([
  'role',
  'nodeId',
  'transportMode',
  'hubUrl',
  'relayUrl',
  'roots',
])

/**
 * 从**现有托管块**里抽出"本次表单不管辖"的 config 字段，原样返回（含缩进）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要（2026-10-20，v0.9.3 审查 H2）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `upsertManagedBlock` 是**块级整体替换**：新块进来，旧块整段消失。
 * 而面板的 setup 表单只提交 role/nodeId/transportMode/hubUrl/relayUrl/roots。
 *
 * 于是用户在面板点一次「保存」，托管块里的 `nodeToken`、`uiPullRoot`、
 * `listenHost`、`listenPort`、`relay` **全部被静默删掉**（已实证）。
 * 而 instance.json 那边也没存这些 —— 等于"点一次保存，凭证和设置就没了"。
 *
 * 修法不是让表单管更多字段（字段会一直加），而是**只重写自己管辖的那几个**，
 * 其余原样搬回来。
 *
 * 实现刻意走**文本级切分**而不是 YAML 解析：
 *   · 不需要引入解析器（本包零运行时依赖是硬约束）
 *   · 保留用户的原始格式（注释、引号风格、键顺序）—— 解析再序列化会全部丢失
 *
 * @param {string} blockText 托管块正文（`MANAGED_BEGIN/END` 之间的内容）
 * @param {Set<string>|string[]} ownedKeys 本次由表单管辖的顶层 config 键
 * @returns {string[]} 需要原样保留的行
 */
export function extractPreservedConfig(blockText, ownedKeys) {
  const src = typeof blockText === 'string' ? blockText : ''
  const owned = ownedKeys instanceof Set ? ownedKeys : new Set(Array.isArray(ownedKeys) ? ownedKeys : [])
  const lines = src.split('\n')

  // 定位 `  config:`（两个空格缩进 —— loader 条目的标准形态）
  const start = lines.findIndex((l) => /^\s{2}config:\s*$/.test(l))
  if (start === -1) return []

  const groups = []
  let cur = null
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      // 空行跟着当前组（保留段落感），组还没开始就忽略
      if (cur) cur.lines.push(line)
      continue
    }
    // 顶层字段：4 个空格 + key:
    const m = /^ {4}([A-Za-z0-9_]+):/.exec(line)
    if (m) {
      cur = { key: m[1], lines: [line] }
      groups.push(cur)
      continue
    }
    // 更深缩进（嵌套对象 / 列表项）→ 属于当前组
    if (cur && /^ {5,}\S/.test(line)) {
      cur.lines.push(line)
      continue
    }
    // 缩进 ≤3 或新条目 —— config 段结束
    break
  }

  const kept = []
  for (const g of groups) {
    if (owned.has(g.key)) continue
    // 去掉尾部多余空行，避免拼回去时积累空行
    const ls = g.lines.slice()
    while (ls.length > 0 && ls[ls.length - 1].trim() === '') ls.pop()
    kept.push(...ls)
  }
  return kept
}

/**
 * 读取文件里现有托管块的正文（不含标记行）。没有托管块时返回 ''。
 * @param {string} fileText
 * @returns {string}
 */
export function readManagedBlockBody(fileText) {
  const src = typeof fileText === 'string' ? fileText : ''
  const i = src.indexOf(MANAGED_BEGIN)
  if (i === -1) return ''
  const j = src.indexOf(MANAGED_END, i)
  if (j === -1) return ''
  return src.slice(i + MANAGED_BEGIN.length, j)
}

/**
 * 在托管块正文里设置 `nodeToken`（有则替换，无则插入），返回**新的块正文**。
 *
 * 为什么不是"重新生成整个块"：那会把用户手写的其它字段一起冲掉（H2）。
 * 这里只动 token 这一行，其余字节保持原样。
 *
 * @param {string} blockText 托管块正文（不含标记）
 * @param {string} token 新口令
 * @returns {string}
 */
export function upsertTokenInBlock(blockText, token) {
  const body = typeof blockText === 'string' ? blockText : ''
  const t = typeof token === 'string' ? token.trim() : ''
  if (t === '') return body
  // 单引号包裹 + 转义：token 是 nt_ + base64url，理论上不含引号，但不赌
  const line = `    nodeToken: '${t.replace(/'/g, "''")}'`
  const lines = body.split('\n')

  const i = lines.findIndex((l) => /^ {4}nodeToken:/.test(l))
  if (i !== -1) {
    lines[i] = line
    return lines.join('\n')
  }

  // 没有 → 插到 `  config:` 之后（保持它作为 config 的第一个子键，可读性好）
  const ci = lines.findIndex((l) => /^\s{2}config:\s*$/.test(l))
  if (ci !== -1) {
    lines.splice(ci + 1, 0, line)
    return lines.join('\n')
  }

  // 连 config 行都没有（极早期手写块）→ 追加一个 config 段
  const trimmed = body.replace(/\s+$/, '')
  return `${trimmed}${trimmed === '' ? '' : '\n'}  config:\n${line}\n`
}

/**
 * 写盘主流程：备份 → 合并 → 写入 → 校验，失败自动回滚。
 *
 * @param {object} o
 * @param {string} o.file patch 文件绝对路径
 * @param {string} o.blockYaml 生成的配置块（buildHubYaml/buildWorkerYaml 输出）
 * @param {boolean} [o.force] 有手写条目冲突时，**用它替换**手写条目（默认拒绝）。
 *
 *   ⚠ 语义修订（2026-10-15）：原实现里 `force` 只跳过冲突检测，却仍走"追加"
 *   路径 —— 结果是手写条目留着、托管块又写一条，**两条同 id**（插件挂载两次
 *   → 启动失败），正是它声称要防的事。而且写完之后文件里永久同时存在两者，
 *   下一次写入会被冲突检测挡住 —— **force 一次之后就再也改不了**（实测死锁）。
 *
 *   现在 force = "确认用托管块接管，请把手写那条替换掉"，真的会移除手写条目。
 *
 * @returns {{ok:boolean, file:string, backup:string, mode:string, error:string}}
 */
export function writePatchBlock({ file, blockYaml, force = false } = {}) {
  const fail = (error) => ({ ok: false, file: String(file ?? ''), backup: '', mode: '', error })
  if (typeof file !== 'string' || file === '') return fail('缺少目标文件路径')
  let original
  try {
    original = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return fail(`读不了 ${file}：${err?.code === 'ENOENT' ? '文件不存在（DSH 未安装或 profile 名不对）' : msg(err)}`)
  }
  const conflicted = hasUnmanagedRemoteAgent(original)
  if (conflicted && force !== true) {
    return fail(
      '配置里已有一段手写的 remote-agent 条目。直接写会产生同 id 重复（插件挂载两次，启动失败）。'
      + '勾选"替换手写配置"后重试（会自动备份原文件），或手动合并。',
    )
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${file}.bak-dshra-${stamp}`
  try {
    fs.writeFileSync(backup, original, 'utf8')
    // force 且真有手写条目时才走"替换手写"路径 —— 没有冲突时保持原行为，
    // 免得无谓地动用户文件（例如托管块已在、只是改个 role）。
    const replaceHandWritten = force === true && conflicted
    const { text, mode } = upsertManagedBlock(original, blockYaml, replaceHandWritten)
    // 写前校验：结果必须仍非空且标记配对
    if (text.trim() === '') throw new Error('合并结果为空')
    // ⚠ 关键校验：写完之后**不得**再存在托管块之外的手写条目 ——
    // 这正是原 bug 的形态（两条同 id）。不校验的话它会静默写出去。
    if (hasUnmanagedRemoteAgent(text)) {
      throw new Error('合并后仍存在托管块之外的手写 remote-agent 条目（会产生同 id 重复）')
    }
    fs.writeFileSync(file, text, 'utf8')
    const verify = fs.readFileSync(file, 'utf8')
    if (!verify.includes(MANAGED_BEGIN) || !verify.includes(MANAGED_END)) throw new Error('写入后标记丢失')
    if (hasUnmanagedRemoteAgent(verify)) throw new Error('落盘后校验发现重复条目')
    return { ok: true, file, backup, mode, error: '' }
  } catch (err) {
    // 回滚：任何一步失败都把原文件还回去
    try {
      if (typeof original === 'string') fs.writeFileSync(file, original, 'utf8')
    } catch { /* 回滚失败也如实上报 */ }
    return fail(`写入失败（已回滚）：${msg(err)}`)
  }
}

function msg(err) {
  return err instanceof Error ? err.message : String(err)
}
