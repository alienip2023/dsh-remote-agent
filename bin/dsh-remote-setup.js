#!/usr/bin/env node
/**
 * dsh-remote-setup —— 小白向导。
 *
 * 用法：
 *   node bin/dsh-remote-setup.js                # 交互式：一步步生成两台的配置
 *   node bin/dsh-remote-setup.js --doctor       # 体检当前配置，只报问题 + 怎么修
 *   node bin/dsh-remote-setup.js --role worker --hub-url ws://192.168.1.10:19387/api/remote-agent/node \
 *        --token nt_xxx --roots D:\work --node-id slave-pc     # 非交互生成副机配置
 *   node bin/dsh-remote-setup.js --role hub --token nt_xxx --roots D:\work   # 非交互生成主机配置
 *
 * 零外部依赖，只用 node: 内置模块。逻辑层在 lib/setup.js（可测试）。
 */
import readline from 'node:readline/promises'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  newNodeToken,
  detectLanIps,
  normalizeRoots,
  buildHubYaml,
  buildWorkerYaml,
  buildHubUrl,
  probeTcp,
  doctorChecks,
  renderDoctor,
  friendlyConnectError,
} from '../lib/setup.js'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

function say(msg = '') {
  console.log(msg)
}
function hint(msg) {
  console.log(`${DIM}${msg}${RESET}`)
}

/** 读一个用户输入（readline），支持默认值与校验循环。 */
async function ask(rl, question, { def = '', validate, retryMsg = '输入不合要求，请重试' } = {}) {
  for (;;) {
    const suffix = def !== '' ? `（回车 = ${def}）` : ''
    const raw = (await rl.question(`${question}${suffix} > `)).trim() || def
    if (!validate) return raw
    const err = validate(raw)
    if (err === true || err === undefined) return raw
    say(`  ✗ ${typeof err === 'string' ? err : retryMsg}`)
  }
}

function parseCliArgs() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true, // --doctor <配置文件路径>
      options: {
        doctor: { type: 'boolean', default: false },
        role: { type: 'string' }, // hub | worker
        'hub-url': { type: 'string' },
        'hub-ip': { type: 'string' },
        port: { type: 'string' },
        token: { type: 'string' },
        'node-id': { type: 'string' },
        roots: { type: 'string' }, // 逗号分隔
        out: { type: 'string' }, // 写文件而不是打印
        help: { type: 'boolean', default: false },
      },
      strict: true,
    })
    return { values, positionals }
  } catch (err) {
    say(`参数解析失败：${err.message}`)
    say('用 --help 查看用法。')
    process.exit(2)
  }
}

function splitRoots(raw) {
  return String(raw ?? '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function printYaml(name, yaml, outFile) {
  if (outFile) {
    fs.writeFileSync(path.resolve(outFile), yaml + '\n', 'utf8')
    say(`✓ 已写入 ${path.resolve(outFile)}`)
    return
  }
  say('')
  say(`${BOLD}=== ${name} ===${RESET}`)
  say(yaml)
}

/* ══════════════════ doctor ══════════════════ */

async function runDoctor(positionals) {
  const cfgPath = positionals[0]
  if (!cfgPath || !fs.existsSync(cfgPath)) {
    say('用法：--doctor <cordis配置文件.yml>')
    say('它会读取配置文件里的 remote-agent 行做体检（角色、token、roots、目录存在性）。')
    process.exit(2)
  }
  const raw = fs.readFileSync(cfgPath, 'utf8')
  // 轻量解析 remote-agent 行：不引 YAML 依赖，只提取 role/各字段（生成器的输出形态）
  const grab = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(raw)
    return m ? m[1].replace(/^['"]|['"]$/g, '').trim() : ''
  }
  const rootsM = /roots:\s*\n((?:\s+-\s+.+\n?)+)/.exec(raw)
  const roots = rootsM
    ? [...rootsM[1].matchAll(/-\s*(.+)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, '').trim())
    : splitRoots(grab('roots'))
  const config = {
    role: grab('role') || 'hub',
    hubUrl: grab('hubUrl'),
    token: grab('token'),
    nodeToken: grab('nodeToken'),
    nodeId: grab('nodeId'),
    roots,
    uiPullRoot: grab('uiPullRoot'),
  }
  const role = config.role === 'worker' ? 'worker' : 'hub'

  const checks = doctorChecks({ role, config, lanIps: detectLanIps() })

  // 网络探活：worker 且 hubUrl 合法时试一把 TCP
  if (role === 'worker' && config.hubUrl) {
    try {
      const u = new URL(/^wss?:\/\//i.test(config.hubUrl) ? config.hubUrl : `ws://${config.hubUrl}`)
      const r = await probeTcp(u.hostname, u.port || 80)
      checks.push({
        ok: r.ok,
        label: `主机端口可达 ws://${u.hostname}:${u.port || 80}${r.ok ? `（${r.ms}ms）` : ''}`,
        fix: r.error ?? '',
      })
    } catch { /* URL 不合法已在静态检查报过 */ }
  }

  const { text, failed } = renderDoctor(checks, { title: `dsh-remote-agent 体检（role=${role}）` })
  say(text)
  process.exit(failed === 0 ? 0 : 1)
}

/* ══════════════════ 交互式向导 ══════════════════ */

async function wizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    say('')
    say(`${BOLD}dsh-remote-agent 配置向导${RESET}`)
    hint('把另一台电脑变成你 DSH 的远程同事。全程回车可用默认值。')
    say('')

    const role = await ask(rl, '① 这台机器是？[1=主机(派活) 2=副机(干活)]', {
      def: '1',
      validate: (v) => (['1', '2', 'hub', 'worker'].includes(v.toLowerCase()) || '请输 1 或 2'),
    })
    const isHub = role === '1' || role.toLowerCase() === 'hub'

    // ── roots：两台都要 ────────────────────────────────────────
    const defaultRoot = path.join(fs.realpathSync(os.homedir()), 'dsh-remote-work')
    let roots = []
    await ask(rl, `② 允许任务操作的目录（多个用逗号分隔）`, {
      def: defaultRoot,
      validate: (v) => {
        const { clean, missing } = normalizeRoots(splitRoots(v))
        if (clean.length === 0) return '至少给一个目录'
        if (missing.length > 0) {
          for (const m of missing) {
            try { fs.mkdirSync(m, { recursive: true }); hint(`  已自动创建缺失目录 ${m}`) } catch { return `无法创建目录 ${m}` }
          }
        }
        roots = clean
        return true
      },
    })

    // ── token：hub 生成、worker 粘贴 ───────────────────────────
    let hubToken = ''
    if (isHub) {
      hubToken = newNodeToken()
      hint(`③ 已为你生成副机入网口令（nodeToken，粘到副机配置里）：`)
      say(`    ${hubToken}`)
      say('')
    } else {
      hubToken = await ask(rl, '③ 主机的 nodeToken（在主机上跑本向导会生成；留空仅限完全可信内网）', {
        def: '',
      })
    }

    let workerYaml = ''
    if (isHub) {
      // ── hub：IP 选择 ────────────────────────────────────────
      const ips = detectLanIps()
      say('')
      hint('本机局域网地址（副机要连的就是它）：')
      ips.forEach((ip, i) => say(`  [${i + 1}] ${ip.address}  (${ip.name}${ip.private ? '' : ', 公网'})`))
      const ipPick = await ask(rl, '④ 副机连哪个地址？', {
        def: ips[0]?.address ?? '',
        validate: (v) => (ips.some((i) => i.address === v) || /^[\w.-]+$/.test(v) || '请输入列表中的地址或合法主机名'),
      })
      const port = await ask(rl, '⑤ 端口', {
        def: '19387',
        validate: (v) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? true : '1-65535 的数字'),
      })
      const hubUrl = buildHubUrl(ipPick, +port)
      const nodeId = await ask(rl, '⑥ 这台主机的节点 id 留空即可；副机的节点 id（如 slave-pc）', { def: '' })

      printYaml('主机（hub）：粘到 DSH 的 cordis 配置里', buildHubYaml({ token: hubToken, roots }))
      workerYaml = buildWorkerYaml({
        hubUrl,
        token: hubToken,
        nodeId: nodeId !== '' ? nodeId : 'slave-pc',
        roots,
      })
      printYaml(`副机（worker）配置 —— 抄到另一台电脑的 DSH 里（注意 inject: [] 已替你填好）`, workerYaml)
      say('')
      hint(`最后一步（Windows 主机）：放行防火墙端口 ${port} ——`)
      hint(`  netsh advfirewall firewall add rule name="dsh-remote-agent" dir=in action=allow protocol=TCP localport=${port}`)
    } else {
      // ── worker：hubUrl ──────────────────────────────────────
      const hubUrl = await ask(rl, '④ 主机地址（形如 ws://192.168.1.10:19387/api/remote-agent/node，或只给 IP:端口）', {
        def: '',
        validate: (v) => {
          if (v === '') return '不能为空'
          const norm = buildHubUrl(v, 19387)
          return (norm !== '' ? true : '解析不了，示例：192.168.1.10:19387 或完整 ws:// 地址')
        },
      })
      const nodeId = await ask(rl, '⑤ 本机节点 id（留空用主机名）', { def: '' })
      const finalUrl = buildHubUrl(hubUrl, 19387)
      const u = new URL(finalUrl)
      hint(`⑥ 探活 ${u.host} …`)
      const r = await probeTcp(u.hostname, u.port || 80)
      if (r.ok) say(`  ✓ 端口可达（${r.ms}ms）`)
      else say(`  ✗ ${r.error}`)
      say('')

      workerYaml = buildWorkerYaml({
        hubUrl: finalUrl,
        token: hubToken,
        nodeId,
        roots,
      })
      printYaml('副机（worker）：粘到这台机器 DSH 的 cordis 配置里', workerYaml)
      if (!r.ok) {
        say('')
        hint('主机端口当前不可达 —— 先在主机上跑好并放行防火墙，再重启副机 DSH。')
      }
    }

    say('')
    hint('配置写好后重启 DSH，对主机说「副机上有哪些节点在线？」验证连通。')
    hint('出问题时用 --doctor 体检；详见 README「五分钟上手」。')
  } finally {
    rl.close()
  }
}

/* ══════════════════ 非交互生成 ══════════════════ */

function generateNonInteractive(values) {
  const role = String(values.role ?? '').toLowerCase()
  if (role !== 'hub' && role !== 'worker') {
    say('--role 必须是 hub 或 worker')
    process.exit(2)
  }
  const roots = normalizeRoots(splitRoots(values.roots)).clean
  const token = String(values.token ?? '')
  if (role === 'hub') {
    printYaml('hub 配置', buildHubYaml({ token, roots }), values.out)
    return
  }
  const hubUrl = buildHubUrl(values['hub-url'] ?? '', 19387)
  if (hubUrl === '') {
    say('--hub-url 必填，形如 192.168.1.10:19387 或完整 ws:// 地址')
    process.exit(2)
  }
  printYaml(
    'worker 配置',
    buildWorkerYaml({ hubUrl, token, nodeId: String(values['node-id'] ?? ''), roots }),
    values.out,
  )
}

/* ══════════════════ 入口 ══════════════════ */

const { values, positionals } = parseCliArgs()
if (values.help) {
  say('dsh-remote-setup —— dsh-remote-agent 配置向导（交互式 / 非交互 / 体检）')
  say('  node bin/dsh-remote-setup.js                 交互式生成两台的配置')
  say('  node bin/dsh-remote-setup.js --doctor <配置.yml>     体检现有配置')
  say('  --role hub|worker --hub-url --token --node-id --roots a,b --out file.yml   非交互生成')
  process.exit(0)
}
if (values.doctor) await runDoctor(positionals)
else if (values.role) generateNonInteractive(values)
else await wizard()
