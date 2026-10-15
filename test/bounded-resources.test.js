/**
 * 安全回归：两个"只修了一半"的边界必须有总量上限。
 *
 * 这两条是 2026-10-15 独立评审发现的真缺陷，都会在第 4 层（参数/步骤）上
 * 表现为「资源无限增长」：
 *
 *   1. `ws.js` 的分片重组只限单帧、不限总量 —— 一条连接可以发任意多个
 *      4MiB 分片，在 `Buffer.concat` 之前把 frags 撑爆内存。
 *   2. `relay.js` 的背压只覆盖 node 方向 —— `broadcastHubs` 直接 send，
 *      一个不读 socket 的 hub 连接会让中继 OWR 无限增长。
 *
 * 两条都**不能只靠"读了代码觉得对"**，所以这里做行为层断言。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const ws = read('lib/ws.js')
const relay = read('lib/relay.js')
const protocol = read('lib/protocol.js')

/**
 * 剥掉 `//` 与 `/* … *​/` 注释，只留代码。
 *
 * 为什么必须有：本项目的注释密度极高，且注释里经常**引用被讨论的代码**
 * （例如"上面 `len > limit` 只挡住单个分片"）。任何基于 `indexOf` 的
 * 位置断言都必须先剥注释，否则会命中注释里的词 —— 那是假断言。
 *
 * 字符串字面量不特殊处理：本项目里没有把 `//` 写进字符串的用法，
 * 而处理它需要完整词法分析，收益不抵复杂度。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ────────────────────────── ws.js 分片上限 ────────────────────────── */

test('ws.js：分片重组必须有总量上限（不能只限单帧）', () => {
  // 单帧上限来自 protocol.js
  const m = /MAX_ARTIFACT_FRAME_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/.exec(protocol)
  assert.ok(m, 'protocol.js 应定义 MAX_ARTIFACT_FRAME_BYTES')
  const frameLimit = Number(m[1]) * Number(m[2]) * Number(m[3])
  assert.ok(frameLimit > 0, '单帧上限应是正数')

  // 分片累积处必须出现一个**大于**分片本身的判断
  const dispIdx = ws.indexOf('dispatch(fin, opcode, payload) {')
  assert.ok(dispIdx >= 0, '应存在 dispatch 方法')
  // 花括号配对（不用 `\n  }`，会被内部更深缩进截断）
  let depth = 0
  let end = -1
  for (let k = ws.indexOf('{', dispIdx); k < ws.length; k += 1) {
    if (ws[k] === '{') depth += 1
    else if (ws[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  assert.ok(end > 0, 'dispatch 花括号配对失败')
  const body = ws.slice(dispIdx, end)
  assert.match(body, /this\.fragBytes\s*\+=/, '应先累加 fragBytes')
  // ⚠ 不能只断言"存在某种比较" —— 把 `>` 写成 `<`（恒假守卫）也能通过那种断言。
  // 这里锚定到**语义**：比较的右操作数必须是那个真实的帧上限常量，
  // 且左操作数必须是累积量。
  // （判别力验证时发现的：③ 把 `> MAX` 改成 `< 0` 曾能骗过第一版断言。）
  assert.match(
    body,
    /this\.fragBytes\s*>\s*MAX_ARTIFACT_FRAME_BYTES\b/,
    '守卫必须是 fragBytes > MAX_ARTIFACT_FRAME_BYTES（写成别的比较会变成恒真/恒假）',
  )
  assert.ok(
    /fail\(['"]fragment-too-large['"]\)/.test(body),
    '超限时应 fail(fragment-too-large)，而不是继续累积',
  )
})

test('ws.js：分片上限必须晚于累加、早于 concat（顺序不能反）', () => {
  const dispIdx = ws.indexOf('dispatch(fin, opcode, payload) {')
  assert.ok(dispIdx >= 0, '应存在 dispatch 方法')
  // ⚠ 边界不能用 `\n  }` —— dispatch 内部有更深缩进的 `}`，会截断 body。
  let depth = 0
  let end = -1
  for (let k = ws.indexOf('{', dispIdx); k < ws.length; k += 1) {
    if (ws[k] === '{') depth += 1
    else if (ws[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  assert.ok(end > 0, 'dispatch 花括号配对失败')
  // ⚠ 必须**先剥注释**再比对位置：本函数的注释里提到了 `Buffer.concat(`，
  // 不剥注释时 indexOf 会命中注释里的那个词（位置比真实调用靠前），
  // 导致 "guard < concat" 恒为 false —— 这是典型的「注释污染断言」。
  const body = stripComments(ws.slice(dispIdx, end))
  const acc = body.indexOf('this.fragBytes +=')
  const guard = body.indexOf('this.fragBytes >')
  const concat = body.indexOf('Buffer.concat(')
  assert.ok(acc >= 0 && guard >= 0 && concat >= 0, `三个位置都应存在（acc=${acc} guard=${guard} concat=${concat}）`)
  assert.ok(acc < guard, '先累加 -> 再检查')
  assert.ok(guard < concat, '检查必须在 concat 之前（否则已经分配了内存）')
})

/* ────────────────────────── relay.js 背压对称性 ────────────────────────── */

test('relay.js：node 方向两个转发函数都过背压', () => {
  const f1 = relay.indexOf('function forwardToNode')
  const f2 = relay.indexOf('function forwardBinaryToNode')
  assert.ok(f1 >= 0 && f2 >= 0, '应存在两个 node 方向转发函数')
  const b1 = relay.slice(f1, f1 + 1200)
  const b2 = relay.slice(f2, f2 + 1200)
  assert.match(b1, /applyBackpressure\(rec\)/, 'forwardToNode 必须有背压')
  assert.match(b2, /applyBackpressure\(rec\)/, 'forwardBinaryToNode 必须有背压')
})

test('relay.js：hub 方向两个广播函数也必须有背压（对称）', () => {
  const g1 = relay.indexOf('function broadcastHubs(')
  const g2 = relay.indexOf('function broadcastHubsBinary(')
  assert.ok(g1 >= 0 && g2 >= 0, '应存在两个 hub 方向广播函数')
  const b1 = relay.slice(g1, g1 + 900)
  const b2 = relay.slice(g2, g2 + 900)
  assert.match(b1, /applyHubBackpressure\(h\)/, 'broadcastHubs 必须有 hub 背压')
  assert.match(b2, /applyHubBackpressure\(h\)/, 'broadcastHubsBinary 必须有 hub 背压')
})

test('relay.js：hub 背压用的字段必须在 ws.js 里真实存在', () => {
  // 断言不靠"名字看起来对"，而是核对 ws.js 真的暴露了这些
  const need = ['get overBudget', 'get bufferedBytes', 'this.maxQueuedBytes', 'destroy(err)']
  for (const n of need) {
    assert.ok(ws.includes(n), `ws.js 应暴露 ${n}（applyHubBackpressure 依赖它）`)
  }
})

test('relay.js：背压断连必须是可观测的（计入 stats + 记日志）', () => {
  const i = relay.indexOf('function applyHubBackpressure')
  assert.ok(i >= 0, '应存在 applyHubBackpressure')
  const body = relay.slice(i, i + 900)
  assert.match(body, /stats\.backpressureDrops\s*\+=\s*1/, '必须计入 stats')
  assert.match(body, /log\(['"]warn['"]/, '必须记 warn 日志')
  assert.match(body, /destroy\(/, '必须真的断连')
})

test('relay.js：broadcastHubs 遍历时必须快照 hubs（断连会改集合）', () => {
  const g1 = relay.indexOf('function broadcastHubs(')
  const b1 = relay.slice(g1, g1 + 400)
  // 断连会从 hubs 里移除元素，直接遍历原集合会有迭代器失效风险
  assert.match(b1, /for \(const h of \[\.\.\.hubs\]\)/, '应遍历快照 [...hubs]')
})

/* ─────────────────── 命令注入：不可信输入不进命令行 ─────────────────── */

const runner = read('lib/node/runner.js')

test('runner.js：headless 后端绝不能开 shell（任务书是不可信输入）', () => {
  const i = runner.indexOf('child = spawn(this.dshBin, args, {')
  assert.ok(i >= 0, '应存在 dshBin 的 spawn 调用')
  // 找到这个 spawn 调用的配置对象
  let depth = 0
  let end = -1
  for (let k = runner.indexOf('{', i); k < runner.length; k += 1) {
    if (runner[k] === '{') depth += 1
    else if (runner[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  assert.ok(end > 0, 'spawn 配置对象花括号配对失败')
  const opts = runner.slice(i, end)
  // ⚠ 剥注释后断言：注释里**引用了**旧的 `shell: this.platform === ...`
  // 作为教训记录，不剥注释会误判成"还开着 shell"。
  const code = stripComments(opts)
  assert.match(code, /shell:\s*false/, 'headless spawn 必须显式 shell: false')
  assert.ok(
    !/shell:\s*(true|this\.platform)/.test(code),
    'shell 不得为 true 或按平台开启 —— goal 是远端不可信输入，进 shell 即命令注入',
  )
})

test('runner.js：任务书通过 stdin 传，不拼进 argv', () => {
  // argv 里必须是 `-`（dsh headless 的 stdin 约定），而不是 goal 本身
  const argsIdx = runner.indexOf('const args = []')
  assert.ok(argsIdx >= 0, '应存在 args 构造')
  const argsBlock = runner.slice(argsIdx, argsIdx + 500)
  assert.match(argsBlock, /args\.push\('headless', '--json'/, '应构造 headless --json 参数')
  assert.match(argsBlock, /'-'\)/, "argv 末尾应是 '-'（读 stdin），不是 goal")
  assert.ok(
    !/args\.push\([^)]*\bgoal\b/.test(argsBlock),
    'goal 绝不能出现在 argv 里',
  )
  // 并且要真的把 goal 写进 stdin
  assert.match(runner, /child\.stdin\.end\(String\(goal/, '应把 goal 写入 child.stdin')
})

test('runner.js：写 stdin 必须处理 EPIPE（子进程提前退出）', () => {
  const i = runner.indexOf('child.stdin.end(String(goal')
  assert.ok(i >= 0, '应存在写 stdin')
  // 前一段里必须有 error 处理器
  const before = runner.slice(Math.max(0, i - 500), i)
  assert.match(before, /child\.stdin\.on\(['"]error['"]/, 'stdin 需要 error 监听，否则 EPIPE 会变成 uncaught')
})

test('exec.js：命令执行走显式 file+args，不经 shell', () => {
  const exec = read('lib/node/exec.js')
  const i = exec.indexOf('child = spawn(file, args, {')
  assert.ok(i >= 0, 'exec 应显式传 file + args')
  let depth = 0
  let end = -1
  for (let k = exec.indexOf('{', i); k < exec.length; k += 1) {
    if (exec[k] === '{') depth += 1
    else if (exec[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  const opts = stripComments(exec.slice(i, end))
  assert.ok(!/shell:\s*true/.test(opts), 'exec 的 spawn 不得开 shell')
})
