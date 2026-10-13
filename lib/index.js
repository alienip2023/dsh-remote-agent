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

export function resolveRole(config) {
  const raw = config && typeof config === 'object' ? config.role : undefined
  if (raw === ROLE.WORKER || raw === ROLE.BOTH) return raw
  return ROLE.HUB
}

/**
 * 在服务就绪后执行一段注册逻辑。
 *
 * 有 ctx.inject 就用作用域注入（服务缺失时不激活，服务出现时自动补挂）；
 * 没有注入能力的宿主（例如自检 stub）就直接执行，让缺失的服务在调用点暴露。
 */
function withServices(ctx, deps, run) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(deps, (scoped) => {
      run(scoped ?? ctx)
    })
    return
  }
  run(ctx)
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
  const role = resolveRole(config)
  const log = loggerOf(ctx)
  const handles = { role, hub: undefined, worker: undefined }

  if (role === ROLE.HUB || role === ROLE.BOTH) {
    withServices(ctx, HUB_SERVICES, (scoped) => {
      handles.hub = applyHub(scoped, config)
    })
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

export { applyHub, newNodeToken, normalizeConfig, NODE_UPGRADE_PATH, HEALTH_PATH }
export default apply
