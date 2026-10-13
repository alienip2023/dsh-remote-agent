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
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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

/**
 * 解析 `@deepseek-ai/schemastery`（dsh 运行时提供，不在本包依赖里）。
 *
 * 为什么不是一句 `createRequire(import.meta.url)`：**Node 会解析 junction/软链**，
 * 所以从 profile 的 `node_modules/dsh-remote-agent`（junction）进入时，
 * `import.meta.url` 是**工作区真实路径** `...\dsh-remote-agent\lib\index.js` ——
 * 那里没有 node_modules，解析必然失败（实测 MODULE_NOT_FOUND）。
 * 但插件在宿主里运行时，真正的依赖在 **profile 的 node_modules** 下。
 *
 * 所以按「离得最近 → 离运行环境最近」的顺序多路径尝试：
 *   1. 模块自身位置（普通安装：包就在 profile 的 node_modules 里，这一步就中）
 *   2. 进程 cwd（宿主通常从 profile 目录启动）
 *   3. $DSH_HOME/profiles/$DSH_PROFILE（显式环境变量，最可靠）
 *
 * 全部失败则返回 undefined —— Config 是可选增强，拿不到只是不渲染配置表单，
 * 用户仍可手写 YAML，插件其余功能不受影响。**绝不因此让插件起不来。**
 */
function loadSchema() {
  const bases = []
  try {
    bases.push(import.meta.url)
  } catch {
    /* 极端环境下 import.meta.url 不可用 */
  }
  try {
    bases.push(pathToFileURL(path.join(process.cwd(), 'index.js')).href)
  } catch {
    /* cwd 不可用 */
  }
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (home && profile) {
    try {
      bases.push(pathToFileURL(path.join(home, 'profiles', profile, 'index.js')).href)
    } catch {
      /* 环境变量形状异常 */
    }
  }

  for (const base of bases) {
    try {
      const req = createRequire(base)
      const mod = req('@deepseek-ai/schemastery')
      // require 的返回值本身就是函数（无 default 包装），但 ESM 互操作下也可能是 { default }
      const schema = mod?.default ?? mod
      if (schema && typeof schema.object === 'function') return schema
    } catch {
      // 这个 base 解析不到，试下一个
    }
  }
  return undefined
}

const Schema = loadSchema()

export const Config = Schema
  ? Schema.object({
    role: Schema
      .union([Schema.const('hub'), Schema.const('worker'), Schema.const('both')])
      .default('hub')
      .description('本机角色：hub=主机（派活方）；worker=副机（干活方）；both=同一台机器自测。'),

    // ── 副机（worker）专用 ────────────────────────────────────────
    nodeId: Schema.string()
      .default('')
      .description('副机唯一标识（留空则取主机名）。只能含字母数字 . _ -，以字母或数字开头。'),
    transportMode: Schema
      .union([Schema.const('direct'), Schema.const('relay')])
      .default('relay')
      .description('direct=副机主动连主机（主机地址需可达）；relay=经中继 VPS 会合（双方都在 NAT 后时用）。'),
    hubUrl: Schema.string()
      .default('')
      .description('direct 模式：主机地址，形如 ws://主机IP:19387/api/remote-agent/node。'),
    relayUrl: Schema.string()
      .default('')
      .description('relay 模式：中继地址，形如 ws://中继IP:8890/relay。'),
    roots: Schema.array(Schema.string())
      .default([])
      .description('副机允许任务操作的工作区根目录（绝对路径，必须真实存在）。留空退回保守默认。'),
    stateDir: Schema.string()
      .default('')
      .description('副机任务状态落盘目录（留空用 ~/.dsh-remote-agent）。任务状态真身在这里。'),

    // ── 主机（hub）专用 ──────────────────────────────────────────
    relay: Schema.object({
      url: Schema.string().default('').description('中继地址，留空表示不用中继。'),
      token: Schema.string().default('').description('中继的 hub token（rt_ 开头那一半）。'),
    })
      .default({ url: '', token: '' })
      .description('主机经中继接入时的地址与凭证。'),
    nodeToken: Schema.string()
      .default('')
      .description('direct 模式下校验副机的共享口令。留空=不校验（仅限可信内网；公网暴露时必须填）。'),
    uiPullRoot: Schema.string()
      .default('')
      .description('Web 面板拉取产物时唯一允许落地的目录（绝对路径）。留空则面板拉取按钮禁用。'),
    uiEnabled: Schema.boolean()
      .default(true)
      .description('是否注册 Web 面板的控制路由。'),
  })
  : undefined

export { applyHub, newNodeToken, normalizeConfig, NODE_UPGRADE_PATH, HEALTH_PATH }
export default apply
