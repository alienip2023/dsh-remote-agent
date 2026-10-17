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

/** 检查结果。`autoFix` 为真表示"我们能自动改配置修好它"。 */
function item(ok, id, label, { fix = '', detail = '', autoFix = false, severity = 'error' } = {}) {
  return { ok: Boolean(ok), id, label, fix: ok ? '' : fix, detail, autoFix: ok ? false : autoFix, severity }
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
 * @param {object|null} [o.reachability] hub 的可达性自检结论（applyHub 产出）
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
  webPort = null,
  portFree = null,
  firewallOk = null,
  missingRoots = [],
  tailscaleUp = null,
  nodesOnline = null,
} = {}) {
  const out = []
  const isHub = role === 'hub' || role === 'both'
  // `config` 可能显式传 null（调用方拿不到配置快照时）—— 归一成空对象，
  // 否则下面每一处 `config.role` 都会 TypeError，整份体检直接抛。
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {}

  /* ── 1. 角色已配置（未配置时面板显示引导页，用户会以为装坏了）── */
  const roleRaw = typeof cfg.role === 'string' ? cfg.role.trim().toLowerCase() : ''
  out.push(item(
    roleRaw === 'hub' || roleRaw === 'worker' || roleRaw === 'both',
    'role',
    '本机角色已配置（hub / worker / both）',
    {
      fix: "打开 Web 面板「远程同事」，点「我是主机」或「我是副机」选一次角色",
      detail: roleRaw === '' ? '当前 role 为空 = 未配置' : `当前 role = ${roleRaw}`,
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

  /* ── 3. hub 可达性（**最贵的一条**：绑 loopback 时副机永远连不上）── */
  if (isHub) {
    const loop = reachability && typeof reachability.loopback === 'boolean'
      ? reachability.loopback
      : (reachability && typeof reachability.origin === 'string' ? isLoopbackOrigin(reachability.origin) : null)
    if (loop === null) {
      out.push(item(true, 'reachability', 'Web 服务可达性（无法判定，已跳过）', {
        detail: reachability && reachability.hint ? reachability.hint : '未拿到 webServer.getOrigin()',
        severity: 'info',
      }))
    } else {
      out.push(item(
        loop === false,
        'reachability',
        'Web 服务绑在可达地址（副机才能连上）',
        {
          fix: "在 profile 的 cordis.patch.yml 里给 webserver 行加 host: '0.0.0.0'（保留 port），然后重启 DSH",
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
    if (!it.ok && it.autoFix) lines.push('    ↳ 可以自动修（面板上点「修复」，或命令行加 --fix）')
  }
  lines.push('')
  if (result.ok && result.failed === 0) {
    lines.push('核心项全部通过。')
  } else {
    lines.push(`共 ${result.failed} 项需要处理${result.autoFixable > 0 ? `（其中 ${result.autoFixable} 项可自动修）` : ''}。`)
  }
  return { text: lines.join('\n'), failed: result.failed, autoFixable: result.autoFixable }
}
