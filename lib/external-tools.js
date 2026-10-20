/**
 * 外部工具检测（2026-10-20，用户要求的"自动装依赖"）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 边界：**检测 + 给命令，不代下载**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话是"自动装依赖"，但我们把范围收窄到"**外部工具**"，并且
 * **不代下载**。理由（用户此前也确认过这条边界）：
 *
 *   · 本插件的核心卖点是**零 npm 依赖** —— 代装 npm 包会自毁卖点
 *   · 代下载第三方二进制会让我们变成软件分发方：
 *     装哪个版本、从哪下、校验和怎么保证、装失败算谁的、供应链攻击面
 *     —— 全落在我们头上
 *
 * 所以本模块做三件事：
 *   1. **探测**这些工具在不在（不执行它们做实际工作，只查版本）
 *   2. **说清缺了会怎样**（用户才能判断要不要装）
 *   3. **给官方下载链接 + 安装命令**（用户自己决定、自己执行）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这些工具值得检测
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 都是"**缺了会静默失败或体验大幅退化**"的那类：
 *
 *   · **Tailscale** —— 跨网场景的唯一现实路径。缺了副机连不上，
 *     而错误表现是"连接超时"，用户根本想不到是缺个 VPN 工具。
 *   · **PowerShell** —— Windows 上 SMB 共享、部分 exec 任务依赖它。
 *     缺了表现为"命令找不到"，很难归因。
 *   · **git** —— 仓库感知调度（提案 #13）依赖它。缺了只是少个功能，
 *     但用户不知道为什么 repo 路由不生效。
 *   · **Node.js** —— 插件本身跑在 DSH 里（DSH 自带），但副机侧某些
 *     headless 场景要独立的 node。缺了报错很难懂。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 探测方式：只查版本，不做事
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 每个工具跑 `<tool> --version`（或等价），超时 3 秒。
 * **不传任何用户输入**，命令是写死的常量 —— 没有注入面。
 */

import { spawnSync } from 'node:child_process'

/**
 * 工具清单。
 *
 * 字段说明：
 *   · `required`：缺了核心功能不可用（true）还是只是功能退化（false）
 *   · `why`：缺了会怎样 —— 用户据此判断要不要装
 *   · `install`：**给用户复制粘贴的命令**（我们不执行它）
 *   · `url`：官方下载页
 */
const TOOLS = Object.freeze([
  {
    id: 'tailscale',
    name: 'Tailscale',
    // 探测命令：`tailscale version` 输出形如 `1.62.0\n  go1.21`
    probe: { cmd: 'tailscale', args: ['version'], timeoutMs: 3000 },
    required: false,
    why: '跨网（不在同一局域网）时的推荐路径。缺了副机连不上，'
      + '而错误表现只是"连接超时"，很难想到是缺个 VPN 工具。'
      + '同一局域网可以不用它。',
    install: {
      win: 'winget install --id Tailscale.Tailscale -e',
      mac: 'brew install --cask tailscale',
      linux: 'curl -fsSL https://tailscale.com/install.sh | sh',
    },
    url: 'https://tailscale.com/download',
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    // Windows 上叫 powershell / pwsh；非 Windows 上可能没有
    probe: { cmd: process.platform === 'win32' ? 'powershell' : 'pwsh', args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], timeoutMs: 4000 },
    required: process.platform === 'win32',
    why: 'Windows 上的 SMB 共享、部分 exec 任务依赖它。缺了表现为"命令找不到"，很难归因。',
    install: {
      win: '（Windows 自带；若缺失说明系统组件被裁剪）',
      mac: 'brew install --cask powershell',
      linux: 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell',
    },
    url: 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell',
  },
  {
    id: 'git',
    name: 'git',
    probe: { cmd: 'git', args: ['--version'], timeoutMs: 3000 },
    required: false,
    why: '仓库感知调度（remote_task 的 repo 参数）依赖它扫描副机上的仓库。'
      + '缺了只是少这个功能，但用户不知道为什么 repo 路由不生效。',
    install: {
      win: 'winget install --id Git.Git -e',
      mac: 'brew install git',
      linux: 'sudo apt install git   # 或 dnf / pacman',
    },
    url: 'https://git-scm.com/downloads',
  },
  {
    id: 'node',
    name: 'Node.js',
    probe: { cmd: 'node', args: ['--version'], timeoutMs: 3000 },
    required: false,
    why: '插件本身跑在 DSH 里（DSH 自带 node），但副机的 headless 后端'
      + '要一个独立的 node 才能 spawn 子进程。缺了 agent 模式会退化。',
    install: {
      win: 'winget install --id OpenJS.NodeJS.LTS -e',
      mac: 'brew install node@22',
      linux: 'https://nodejs.org/en/download',
    },
    url: 'https://nodejs.org/en/download',
  },
])

/** 当前平台的安装命令键。 */
function platformKey() {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

/**
 * 探测单个工具。
 *
 * @returns {{id:string, name:string, installed:boolean, version:string, error:string}}
 */
function probeTool(tool) {
  const base = { id: tool.id, name: tool.name, installed: false, version: '', error: '' }
  try {
    const r = spawnSync(tool.probe.cmd, tool.probe.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: tool.probe.timeoutMs,
      // 不继承用户 shell 的 alias / 函数 —— 只跑真实可执行文件
      shell: false,
    })
    if (r.error) {
      // ENOENT = 没装，这是最常见的情形，不算"错误"
      base.error = r.error.code === 'ENOENT' ? '' : String(r.error.message ?? r.error)
      return base
    }
    if (r.status !== 0) {
      base.error = `退出码 ${r.status}`
      return base
    }
    const out = String(r.stdout ?? '').trim()
    if (out === '') {
      base.error = '没有输出'
      return base
    }
    base.installed = true
    // 只取第一行、截断 —— 版本串不需要整段
    base.version = out.split(/\r?\n/)[0].slice(0, 60)
    return base
  } catch (err) {
    base.error = String(err?.message ?? err)
    return base
  }
}

/**
 * 探测所有外部工具。
 *
 * @param {object} [o]
 * @param {boolean} [o.onlyMissing] 只返回缺失的（面板用，省流量）
 * @returns {{platform:string, tools:Array, missing:Array, requiredMissing:Array}}
 */
export function probeExternalTools({ onlyMissing = false } = {}) {
  const pk = platformKey()
  const tools = []
  for (const t of TOOLS) {
    const p = probeTool(t)
    const entry = {
      id: p.id,
      name: p.name,
      installed: p.installed,
      version: p.version,
      required: t.required,
      // 缺了会怎样 —— 这是用户判断"要不要装"的唯一依据
      why: t.why,
      // 安装命令（**给用户复制，我们不执行**）
      install: t.install[pk] ?? '',
      url: t.url,
      error: p.error,
    }
    if (onlyMissing && entry.installed) continue
    tools.push(entry)
  }
  const missing = tools.filter((t) => !t.installed)
  return {
    platform: process.platform,
    tools,
    missing,
    requiredMissing: missing.filter((t) => t.required),
  }
}

/**
 * 把探测结果渲染成人读文本（命令行用）。
 */
export function renderExternalTools(result) {
  const lines = ['外部工具检测', '']
  if (!result || !Array.isArray(result.tools) || result.tools.length === 0) {
    lines.push('（未探测到任何工具）')
    return lines.join('\n')
  }
  for (const t of result.tools) {
    const mark = t.installed ? '✓' : (t.required ? '✗' : '⚠')
    const ver = t.installed && t.version !== '' ? `  ${t.version}` : ''
    lines.push(`${mark} ${t.name}${ver}`)
    if (!t.installed) {
      if (t.why) lines.push(`    ${t.why}`)
      if (t.install) lines.push(`    安装：${t.install}`)
      if (t.url) lines.push(`    下载：${t.url}`)
    }
  }
  lines.push('')
  if (result.requiredMissing.length === 0) {
    lines.push('必需工具都在。')
  } else {
    lines.push(`缺少 ${result.requiredMissing.length} 个必需工具：${result.requiredMissing.map((t) => t.name).join(', ')}`)
  }
  return lines.join('\n')
}

/** 导出清单（测试与面板共用，避免两处写死）。 */
export function toolCatalog() {
  const pk = platformKey()
  return TOOLS.map((t) => ({
    id: t.id,
    name: t.name,
    required: t.required,
    why: t.why,
    install: t.install[pk] ?? '',
    url: t.url,
  }))
}
