/**
 * 中优先级修复的回归锁（2026-10-15 独立评审）。
 *
 * 四组，都是"看起来对但实际有洞"的形态：
 *   1. relay token 走 URL query → 进各级日志（改成 header）
 *   2. runner 的临时诊断无限增长 + 泄漏 → 改 opt-in + 有上限
 *   3. pull-manager 忽略 writeSync 返回值 → 部分写靠 hash 兜底，白传一整份
 *   4. relay 死连接：HELLO 无守卫 + 无空闲淘汰 → 永久占配额
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 剥注释（同 bounded-resources.test.js：本项目注释里常引用被讨论的代码）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ─────────────── 1. relay token 不得进 URL query ─────────────── */

test('transport.js：relay 模式不得把 token 放进 URL query', () => {
  const t = read('lib/node/transport.js')
  const code = stripComments(t)
  // 定位 resolveUrl 里的 relay 分支
  const i = code.indexOf('if (this.mode === TRANSPORT_MODE.RELAY) {')
  assert.ok(i >= 0, '应存在 relay 分支')
  const branch = code.slice(i, i + 900)
  assert.ok(
    !/searchParams\.set\(['"]token['"]/.test(branch),
    'token 绝不能进 URL query —— URL 会进中继 access log、反代日志、CDN 日志',
  )
  // 并且真的改用了 header
  assert.match(code, /x-relay-token/, 'relay 模式应用 x-relay-token header')
})

test('transport.js：两种模式的 token header 名要分开（两端是不同组件）', () => {
  const code = stripComments(read('lib/node/transport.js'))
  assert.match(code, /headers\['x-dsh-token'\]/, 'direct 用 x-dsh-token（主机 DSH）')
  assert.match(code, /headers\['x-relay-token'\]/, 'relay 用 x-relay-token（中继服务）')
})

test('node-registry.js：hub 连中继时 token 也不进 URL', () => {
  const code = stripComments(read('lib/hub/node-registry.js'))
  // RelayLink 里的 URL 构造
  const i = code.indexOf("target.searchParams.set('role', 'hub')")
  assert.ok(i >= 0, '应存在 hub 的 relay URL 构造')
  const seg = code.slice(i, i + 500)
  assert.ok(
    !/searchParams\.set\(['"]token['"]/.test(seg),
    'hub 侧同样不能把 token 放进 URL',
  )
  assert.match(seg, /x-relay-token/, 'hub 侧应用 x-relay-token header')
})

test('relay.js：服务端必须仍接受 header（向后兼容 + 生效前提）', () => {
  const code = read('lib/relay.js')
  const n = (code.match(/req\.headers\['x-relay-token'\]/g) || []).length
  assert.ok(n >= 3, `relay 的三处鉴权都应认 x-relay-token，实际 ${n} 处`)
})

/* ─────────────── 2. 诊断日志必须 opt-in 且有上限 ─────────────── */

test('runner.js：临时诊断默认关闭（环境变量控制）', () => {
  const code = stripComments(read('lib/node/runner.js'))
  assert.match(code, /DSH_REMOTE_AGENT_TRACE/, '应由环境变量控制')
  // dlog 开门必须能直接返回
  assert.match(
    code,
    /const dlog = \(msg, extra\) => \{\s*\n\s*if \(!TRACE_ON\) return/,
    'dlog 在未开启时必须立刻返回，不能写文件',
  )
})

test('runner.js：诊断文件必须有大小上限（轮转）', () => {
  const code = stripComments(read('lib/node/runner.js'))
  assert.match(code, /MAX_TRACE_BYTES/, '应定义上限常量')
  assert.match(code, /statSync\(traceFile\)/, '写入前应检查文件大小')
  assert.match(code, /writeFileSync\(traceFile/, '超限时应轮转（截断重写）')
})

test('runner.js：agent/error 的上报不能被诊断开关关掉', () => {
  const src = read('lib/node/runner.js')
  // liveText.push 与 onEvent 必须在 dlog 之外无条件执行 ——
  // 它们把错误带给 hub（handoff 摘要），是功能而非诊断。
  const i = src.indexOf("this.ctx.on('agent/error'")
  assert.ok(i >= 0, '应存在 agent/error 监听')
  const block = src.slice(i, i + 1200)
  assert.match(block, /liveText\.push\(/, '错误必须进 liveText（否则 handoff 摘要看不到）')
  assert.match(block, /onEvent\(\{ kind: 'error'/, '错误必须上报给 hub')
  // 这两行不应被 TRACE_ON 包住
  const beforePush = block.slice(0, block.indexOf('liveText.push('))
  assert.ok(
    !/if \(!TRACE_ON\) return/.test(beforePush.replace(/dlog\([\s\S]*?\n\s*\}/, '')),
    'liveText.push 之前不应有条件返回挡住它',
  )
})

/* ─────────────── 3. pull-manager 必须检查 writeSync 返回值 ─────────────── */

test('pull-manager.js：writeSync 必须检查部分写', () => {
  const code = stripComments(read('lib/hub/pull-manager.js'))
  const i = code.indexOf('fs.writeSync(s.fd, payload')
  assert.ok(i >= 0, '应存在写产物分块的调用')
  const seg = code.slice(Math.max(0, i - 400), i + 600)
  assert.match(seg, /const n = fs\.writeSync\(/, '应接收 writeSync 的返回值')
  assert.match(seg, /n <= 0|!Number\.isFinite\(n\)/, '必须判断返回值异常')
  assert.match(seg, /while \(written < payload\.length\)/, '应循环直到写完')
})

/* ─────────────── 4. relay 死连接治理 ─────────────── */

const relayCode = read('lib/relay.js')

test('relay.js：同一连接不得二次 HELLO（否则产生幽灵条目）', () => {
  const code = stripComments(relayCode)
  const i = code.indexOf('if (frame.t === RELAY_FRAME.HELLO_NODE) {')
  assert.ok(i >= 0, '应存在 HELLO_NODE 分支')
  const branch = code.slice(i, i + 700)
  assert.match(branch, /if \(boundId !== ''\)/, '必须有"已 hello 过"的守卫')
  assert.match(branch, /already-helloed/, '应明确拒绝并给出可诊断的 code')
})

test('relay.js：必须有空闲淘汰（否则 NAT 静默死亡的连接永久占配额）', () => {
  assert.match(relayCode, /function sweepIdleConnections/, '应定义空闲淘汰')
  assert.match(relayCode, /idleMs = 3 \* 60 \* 1000/, '阈值应是有限的正数')
  // 必须用 ping 探测，不能只按"多久没帧"直接断（会误杀空闲健康节点）
  assert.match(relayCode, /rec\.conn\.ping\(\)/, '应发 WebSocket ping 探测')
  assert.match(relayCode, /conn\.on\('pong'/, '应监听 pong 作为活着证据')
  // 扫描定时器必须 unref（否则吊住事件循环）
  assert.match(relayCode, /sweepTimer\.unref\(\)/, '定时器必须 unref')
  // close 里要清掉
  assert.match(relayCode, /clearInterval\(sweepTimer\)/, 'close 时应清定时器')
})

test('relay.js：收到帧时必须清掉 ping 标记（否则健康节点被误杀）', () => {
  const code = stripComments(relayCode)
  const n = (code.match(/rec\.pingSentAt = undefined/g) || []).length
  assert.ok(n >= 2, `每处 lastSeen 更新都应一并清 pingSentAt，实际 ${n} 处`)
})

test('relay.js：淘汰必须可观测（广播 offline + 记日志）', () => {
  const i = relayCode.indexOf('function sweepIdleConnections')
  const body = relayCode.slice(i, i + 3000)
  assert.match(body, /NODE_OFFLINE/, '淘汰节点应广播 NODE_OFFLINE')
  assert.match(body, /idle-timeout/, '原因应可诊断')
  assert.match(body, /log\('warn'/, '应记日志')
})

/* ─────────────── 5. task-store prune 必须被调用 ─────────────── */

test('task-store 的 prune 必须有调用方（否则终态记录无限累积）', () => {
  const idx = read('lib/node/index.js')
  assert.match(idx, /store\.prune\(\)/, 'prune 必须在某处被调用')
  // 且调用要容错（清理失败不能挡启动）
  const i = idx.indexOf('store.prune()')
  const around = idx.slice(Math.max(0, i - 500), i + 300)
  assert.match(around, /try\s*\{/, 'prune 调用应包在 try 里')
  assert.match(around, /catch/, '应有 catch 兜底')
})

/* ─── 6. agent 的模型选择必须显式带上 ─── */

test('runner.js：createAgent 必须带上默认模型选择', () => {
  const code = stripComments(read('lib/node/runner.js'))
  // 必须从 agentDefaultModel 取选择
  assert.match(code, /ctx\.get\(['"]agentDefaultModel['"]\)/, '应从 agentDefaultModel 取默认模型')
  assert.match(code, /currentSelection\(\)/, '应调用 currentSelection()')
  // 不能写死 agentOptions: undefined（那会让 {{model}} 无值 → turn 1 抛错）
  assert.ok(
    !/agentOptions:\s*undefined,/.test(code),
    'agentOptions 不能写死 undefined —— personafix 段的 {{model}} 会没有值',
  )
  // 要真的传进去
  assert.match(code, /agentOptions,/, '应把取到的 agentOptions 传给 createAgent')
})

test('runner.js：agentOptions 的 provider/model 必须成对', () => {
  const code = stripComments(read('lib/node/runner.js'))
  // 只给 provider 不给 model（或反之）是无效选择 —— 应整体放弃
  assert.match(code, /o\.provider\s*&&\s*o\.model\s*\?\s*o\s*:\s*undefined/, 'provider 与 model 必须成对校验')
})

test('runner.js：agentDefaultModel 缺失不能让 available 变 false', () => {
  const code = stripComments(read('lib/node/runner.js'))
  const i = code.indexOf('get available()')
  assert.ok(i >= 0, '应存在 available getter')
  const body = code.slice(i, i + 500)
  // agentDefaultModel 是可选增益：缺了只是不传 agentOptions，
  // 不该让整个 in-process 后端不可用（那会静默回退 headless，掩盖问题）
  assert.ok(
    !/agentDefaultModel/.test(body),
    'available 不应依赖 agentDefaultModel —— 它缺了只是不传模型，不是不可用',
  )
})
