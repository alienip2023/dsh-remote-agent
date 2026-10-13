/**
 * 主机侧 hub 插件入口（零外部依赖）。
 *
 * 这一层只做三件事：
 *   1. **接线** —— 把 webServer 的 upgrade 路由、七个 remote_* 工具、
 *      一个 systemPrompt section、一个 subagent provider 挂上去；
 *   2. **路由上行帧** —— 直连 socket 与中继链路都汇到同一个 NodeRegistry；
 *   3. **生命周期** —— 每一处注册都包在 ctx.effect 里，disposer 真的释放资源
 *      （关连接、清定时器、删临时文件、reject 在途 pull）。
 *
 * 刻意的边界：hub 不持有任务状态的真身。断连只把节点置为 offline，任务投影留在
 * 内存里等副机重连后 task/sync 重建 —— 任务在副机本地持久运行，断连不终止。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ERROR_CODE, PROTOCOL_VERSION } from '../protocol.js'
import { acceptUpgrade } from '../ws.js'
import { NodeRegistry, RelayLink, createPluginLogger } from './node-registry.js'
import { PullManager } from './pull-manager.js'
import { registerRemoteTools } from './tools.js'
import { registerUiRoutes } from './ui-routes.js'
import { createRemoteAgentProvider } from './subagent-provider.js'

/** 默认 upgrade 路径：与 node/transport.js 的 direct 分支一致，改动会同时打穿两边。 */
export const NODE_UPGRADE_PATH = '/api/remote-agent/node'
/** 只读健康检查：给部署脚本与验证用，不暴露任何凭证。 */
export const HEALTH_PATH = '/api/remote-agent/healthz'
/** systemPrompt section 的 order：紧接 dsh-anywhere 的 fleet（151）之后。 */
export const PROMPT_ORDER = 152

export function normalizeConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {}
  const limits = c.limits && typeof c.limits === 'object' ? c.limits : {}
  const defaults = c.defaults && typeof c.defaults === 'object' ? c.defaults : {}
  const relay = c.relay && typeof c.relay === 'object' ? c.relay : null
  return {
    nodePath: typeof c.nodePath === 'string' && c.nodePath !== '' ? c.nodePath : NODE_UPGRADE_PATH,
    healthPath: typeof c.healthPath === 'string' && c.healthPath !== '' ? c.healthPath : HEALTH_PATH,
    nodeToken: typeof c.nodeToken === 'string' ? c.nodeToken : '',
    systemPrompt: c.systemPrompt !== false,
    // F1-1：healthz 是否暴露计数。默认 true（便于运维自检）；
    // 设为 false 时该路由只回 { ok, plugin, role, protocol }，不暴露任何计数。
    healthDetail: c.healthDetail !== false,
    // Web 面板（client 半）用。uiEnabled 默认 true（面板路由随 hub 一起注册）；
    // uiPullRoot 是**唯一**允许面板拉取产物落地的目录，未配置则面板的 pull 动作禁用 ——
    // 不让 Web 界面变成任意路径写入的入口。
    uiEnabled: c.uiEnabled !== false,
    uiPullRoot: typeof c.uiPullRoot === 'string' && c.uiPullRoot !== '' ? c.uiPullRoot : '',
    relay:
      relay && typeof relay.url === 'string' && relay.url !== ''
        ? { url: relay.url, token: typeof relay.token === 'string' ? relay.token : '' }
        : null,
    limits: {
      heartbeatMs: numOr(limits.heartbeatMs, 15_000),
      ackTimeoutMs: numOr(limits.ackTimeoutMs, 60_000),
      pullTimeoutMs: numOr(limits.pullTimeoutMs, 30 * 60 * 1000),
      maxPullBytes: numOr(limits.maxPullBytes, 512 * 1024 * 1024),
      maxTasksPerNode: numOr(limits.maxTasksPerNode, 64),
      helloTimeoutMs: numOr(limits.helloTimeoutMs, 10_000),
    },
    defaults: {
      timeoutMs: numOr(defaults.timeoutMs, 60 * 60 * 1000),
    },
  }
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 恒定时间比较，避免 token 逐字节泄露。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}

function remoteAddress(req) {
  return String(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? '')
}

/**
 * 把一个 disposer 包成**幂等**的。
 *
 * 为什么需要：同一个注册可能有两个 owner（插件自己的 effect + 服务侧的
 * 作用域），HMR 与卸载竞态都会让它被释放两次。注册类 disposer 的语义是
 * "移除我注册的那个东西"，第二次调用必须是安全的 no-op，而不是抛错把
 * 一次正常的卸载变成失败。
 */
function once(fn) {
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      fn?.()
    } catch {
      /* 注册可能已被服务侧先行移除 */
    }
  }
}

/** 中继 URL 去掉 userinfo 后用于日志。 */
function redactUrl(raw) {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '(invalid-relay-url)'
  }
}

/** systemPrompt 文案：让主 agent 知道什么时候该用远程同事，以及正确的调用顺序。 */
export const SYSTEM_PROMPT_TEXT = `## 远程同事（dsh-remote-agent）

你可以把任务派给其他电脑上的 DSH 节点执行。这些节点在自己的机器上**本地持久运行**
任务（独立 agent 循环、独立模型上下文），断连不会终止任务；主电脑只消费交接卡，
不消费副机的原始日志。

调用顺序：

1. \`remote_nodes\` —— 看有哪些节点在线、各自允许的工作区根（roots）与能力（caps）。
2. \`remote_task\` —— 派单。给出 \`node\`、\`goal\`；需要指定目录时给 \`workspace\`（必须在 roots 内）；
   简单的命令式活可用 \`mode:"exec"\`，需要判断与多步操作的活用默认的 \`mode:"agent"\`。
   本工具只等到副机"接受任务"就返回，不等结果。
3. \`remote_status\` —— 跟进进度（进度尾巴 + 日志尾巴）。任务状态的真身在副机，
   节点短暂离线不代表任务停了。
4. \`remote_handoff\` —— 任务结束后取交接卡：状态、退出码、摘要、工作区变更、
   产物清单、拉取提示。**决策所需的一切都在这一张卡里。**
5. \`remote_manifest\` + \`remote_pull\` —— 清单先于字节。只有清单里 \`role:final\`
   的成品可以拉；\`intermediate\`（日志、缓存、中间构建文件）只在副机留存，
   仅上报元数据，不要去拉它。
6. \`remote_cancel\` —— 需要打断时用。

注意：产物回流是**按需**的，不会自动同步。想看成品就用 \`remote_pull\` 显式拉取。
作为委派目标使用时，用 subagent 的 provider \`remote-agent\`（label 里写节点名可指定机器）。`

/**
 * 挂载 hub 角色。
 * @param {object} ctx DSH 插件上下文（已声明 webServer / tools / systemPrompt）
 * @param {object} [config] profiles/hub.cordis.yml 里的 config
 */
export function applyHub(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const log = createPluginLogger(ctx, 'remote-agent')

  const registry = new NodeRegistry({ log, limits: cfg.limits })
  const pulls = new PullManager({ registry, log, limits: cfg.limits })
  registry.bindPulls(pulls)

  // 先建运行时 effect：Cordis 逆序释放，所以它的 disposer 最后跑，
  // 保证路由/工具/provider 先摘干净，再拆运行时资源。
  ctx.effect(() => {
    log('info', 'hub runtime started', { protocol: PROTOCOL_VERSION })
    // 启动心跳巡检。此前 startHeartbeat() 实现完整却从未被调用（只有副机侧调过同名方法），
    // 导致 tick() 永不执行、this.timer 恒 undefined —— 半开连接（拔网线 / NAT 静默超时 /
    // 主机休眠）会**永久显示 online**，任务继续派给收不到的节点。
    registry.startHeartbeat()
    return () => {
      try {
        pulls.dispose()
      } catch {
        /* 已经清空 */
      }
      try {
        registry.dispose()
      } catch {
        /* 已经清空 */
      }
      log('info', 'hub runtime stopped')
    }
  }, 'remote-agent: runtime')

  // ── 中继链路（可选） ────────────────────────────────────────────
  if (cfg.relay) {
    ctx.effect(() => {
      const link = new RelayLink({
        url: cfg.relay.url,
        token: cfg.relay.token,
        log,
        onFrame: (frame) => registry.handleRelayFrame(frame),
        onBinary: (header, payload) => registry.handleRelayBinary(header, payload),
      })
      registry.attachRelay(link)
      link.start()
      return () => {
        try {
          link.stop()
        } catch {
          /* 已停 */
        }
      }
    }, 'remote-agent: relay-link')
  }

  // ── 直连 upgrade 路由 ─────────────────────────────────────────
  ctx.effect(() => {
    const dispose = ctx.webServer.registerUpgrade({
      path: cfg.nodePath,
      handler: (req, socket, head) => {
        try {
          // direct 模式下可选校验 x-dsh-token；配置为空则不校验（用户自选的裸奔模式）
          if (cfg.nodeToken !== '') {
            const token = req.headers['x-dsh-token']
            if (!safeEqual(token, cfg.nodeToken)) {
              log('warn', 'node upgrade rejected: bad token', { remote: remoteAddress(req) })
              socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
              socket.destroy()
              return
            }
          }
          const conn = acceptUpgrade(req, socket, head, { name: 'remote-agent-node' })
          if (!conn) return
          registry.attachDirect(conn, { remote: remoteAddress(req) })
        } catch (err) {
          log('error', 'node upgrade handler failed', { error: String(err?.message ?? err) })
          try {
            socket.destroy()
          } catch {
            /* 已销毁 */
          }
        }
      },
    })
    return once(dispose)
  }, 'remote-agent: node-upgrade')

  // ── 健康检查（只读，不含凭证） ─────────────────────────────────
  //
  // F1-1：该路由无鉴权，暴露的计数可被用来探测"本机在跑多少远程任务"。
  // 凭证扫描已确认 14 项全 false（无 token/apiKey/绝对路径/hostname/nodeId），
  // 所以这不是泄漏，只是可被动的存在性探测。
  // 处置：加 `healthDetail` 配置（默认 true，便于运维自检）；设为 false 时
  // 只返回 { ok, plugin, role, protocol }，不暴露任何计数。
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: cfg.healthPath,
      handler: (req, res) => {
        try {
          const base = {
            ok: true,
            plugin: 'dsh-remote-agent',
            role: 'hub',
            protocol: PROTOCOL_VERSION,
          }
          let body = base
          if (cfg.healthDetail) {
            const nodes = registry.list()
            body = {
              ...base,
              nodes: nodes.length,
              online: nodes.filter((n) => n.online).length,
              tasks: registry.listTasks().length,
              activePulls: pulls.activeCount,
            }
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        } catch (err) {
          log('warn', 'healthz failed', { error: String(err?.message ?? err) })
          try {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false }))
          } catch {
            /* 响应可能已结束 */
          }
        }
      },
    })
    return once(dispose)
  }, 'remote-agent: healthz')

  // ── Web 面板控制路由（client 半的数据源）──────────────────────
  //
  // 静态 bundle 的浏览器半边拿不到任何"远程节点/任务"的 Client 服务，
  // 所以面板通过 fetch 本组路由取数据（同 profile 的 dsh-context 也用这个模式）。
  if (cfg.uiEnabled) {
    ctx.effect(() => {
      const disposers = registerUiRoutes({
        ctx,
        registry,
        pulls,
        log,
        defaults: cfg.defaults,
        pullRoot: cfg.uiPullRoot,
      }).map(once)
      return () => {
        for (const d of disposers) d()
      }
    }, 'remote-agent: ui-routes')
  }

  // ── 七个 remote_* 工具 ────────────────────────────────────────
  ctx.effect(() => {
    const disposers = registerRemoteTools({ ctx, registry, pulls, log, defaults: cfg.defaults }).map(once)
    return () => {
      for (const d of disposers) {
        d()
      }
    }
  }, 'remote-agent: tools')

  // ── systemPrompt section ──────────────────────────────────────
  if (cfg.systemPrompt) {
    ctx.effect(() => {
      const dispose = ctx.systemPrompt.section({
        name: 'remote-agent',
        order: PROMPT_ORDER,
        text: SYSTEM_PROMPT_TEXT,
      })
      return once(dispose)
    }, 'remote-agent: system-prompt')
  }

  // ── subagent provider ────────────────────────────────────────
  // subagents 是可选服务：不能写进硬 inject（hub 也可能跑在没有 subagent 的组合里）。
  // 注册风格与上面五处保持一致：effect 回调里拿到 disposer，再用 once() 包成幂等。
  const registerProvider = (subagents) => {
    const provider = createRemoteAgentProvider({ registry, pulls, log, defaults: cfg.defaults })
    const dispose = subagents.registerProvider(provider)
    return once(dispose)
  }

  if (ctx.subagents) {
    ctx.effect(() => registerProvider(ctx.subagents), 'remote-agent: subagent-provider')
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['subagents'], (scoped) => {
      const target = scoped ?? ctx
      target.effect(() => registerProvider(target.subagents), 'remote-agent: subagent-provider')
    })
  }

  log('info', 'hub plugin applied', {
    path: cfg.nodePath,
    relay: cfg.relay ? redactUrl(cfg.relay.url) : 'direct',
    tokenCheck: cfg.nodeToken !== '',
  })

  return {
    registry,
    pulls,
  }
}

/** 生成一个节点 token（部署脚本用，避免手写弱口令）。 */
export function newNodeToken() {
  return `nt_${randomBytes(24).toString('base64url')}`
}

export { ERROR_CODE }
