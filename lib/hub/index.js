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
import os from 'node:os'
import path from 'node:path'
import { ERROR_CODE, PROTOCOL_VERSION } from '../protocol.js'
import { acceptUpgrade } from '../ws.js'
import { NodeRegistry } from './node-registry.js'
import { RelayLink } from './relay-link.js'
import { createPluginLogger } from './hub-util.js'
import { PullManager } from './pull-manager.js'
import { createAuditLog } from './audit-log.js'
import { registerRemoteTools } from './tools.js'
import { registerUiRoutes } from './ui-routes.js'
import { createRemoteAgentProvider } from './subagent-provider.js'
// P2-11：hub 持久身份（ed25519）。指纹进 welcome / hub-identity 帧，副机钉住防假 hub。
import { IDENTITY_FILE_NAME, loadOrCreateHubIdentity } from '../identity.js'

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
    // P2-11：hub 身份落盘目录（<stateDir>/hub-identity.json，0600）。与副机默认
    // 同目录无冲突 —— hub 只写 hub-identity.json，副机写 token/ 与 tasks/。
    stateDir: typeof c.stateDir === 'string' && c.stateDir.trim() !== '' ? path.resolve(c.stateDir.trim()) : defaultHubStateDir(),
    // 提案 #19：审计日志。默认开启（本地 JSONL、无凭证、有轮转）；audit:false
    // 或 audit.enabled:false 显式关闭。maxBytes/maxFiles 控制轮转体积。
    audit: normalizeAudit(c.audit),
    relay:
      relay && typeof relay.url === 'string' && relay.url !== ''
        ? { url: relay.url, token: typeof relay.token === 'string' ? relay.token : '' }
        : null,
    limits: {
      heartbeatMs: numOr(limits.heartbeatMs, 15_000),
      ackTimeoutMs: numOr(limits.ackTimeoutMs, 60_000),
      pullTimeoutMs: numOr(limits.pullTimeoutMs, 30 * 60 * 1000),
      maxPullBytes: numOr(limits.maxPullBytes, 512 * 1024 * 1024),
      // ⚠ 这个上限按**在跑的任务**算，不按历史累计（见 createTask 的说明）。
      // 曾经按 `rec.tasks.size`（含终态）算，导致派几十条任务后节点永久不可用。
      maxTasksPerNode: numOr(limits.maxTasksPerNode, 64),
      // hub 侧任务视图的保留期：终态任务超过它就自动清掉，防视图无限累积。
      // 默认 1 小时 —— 比"回看刚才那条任务的结果"需求长，又远短于副机的
      // TaskStore 保留期（7 天）。设 0 关闭自动清理（只留 remote_purge 手动清）。
      taskViewRetainMs: numOr(limits.taskViewRetainMs, 60 * 60 * 1000),
      // 两阶段审批（提案 #2）：manual 任务挂起超过此时长自动拒绝（fail-closed）。
      // 默认 30 分钟；设 0 = 不设超时（任务一直挂着等人，仍不会自动批准）。
      approvalTimeoutMs: numOr(limits.approvalTimeoutMs, 30 * 60 * 1000),
      helloTimeoutMs: numOr(limits.helloTimeoutMs, 10_000),
    },
    defaults: {
      // ⚠ **不要在这里兜底 1h**（2026-10-17 修，行为变更）。
      //
      // 原实现 `numOr(defaults.timeoutMs, 60 * 60 * 1000)` 让 explicitTimeoutMs
      // 恒为 3600000，于是 tools.js 里 #26-1 的优先级
      //
      //     args > 显式配置 > 分模式默认（exec 10min / agent 1h）
      //
      // 被压扁成「恒 1h」——**exec 的 10 分钟默认成了死代码**，一条失控命令
      // 比文档承诺的多跑 50 分钟才被杀。而且那个兜底还掩盖了 tools.js 里的
      // 一个 TDZ 引用 bug（`v.spec.mode` 自引用），让它在生产环境永不触发。
      //
      // 现在保持 undefined：不配置就是"没有显式指定"，让 tools.js 按 mode
      // 分模式取默认值。用户显式配 `defaults.timeoutMs` 时仍然优先。
      timeoutMs: typeof defaults.timeoutMs === 'number' && Number.isFinite(defaults.timeoutMs)
        ? defaults.timeoutMs
        : undefined,
    },
  }
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 审计配置归一（提案 #19）：false/缺省对象两种写法都接受，坏值回落默认。 */
function normalizeAudit(a) {
  const d = { enabled: true, maxBytes: 8 * 1024 * 1024, maxFiles: 3 }
  if (a === false) return { ...d, enabled: false }
  if (!a || typeof a !== 'object') return d
  return {
    enabled: a.enabled !== false,
    maxBytes: numOr(a.maxBytes, d.maxBytes),
    maxFiles: numOr(a.maxFiles, d.maxFiles),
  }
}

/** hub stateDir 默认值：与副机 resolveStateDir 同口径（homedir 不可写退 tmp）。 */
function defaultHubStateDir() {
  try {
    return path.join(os.homedir(), '.dsh-remote-agent')
  } catch {
    return path.join(os.tmpdir(), '.dsh-remote-agent')
  }
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
   需要副机用特定模型时传 \`model\`（如 \`{model:"deepseek-chat"}\` 或
   \`{provider:"openai",model:"gpt-4o"}\`；只传**选择**，副机用自己的凭证跑，
   指定的模型在副机不存在时任务会明确失败。headless 后端不支持 model）。
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
  /**
   * 注册收集器。
   *
   * ⚠ 为什么不用 `ctx.effect(...)`（2026-10-14 实测）：
   * `applyHub` 收到的 `ctx` 是 `ctx.plugin(hubPlugin)` 创建的**子 fiber** 的上下文。
   * 该 fiber 在 `apply` 同步返回后被框架清理 —— 诊断日志显示注册后 **3–13ms**
   * 出现 `DISPOSED (fiber unloaded)`，所有 `ctx.effect` 的 disposer 被执行，
   * 刚注册的 9 条路由 + healthz 全部被删，且**不再重新注册**（框架不会重新 load
   * 一个已"完成"的父 fiber 下的子 fiber）。表现：面板 404/401，启动日志无异常。
   *
   * 改成「立即执行 + 收集 disposer」后完全不依赖 fiber 生命周期。
   * 代价：热重载时不会自动摘路由 —— 可接受，因为 DSH 重启会清掉一切，
   * 而 disposer 仍由 applyHub 的返回值交给调用方保管。
   */
  const __disposers = []
  const __reg = (fn, label) => {
    try {
      const d = fn()
      if (typeof d === 'function') __disposers.push(d)
      // 每条注册都留痕。为什么：注册抛错是**静默致命**的 —— 路由不存在、
      // 工具缺失、面板 404，而宿主启动日志里什么都没有（实测踩过多次）。
      // 有这一行，"哪一条没跑"就一目了然。
      log('info', 'hub registration ok', { label })
    } catch (err) {
      log('error', 'hub registration FAILED', { label, error: String(err?.message ?? err) })
      throw err
    }
  }

  // ── hub 身份（P2-11）：首次启动生成持久 ed25519 密钥对，之后一直复用 ──
  // 加载失败不致命：welcome 不带 identity、relay 不追发，副机按旧协议处理。
  // 身份文件损坏时 loadOrCreateHubIdentity 就地重建 —— 已钉住旧指纹的副机会
  // 在下一次握手大声失败，这正是想要的方向（fail-closed，绝不静默接受新身份）。
  let hubIdentity = null
  try {
    hubIdentity = loadOrCreateHubIdentity(path.join(cfg.stateDir, IDENTITY_FILE_NAME))
    log('info', 'hub identity ready', { fingerprint: hubIdentity.fingerprint, created: hubIdentity.created, file: hubIdentity.file })
  } catch (err) {
    log('warn', 'hub identity unavailable; hub authentication disabled', { error: String(err?.message ?? err) })
  }
  // ── 审计（提案 #19）：派发/取消/拉取证据链，<stateDir>/audit.jsonl ──
  // 必须在 registry/pulls 之前建好（两者构造时就要拿到写入器）。
  // createAuditLog 自身不抛（目录建不了时返回 no-op 形态），这里的 try 只是纵深防御。
  let audit = null
  try {
    audit = createAuditLog({ dir: cfg.stateDir, enabled: cfg.audit.enabled, maxBytes: cfg.audit.maxBytes, maxFiles: cfg.audit.maxFiles, log })
    if (audit) log('info', 'audit log ready', { file: audit.path, enabled: cfg.audit.enabled })
  } catch (err) {
    log('warn', 'audit log unavailable; running without audit', { error: String(err?.message ?? err) })
    audit = null
  }

  // ── 可达性自检：webServer 绑在 loopback 时副机永远连不上 ────────────────
  //
  // ═══════════════════════════════════════════════════════════════════════════
  // 这是一个**静默失败**，2026-10-17 实测踩到
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // DSH 的 `@deepseek-ai/dsh-host-webserver` 的 `host` 是**必填项、无默认值**，
  // 而它面向的默认场景是"本机浏览器访问自己"，所以多数 profile 里绑的是
  // `127.0.0.1`。`webServer.getOrigin()` 的文档也明说它返回的是
  // "the root URL **local clients** use to reach the bound listener"。
  //
  // 但本插件的整个用法是**跨机**：副机拿 `ws://<主机IP>:19387/...` 拨入。
  // 绑 loopback 时：
  //   · hub 自己一切正常（healthz 200、面板能开、工具都在）
  //   · 副机**永远连不上**，报 `ECONNREFUSED` / `connect timeout`
  //   · 主机侧**没有任何异常**，用户只能去猜"地址填错了？token 错了？防火墙？"
  //
  // 三种用户会踩：
  //   A. 全新安装，没动过 webserver 配置（**绝大多数**）
  //   B. 装过某个改 lanBind 的插件又卸载，托管块残留但插件没了
  //   C. 自己改过 webserver，绑错了
  //
  // 所以这里做两件事：
  //   1. **启动时 log 一条明确的 warn**（带修法，不是只说"不可达"）
  //   2. 把结论存进 `reachability`，由面板渲染成**红色横幅** ——
  //      日志用户不会看，面板会看
  //
  // ⚠ 自检本身**绝不能**让 hub 起不来：`getOrigin()` 在 listen 之前会抛，
  // 服务缺失时也不存在。整段包 try/catch，拿不到就记 `unknown`。
  let reachability = { bound: null, origin: null, loopback: null, hint: '' }
  try {
    const ws = ctx.webServer
    const origin = typeof ws?.getOrigin === 'function' ? ws.getOrigin() : null
    if (typeof origin === 'string' && origin !== '') {
      let hostname = null
      try {
        hostname = new URL(origin).hostname
      } catch {
        /* 非 URL 形态：保持 null */
      }
      const h = typeof hostname === 'string' ? hostname.toLowerCase() : ''
      // IPv6 在 URL.hostname 里带方括号
      const loopback = h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
      reachability = {
        bound: hostname,
        origin,
        loopback,
        hint: loopback
          ? "webServer 绑在 loopback，副机无法接入。在 profile 的 cordis.patch.yml 里给 webserver 行加 host: '0.0.0.0'（保留 port），然后重启 DSH。"
          : '',
      }
      if (loopback) {
        log('warn', 'hub 绑在 loopback：副机将无法接入', {
          origin,
          bound: hostname,
          fix: "给 webserver 加 host: '0.0.0.0'",
        })
      } else {
        log('info', 'hub reachable from other hosts', { origin, bound: hostname })
      }
    } else {
      reachability = { bound: null, origin: null, loopback: null, hint: 'webServer.getOrigin() 不可用，无法判断可达性' }
    }
  } catch (err) {
    // getOrigin() 在 listen 完成前会抛（文档明说）；服务缺失也会抛。
    reachability = { bound: null, origin: null, loopback: null, hint: `可达性自检失败：${String(err?.message ?? err)}` }
    log('info', 'reachability self-check unavailable', { error: String(err?.message ?? err) })
  }

  const registry = new NodeRegistry({ log, limits: cfg.limits, identity: hubIdentity, audit })
  const pulls = new PullManager({ registry, log, limits: cfg.limits, audit })
  registry.bindPulls(pulls)
  // 先建运行时 effect：Cordis 逆序释放，所以它的 disposer 最后跑，
  // 保证路由/工具/provider 先摘干净，再拆运行时资源。
  __reg(() => {
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
      // 审计在途写入 flush（fire-and-forget：dispose 返回 promise，失败已在其内部吞掉）
      try {
        void audit?.dispose?.()
      } catch {
        /* 已清空 */
      }
      log('info', 'hub runtime stopped')
    }
  }, 'remote-agent: runtime')

  // ── 中继链路（可选） ────────────────────────────────────────────
  if (cfg.relay) {
    __reg(() => {
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
  __reg(() => {
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
  __reg(() => {
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
    __reg(() => {
      let disposers = []
      try {
        disposers = registerUiRoutes({
          ctx,
          registry,
          pulls,
          log,
          defaults: cfg.defaults,
          pullRoot: cfg.uiPullRoot,
          // 本行生效配置的只读快照，供面板「主机设置」区展示。
          // 传**原始** config（而非归一化后的 cfg），因为面板要如实反映用户写了什么。
          config,
          // 可达性自检结论（2026-10-17）：绑 loopback 时副机永远连不上，
          // 面板要渲染成红色横幅 —— 这个失败在主机侧是完全静默的。
          reachability,
        }).map(once)
      } catch (err) {
        log('error', 'ui route registration threw', { error: String(err?.message ?? err) })
        return () => {}
      }
      return () => {
        for (const d of disposers) d()
      }
    }, 'remote-agent: ui-routes')
  }

  // ── 八个 remote_* 工具 ────────────────────────────────────────
  //
  // ⚠ 这里**必须容错**：`ctx.tools` 是 loader 行 inject 声明的服务，若某个
  // 部署（旧 profile / 手写配置）没声明它，访问会抛
  //
  //     cannot get property "tools" without inject
  //
  // 而本函数的位置在路由注册**之后** —— 不兜住的话，整个 `applyHub` 抛错、
  // fiber 标记 failed，现象是**路由活着但工具全没了 + 插件页显示"异常"**
  // （实测踩过：包内 inject 被收窄成 ['webServer'] 就复现了）。
  //
  // 工具是**可选能力**：拿不到 tools 服务只该让工具消失，不该让整个 hub 挂掉。
  // 所以单独 try/catch，并把原因写进日志（否则又是"静默半死"）。
  __reg(() => {
    let toolsSvc
    try {
      toolsSvc = ctx.tools
    } catch (err) {
      log('error', 'tools service unavailable: remote_* tools NOT registered (check inject on the loader row)', {
        error: String(err?.message ?? err),
        hint: "loader 行的 inject 需要包含 'tools'",
      })
      return () => {}
    }
    if (!toolsSvc || typeof toolsSvc.register !== 'function') {
      log('warn', 'tools service missing register(): remote_* tools NOT registered')
      return () => {}
    }
    const disposers = registerRemoteTools({ ctx, registry, pulls, log, defaults: cfg.defaults }).map(once)
    return () => {
      for (const d of disposers) {
        d()
      }
    }
  }, 'remote-agent: tools')

  // ── systemPrompt section ──────────────────────────────────────
  if (cfg.systemPrompt) {
    __reg(() => {
      let systemPromptSvc
      try {
        systemPromptSvc = ctx.systemPrompt
      } catch (err) {
        // 同上的理由：缺这个服务只该少一段提示词，不该让 hub 挂掉。
        log('warn', 'systemPrompt service unavailable: prompt section NOT registered', {
          error: String(err?.message ?? err),
        })
        return () => {}
      }
      const dispose = systemPromptSvc.section({
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

  // subagents 是**可选**服务：不能写进 loader 行的硬 inject（hub 也可能跑在
  // 没有 subagent 的组合里）。所以用 `ctx.get('subagents')` 安全探测 ——
  // ⚠ 不能写 `ctx.subagents`：cordis 对未声明 inject 的服务访问会抛
  // `cannot get property "subagents" without inject`（实测）。
  const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
  if (subagents) {
    __reg(() => registerProvider(subagents), 'remote-agent: subagent-provider')
  }

  log('info', 'hub plugin applied', {
    path: cfg.nodePath,
    relay: cfg.relay ? redactUrl(cfg.relay.url) : 'direct',
    tokenCheck: cfg.nodeToken !== '',
  })

  return {
    registry,
    pulls,
    // 由调用方保管；DSH 卸载插件时可用它们清理。
    disposeAll: () => { for (const d of __disposers) { try { d() } catch { /* 已清 */ } } },
  }
}

/** 生成一个节点 token（部署脚本用，避免手写弱口令）。 */
export function newNodeToken() {
  return `nt_${randomBytes(24).toString('base64url')}`
}

export { ERROR_CODE }
