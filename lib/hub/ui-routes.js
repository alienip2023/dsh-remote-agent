/**
 * UI 控制路由：给 Web 面板提供只读数据 + 少量动作。
 *
 * 为什么用 HTTP 路由而不是别的通道：
 *   静态 bundle 的 client 半（浏览器）能用的 Client 服务只有 layout/sessions/slots/
 *   theme/timer/workspaces —— **没有任何一个能读到远程节点或任务**。而 `host.call()`
 *   属于动态包（cordis_run）机制，静态 bundle 不走那条路。同 profile 的
 *   `dsh-context` 与 `dsh-better-sidebar` 都是用 `fetch('<自己的路由>')` 拿 Host 数据，
 *   这是已在本机验证过可行的模式。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（v0.1 加固版，逐条结论见下方各段注释）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 【结论 1 · 这些路由**不在** DSH 的 /api 鉴权围栏内】
 *
 * 这是本文件最重要的一条。DSH 的 Host/Origin + 浏览器 cookie 围栏由
 * `@deepseek-ai/dsh-client-connection` 注册，而它的注册形态是：
 *
 *     kind: 'prefix', path: '/api'      // ← prefix
 *     handler: 先 admit(req)（Host/Origin + cookie），再 bridge 到 RPC
 *
 * 而本文件的路由是：
 *
 *     kind: 'exact',  path: '/api/remote-agent/ui/...'   // ← exact
 *
 * `@deepseek-ai/dsh-host-webserver` 的 `match()` 是 **exact 表优先于 prefix 表**：
 *
 *     match(pathname) {
 *       const exact = this.exact.get(pathname);
 *       if (exact !== void 0) return exact;      // ← 命中 exact 就直接返回
 *       ...longest-prefix-wins...
 *     }
 *
 * 结论：命中 exact 的请求**不会**走到 `/api` prefix 的 admit()，即我们的 UI 路由
 * 绕过了 DSH 的 token/cookie 围栏。已用真实 dsh-host-webserver 实测确认：
 * 同一台 server 上，`/api/remote-agent/ui/overview`（exact）返回 200，
 * 而 `/api/some-other/thing`（只命中 prefix）返回 401。
 *
 * 因此本文件**不能**假设"外层会替我们鉴权"，必须自带请求围栏 —— 见 `guard()`。
 * 这与 `dsh-context` 的做法一致：它走 `ctx.connection.fetch.register`（受围栏保护），
 * 而不是 `webServer.register`；我们走 webServer 是因为静态 bundle 拿不到 connection。
 *
 * 【结论 2 · CSRF：判定"低风险，但已显式加固"】
 *
 * 判定：第三方页面**无法**诱导这些动作，理由三条（前两条来自框架，第三条来自本文件）：
 *
 *   a) **cookie 是 SameSite=Strict**（client-connection `sessionCookie()`：
 *      `Path=/; HttpOnly; SameSite=Strict`）。跨站发起的 fetch/XHR 不会带上
 *      这个 cookie，所以跨站请求拿不到任何浏览器凭证。
 *   b) **JSON content-type 触发 CORS 预检**。`apiPost` 发的是
 *      `content-type: application/json`，属于"非简单请求"，浏览器必先发
 *      OPTIONS 预检；本文件不返回任何 `access-control-allow-*` 头，
 *      预检必然失败，真实请求不会发出。
 *      （`text/plain` 表单可绕过预检，但 body 是 `a=b` 形式，readJson() 解析失败 → 400。）
 *   c) **本文件现在主动拒绝跨源**（结论 1 的 guard）：带 `Origin` 且与 `Host`
 *      不一致 → 403；`sec-fetch-site: cross-site` → 403。即使 (a)(b) 因浏览器
 *      行为差异或未来框架改动而失效，这一层仍然拦得住。
 *
 * 结论：CSRF **不是**本组路由的主要风险面 —— 因为 DSH 的会话 cookie 是
 * SameSite=Strict 且动作要求 JSON，浏览器的同源模型已经把它挡在门外。
 * 主要风险面是**绕过围栏的本地/同源访问**（结论 1），以及 pull 的路径逃逸（结论 4）。
 * 因此 guard 的设计目标是"补上被绕过的围栏"，而不是"防 CSRF"。
 * 注意 guard 对无 Origin 的请求放行（curl/本机进程），这类客户端本就不携带
 * 浏览器凭证，不属于 CSRF 载体。
 *
 * 【结论 3 · 响应体逐字段白名单，绝不 spread】
 *
 * `nodeView()` / `taskView()` / `handoffView()` 都是**逐字段构造**的字面量对象。
 * 反例是 `{...registry.list()[i]}` 或 `{...t.handoff}` —— 那会让将来新增的
 * 内部字段（conn、hello 全量、pendingPulls…）自动泄漏到浏览器。
 * `handoffView()` 尤其重要：handoff 由副机上报，字段集不受本文件控制。
 *
 * 【结论 4 · pull 是唯一写盘动作，双道校验】
 *
 * 顺序必须是：字符串层 isInside → mkdir → realpath 复查。
 * 先字符串（挡 `../` 与反斜杠），再 realpath（挡符号链接与 8.3 短名）。
 * 注意 realpath **必须在 mkdir 之后**，否则新目录 realpath 会失败；
 * 而"先 mkdir 再校验"意味着一个越界目录可能被**创建**出来 —— 这是可接受的，
 * 因为创建空目录不是数据泄漏，而写入越界文件才是。见 `resolvePullDest()`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ERROR_CODE, RemoteAgentError, TASK_MODE } from '../protocol.js'
import { isInside, normalizePath } from '../glob.js'
// 视图投影共享层：工具路径与 UI 路径用**同一份**白名单，
// 不让任一方绕开投影（见下方「视图投影」段的说明）。
import {
  changedView,
  exitView,
  errorView,
  handoffView,
  nodeView,
  taskView,
} from './views.js'

export const UI_API_PREFIX = '/api/remote-agent/ui'

/** 单次请求体上限：UI 只发小 JSON，超过就是异常。 */
const MAX_BODY = 256 * 1024

/** 错误消息回给浏览器的上限（避免把绝对路径/内部细节整段回显）。 */
const MAX_ERR_MESSAGE = 300

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // 面板数据不进任何缓存：任务状态是活的
    'cache-control': 'no-store',
  })
  res.end(payload)
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

/**
 * 错误消息净化：只回稳定 code + 截断后的短消息，绝不回堆栈。
 *
 * 为什么必须截断：`RemoteAgentError` 的消息里经常带绝对路径
 * （例如 `artifact vanished: C:\Users\...\x`、`workspace outside allowed roots: ...`），
 * 整段回显等于把主机目录结构交给浏览器。堆栈更糟（含源码路径与行号）。
 * 所以这里**只取 message 的前 N 字符**，并且从不把 `err.stack` 写进响应。
 */
function shortMessage(err) {
  const raw = String(err?.message ?? err ?? '')
  // 去掉可能夹带的换行/堆栈形态尾巴
  const firstLine = raw.split(/\r?\n/)[0]
  return firstLine.slice(0, MAX_ERR_MESSAGE)
}

/**
 * 本地请求围栏的兜底实现（当 `connection` 服务不可用时使用）。
 *
 * 刻意做成 DSH `isTrustedApiRequest` 的**保守子集**：
 *   - `sec-fetch-site: cross-site` → 拒（浏览器明确标注的跨站）
 *   - 带 `Origin` 且其 host 与 `Host` 不一致 → 拒（跨源）
 *   - 无 `Origin`（curl / 本机进程 / 测试）→ 放行
 *
 * 为什么无 Origin 放行：非浏览器客户端不会自动携带凭证，本就不是 CSRF 载体；
 * 而要求 Origin 会让所有 CLI/测试调用失效。真正的边界是 Host/Origin 一致性。
 */
function sameOriginOk(req) {
  const headers = req?.headers ?? {}
  const host = headers.host
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 请求围栏：每个 UI 路由的第一道门。
 *
 * 【为什么必须有这一道】
 * 见文件头"结论 1"：本文件注册的是 `kind:'exact'`，而 DSH 的 /api 围栏是
 * `kind:'prefix'`，WebServer.match() exact 优先 → 我们的路由**绕过**了 DSH 的
 * Host/Origin + cookie 鉴权。所以不能假设"外层会替我们鉴权"。
 *
 * 【怎么补】优先复用框架自己的围栏，而不是自己造一套：
 *   `ctx.connection.requestRejection(request)` 的官方用途正是
 *   "Apply Connection's Host/Origin checks and browser authentication to
 *    **another** Web route" —— 我们就是那个 another route。
 *   返回 401 / 403 / undefined，语义与 DSH 内建 /api 完全一致。
 *
 * 该服务不存在时（例如无 web 组件的组合、单元测试）退回到 sameOriginOk()，
 * 保证"没有围栏"不会退化成"完全不检查跨站"。
 *
 * @returns {true} 放行；{false} 已写响应，调用方应立即返回
 */
function makeGuard(ctx, log) {
  return function guard(req, res, pathname) {
    let rejection
    try {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
      if (connection && typeof connection.requestRejection === 'function') {
        rejection = connection.requestRejection({ headers: req.headers ?? {} })
      }
    } catch (err) {
      // 围栏自身出错时**失败关闭**：宁可面板不可用，也不放行未鉴权请求。
      log('warn', 'ui guard: connection fence threw, failing closed', { path: pathname, error: shortMessage(err) })
      rejection = 403
    }
    if (rejection === undefined && !sameOriginOk(req)) rejection = 403
    if (rejection === undefined) return true
    writeJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return false
  }
}

// ── 视图投影：**从 lib/hub/views.js 共享** ──────────────────────────
//
// 这里的六个投影函数（nodeView / changedView / exitView / errorView /
// taskView / handoffView）原本定义在本文件里。提取出去的原因是：它们只被
// UI 路径使用，而 `remote_handoff` 工具因为"没有对应的 View 函数"就裸直出了
// `t.handoff` —— 加固做了一半，而且漏掉的正是更该加固的那一半
// （工具返回值会进入会话日志，被后续每个请求带上）。
//
// 集中到 views.js 后，新增消费方无处可绕开投影。

/**
 * 计算 pull 的落盘目录，双道校验。
 *
 * 顺序（**不可调换**）：
 *   1. 字符串层 `isInside(pullRoot, destDir)` —— 挡 `../`、`..\`、绝对路径
 *   2. `mkdirSync(destDir)` —— 目录不存在时 realpath 会失败，所以必须先建
 *   3. `realpathSync(destDir)` 后复查 `isInside(realRoot, realDest)`
 *      —— 挡符号链接、Windows 8.3 短名、junction 等字符串层看不出的逃逸
 *
 * 已知的取舍：第 2 步可能创建一个"最终会被判定越界"的空目录
 * （例如 pullRoot 内已有一个指向 /etc 的符号链接，我们会在 /etc 下 mkdir）。
 * 这是可接受的 —— 创建空目录不是数据泄漏，越界**写入**才是，
 * 而第 3 步保证了越界写入不会发生。反过来若先校验再 mkdir，
 * 新建目录的 realpath 会抛 ENOENT，正常路径反而不可用。
 *
 * @returns {{ok:true, dir:string} | {ok:false, code:string, dest:string}}
 */
export function resolvePullDest(pullRoot, sub) {
  const destDir = path.resolve(pullRoot, typeof sub === 'string' ? sub : '')

  // ① 字符串层：挡 ../ 与反斜杠写法
  if (!isInside(normalizePath(pullRoot), normalizePath(destDir), {})) {
    return { ok: false, code: 'dest-outside-pull-root', dest: typeof sub === 'string' ? sub : '' }
  }

  let realRoot
  let realDest
  try {
    fs.mkdirSync(pullRoot, { recursive: true })
    realRoot = fs.realpathSync.native ? fs.realpathSync.native(pullRoot) : fs.realpathSync(pullRoot)
    // ② 建目录（realpath 要求路径存在）
    fs.mkdirSync(destDir, { recursive: true })
    // ③ realpath 归一后复查：挡符号链接逃逸
    realDest = fs.realpathSync.native ? fs.realpathSync.native(destDir) : fs.realpathSync(destDir)
  } catch (err) {
    return { ok: false, code: 'pull-root-unusable', dest: typeof sub === 'string' ? sub : '', message: shortMessage(err) }
  }

  if (!isInside(normalizePath(realRoot), normalizePath(realDest), {})) {
    return { ok: false, code: 'dest-outside-pull-root-after-resolve', dest: typeof sub === 'string' ? sub : '' }
  }
  return { ok: true, dir: realDest }
}

/**
 * 注册 UI 路由。
 *
 * @param {object} o
 * @param {object} o.ctx dsh 上下文（需要 webServer）
 * @param {object} o.registry NodeRegistry
 * @param {object} o.pulls PullManager
 * @param {(level:string,msg:string,extra?:object)=>void} o.log
 * @param {object} o.defaults remote_task 默认值
 * @param {string} [o.pullRoot] 允许 UI 拉取产物落地的根目录（绝对路径）。未配置则禁用 pull。
 * @param {object} [o.config] 本插件行的**生效配置**（只读快照），供面板展示
 * @returns {Array<() => void>} disposers
 */
export function registerUiRoutes({ ctx, registry, pulls, log, defaults = {}, pullRoot, config = {} }) {
  const disposers = []
  const guard = makeGuard(ctx, log)

  // ── 诊断（临时）：把注册过程写到文件，不依赖任何日志系统 ──────────
  //
  // 背景：桌面版面板报 `HTTP 404`，而命令行实测「带 cookie 时我的路由与
  // 不存在的路径返回完全相同（404 not found）」—— 指向 exact 路由**没注册成功**。
  // 但启动输出里没有任何错误（DSH 的启动日志不包含插件的 import/注册失败详情）。
  // 所以这里直接把注册结果落到文件，绕过日志系统取证。
  const diagFile = path.join(os.tmpdir(), 'dsh-remote-agent-diag.log')
  const diag = (msg, extra) => {
    try {
      fs.appendFileSync(diagFile, `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`, 'utf8')
    } catch {
      /* 诊断不能影响主流程 */
    }
  }
  diag('registerUiRoutes called', {
    hasWebServer: Boolean(ctx && ctx.webServer),
    hasRegister: typeof (ctx && ctx.webServer && ctx.webServer.register) === 'function',
    hasGet: typeof (ctx && ctx.get) === 'function',
    wsKeys: (() => {
      try { return Object.keys(ctx.webServer || {}).sort().slice(0, 40) } catch { return null }
    })(),
    wsProto: (() => {
      try { return Object.getPrototypeOf(ctx.webServer)?.constructor?.name ?? null } catch { return null }
    })(),
    // ⚠ 注意时间顺序：这是**注册之前**的快照，本来就不该包含 ui/* 路由。
    // 真正要对照的是注册**之后**的 exactKeysFinal（在函数末尾）。
    exactKeysBefore: (() => {
      try {
        const t = ctx.webServer.exact
        if (!t) return null
        return typeof t.keys === 'function' ? [...t.keys()].length : 'no-keys-method'
      } catch (e) { return 'err:' + String(e?.message ?? e) }
    })(),
    listenedPort: (() => {
      try { return ctx.webServer.listenedPort ?? null } catch { return null }
    })(),
  })

  /**
   * 面板可读的配置视图。
   *
   * **为什么只读**：改配置需要写回 profile 的 patch 层（`cordis.patch.yml`），
   * 而那条路径由 loader 拥有 —— 插件在运行时改它会让下次启动的配置与当前进程
   * 不一致，且没有事务保证。所以面板只**展示**当前生效值，要改请编辑 profile。
   * 这比提供一个"半可靠"的写入按钮更诚实。
   */
  const configView = () => ({
    role: typeof config.role === 'string' ? config.role : 'hub',
    // ⚠ 凭证一律**只回"是否已设置"的布尔**，绝不回明文 —— 面板是浏览器里的东西，
    // 它看到的每个字节都可能被扩展、调试工具或被截图带走。
    // （nodeToken 曾经原样回传，是实测发现的泄漏；relay.token 一开始就是布尔。）
    nodeTokenSet: typeof config.nodeToken === 'string' && config.nodeToken !== '',
    relayTokenSet: typeof config.relay?.token === 'string' && config.relay.token !== '',
    uiPullRoot: typeof config.uiPullRoot === 'string' ? config.uiPullRoot : '',
    uiEnabled: config.uiEnabled !== false,
    relayUrl: typeof config.relay?.url === 'string' ? config.relay.url : '',
    nodeId: typeof config.nodeId === 'string' ? config.nodeId : '',
    transportMode: typeof config.transportMode === 'string' ? config.transportMode : 'relay',
    roots: Array.isArray(config.roots) ? config.roots : [],
    stateDir: typeof config.stateDir === 'string' ? config.stateDir : '',
    // 让面板能提示"改这些要去哪改"
    editHint: '以下配置在 profile 的 cordis.patch.yml 里修改，改完重启 DSH 生效',
  })

  /**
   * 每个 handler 都包两层：
   *   1. **请求围栏**（guard）：见文件头"结论 1" —— 这些 exact 路由绕过 DSH 的
   *      /api prefix 围栏，必须自己复用 connection.requestRejection。
   *   2. **异常收口**：稳定 code + 截断消息（**不含堆栈**，堆栈里有绝对路径），
   *      且 UI 抛错不能让 host 崩。
   */
  const route = (pathname, handler) => {
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          try {
            // 诊断：记录每次命中的请求。桌面版（Electron）的 dsh-app:// 页面
            // 经 forwardWebRequest 转发时会改写 origin/cookie，出问题时这一行
            // 是判断"请求到没到"的唯一依据。
            log('debug', 'ui route hit', { path: pathname, method: req.method, origin: req.headers?.origin ?? null })
            if (!guard(req, res, pathname)) {
              log('warn', 'ui route rejected by guard', { path: pathname, origin: req.headers?.origin ?? null })
              return
            }
            await handler(req, res)
          } catch (err) {
            const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL
            log('warn', 'ui route failed', { path: pathname, code, error: shortMessage(err) })
            try {
              writeJson(res, 500, { error: code, message: shortMessage(err) })
            } catch {
              /* 响应可能已发出 */
            }
          }
        },
      }))
      // 注册后**回查**：确认路由真的进了该实例的路由表。
      // 如果 register() 成功但表里查不到，说明我们注册到的实例与对外服务的不一致
      // （双实例）；如果表里有但请求仍不命中，问题在匹配或转发层。
      diag('route registered OK', {
        path: pathname,
        // 从实例上回查 —— **必须直接查 exact 表，不能用 ws.match()**。
        //
        // 我的第一版用了 `Boolean(ws.match(pathname))`，那是**错的**：match() 在
        // exact 未命中时会 fallback 到 prefix 表，而 `/api` 是 prefix —— 于是
        // 任何 /api/* 路径都返回 truthy，`inTable` 恒为 true，把真相掩盖了。
        // 实测证据：inTable 报 true，但 exactKeysBefore 里根本没有我的路由。
        inExact: (() => {
          try {
            const t = ctx.webServer.exact
            if (!t) return 'no-exact-table'
            if (typeof t.has === 'function') return t.has(pathname)
            return 'no-has-method'
          } catch (e) { return 'error:' + String(e?.message ?? e) }
        })(),
        // match() 的完整结果（用于对照：能看出它落到了哪个 prefix）
        matchResult: (() => {
          try {
            const r = ctx.webServer.match ? ctx.webServer.match(pathname) : null
            if (!r) return null
            return { kind: r.kind, path: r.path }
          } catch (e) { return 'error:' + String(e?.message ?? e) }
        })(),
        // 注册**之后**再看一次 exact 表的全部 key，与 exactKeysBefore 对照
        exactKeysAfter: (() => {
          try {
            const t = ctx.webServer.exact
            return t && typeof t.keys === 'function' ? [...t.keys()].length : null
          } catch { return null }
        })(),
      })
    } catch (err) {
      // 注册抛错是**静默致命**的：路由不存在 → 请求落到 /api prefix → 面板看到
      // 404/401，而启动日志里什么都没有。必须留痕。
      diag('route registration FAILED', { path: pathname, error: String(err && err.message ? err.message : err) })
      log('error', 'ui route registration failed', { path: pathname, error: shortMessage(err) })
    }
  }

  // ── 总览：节点 + 任务计数 + 面板自身能力 ──────────────────────
  route(`${UI_API_PREFIX}/overview`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const nodes = registry.list().map(nodeView)
    const tasks = registry.listTasks().map((t) => registry.taskView(t))
    writeJson(res, 200, {
      ok: true,
      nodes,
      counts: {
        nodes: nodes.length,
        online: nodes.filter((n) => n.online).length,
        tasks: tasks.length,
        running: tasks.filter((t) => t.status === 'running' || t.status === 'queued').length,
        activePulls: pulls.activeCount,
      },
      // 面板据此决定按钮是否可用，而不是让用户点了才知道不行
      capabilities: {
        pull: typeof pullRoot === 'string' && pullRoot !== '',
        // 未配置时回 null（而不是空串）：normalizeConfig 会把未配置归一成 ''，
        // 面板据此判断"该不该显示落地目录"，空串会渲染成 "落地到 " 这种残缺文案。
        pullRoot: typeof pullRoot === 'string' && pullRoot !== '' ? pullRoot : null,
        dispatch: true,
      },
    })
  })

  // ── 节点列表 ──────────────────────────────────────────────────
  route(`${UI_API_PREFIX}/nodes`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    writeJson(res, 200, { nodes: registry.list().map(nodeView) })
  })

  // ── 任务列表（可按节点过滤） ──────────────────────────────────
  route(`${UI_API_PREFIX}/tasks`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const nodeId = url.searchParams.get('node') ?? ''
    let tasks = registry.listTasks().map((t) => registry.taskView(t))
    if (nodeId !== '') tasks = tasks.filter((t) => t.nodeId === nodeId)
    // 最近的在前，面板顶部就是最新活动
    tasks.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    writeJson(res, 200, { tasks: tasks.slice(0, 200).map((t) => taskView(t)) })
  })

  // ── 单任务详情（含 handoff 卡片） ─────────────────────────────
  route(`${UI_API_PREFIX}/task`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const taskId = url.searchParams.get('taskId') ?? ''
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })
    const view = taskView(t, { tail: 20 })
    // handoff 经白名单投影后再回（副机上报的字段集不受本文件控制）
    writeJson(res, 200, { task: view, handoff: handoffView(t.handoff) })
  })

  // ── 动作：派任务 ──────────────────────────────────────────────
  route(`${UI_API_PREFIX}/dispatch`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    if (!body) return writeJson(res, 400, { error: 'bad-body' })

    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (goal === '') return writeJson(res, 400, { error: 'goal-required' })

    const nodes = registry.list()
    const nodeId = typeof body.node === 'string' && body.node !== ''
      ? body.node
      : (nodes.length === 1 ? nodes[0].nodeId : '')
    if (nodeId === '') {
      return writeJson(res, 400, { error: 'node-required', message: '多个节点时必须在 body.node 指定' })
    }
    if (!registry.getNode(nodeId)) return writeJson(res, 404, { error: 'node-unknown', nodeId })

    const mode = body.mode === TASK_MODE.EXEC ? TASK_MODE.EXEC : TASK_MODE.AGENT
    const taskId = `ui-${Date.now().toString(36)}${Math.floor(Math.random() * 0x1000).toString(36)}`

    // 复用与 remote_task 工具完全相同的注册路径，避免两套行为漂移
    const { validateTaskStart } = await import('../protocol.js')
    const v = validateTaskStart({
      taskId,
      goal,
      workspace: typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : undefined,
      mode,
      outputs: Array.isArray(body.outputs) ? body.outputs.filter((s) => typeof s === 'string') : [],
      constraints: {
        timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : (defaults.timeoutMs ?? 3600000),
        denyPaths: [],
      },
      origin: 'ui',
    })
    if (!v.ok) return writeJson(res, 400, { error: v.error })

    registry.createTask({ nodeId, spec: v.spec })
    writeJson(res, 200, { ok: true, taskId, nodeId, mode })
  })

  // ── 动作：取消任务 ────────────────────────────────────────────
  route(`${UI_API_PREFIX}/cancel`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    const body = await readJson(req)
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    if (taskId === '') return writeJson(res, 400, { error: 'taskId-required' })
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })
    // cancelTask 返回 false 有两种含义：任务不存在（上面已排除）或 cancel 帧没发出去
    // （节点离线）。所以 requested=false 表示"请求未能送达"，面板应据此提示。
    const delivered = registry.cancelTask(taskId) === true
    writeJson(res, 200, { ok: true, requested: delivered, nodeId: t.nodeId })
  })

  // ── 动作：拉产物 ──────────────────────────────────────────────
  //
  // 这是唯一会写磁盘的 UI 动作，所以约束最严：
  //   - 必须配置 pullRoot（否则整个动作禁用）
  //   - dest 只能是 pullRoot 内的相对子路径，且经 realpath 归一后仍在其中
  route(`${UI_API_PREFIX}/pull`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    if (typeof pullRoot !== 'string' || pullRoot === '') {
      return writeJson(res, 403, { error: 'pull-disabled', message: '未配置 uiPullRoot，UI 拉取已禁用' })
    }
    const body = await readJson(req)
    const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
    const paths = Array.isArray(body?.paths) ? body.paths.filter((p) => typeof p === 'string') : []
    if (taskId === '' || paths.length === 0) {
      return writeJson(res, 400, { error: 'taskId-and-paths-required' })
    }
    const t = registry.getTask(taskId)
    if (!t) return writeJson(res, 404, { error: ERROR_CODE.TASK_UNKNOWN, taskId })

    // 目标目录：pullRoot + 可选相对子目录（双道校验，见 resolvePullDest）
    const resolved = resolvePullDest(pullRoot, body?.dest)
    if (!resolved.ok) {
      const status = resolved.code === 'pull-root-unusable' ? 500 : 403
      return writeJson(res, status, { error: resolved.code, dest: resolved.dest })
    }

    const results = []
    for (const p of paths.slice(0, 50)) {
      try {
        // pull() 的契约是 { nodeId, taskId, relPath, dest }（见 pull-manager.js）
        const r = await pulls.pull({ nodeId: t.nodeId, taskId, relPath: p, dest: resolved.dir })
        results.push({ path: p, ok: true, bytes: r?.bytes ?? null, sha256: r?.sha256 ?? null })
      } catch (err) {
        const code = err instanceof RemoteAgentError ? err.code : ERROR_CODE.INTERNAL
        results.push({ path: p, ok: false, error: code, message: shortMessage(err) })
      }
    }
    writeJson(res, 200, { ok: true, dest: resolved.dir, results })
  })

  // ── 配置视图：面板里的「主机设置」区读它 ──────────────────────
  //
  // 只读。改配置要编辑 profile 的 patch 层并重启 —— 插件在运行时写它会让
  // 下次启动的配置与当前进程不一致，且没有事务保证。面板负责**展示**当前
  // 生效值 + 指明去哪改，比提供一个半可靠的写入按钮更诚实。
  route(`${UI_API_PREFIX}/config`, (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { error: 'method' })
    writeJson(res, 200, { ok: true, config: configView() })
  })

  // ── 诊断：面板自报（用于排查"面板 404 但路由存在"这类问题）──────
  //
  // 背景：桌面版（Electron）的页面来源是 `dsh-app://app/`，它对非静态资源的
  // 请求会经 `forwardWebRequest` 转发到本机 HTTP 服务。这条链路上任何一环出问题
  // （页面 origin 不同、转发改写、路径不符）都会表现为面板里的一个 HTTP 错误码，
  // 而**光看那个码无法区分是哪一环**。
  //
  // 所以给面板一个"把现场报回来"的端点：client 在首次加载时 POST 自己的
  // location.href / origin / 以及它实际请求的 URL。这条会进 DSH 日志。
  //
  // 安全：只接受同源请求（走同一个 guard），且**只记录不执行任何动作**；
  // 请求体上限 4KB，字段逐个白名单，绝不回显。
  route(`${UI_API_PREFIX}/diag`, async (req, res) => {
    if (req.method !== 'POST') return writeJson(res, 405, { error: 'method' })
    let body = {}
    try {
      body = (await readJson(req, 4096)) ?? {}
    } catch {
      /* 体不合法也继续记，现场信息在 header 里 */
    }
    const pick = (v) => (typeof v === 'string' ? v.slice(0, 300) : null)
    log('info', 'panel self-report', {
      pageHref: pick(body.href),
      pageOrigin: pick(body.origin),
      pageProtocol: pick(body.protocol),
      apiBase: pick(body.apiBase),
      probeUrl: pick(body.probeUrl),
      probeStatus: typeof body.probeStatus === 'number' ? body.probeStatus : null,
      probeError: pick(body.probeError),
      reqHost: pick(req.headers?.host),
      reqOrigin: pick(req.headers?.origin),
      reqSecFetchSite: pick(req.headers?.['sec-fetch-site']),
    })
    writeJson(res, 200, { ok: true })
  })

  // ── 注册后的最终取证 ──────────────────────────────────────────
  //
  // 这一条是定位"注册成功但请求不命中"的**决定性**证据：
  //   ① exactKeysFinal：注册**之后** exact 表里的 key 总数与是否含我们的路径
  //      （对照 exactKeysBefore —— 若数量没变，说明注册没进表）
  //   ② 延迟复查（+3s / +8s）：若此刻在、稍后不在，说明 effect 被 dispose 了
  const snapshot = () => {
    try {
      const t = ctx.webServer.exact
      if (!t || typeof t.keys !== 'function') return { err: 'no-exact-keys' }
      const keys = [...t.keys()]
      return {
        total: keys.length,
        hasOverview: keys.includes(`${UI_API_PREFIX}/overview`),
        hasConfig: keys.includes(`${UI_API_PREFIX}/config`),
        hasDiag: keys.includes(`${UI_API_PREFIX}/diag`),
      }
    } catch (e) { return { err: String(e?.message ?? e) } }
  }
  diag('exactKeysFinal (right after registration)', snapshot())
  setTimeout(() => diag('exactKeysFinal (+3s)', snapshot()), 3000)
  setTimeout(() => diag('exactKeysFinal (+8s)', snapshot()), 8000)

  return disposers
}