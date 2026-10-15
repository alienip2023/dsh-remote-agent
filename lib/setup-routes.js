/**
 * 引导路由：**未配置时**注册的最小 UI 路由集。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要一组独立的路由（而不是复用 hub 的那些）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 首次安装时插件**无法知道**这台机器是主机还是副机 —— 只有用户知道。
 * 所以 `role` 的默认值是空（未配置），此时：
 *
 *   · `applyHub` **不跑** → hub 的 10 条 UI 路由都不存在
 *   · `applyWorkerBranch` **不跑** → 也不启动拨入
 *
 * 如果这时什么都不注册，用户打开面板只会看到两个端点都失败的报错 ——
 * **拿不到任何引导**。所以未配置时必须注册这一小组：
 *
 *   GET  /api/remote-agent/setup/state   当前配置状态（让面板知道该显示引导）
 *   POST /api/remote-agent/setup/apply   写入角色选择（安全写盘，含备份回滚）
 *   GET  /api/remote-agent/setup/pair    生成配对码（选 hub 后给副机用）
 *
 * ── 与 hub 那组路由的关系 ────────────────────────────────────────────────
 * 这组**不依赖** NodeRegistry / PullManager（未配置时它们不存在），所以参数
 * 只有 `ctx` 与 `config`。它也不注册工具 —— 未配置时不该有任何工具可用。
 *
 * ── 安全 ────────────────────────────────────────────────────────────────
 * 与其他 UI 路由一样自带同源围栏（`kind:'exact'` 会绕过 DSH 的 `/api` prefix
 * 围栏，所以必须自己补）。写盘走 `lib/setup.js` 的 `writePatchBlock()` ——
 * 它有冲突检测、备份、托管块、写后校验、失败回滚。
 */
import path from 'node:path'
import os from 'node:os'
import { ERROR_CODE, RemoteAgentError } from './protocol.js'
import { writePatchBlock } from './setup.js'

/** 引导路由的前缀。与 hub 的 `/api/remote-agent/ui` 分开 —— 未配置时后者不存在。 */
export const SETUP_API_PREFIX = '/api/remote-agent/setup'

const MAX_BODY = 16 * 1024

/** 同源围栏（与 ui-routes.js 的 makeGuard 同策略，但更简单：这里没有 connection 可用时也要 fail-closed）。 */
function makeGuard(ctx, log) {
  return function guard(req, res, pathname) {
    let rejection
    try {
      // 与 webServer 同理：**属性访问优先**，`ctx.get(name, false)` 非严格兜底。
      // `ctx.get` 的默认 strict=true 只返回"提供者 fiber 当前活跃"的服务，
      // 在 apply() 早期可能拿不到。
      let connection
      try {
        connection = ctx.connection
      } catch {
        /* 未声明 inject 时属性访问会抛 */
      }
      if (!connection && typeof ctx.get === 'function') connection = ctx.get('connection', false)
      if (connection && typeof connection.requestRejection === 'function') {
        rejection = connection.requestRejection({ headers: req.headers ?? {} })
      }
    } catch (err) {
      log('warn', 'setup guard: connection fence threw, failing closed', { path: pathname, error: String(err?.message ?? err) })
      rejection = 403
    }
    if (rejection === undefined) {
      // connection 不可用（或没拒绝）时的兜底：只挡浏览器明确标注的跨站。
      const h = req.headers ?? {}
      if (h['sec-fetch-site'] === 'cross-site') rejection = 403
      else if (h.origin !== undefined) {
        try {
          if (new URL(h.origin).host !== h.host) rejection = 403
        } catch {
          rejection = 403
        }
      }
    }
    if (rejection === undefined) return true
    res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
    return false
  }
}

async function readJson(req, maxBody = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBody) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * 默认 profile 的 `cordis.patch.yml` 路径。
 *
 * 与 `lib/setup.js` 的 `defaultPatchFile()` 同源 —— 但这里**不 import 它**，
 * 因为那条路径要处理 profile 名归一化，而这里只关心"当前生效的 profile"。
 * 从环境变量 `DSH_PROFILE` 取（DSH 启动时设置），退回到 desktop。
 */
function currentPatchFile() {
  const raw = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'desktop'
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '')
  return path.join(os.homedir(), '.dsh', 'profiles', safe === '' ? 'desktop' : safe, 'cordis.patch.yml')
}

/**
 * 注册引导路由。
 *
 * @param {object} ctx cordis 上下文（需要 webServer；没有就静默跳过）
 * @param {object} config 本行的生效配置（只读快照）
 * @param {(level:string,msg:string,extra?:object)=>void} log
 * @returns {Array<() => void>} disposers
 */
export function registerSetupRoutes(ctx, config = {}, log = () => {}) {
  const disposers = []
  // ⚠ **必须优先用属性访问 `ctx.webServer`，不能只用 `ctx.get('webServer')`。**
  //
  // cordis 的 `ctx.get(name, strict = true)` 默认只返回"提供者 fiber **当前
  // 活跃**"的服务（源码注释原文："strict — when true, only return
  // implementations whose providing fiber is currently active"）。
  //
  // 而本函数在 `apply()` 的**早期**被调用（先于 hub/worker 分支），那时
  // webServer 的提供者 fiber 可能还没激活 → `ctx.get` 返回 undefined →
  // 整组引导路由静默跳过 → `/api/remote-agent/setup/state` 落到 DSH 的
  // `/api` prefix 围栏 → 返回**纯文本** `unauthorized`（与"路径不存在"
  // 完全一样的响应，实测极难排查）。
  //
  // 属性访问走的是另一条路（`internal/get` waterfall + fiber store 查找），
  // 能拿到已就绪的服务 —— `applyHub` 一直用的就是 `ctx.webServer`，那是
  // 被验证可用的形态。
  //
  // 保留 `ctx.get(name, false)`（**非严格**）作为兜底：万一属性访问在某个
  // 组合下不可用（例如 loader 行没声明 inject），非严格查找仍能拿到值。
  let webServer
  try {
    webServer = ctx.webServer
  } catch {
    /* 没声明 inject 时属性访问会抛 —— 走下面的兜底 */
  }
  if (!webServer) {
    try {
      webServer = typeof ctx.get === 'function' ? ctx.get('webServer', false) : undefined
    } catch {
      webServer = undefined
    }
  }
  if (!webServer || typeof webServer.register !== 'function') {
    // 没有 webServer 的组合（纯 headless）：没有面板，也就不需要引导路由。
    log('info', 'setup routes skipped: no webServer in this composition')
    return disposers
  }
  const guard = makeGuard(ctx, log)

  const route = (pathname, handler) => {
    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          try {
            const h = req.headers ?? {}
            log('info', 'setup route in', {
              path: pathname,
              method: req.method,
              hasCookie: typeof h.cookie === 'string' && h.cookie !== '',
              origin: typeof h.origin === 'string' ? h.origin : null,
            })
            if (!guard(req, res, pathname)) return
            await handler(req, res)
          } catch (err) {
            const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL
            log('warn', 'setup route failed', { path: pathname, code, error: String(err?.message ?? err) })
            try {
              writeJson(res, 500, { error: code, message: String(err?.message ?? err).slice(0, 300) })
            } catch {
              /* 响应可能已发出 */
            }
          }
        },
      }))
      log('info', 'setup route registered', { path: pathname })
    } catch (err) {
      log('error', 'setup route registration failed', { path: pathname, error: String(err?.message ?? err) })
    }
  }

  // ── 状态：面板据此决定显示引导还是"切换角色" ─────────────────────────
  //
  // 这组路由**始终注册**（不只未配置时）—— 所以这里必须如实报告当前是否
  // 已配置，面板才能区分：
  //   configured: false → 显示**首次引导**（两个大按钮）
  //   configured: true  → 显示**切换角色**（在设置区，带当前值）
  route(`${SETUP_API_PREFIX}/state`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const role = typeof config.role === 'string' ? config.role.trim().toLowerCase() : ''
    const valid = role === 'hub' || role === 'worker' || role === 'both'
    writeJson(res, 200, {
      ok: true,
      // 未配置 = role 为空或无法识别（与 lib/index.js 的 resolveRoleDetail 同判据）
      configured: valid,
      // 回显当前配置里已有的值，方便用户"改一个字段"而不是从头填
      current: {
        role: valid ? role : '',
        nodeId: typeof config.nodeId === 'string' ? config.nodeId : '',
        transportMode: typeof config.transportMode === 'string' ? config.transportMode : 'relay',
        hubUrl: typeof config.hubUrl === 'string' ? config.hubUrl : '',
        relayUrl: typeof config.relayUrl === 'string' ? config.relayUrl : '',
        roots: Array.isArray(config.roots) ? config.roots : [],
      },
      // 写入目标（让用户知道改的是哪个文件）
      patchFile: currentPatchFile(),
      // 提示：写盘后必须重启
      note: '写入后需要重启 DSH 生效',
    })
  })

  // ── 写入角色选择 ────────────────────────────────────────────────────
  route(`${SETUP_API_PREFIX}/apply`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    if (body === undefined) return writeJson(res, 400, { error: 'bad-body' })

    const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : ''
    if (role !== 'hub' && role !== 'worker' && role !== 'both') {
      return writeJson(res, 400, { error: 'bad-role', message: 'role 必须是 hub / worker / both' })
    }

    // 组装要写入的 YAML 块。**逐字段构造**，绝不把 body 直接序列化进去 ——
    // 那是把用户输入变成配置注入（YAML 里一个换行就能插入任意 loader 行）。
    const lines = [
      '- id: remote-agent',
      '  name: dsh-remote-agent',
    ]
    // inject 必须跟着 role 走：
    //   hub  → 需要 webServer/tools/systemPrompt（注册路由与工具）
    //   worker → 需要 tools/agentLoop/sessions（agent 的 ctx 继承依赖声明，
    //            少了 tools 就挂不上 shell/文件工具 —— 实测踩过）
    if (role === 'worker') {
      lines.push("  inject: ['tools', 'agentLoop', 'sessions']")
    } else {
      lines.push("  inject: ['webServer', 'tools', 'systemPrompt']")
    }
    lines.push('  config:')
    lines.push(`    role: ${role}`)

    const str = (v) => (typeof v === 'string' ? v.trim() : '')
    const nodeId = str(body.nodeId)
    if (nodeId !== '') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nodeId)) {
        return writeJson(res, 400, { error: 'bad-node-id', message: '节点 ID 只能含字母数字 . _ -，以字母或数字开头' })
      }
      lines.push(`    nodeId: ${nodeId}`)
    }
    if (role === 'worker') {
      const mode = str(body.transportMode) === 'direct' ? 'direct' : 'relay'
      lines.push(`    transportMode: ${mode}`)
      if (mode === 'direct') {
        const hubUrl = str(body.hubUrl)
        if (hubUrl === '') {
          return writeJson(res, 400, { error: 'hub-url-required', message: 'direct 模式必须填主机地址' })
        }
        // 引号包裹：URL 里可能有冒号/斜杠，YAML 裸标量在某些形态下会解析异常
        lines.push(`    hubUrl: '${hubUrl.replace(/'/g, "''")}'`)
      } else {
        const relayUrl = str(body.relayUrl)
        if (relayUrl !== '') lines.push(`    relayUrl: '${relayUrl.replace(/'/g, "''")}'`)
      }
    }
    const roots = Array.isArray(body.roots) ? body.roots.map(str).filter((s) => s !== '') : []
    if (roots.length > 0) {
      lines.push('    roots:')
      for (const r of roots) lines.push(`      - '${r.replace(/'/g, "''")}'`)
    }

    const blockYaml = `${lines.join('\n')}\n`
    const file = currentPatchFile()
    const result = writePatchBlock({ file, blockYaml, force: body.force === true })
    if (result.ok !== true) {
      // 冲突（有手写条目）是可预期的用户可修复状态，单独给个 code 让面板
      // 能显示"替换手写配置"按钮，而不是把整段错误文案丢给用户。
      const conflict = /手写的 remote-agent 条目/.test(String(result.error ?? ''))
      return writeJson(res, conflict ? 409 : 400, {
        error: conflict ? 'handwritten-conflict' : 'write-failed',
        message: result.error,
        file: result.file,
      })
    }
    log('info', 'setup applied', { role, file: result.file, mode: result.mode })
    writeJson(res, 200, {
      ok: true,
      role,
      file: result.file,
      backup: result.backup,
      mode: result.mode,
      note: '已写入配置。**重启 DSH 后生效**。',
    })
  })

  return disposers
}
