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
import path from 'node:path'
import { ERROR_CODE, RemoteAgentError, TASK_MODE } from '../protocol.js'
import { isInside, normalizePath } from '../glob.js'

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

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return undefined
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

/**
 * 节点视图：只取 UI 需要的字段，逐字段白名单。
 * 不 spread `registry.list()` 的元素 —— 那会让将来新增的内部字段自动泄漏到浏览器。
 */
function nodeView(n) {
  return {
    nodeId: n.nodeId,
    online: n.online === true,
    os: n.os,
    arch: n.arch,
    agentMode: n.agentMode === true,
    roots: Array.isArray(n.roots) ? n.roots : [],
    caps: Array.isArray(n.caps) ? n.caps : [],
    lastSeen: n.lastSeen,
    since: n.since,
    taskCount: n.taskCount,
  }
}

/**
 * 单个 changed 条目的投影。
 *
 * 为什么必须逐元素投影（而不是只截长度）：`changed` 来自**副机上报**
 * （node-registry 把 handoff.changed 原样存进任务投影）。旧实现只做
 * `t.changed.slice(0, 50)`，元素原样出去 —— 副机只要上报一个 `null`
 * 元素，客户端 `client.js` 的 `c.op` 就会抛 TypeError，而渲染期抛错会让
 * **整个 slot entry 空白**（面板白屏）。这是跨信任边界的缺陷：副机是可被
 * 攻陷的远端，不能让它的上报内容决定主机 UI 是否崩。
 *
 * 只保留客户端真正渲染的四个字段，且强制类型，缺字段给安全默认值。
 */
function changedView(c) {
  if (!c || typeof c !== 'object') return null
  return {
    op: typeof c.op === 'string' ? c.op : 'unknown',
    path: typeof c.path === 'string' ? c.path.slice(0, 500) : '',
    bytes: Number.isFinite(c.bytes) ? c.bytes : 0,
    deltaBytes: Number.isFinite(c.deltaBytes) ? c.deltaBytes : 0,
  }
}

/**
 * exit / error 的投影。
 *
 * 与 handoffView 里的同类投影保持一致 —— 旧实现是 `t.exit ?? null` 直出，
 * 于是副机往 exit/error 里塞的任何字段（诊断信息、环境变量、凭证片段）
 * 都会出现在浏览器里。同一份数据在 handoffView 被白名单、在这里却直出，
 * 是加固不一致。
 */
function exitView(e) {
  if (!e || typeof e !== 'object') return null
  return {
    code: Number.isFinite(e.code) ? e.code : null,
    timedOut: e.timedOut === true,
    aborted: e.aborted === true,
    runner: typeof e.runner === 'string' ? e.runner : '',
    toolCalls: Number.isFinite(e.toolCalls) ? e.toolCalls : 0,
  }
}

function errorView(e) {
  if (!e || typeof e !== 'object') return null
  return {
    code: typeof e.code === 'string' ? e.code : '',
    message: typeof e.message === 'string' ? e.message.slice(0, 500) : '',
  }
}

/** 任务视图：逐字段白名单，元素级投影，并裁掉可能很大的日志/进度尾部。 */
function taskView(t, { tail = 6 } = {}) {
  return {
    taskId: t.taskId,
    nodeId: t.nodeId,
    nodeOnline: t.nodeOnline === true,
    status: t.status,
    mode: t.mode,
    goal: typeof t.goal === 'string' ? t.goal.slice(0, 500) : '',
    // workspace 不再回传：它是**绝对路径**，会回显主机目录结构；而客户端
    // 从不读它（只读派发表单自己的 fv.workspace）。handoffView 早已刻意
    // 移除它，这里保持一致。
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    durationMs: t.durationMs ?? null,
    exit: exitView(t.exit),
    error: errorView(t.error),
    summaryText: typeof t.summary?.text === 'string' ? t.summary.text.slice(0, 2000) : '',
    changedCount: Array.isArray(t.changed) ? t.changed.length : 0,
    // 元素级投影后过滤掉非对象元素 —— 客户端可以安全解引用 c.op
    changed: Array.isArray(t.changed)
      ? t.changed.slice(0, 50).map(changedView).filter(Boolean)
      : [],
    manifestCounts: t.manifest?.counts ?? null,
    progressTail: Array.isArray(t.progressTail) ? t.progressTail.slice(-tail) : [],
    logTail: Array.isArray(t.logTail) ? t.logTail.slice(-tail) : [],
  }
}

/**
 * handoff 卡片视图：**逐字段白名单**。
 *
 * 为什么不能 `{ handoff: t.handoff }` 直接回：handoff 是**副机上报**的对象，
 * 字段集不由本文件控制（见 lib/node/task-engine.js 的 buildHandoff）。
 * 副机版本升级、或将来有人往 handoff 里加诊断字段（含绝对路径、环境变量、
 * 甚至凭证片段），只要本文件 spread 它，就会自动出现在浏览器里。
 * 逐字段挑出面板真正要用的部分，是唯一不依赖"副机永远不写敏感字段"的做法。
 */
function handoffView(h) {
  if (!h || typeof h !== 'object') return null
  const artifacts = h.artifacts && typeof h.artifacts === 'object' ? h.artifacts : null
  const summary = h.summary && typeof h.summary === 'object' ? h.summary : null
  const exit = h.exit && typeof h.exit === 'object' ? h.exit : null
  return {
    taskId: typeof h.taskId === 'string' ? h.taskId : null,
    nodeId: typeof h.nodeId === 'string' ? h.nodeId : null,
    status: typeof h.status === 'string' ? h.status : null,
    mode: typeof h.mode === 'string' ? h.mode : null,
    runner: typeof h.runner === 'string' ? h.runner : null,
    durationMs: typeof h.durationMs === 'number' ? h.durationMs : null,
    startedAt: typeof h.startedAt === 'number' ? h.startedAt : null,
    endedAt: typeof h.endedAt === 'number' ? h.endedAt : null,
    exit: exit
      ? {
        code: typeof exit.code === 'number' ? exit.code : null,
        timedOut: exit.timedOut === true,
        toolCalls: typeof exit.toolCalls === 'number' ? exit.toolCalls : 0,
      }
      : null,
    summaryText: summary && typeof summary.text === 'string' ? summary.text.slice(0, 4000) : '',
    changed: Array.isArray(h.changed)
      ? h.changed.slice(0, 50).map((c) => ({
        path: typeof c?.path === 'string' ? c.path : '',
        op: typeof c?.op === 'string' ? c.op : '',
        bytes: typeof c?.bytes === 'number' ? c.bytes : 0,
      }))
      : [],
    artifacts: artifacts
      ? {
        counts: artifacts.counts ?? null,
        bytesFinal: typeof artifacts.bytesFinal === 'number' ? artifacts.bytesFinal : 0,
        final: Array.isArray(artifacts.final)
          ? artifacts.final.slice(0, 200).map((f) => ({
            path: typeof f?.path === 'string' ? f.path : '',
            kind: typeof f?.kind === 'string' ? f.kind : 'file',
            bytes: typeof f?.bytes === 'number' ? f.bytes : 0,
            sha256: typeof f?.sha256 === 'string' ? f.sha256 : null,
          }))
          : [],
        intermediateCount: typeof artifacts.intermediateCount === 'number' ? artifacts.intermediateCount : 0,
        note: typeof artifacts.note === 'string' ? artifacts.note : '',
      }
      : null,
    pullHint: typeof h.pullHint === 'string' ? h.pullHint.slice(0, 1000) : '',
  }
}

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
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        try {
          if (!guard(req, res, pathname)) return
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

  return disposers
}
