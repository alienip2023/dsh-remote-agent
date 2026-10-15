/**
 * dsh-remote-agent 插件入口：角色分发器。
 *
 * 一个包，两种角色，因为协议层、glob、产物判定这些地基是共用的：
 *
 *   role: 'hub'    主电脑 —— 节点注册表 + remote_* 工具 + subagent provider
 *   role: 'worker' 副机   —— 拨入 hub、本地跑任务、按需外发产物
 *   role: 'both'   同机自测（一台机器同时当 hub 与 worker）
 *
 * **为什么这里刻意不写 `export const inject`**：
 * 声明式 inject 是模块级的，一旦声明了 `['webServer','tools','systemPrompt']`，
 * 那么在没有 webServer 的副机 profile 里整个插件都不会激活 —— worker 分支会被
 * hub 的依赖一起拖死。所以 hub 侧改用作用域注入 `ctx.inject([...], cb)`：
 * 缺服务时 hub 分支自然不激活，worker 分支照常跑。这也是 E3 契约要求的形态。
 *
 * worker 分支走动态 import：hub 进程不需要加载副机的任务引擎、进程管理、
 * 文件遍历那一整套代码；副机进程也不需要在内存里挂着 hub 的注册表。
 */
// schemastery 由 dsh 运行时提供。**必须顶层 import**，且必须在 package.json 里
// 声明为 peerDependency，否则 loader 判定该行没有 Config（实测报 `status: absent`）。
// 这与 dsh-better-sidebar 等已发布插件一致，是唯一被验证可用的形态。
import z from '@deepseek-ai/schemastery'
import { applyHub, newNodeToken, normalizeConfig, NODE_UPGRADE_PATH, HEALTH_PATH } from './hub/index.js'

/** 角色取值。 */
export const ROLE = Object.freeze({ HUB: 'hub', WORKER: 'worker', BOTH: 'both' })

/** hub 分支需要的服务：缺一个就不激活 hub，而不是抛错打挂 host。 */
const HUB_SERVICES = ['webServer', 'tools', 'systemPrompt']

/**
 * 解析本机角色。
 *
 * 为什么需要归一化 + 明确告警（t3 审计查出的真实风险）：
 * 原实现只做精确匹配，其余一律 `return ROLE.HUB`。于是 `role: 'Worker'`（大小写）、
 * `'hub '`（尾空格）、`42`、`true` 全都**静默**变成 hub —— 而副机 profile 写错一个
 * 字母的后果很严重：那台机器会以 **hub 身份**启动，注册 `/api/remote-agent/node`
 * 直连端点与 healthz，而 hub 的 `nodeToken` 默认为空串 → **该端点不校验任何凭证**。
 * 用户以为自己配的是"副机"，实际开了个无鉴权的直连入口。
 *
 * 修法：先归一化（trim + 小写）以容忍常见笔误，再对**无法识别**的值返回 hub 但
 * 附带 `invalid` 标记，由 apply() 记 warn —— 配置写错必须有反馈，不能静默。
 *
 * @returns {{role:string, invalid?:string}} role 为 hub/worker/both；invalid 为原始非法值
 */
export function resolveRoleDetail(config) {
  const raw = config && typeof config === 'object' ? config.role : undefined
  if (raw === undefined || raw === null || raw === '') return { role: ROLE.HUB }
  if (typeof raw === 'string') {
    const norm = raw.trim().toLowerCase()
    if (norm === ROLE.HUB || norm === ROLE.WORKER || norm === ROLE.BOTH) return { role: norm }
  }
  return { role: ROLE.HUB, invalid: raw }
}

/** 兼容旧签名：只返回角色字符串。 */
export function resolveRole(config) {
  return resolveRoleDetail(config).role
}

function loggerOf(ctx) {
  return (level, msg, extra) => {
    try {
      const l = ctx?.logger
      if (l && typeof l[level] === 'function') l[level](`[remote-agent] ${msg}`, extra)
      else if (l && typeof l.info === 'function') l.info(`[remote-agent] ${msg}`, extra)
      else if (level === 'warn' || level === 'error') console.warn(`[remote-agent] ${msg}`, extra ?? '')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
}

/** 动态加载副机实现并调用 applyWorker。 */
async function applyWorkerBranch(ctx, config, log) {
  let mod
  try {
    mod = await import('./node/index.js')
  } catch (err) {
    log('error', 'worker 分支加载失败：lib/node/index.js 不可用', {
      error: String(err?.message ?? err),
    })
    return undefined
  }
  const fn = typeof mod?.applyWorker === 'function' ? mod.applyWorker : typeof mod?.apply === 'function' ? mod.apply : undefined
  if (typeof fn !== 'function') {
    log('error', 'worker 分支加载失败：lib/node/index.js 未导出 applyWorker')
    return undefined
  }
  try {
    return fn(ctx, config)
  } catch (err) {
    log('error', 'worker 分支挂载失败', { error: String(err?.message ?? err) })
    return undefined
  }
}

/**
 * DSH 插件入口。
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] 行配置（profiles/*.cordis.yml 里的 config）
 */
export function apply(ctx, config = {}) {
  const { role, invalid } = resolveRoleDetail(config)
  const log = loggerOf(ctx)
  // 配置写错必须有反馈：`role` 无法识别时**回退到 hub 并明确告警**。
  // 静默回退的后果不是"功能不对"，而是安全面向的 —— 见 resolveRoleDetail 的说明。
  if (invalid !== undefined) {
    log(
      'warn',
      'unrecognized role, falling back to hub',
      { got: invalid, expected: [ROLE.HUB, ROLE.WORKER, ROLE.BOTH] },
    )
  }
  const handles = { role, hub: undefined, worker: undefined }

  if (role === ROLE.HUB || role === ROLE.BOTH) {
    // ═══════════════════════════════════════════════════════════════════════
    // 服务可见性：靠 loader 行上的**声明式 inject**（见 cordis.patch.yml）
    // ═══════════════════════════════════════════════════════════════════════
    //
    // cordis 的防护：没有声明 inject 就直接读 `ctx.webServer` 会抛
    // `cannot get property "webServer" without inject`（实测）。
    //
    // 而"运行时 ctx.inject(deps, cb)"这条路走不通（实测，2026-10-14）：
    //   - inject 返回 thenable fiber，要 await 才算"加载完成"
    //   - 插件的 apply 是同步的，父 fiber 同步返回后框架清理未 settle 的子 fiber
    //   - 诊断：注册成功 13ms 后 `DISPOSED (fiber unloaded)`，路由被删且不再回来
    //   - `ctx.plugin({inject, apply})` 更糟：子插件的 apply 根本没被调用
    //
    // 所以 inject 声明在**行上**（cordis.patch.yml 的 `inject: [...]`）：框架推迟
    // 本行激活直到服务就绪，只 apply 一次、无子 fiber 抖动。这是唯一可用的形态。
    //
    // 副机（worker）不需要这些服务，必须在自己的 profile 里覆盖 `inject: []`，
    // 否则该行永远 PENDING。见 profiles/worker.cordis.yml。
    handles.hub = applyHub(ctx, config)
  }

  if (role === ROLE.WORKER || role === ROLE.BOTH) {
    // 动态 import 是异步的；不 await —— apply 本身是同步契约。
    // 失败已在 applyWorkerBranch 内部记日志，不让 host 因副机缺件而起不来。
    void applyWorkerBranch(ctx, config, log).then((h) => {
      handles.worker = h
    })
  }

  return handles
}

export const Config = z.object({
  role: z
    .union([z.const('hub'), z.const('worker'), z.const('both')])
    .default('hub')
    .description('本机角色：hub=主机（派活方）；worker=副机（干活方）；both=同一台机器自测。'),

  // ── 副机（worker）专用 ────────────────────────────────────────
  nodeId: z
    .string()
    .default('')
    .description('副机唯一标识（留空则取主机名）。只能含字母数字 . _ -，以字母或数字开头。'),
  transportMode: z
    .union([z.const('direct'), z.const('relay')])
    .default('relay')
    .description('direct=副机主动连主机（主机地址需可达）；relay=经中继 VPS 会合（双方都在 NAT 后时用）。'),
  hubUrl: z
    .string()
    .default('')
    .description('direct 模式：主机地址，形如 ws://主机IP:19387/api/remote-agent/node。'),
  relayUrl: z
    .string()
      .default('')
      .description('relay 模式：中继地址，形如 ws://中继IP:8890/relay。'),
    roots: z.array(z.string())
      .default([])
      .description('副机允许任务操作的工作区根目录（绝对路径，必须真实存在）。留空退回保守默认。'),
    stateDir: z.string()
      .default('')
      .description('副机任务状态落盘目录（留空用 ~/.dsh-remote-agent）。任务状态真身在这里。'),

    // ── 主机（hub）专用 ──────────────────────────────────────────
    relay: z.object({
      url: z.string().default('').description('中继地址，留空表示不用中继。'),
      token: z.string().default('').description('中继的 hub token（rt_ 开头那一半）。'),
    })
      .default({ url: '', token: '' })
      .description('主机经中继接入时的地址与凭证。'),
    nodeToken: z.string()
      .default('')
      .description('direct 模式下校验副机的共享口令。留空=不校验（仅限可信内网；公网暴露时必须填）。'),
    uiPullRoot: z.string()
      .default('')
      .description('Web 面板拉取产物时唯一允许落地的目录（绝对路径）。留空则面板拉取按钮禁用。'),
    uiEnabled: z.boolean()
      .default(true)
      .description('是否注册 Web 面板的控制路由。'),
})

// ⚠ 这里刻意**不写** `export default apply`。
//
// cordis loader 用 `unwrapExports()` 解析模块：
//     exports = exports.default ?? exports
// 也就是说，只要模块有 default 导出，它就会**把整个命名空间替换成那个 default**。
// 我们的 default 是 `apply` 函数，于是 loader 拿到的是函数、而不是命名空间 ——
// 函数上没有 `Config`，判定链直接落到 `status: 'absent'`，插件页因此不出现配置表单。
// （对照：dsh-better-sidebar 等有 schema 的插件都没有 default 导出。）
//
// 保持只用具名导出（apply + Config + 若干常量），命名空间完整，Config 才能被读到。
// `apply` 已由上面的 `export function apply` 具名导出，这里不重复列出。
export { applyHub, newNodeToken, normalizeConfig, NODE_UPGRADE_PATH, HEALTH_PATH }
