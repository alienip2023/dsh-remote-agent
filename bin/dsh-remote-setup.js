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
import os from 'node:os'
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
  patchFilePath,
  listDshProfiles,
  writePatchBlock,
} from '../lib/setup.js'
import { encodePairCode, decodePairCode } from '../lib/pairing.js'
import { IDENTITY_FILE_NAME, readHubIdentity } from '../lib/identity.js'

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
        pair: { type: 'string' }, // worker 非交互：直接用配对码
        roots: { type: 'string' }, // 逗号分隔
        out: { type: 'string' }, // 写文件而不是打印
        write: { type: 'boolean', default: false }, // 非交互：直接写进 DSH 配置（自动备份）
        'no-write': { type: 'boolean', default: false }, // 交互：禁止写盘询问（只输出）
        force: { type: 'boolean', default: false }, // 有手写 remote-agent 条目时强制写入
        profile: { type: 'string' }, // dsh profile 名（默认 desktop）
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

/**
 * 询问并把 YAML 写进本机 DSH 配置（备份 → 托管块合并 → 校验，失败自动回滚）。
 * 写盘是零终端小白的"最后一公里"：不用自己找配置文件、开编辑器、粘 YAML。
 */
async function offerWrite(rl, values, yaml, roleLabel) {
  if (values['no-write']) return false
  const profile = String(values.profile ?? '').trim() || 'desktop'
  const file = patchFilePath(profile)
  const profiles = listDshProfiles()
  if (profiles.length === 0 && !fs.existsSync(file)) {
    hint(`未找到 DSH 配置（${file}）—— 确认这台机器装了 DSH？下面保持只输出，请你手动粘贴。`)
    return false
  }
  const yes = await ask(rl, `要把这份${roleLabel}配置直接写进 DSH 吗？（自动备份原文件；profile=${profile}）`, {
    def: 'Y',
    validate: (v) => (['y', 'yes', 'n', 'no', '1', '0'].includes(v.toLowerCase()) || '输 Y 或 N'),
  })
  if (!['y', 'yes', '1'].includes(yes.toLowerCase())) return false
  return applyWrite({ file, blockYaml: yaml, force: values.force === true })
}

/** 非交互写盘执行 + 结果播报。返回 true = 成功。 */
function applyWrite({ file, blockYaml, force }) {
  const r = writePatchBlock({ file, blockYaml, force })
  if (r.ok) {
    say(`  ✓ 已${r.mode === 'replaced' ? '更新（原托管块替换）' : '写入（追加托管块）'} ${r.file}`)
    say(`    （原文件已备份：${r.backup}）`)
    hint('  重启 DSH 后生效。')
  } else {
    say(`  ✗ ${r.error}`)
  }
  return r.ok
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
    pair: grab('pair'),
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
    let pairPrefill = null // 配对码解析结果（worker 路径用）
    let pairRaw = '' // 用户粘贴的原始配对码串
    if (isHub) {
      hubToken = newNodeToken()
      hint(`③ 已为你生成副机入网口令（nodeToken，粘到副机配置里）：`)
      say(`    ${hubToken}`)
      say('')
    } else {
      const tok = await ask(rl, '③ 主机的 nodeToken，或直接粘贴主机给的整行配对码（dshra1:// 开头）', {
        def: '',
      })
      if (tok.toLowerCase().startsWith('dshra1://')) {
        const dec = decodePairCode(tok)
        if (!dec.ok) {
          say(`  ✗ ${dec.error}`)
          hint('  下面继续按手动方式配置。')
        } else {
          pairPrefill = dec.payload
          pairRaw = tok
          hubToken = dec.payload.token ?? ''
          hint('✓ 配对码已识别 —— 地址与 token 自动填好，后面几步直接回车即可')
        }
      } else {
        hubToken = tok
      }
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
      const nodeId = await ask(rl, '⑥ 这台主机的节点 id 留空即可；副机的节点 id（如 slave-pc）', { def: '' })
      const hubUrl = buildHubUrl(ipPick, +port)
      const workerNodeId = nodeId !== '' ? nodeId : 'slave-pc'
      const hubFingerprint = hubFingerprintForPairCode()
      const pairCode = encodePairCode({ hubUrl, token: hubToken, nodeId: workerNodeId, hubFingerprint })

      const hubYaml = buildHubYaml({ token: hubToken, roots })
      printYaml('主机（hub）：粘到 DSH 的 cordis 配置里', hubYaml)
      await offerWrite(rl, values, hubYaml, '主机（hub）')
      // 配对码：最不容易抄错的一条路 —— 一行代替 hubUrl+token+transportMode。
      say('')
      say(`${BOLD}=== 副机（worker）配对码 —— 首选：整行复制发给副机 ===${RESET}`)
      say(`    ${pairCode}`)
      hint('  （内含 token，等同凭证：当面或加密聊天传，别贴公开群里）')
      if (hubFingerprint !== '') {
        hint(`  （已带 hub 指纹 ${hubFingerprint} —— 副机粘码即完成身份钉住，假 hub 冒充会被当场拒绝）`)
      }
      say('')
      // 显式 YAML 作为备份/排查用（配对码展开后的形态）
      workerYaml = buildWorkerYaml({
        hubUrl,
        token: hubToken,
        nodeId: workerNodeId,
        roots,
        pinnedHubFingerprint: hubFingerprint,
      })
      printYaml('副机（worker）显式配置 —— 备用：不想用配对码就抄这一段（inject: [] 已替你填好）', workerYaml)
      say('')
      hint(`最后一步（Windows 主机）：放行防火墙端口 ${port} ——`)
      hint(`  netsh advfirewall firewall add rule name="dsh-remote-agent" dir=in action=allow protocol=TCP localport=${port}`)
    } else {
      // ── worker：hubUrl ──────────────────────────────────────
      const hubUrl = await ask(rl, '④ 主机地址（形如 ws://192.168.1.10:19387/api/remote-agent/node，或只给 IP:端口）', {
        def: pairPrefill?.hubUrl ?? '',
        validate: (v) => {
          if (v === '') return '不能为空'
          const norm = buildHubUrl(v, 19387)
          return (norm !== '' ? true : '解析不了，示例：192.168.1.10:19387 或完整 ws:// 地址')
        },
      })
      const nodeId = await ask(rl, '⑤ 本机节点 id（留空用主机名）', { def: pairPrefill?.nodeId ?? '' })
      const finalUrl = buildHubUrl(hubUrl, 19387)
      const u = new URL(finalUrl)
      hint(`⑥ 探活 ${u.host} …`)
      const r = await probeTcp(u.hostname, u.port || 80)
      if (r.ok) say(`  ✓ 端口可达（${r.ms}ms）`)
      else say(`  ✗ ${r.error}`)
      say('')

      // 配对码路径：字段没被手动改动时，直接输出 pair 一行版（最少可抄错的内容）
      const usedPair = pairPrefill
        && finalUrl === buildHubUrl(pairPrefill.hubUrl, 19387)
        && nodeId === (pairPrefill.nodeId ?? '')
        && hubToken === (pairPrefill.token ?? '')
      workerYaml = usedPair
        ? buildWorkerYaml({ pair: pairRaw, nodeId, roots })
        : buildWorkerYaml({ hubUrl: finalUrl, token: hubToken, nodeId, roots, pinnedHubFingerprint: pairPrefill?.hubFingerprint ?? '' })
      printYaml('副机（worker）：粘到这台机器 DSH 的 cordis 配置里', workerYaml)
      await offerWrite(rl, values, workerYaml, '副机（worker）')
      if (usedPair) {
        hint('（pair 一行在运行时自动展开成 hubUrl/token，显式配置优先 —— 改地址时写 hubUrl 即可覆盖）')
      }
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

/**
 * 读 hub 身份指纹用于配对码（P2-11）。
 *
 * 读不到（hub 还没在机上启动过 / 文件损坏）就返回 '' —— 配对码照常出，
 * 只是少带指纹；绝不阻塞出码。注意：hub 配置了自定义 stateDir 时这里读的
 * 是默认目录（~/.dsh-remote-agent），可能错过 —— 高级用户请显式写
 * pinnedHubFingerprint，向导只覆盖常见路径。
 */
function hubFingerprintForPairCode() {
  try {
    const id = readHubIdentity(path.join(os.homedir(), '.dsh-remote-agent', IDENTITY_FILE_NAME))
    return id?.fingerprint ?? ''
  } catch {
    return ''
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
  const profile = String(values.profile ?? '').trim() || 'desktop'
  const writeFile = patchFilePath(profile)
  if (role === 'hub') {
    const hubYaml = buildHubYaml({ token, roots })
    printYaml('hub 配置', hubYaml, values.out)
    // 给了 --hub-ip（可选 --port）就顺手生成配对码 —— 副机一行 pair 即可接入
    if (values['hub-ip']) {
      const port = /^\d+$/.test(String(values.port ?? '')) ? +values.port : 19387
      const hubUrl = buildHubUrl(values['hub-ip'], port)
      const pairCode = encodePairCode({ hubUrl, token, nodeId: String(values['node-id'] ?? ''), hubFingerprint: hubFingerprintForPairCode() })
      if (pairCode !== '') {
        say('')
        say('副机配对码（整行粘到副机配置的 pair: 字段，或用 --role worker --pair 生成配置）：')
        say(`    ${pairCode}`)
        say('    ⚠ 内含 token，等同凭证，勿贴公开渠道')
      }
    }
    if (values.write) {
      if (!applyWrite({ file: writeFile, blockYaml: hubYaml, force: values.force === true })) process.exit(2)
    }
    return
  }
  const nodeId = String(values['node-id'] ?? '')
  // --pair：配对码直接展开成 worker 配置（最省事的非交互路径）
  if (values.pair) {
    const dec = decodePairCode(values.pair)
    if (!dec.ok) {
      say(`配对码无效：${dec.error}`)
      process.exit(2)
    }
    const workerYaml = buildWorkerYaml({ pair: values.pair, nodeId, roots })
    printYaml('worker 配置（来自配对码）', workerYaml, values.out)
    if (values.write) {
      if (!applyWrite({ file: writeFile, blockYaml: workerYaml, force: values.force === true })) process.exit(2)
    }
    return
  }
  const hubUrl = buildHubUrl(values['hub-url'] ?? '', 19387)
  if (hubUrl === '') {
    say('--hub-url 必填，形如 192.168.1.10:19387 或完整 ws:// 地址（或改用 --pair 配对码）')
    process.exit(2)
  }
  const workerYaml = buildWorkerYaml({ hubUrl, token, nodeId, roots })
  printYaml('worker 配置', workerYaml, values.out)
  if (values.write) {
    if (!applyWrite({ file: writeFile, blockYaml: workerYaml, force: values.force === true })) process.exit(2)
  }
}

/* ══════════════════ 入口 ══════════════════ */

const { values, positionals } = parseCliArgs()
if (values.help) {
  say('dsh-remote-setup —— dsh-remote-agent 配置向导（交互式 / 非交互 / 体检）')
  say('  node bin/dsh-remote-setup.js                 交互式生成两台的配置')
  say('  node bin/dsh-remote-setup.js --doctor <配置.yml>     体检现有配置')
  say('  --role hub --hub-ip 192.168.1.10 --token nt_xxx --roots a,b   非交互生成主机配置（附配对码）')
  say('  --role worker --pair dshra1://... --roots a,b          非交互：用配对码生成副机配置')
  say('  --role worker --hub-url --token --node-id --roots a,b  非交互：手动生成副机配置')
  say('  写盘（免手粘，自动备份原配置）：交互式回车确认，或非交互加 --write')
  say('  --profile desktop   指定 dsh profile（默认 desktop）  --force  覆盖手写条目')
  process.exit(0)
}
if (values.doctor) await runDoctor(positionals)
else if (values.role) generateNonInteractive(values)
else await wizard()
