/**
 * 环境体检（`env-check`）—— 命令行与 Web 面板共用的同一份检查逻辑。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-17 的真实教训）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户装好插件、配好配对码，副机**永远连不上**，而主机侧**没有任何异常**：
 * hub 自己 healthz 200、面板能开、工具都在，只有副机连不上。
 *
 * 根因是 DSH 的 `webserver` 默认绑 `127.0.0.1`（它面向"本机浏览器访问自己"），
 * 而本插件是跨机用法。这个失败**完全静默** —— 用户只能猜"地址错了？token 错了？
 * 防火墙？"
 *
 * 所以本模块把这些"静默失败的前置条件"逐条查出来，每条都给**人话原因**和
 * **具体修法**，能自动修的给 `autoFix` 标记。
 *
 * ── 三档处置（产品决策，2026-10-17 用户确认）────────────────────────────
 *
 *   A. **自动修**（只改我们自己的配置，不下载任何东西）
 *      webserver 绑 loopback、role/inject 缺失、roots 不存在
 *   B. **提示 + 复制命令**（需要用户装东西）
 *      Tailscale 未安装 —— 只给官方链接和命令，**不代下载**
 *   C. **只诊断**（需要人判断）
 *      端口被占、防火墙、模型凭证失效
 *
 * ── 为什么不代下载（重要）──────────────────────────────────────────────
 *
 * 本插件的核心卖点是**零 npm 依赖、零构建**（README 明确写着）。代用户下载
 * 第三方二进制会让它变成软件分发方：装哪个版本、从哪下、校验和怎么保证、
 * 装失败算谁的、供应链攻击面 —— 全都落在我们头上。所以档位 B 只给提示。
 *
 * ── 设计约束 ────────────────────────────────────────────────────────────
 *
 *   · **纯函数 + 注入探测**：本模块不自己 spawn 命令、不自己读 env，
 *     所有外部探测由调用方传入（便于单测、也便于命令行走真进程而面板走缓存）
 *   · **绝不抛**：任何一项探测失败都落成"该项 ok=false + 说明"，不影响其它项
 *   · **逐项独立**：一项失败不能让整份体检失败
 */

/**
 * 检查结果。
 *
 * `autoFix` 的语义（2026-10-17 修 v0.9.0 审查 L3）：
 *   原先是"我们能自动改配置修好它"，但**全仓库根本没有 fix 路由 / --fix 参数**
 *   （面板没有修复按钮、CLI 没有 --fix）—— 那是个虚假承诺。
 *
 *   现在改成"**该项的修法是一段可直接粘进配置的片段**"（`fix` 字段即以
 *   `yaml:` / `命令:` 开头可直接复制的形态），`autoFix` 只表示"修法机械、
 *   不需要判断"，用于 UI 分组，**不再暗示有一键修复**。
 */
function item(ok, id, label, { fix = '', detail = '', autoFix = false, severity = 'error' } = {}) {
  return { ok: Boolean(ok), id, label, fix: ok ? '' : fix, detail, autoFix: ok ? false : autoFix, severity }
}

// 角色解析**必须只有一份实现**：`role: auto` 是 v0.9.0 的默认值，
// 凡是判定"这台机器是 hub 还是 worker"的地方都得过这一层。
// （v0.9.0 审查 H1 的根因就是这里漏了 —— 直接拿原始 'auto' 跟 'hub' 比。）
import { resolveRole } from './index.js'
// 回环判据**必须只有一份实现**（2026-10-20 收口）：
// 独立监听、env-check、面板曾各写一份，C2 就是这类"两套判据"分叉的直接后果。
import { isLoopbackHost } from './listen-server.js'

/**
 * 独立监听这一项的体检（2026-10-20 新增，v0.9.3 审查 M4）。
 *
 * 三种状态要分开报，因为**修法完全不同**：
 *   · listening  → 看绑在哪（回环 = 副机连不上，多半是 nodeToken 为空）
 *   · disabled   → 用户显式关了（listenPort: 0），走老通道，不算错
 *   · failed     → 端口被占/地址不可用，改 listenPort 或 listenHost
 *   · 未就绪     → 刚启动，稍后刷新
 *
 * @param {object|null} listener { ok, disabled, host, port, source, error }
 * @param {object} cfg 归一化后的配置（用于给出可粘贴的修法片段）
 */
function listenerCheck(listener, cfg) {
  const L = listener && typeof listener === 'object' ? listener : null
  const host = L && typeof L.host === 'string' ? L.host : ''
  const port = L && Number.isFinite(L.port) ? L.port : null
  const source = L && typeof L.source === 'string' ? L.source : ''
  const err = L && typeof L.error === 'string' ? L.error : ''
  const disabled = L && typeof L.disabled === 'string' ? L.disabled : ''

  if (!L || L.ok === null || L.ok === undefined) {
    return item(true, 'listener', '独立监听（尚未就绪）', {
      detail: '插件刚启动？稍后刷新体检',
      severity: 'info',
    })
  }

  if (L.ok === true) {
    const loop = isLoopbackHost(host)
    return item(!loop, 'listener', loop
      ? '独立监听绑在回环（副机连不上）'
      : '独立监听已就绪（副机从这里拨入）', {
      detail: loop
        ? `${host}:${port ?? '?'} —— 安全策略：nodeToken 为空时不暴露到网络`
        : `${host}:${port ?? '?'}（来源 ${source || 'auto'}）`,
      fix: loop
        ? '到面板「副机接入」点「生成口令」（写入 nodeToken），重启 DSH 后会改绑可达地址。\n'
          + '  或显式指定：yaml:\n'
          + '  - id: remote-agent\n'
          + '    config:\n'
          + "      listenHost: '<本机具体 IP，如 tailscale ip -4 的结果>'"
        : '',
      autoFix: true,
    })
  }

  if (disabled !== '') {
    return item(true, 'listener', '独立监听已关闭（走 DSH 的 Web 服务通道）', {
      detail: `原因：${disabled}`,
      severity: 'info',
    })
  }

  return item(false, 'listener', '独立监听启动失败（副机拨不进来）', {
    detail: err !== '' ? err : '未知原因',
    fix: '端口多半被占用。换一个空闲端口后重启 DSH：\n'
      + '  yaml:\n'
      + '  - id: remote-agent\n'
      + '    config:\n'
      + `      listenPort: ${Number.isFinite(cfg?.listenPort) ? (cfg.listenPort + 1) : 19388}`,
    autoFix: true,
  })
}


/**
 * 判定一个 origin/URL 是否只对本机可见。
 * @param {string} origin 形如 `http://127.0.0.1:19387`
 * @returns {boolean|null} null = 无法判定
 */
export function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || origin.trim() === '') return null
  let host
  try {
    host = new URL(origin).hostname
  } catch {
    return null
  }
  const h = host.toLowerCase()
  // IPv6 在 URL.hostname 里带方括号
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/**
 * 环境体检。
 *
 * @param {object} o
 * @param {'hub'|'worker'} o.role
 * @param {object} [o.config] 本行生效配置（只读快照）
 * @param {object|null} [o.reachability] 可达性结论（独立监听优先；见 applyHub 的 currentReachability）
 * @param {object|null} [o.listener] 独立监听原始状态 { ok, disabled, host, port, source, error }
 * @param {number|null} [o.webPort] 实际监听的端口（探测结果）
 * @param {boolean|null} [o.portFree] 目标端口是否空闲（探测结果）
 * @param {boolean|null} [o.firewallOk] 防火墙是否放行（探测结果；null=未探测）
 * @param {string[]} [o.missingRoots] roots 里不存在的路径（探测结果）
 * @param {boolean|null} [o.tailscaleUp] Tailscale 是否可用（探测结果）
 * @param {number} [o.nodesOnline] 已在线副机数
 * @returns {{ok:boolean, items:Array, failed:number, autoFixable:number}}
 */
export function envChecks({
  role,
  config = {},
  reachability = null,
  listener = null,
  webPort = null,
  portFree = null,
  firewallOk = null,
  missingRoots = [],
  tailscaleUp = null,
  nodesOnline = null,
} = {}) {
  const out = []
  // `config` 可能显式传 null（调用方拿不到配置快照时）—— 归一成空对象，
  // 否则下面每一处 `config.role` 都会 TypeError，整份体检直接抛。
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {}

  // ── 角色解析：**必须归一化，不能拿原始 role 字符串直接比** ────────────
  //
  // ⚠ 2026-10-17 修（v0.9.0 审查 H1）：
  //
  // 原实现 `const isHub = role === 'hub' || role === 'both'` —— 而 v0.9.0 起
  // **默认安装的生效配置就是 `role: 'auto'`**（Config schema 的 `.default('auto')`
  // + 包内 patch 显式写入）。于是：
  //
  //   · `isHub` = false → reachability / port / firewall / tailscale / nodes
  //     **五项全部跳过** —— 而这五项正是体检存在的理由（副机连不上的静默失败）
  //   · inject 按 worker 三件套判定 → hub 正确的 inject 反被判"缺服务"
  //   · 检查 1 判 role 未配置 → 误报
  //
  // 更糟的是首次自动体检让这份"双误报 + 零诊断"在每个新装用户首次打开面板时
  // **自动弹出**。
  //
  // 修法：调用 `resolveRole`（与 lib/index.js 同一份实现）把 auto 推断成实际
  // 角色。项目的"判据只有一份"原则在这里同样适用 —— setup-routes 的 `/state`
  // 早就复用了 resolveRoleDetail，env-check 当时漏了。
  //
  // 兼容：调用方仍可传 `role`（面板路由只在 hub/both 时注册，传 'hub' 也对）。
  //
  // 优先级（**顺序很重要**，两种写法都会误报，必须精确）：
  //   1. **配置里写了 role**（哪怕非法/空）→ 以配置为准，交给 resolveRole 判
  //   2. **配置里完全没这个字段** → 退回调用方传的 `role`
  //
  // 为什么不能无条件用配置：会把"调用方明确说 hub、但配置里 role 是空"
  // 误判成未配置（v0.9.0 审查 H1 修复时差点引入的另一种误报）。
  // 为什么不能只认"解析出具体角色"：那样 `config.role='hubb'`（非法）会退回
  // 用调用方的 'hub' 而放行 —— 非法配置必须如实报出来。
  const givenRole = typeof role === 'string' ? role.trim().toLowerCase() : ''
  const cfgHasRole = Object.prototype.hasOwnProperty.call(cfg, 'role')
    && cfg.role !== undefined && cfg.role !== null
  let effectiveRole = givenRole
  if (cfgHasRole) {
    try {
      // resolveRole 对 auto 推断、对空/非法返回 ''（= 未配置，由下面如实报出）
      const resolved = resolveRole(cfg)
      effectiveRole = typeof resolved === 'string' ? resolved : ''
    } catch {
      effectiveRole = ''
    }
  }
  // 最后一道兜底：不认识的（含空）按未配置处理
  const roleRaw = effectiveRole
  const isHub = roleRaw === 'hub' || roleRaw === 'both'

  /* ── 1. 角色已配置（未配置时面板显示引导页，用户会以为装坏了）── */
  out.push(item(
    roleRaw === 'hub' || roleRaw === 'worker' || roleRaw === 'both',
    'role',
    '本机角色已配置（hub / worker / both）',
    {
      fix: "打开 Web 面板「远程同事」，点「我是主机」或「我是副机」选一次角色",
      // 说明推断来源：auto 推断出来的角色要告诉用户"为什么是这个"
      detail: roleRaw === ''
        ? '当前 role 为空 = 未配置'
        : (cfg.role === roleRaw ? `当前 role = ${roleRaw}` : `当前 role = ${roleRaw}（由 role: ${cfg.role || '未写'} 推断）`),
      autoFix: true,
    },
  ))

  /* ── 2. inject 含必需服务（缺了 hub 半死 / agent 无工具）── */
  const inject = Array.isArray(cfg.inject) ? cfg.inject : null
  // inject 通常在 loader 行上，config 快照里可能没有 —— 拿不到就跳过（不误报）
  if (inject !== null) {
    const need = isHub ? ['webServer', 'tools', 'systemPrompt'] : ['tools', 'agentLoop', 'sessions']
    const missing = need.filter((s) => !inject.includes(s))
    out.push(item(
      missing.length === 0,
      'inject',
      `inject 含本角色必需的服务（${need.join(' / ')}）`,
      {
        fix: `在 profile 的 cordis.patch.yml 里把本插件的 inject 改成 [${need.map((s) => `'${s}'`).join(', ')}]`,
        detail: missing.length ? `缺少：${missing.join(', ')}` : '',
        autoFix: true,
      },
    ))
  }

  /* ── 3. 独立监听（0.9.3 起**副机拨入的主通道**）─────────────────
   *
   * ⚠ 这是 2026-10-20 补的（v0.9.3 审查 M4）。此前体检查了 10 项，
   * **没有一项**观察独立监听到底起没起来 —— 而它才是副机真正连的那条路。
   * 端口被占、绑错地址、因为 nodeToken 为空退回回环，体检全都看不见。
   */
  if (isHub) {
    out.push(listenerCheck(listener, cfg))
  }

  /* ── 4. 节点端点可达性（两条通道联合判断）────────────────────────
   *
   * 2026-10-20 重写（v0.9.3 审查 H5）：
   * 原实现只看 `ctx.webServer.getOrigin()`。0.9.3 把端点搬到独立监听后，
   * 这造成**假红** —— DSH 的 webserver 仍绑 127.0.0.1（它的默认行为），
   * 于是面板天天报"副机用任何地址都连不上"，而 19387 上正好好地服务着。
   * 更糟的是修法让用户去改 webserver 的 host —— 那个改动会被 DSH 每次启动
   * 重写冲掉，且与新通道无关。
   *
   * 现在：独立监听在听且绑非回环 → 直接判可达，并把实际地址报出来。
   */
  if (isHub) {
    const listenUp = listener !== null && typeof listener === 'object'
      && listener.ok === true
      && typeof listener.host === 'string' && listener.host !== ''
    const listenLoop = listenUp ? isLoopbackHost(listener.host) : null

    const loop = reachability && typeof reachability.loopback === 'boolean'
      ? reachability.loopback
      : (reachability && typeof reachability.origin === 'string' ? isLoopbackOrigin(reachability.origin) : null)

    if (listenUp && listenLoop === false) {
      // 主通道好着 —— 不再看 webServer（它绑 loopback 也无所谓）
      out.push(item(true, 'reachability', '节点端点可达（副机从独立监听拨入）', {
        detail: `${listener.host}:${listener.port ?? '?'}（来源 ${listener.source || 'auto'}）`,
      }))
    } else if (listenUp && listenLoop === true) {
      out.push(item(false, 'reachability', '独立监听绑在回环 —— 副机连不上', {
        fix: '这是安全策略：nodeToken 为空时不把端点暴露到网络。\n'
          + '  到面板「副机接入」点「生成口令」，重启 DSH 后会自动选可达地址；\n'
          + '  或显式配置 listenHost: \'<本机具体 IP>\' 并设置 nodeToken。',
        detail: `当前绑 ${listener.host}:${listener.port ?? '?'}`,
        autoFix: true,
      }))
    } else if (loop === null) {
      out.push(item(true, 'reachability', '节点端点可达性（无法判定，已跳过）', {
        detail: reachability && reachability.hint ? reachability.hint : '未拿到独立监听或 webServer 状态',
        severity: 'info',
      }))
    } else {
      // 主通道没起来 → 只能靠 DSH webserver 那条老通道（绑具体 IP 才通）
      out.push(item(
        loop === false,
        'reachability',
        '节点端点可达（独立监听未启用，退回 DSH 的 Web 服务）',
        {
          // ⚠ **绝对不要建议 `0.0.0.0`**（2026-10-18 事故，10 份 crash 日志）
          fix: '优先让独立监听起来（改 listenPort 换个空闲端口，或检查 nodeToken）。\n'
            + '  若确实要走 DSH 的 Web 服务：把 profile 的 cordis.patch.yml 里 webserver 的 host\n'
            + '  改成**一个具体的本机 IP**（不能用 0.0.0.0），然后重启 DSH。\n'
            + '  查地址：Tailscale 用 `tailscale ip -4`，局域网用 `ipconfig`。',
          detail: loop
            ? `当前只监听 ${reachability.bound || '127.0.0.1'}（${reachability.origin || ''}）—— 副机用任何地址都连不上`
            : `当前监听 ${reachability.origin || ''}`,
          autoFix: true,
        },
      ))
    }
  }

  /* ── 4. 端口占用（hub 需要能绑上目标端口）── */
  if (isHub && portFree !== null) {
    out.push(item(portFree === true, 'port', 'hub 端口可用', {
      fix: '换一个端口（改 webserver 的 port），或先关掉占用它的程序',
      detail: portFree === false ? `端口 ${webPort ?? '?'} 已被占用` : '',
    }))
  }

  /* ── 5. 防火墙（局域网/公网场景；Tailscale 不受影响）── */
  if (isHub && firewallOk !== null) {
    out.push(item(firewallOk === true, 'firewall', '防火墙已放行 hub 端口', {
      fix: `以管理员运行：netsh advfirewall firewall add rule name="dsh-remote-agent" dir=in action=allow protocol=TCP localport=${webPort ?? 19387}`,
      detail: firewallOk === false
        ? '局域网/公网的副机会被挡住（走 Tailscale 的不受影响）'
        : '',
      autoFix: true,
    }))
  }

  /* ── 6. roots 存在（worker：任务全报 workspace-denied）── */
  const roots = Array.isArray(cfg.roots) ? cfg.roots.filter((r) => typeof r === 'string' && r.trim() !== '') : []
  if (roleRaw === 'worker' || roleRaw === 'both') {
    if (roots.length === 0) {
      out.push(item(false, 'roots', 'roots 已配置且路径存在', {
        fix: '在 profile 的 cordis.patch.yml 里给本插件加 roots: [\'D:\\\\work\']（绝对路径，必须真实存在）',
        detail: 'roots 为空 —— 任务会被全部拒绝（workspace-denied）',
        autoFix: true,
      }))
    } else if (Array.isArray(missingRoots) && missingRoots.length > 0) {
      out.push(item(false, 'roots', 'roots 已配置且路径存在', {
        fix: `创建这些目录，或把 roots 改成真实存在的路径：${missingRoots.join(', ')}`,
        detail: `不存在的路径：${missingRoots.join(', ')}`,
        autoFix: true,
      }))
    } else {
      out.push(item(true, 'roots', 'roots 已配置且路径存在', { detail: roots.join(', ') }))
    }
  }

  /* ── 7. Tailscale（跨网场景的推荐路径；**只提示不代下载**）── */
  if (isHub && tailscaleUp !== null) {
    out.push(item(tailscaleUp === true, 'tailscale', 'Tailscale 可用（跨网推荐）', {
      // ⚠ 边界（产品决策，2026-10-17 用户确认）：本插件**不代用户下载任何第三方软件**。
      // 理由：零 npm 依赖 / 零构建是核心卖点；代下载会让我们变成软件分发方
      // （装哪个版本、从哪下、校验和怎么保证、装失败算谁的、供应链攻击面）。
      // 所以这里只给官方链接 + 说明，动作留给用户。
      fix: '装 Tailscale 并登录同一账号：https://tailscale.com/download —— 装好后两台机器自动互通，'
        + '再用 tailscale ip -4 拿主机 IP 填到副机。'
        + '（本插件不会代你下载第三方软件，只做检测与提示。）',
      detail: tailscaleUp === false
        ? '没装 / 没登录。同一局域网可以直接用主机局域网 IP；跨网建议装 Tailscale'
        : '',
      severity: 'warn',
    }))
  }

  /* ── 8. 副机是否连上过（最能说明"到底通不通"的一条）── */
  if (isHub && nodesOnline !== null) {
    out.push(item(nodesOnline > 0, 'nodes', '至少有一台副机在线', {
      fix: '检查：① 副机的 hubUrl 是否含 :19387 端口 ② 副机 DSH 是否在跑 '
        + '③ 上面那条「Web 服务绑在可达地址」是否通过 ④ 防火墙',
      detail: nodesOnline > 0 ? `${nodesOnline} 台在线` : '还没有副机连上过',
      severity: 'warn',
    }))
  }

  const failed = out.filter((x) => !x.ok && x.severity === 'error').length
  const autoFixable = out.filter((x) => !x.ok && x.autoFix).length
  return { ok: failed === 0, items: out, failed, autoFixable }
}

/**
 * 把体检结果渲染成人读文本（命令行用；面板自己渲染，不走这里）。
 * @param {ReturnType<typeof envChecks>} result
 */
export function renderEnvChecks(result, { title = '环境体检' } = {}) {
  const lines = [title, '']
  for (const it of result.items) {
    const mark = it.ok ? '✓' : (it.severity === 'warn' ? '⚠' : '✗')
    lines.push(`${mark} ${it.label}`)
    if (it.detail) lines.push(`    ${it.detail}`)
    if (!it.ok && it.fix) lines.push(`    ↳ 怎么修：${it.fix}`)
    // v0.9.0 审查 L3：原文案写"面板上点「修复」，或命令行加 --fix" ——
    // **两者都不存在**（全仓库无 fix 路由 / 无 --fix 参数）。虚假承诺比没有
    // 提示更糟：用户会去找那个按钮，找不到就以为功能坏了。改成如实说明。
    if (!it.ok && it.autoFix) lines.push('    ↳ 修法是机械的（照上面复制粘贴即可，不需要判断）')
  }
  lines.push('')
  if (result.ok && result.failed === 0) {
    lines.push('核心项全部通过。')
  } else {
    lines.push(`共 ${result.failed} 项需要处理${result.autoFixable > 0 ? `（其中 ${result.autoFixable} 项修法机械，照抄即可）` : ''}。`)
  }
  return { text: lines.join('\n'), failed: result.failed, autoFixable: result.autoFixable }
}
