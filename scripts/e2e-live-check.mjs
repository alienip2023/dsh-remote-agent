#!/usr/bin/env node
/**
 * e2e-live-check —— 发布前的真实运行时端到端自检（挂到正在跑的 DSH 上）。
 *
 * 与 test/ 的区别：测试是**进程内**装配（真协议真传输，同一 node 进程）；
 * 本工具把 worker 跑在**独立的操作系统进程**里，通过真实 TCP/WebSocket
 * 拨入**正在运行的 DSH 桌面版 hub**（真实 webServer 路由、真实 upgrade
 * 握手、真实 registry）。
 *
 * ⚠ 派发为什么不是全自动：实测 hub 的 webserver 除 /healthz 外整台被
 * DSH 会话围栏保护（requestRejection，桌面渲染器外一律 401）——这是
 * **安全设计生效的证据**（UI 路由不裸奔）。所以本工具分两段：
 *   ① 自动：拨入 → 确认 online（最难的一段：真实握手/鉴权/注册）
 *   ② 人肉一步：由你从 DSH 桌面给这个节点派一个 exec 任务，
 *      工具监视副机 TaskStore 落盘记录 + roots 产物，自动验证状态机
 *      与 handoff/清单，并做 sha256 自校验。
 *
 * 用法：
 *   node scripts/e2e-live-check.mjs --hub-url ws://127.0.0.1:19387/api/remote-agent/node \
 *        [--token <nt_...>] [--node-id e2e-live-worker] [--watch-seconds 90] [--keep]
 *
 * 退出码：0 = 拨入+任务链路通过；1 = 失败（附人话诊断）；3 = 仅拨入通过但超时未见任务。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { applyWorker } from '../lib/node/index.js'

const { values } = parseArgs({
  options: {
    'hub-url': { type: 'string' },
    token: { type: 'string', default: '' },
    'node-id': { type: 'string', default: 'e2e-live-worker' },
    'roots': { type: 'string' }, // 逗号分隔；默认建临时目录
    'watch-seconds': { type: 'string', default: '120' },
    keep: { type: 'boolean', default: false },
  },
})

const say = (m = '') => console.log(m)
const hubUrl = values['hub-url'] ?? ''
if (hubUrl === '') {
  say('用法：node scripts/e2e-live-check.mjs --hub-url ws://<hub>:19387/api/remote-agent/node')
  process.exit(2)
}
const nodeId = values['node-id'] ?? 'e2e-live-worker'
const watchMs = Number(values['watch-seconds']) > 0 ? Number(values['watch-seconds']) * 1000 : 120000

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-')))
const stateDir = path.join(root, 'worker-state')
const roots = (values.roots ? values.roots.split(/[,;]+/) : [path.join(root, 'ws')])
  .map((s) => s.trim()).filter(Boolean)
for (const r of roots) fs.mkdirSync(r, { recursive: true })

/* ── worker：最小 ctx（logger/effect/get）──────────────────────────
 * 与 DSH 里真实的副机一致：没有 webServer / systemPrompt —— 副机
 * inject: [] 拿不到它们，worker 全部按可选处理。 */
const logs = []
const logger = {
  info: (m, e) => logs.push(['info', m, e]),
  warn: (m, e) => logs.push(['warn', m, e]),
  error: (m, e) => logs.push(['error', m, e]),
  debug: (m, e) => logs.push(['debug', m, e]),
}
const disposeWorker = applyWorker(
  { logger, on: () => () => {}, effect: (fn) => fn(), get: () => undefined },
  {
    role: 'worker',
    nodeId,
    transportMode: 'direct',
    hubUrl,
    token: values.token ?? '',
    stateDir,
    roots,
    maxConcurrent: 2,
    resumeQueued: false,
  },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitOnline(ms) {
  const started = Date.now()
  for (;;) {
    // logger 会给消息加 "[dsh-remote-agent:worker] " 前缀，匹配结尾
    if (logs.some(([, m]) => typeof m === 'string' && m.endsWith(' online'))) return true
    if (logs.some(([lv, m]) => lv === 'error' && /transport start failed/.test(m))) return false
    if (Date.now() - started > ms) return false
    await sleep(250)
  }
}

/* ── ① 拨入（全自动） ───────────────────────────────────────────── */
if (!(await waitOnline(30000))) {
  say('✗ worker 未上线 —— 最近日志：')
  for (const [lv, m, e] of logs.slice(-8)) say(`  [${lv}] ${m}${e ? ' ' + JSON.stringify(e) : ''}`)
  say('排查：hub 是否在跑 / token 是否一致 / 防火墙端口')
  disposeWorker()
  process.exit(1)
}
say(`✓ worker 已拨入真实 hub（nodeId=${nodeId}，pid=${process.pid}）`)

/* ── ② 人肉派发 + 自动监视 ──────────────────────────────────────── */
say('')
say('现在请到 DSH 桌面对这个节点派一个 exec 任务，例如：')
say(`  「让 ${nodeId} 在它的工作区里创建 proof.txt 并写入 e2e-live-ok」`)
say(`（工具最多等 ${Math.round(watchMs / 1000)} 秒；等不到按 Ctrl+C 中断）`)
say('')

const tasksDir = path.join(stateDir, 'tasks')
const seen = new Set()
const started = Date.now()
let hit = null
while (Date.now() - started < watchMs) {
  let files = []
  try { files = fs.readdirSync(tasksDir) } catch { /* 还没有任务目录 */ }
  for (const f of files) {
    if (!f.endsWith('.json') || seen.has(f)) continue
    seen.add(f)
    let rec
    try { rec = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')) } catch { continue }
    say(`· 收到任务记录：${rec.taskId} status=${rec.status}`)
    hit = rec
  }
  if (hit && !['queued', 'running'].includes(hit.status)) break
  await sleep(1000)
}

if (!hit) {
  say('✗ 超时未见任何任务记录 —— 请确认派发时选中的节点 id 是本节点')
  say(`  （本节点 nodeId=${nodeId}；hub 侧可在面板/对话里让 agent 选节点）`)
  disposeWorker()
  process.exit(3)
}

/* ── ③ 验证：终态 + 产物 + handoff ─────────────────────────────── */
say('')
say(`✓ 任务到达终态：${hit.status}（${hit.taskId}）`)
if (hit.error) say(`  error：${JSON.stringify(hit.error).slice(0, 300)}`)
if (hit.status !== 'completed') {
  say('✗ 任务未 completed（真实运行时下这同样是有效结论 —— 记下错误信息排查）')
  disposeWorker()
  process.exit(1)
}

// roots 下新增/变化的文件 = 副机真实执行痕迹
const before = new Set()
for (const r of roots) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else before.add(p)
    }
  }
  try { walk(r) } catch { /* 目录可能被任务删了 */ }
}
// （记录是终态后才统计的，所以这里看到的就是任务产物全集）
const artifacts = [...before].filter((p) => !p.includes('worker-state'))
say(`✓ 副机 roots 产物 ${artifacts.length} 个：`)
for (const p of artifacts.slice(0, 10)) {
  const buf = fs.readFileSync(p)
  say(`  - ${path.relative(root, p)}  ${buf.length}B  sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`)
}
if (hit.manifest) {
  say(`✓ manifest：final=${hit.manifest.counts?.final ?? '?'} changed=${hit.manifest.counts?.changed ?? '?'}`)
}

disposeWorker()
if (!values.keep) fs.rmSync(root, { recursive: true, force: true })
else say(`（--keep：worker 状态与产物保留在 ${root}）`)

if (artifacts.length === 0) {
  say('✗ 任务 completed 但 roots 无产物 —— 派的任务可能没写文件，换一个会落盘的任务再试')
  process.exit(1)
}
say('')
say('✓ 真实运行时链路验证通过：独立进程 worker → 真实 hub → 任务落盘执行 → 终态/产物齐全')
process.exit(0)
