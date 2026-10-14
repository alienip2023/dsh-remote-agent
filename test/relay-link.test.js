/**
 * RelayLink 行为测试（hub 侧中继链路，lib/hub/node-registry.js 的 class）。
 *
 * ── 为什么单独测它 ────────────────────────────────────────────────
 * `relay-e2e.test.js` 测的是**中继服务端**（lib/relay.js）：token、路由、副本、
 * 错误帧。而 `RelayLink` 是**hub 侧的客户端**：它拨入中继、断线重连、拉节点目录、
 * 收发帧。这条链路此前**零测试**，却是 relay 模式下 hub 与副机通信的必经之路。
 *
 * 本文件刻意用**真中继**（`createRelay` 起在随机端口）而不是 mock：这一层要验的
 * 正是它与中继的真实交互 —— 尤其是「中继立即推送的帧会不会丢」这种只有真 socket
 * 才能暴露的行为（见第二节）。
 *
 * ── 两条测试约定（沿用 relay-e2e）────────────────────────────────
 * 1. 断连类断言只看**状态**（ready / 注册表大小 / 能否上行），不断言日志行数或
 *    close 回调次数 —— 冻结层 close 修复与上层兜底并存时回调会触发多次，属预期。
 * 2. relay 侧注册表里存的是**服务端 conn 对象**，客户端的 conn 永远不等于它；
 *    所以要用注册表记录本身（`hubs.size` / `nodes`）来判断，不要比较 conn 引用。
 *
 * ── 两个踩过的坑（改本文件前必读）────────────────────────────────
 * 坑 1：`relay.close()` 返回 **Promise，不接受 callback**。写成 `relay.close(cb)`
 *   会让 Promise 永远 pending → `t.after` 挂死 → 整个套件超时且无输出。必须 `await`。
 * 坑 2：停中继前必须**先硬销毁底层 socket**。upgrade 过的 socket 是
 *   `allowHalfOpen=true`，只发 close 帧而对端不回时服务端 socket 不进入 'close'，
 *   `server.close(cb)` 的回调永不触发 → 挂死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  RELAY_FRAME,
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
} from '../lib/protocol.js'
import { createRelay, newRelayToken } from '../lib/relay.js'
import { RelayLink } from '../lib/hub/node-registry.js'
import { acceptUpgrade, connect } from '../lib/ws.js'

const HUB_TOKEN = newRelayToken('rt')
const ENROLL_TOKEN = newRelayToken('en')

/* ─────────────────────────── 工具 ─────────────────────────── */

/** 起一个随机端口的中继。调用方负责 `closeRelay`。 */
function startRelay(port = 0) {
  const relay = createRelay({
    port,
    host: '127.0.0.1',
    hubToken: HUB_TOKEN,
    enrollToken: ENROLL_TOKEN,
  })
  return new Promise((resolve) => {
    relay.listen(() => resolve({ relay, port: relay.address().port, base: `ws://127.0.0.1:${relay.address().port}/relay` }))
  })
}

/** 关中继：先硬销毁 socket（坑 2），再 await close()（坑 1）。 */
async function closeRelay(srv) {
  for (const n of [...srv.relay.nodes.values()]) {
    try { n.conn.socket?.destroy?.() } catch { /* 已断 */ }
  }
  for (const h of [...srv.relay.hubs]) {
    try { h.socket?.destroy?.() } catch { /* 已断 */ }
  }
  await srv.relay.close()
}

/** 取一个当前空闲的端口（监听后立刻释放）。 */
async function freePort() {
  const srv = http.createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

/** 建一个 RelayLink，收集日志与收到的帧。 */
function makeLink(url, opts = {}) {
  const logs = []
  const frames = []
  const binaries = []
  const link = new RelayLink({
    url,
    token: HUB_TOKEN,
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    onFrame: (f) => frames.push(f),
    onBinary: (h, p) => binaries.push({ header: h, payload: Buffer.from(p) }),
    reconnectMs: 5000,
    ...opts,
  })
  return { link, logs, frames, binaries }
}

async function waitFor(fn, { timeoutMs = 8000, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 连一条裸 WS 连接并收集文本帧 / 二进制帧。 */
async function rawConn(url, name) {
  const conn = await connect(url, { name })
  conn.on('error', () => {}) // 不挂监听器会在清理阶段冒 ECONNRESET
  const frames = []
  const binaries = []
  conn.on('message', (payload, isBinary) => {
    if (isBinary) {
      binaries.push(Buffer.from(payload))
      return
    }
    try {
      frames.push(JSON.parse(payload.toString('utf8')))
    } catch { /* 非 JSON 帧忽略 */ }
  })
  return { conn, frames, binaries }
}

/** 以 node 角色接入中继并完成 hello/node 握手。 */
async function openNode(base, nodeId, extra = {}) {
  const r = await rawConn(
    `${base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}&nodeId=${encodeURIComponent(nodeId)}`,
    `test-node:${nodeId}`,
  )
  r.conn.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, {
    nodeId,
    protocol: 1,
    os: 'windows',
    arch: 'x64',
    hostname: nodeId,
    shells: ['powershell'],
    roots: ['D:\\work'],
    caps: ['fs', 'exec', 'artifact', 'agent'],
    profile: 'worker',
    agentMode: true,
    time: Date.now(),
    ...extra,
  })))
  return r
}

/**
 * 手工做一次 WebSocket upgrade，把 101 响应之后**同段到达的原始字节**（head）取出来。
 * 用于证明「中继在 acceptUpgrade 后立刻推送的帧和 101 挤在同一个 TCP 段里」。
 */
function rawUpgrade(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const key = randomBytes(16).toString('base64')
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    })
    req.on('upgrade', (res, socket, head) => resolve({ socket, head }))
    req.on('error', reject)
    req.end()
  })
}

/** 解析服务端→客户端的未掩码 WS 帧（只够本文件用）。 */
function parseServerFrames(buf) {
  const out = []
  let b = Buffer.from(buf)
  while (b.length >= 2) {
    const opcode = b[0] & 0x0f
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) break
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) break
      len = Number(b.readBigUInt64BE(2))
      off = 10
    }
    if (b.length < off + len) break
    out.push({ opcode, payload: b.subarray(off, off + len) })
    b = b.subarray(off + len)
  }
  return out
}

/**
 * 最小假中继：只做 upgrade 接管 + 原始字节注入。
 *
 * 用途见「面对不可信中继的畸形帧」用例 —— 真中继会先过滤畸形帧，所以只有绕开它
 * 才能打到 RelayLink 自己的解码防御分支。它**不**发 hello/hub，也**不**做任何校验，
 * 因此适合扮演「被攻陷 / 版本不匹配 / 被替换」的中继。
 */
function startFakeRelay() {
  let hubConn
  const server = http.createServer((req, res) => {
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head, { name: 'fake-relay-hub' })
    if (!conn) return
    conn.on('error', () => {})
    hubConn = conn
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        base: `ws://127.0.0.1:${port}/relay`,
        get hubConn() { return hubConn },
        pushText: (text) => hubConn.send(text),
        pushBinary: (buf) => hubConn.sendBinary(buf),
        close: async () => {
          try { hubConn?.socket?.destroy?.() } catch { /* 已断 */ }
          await new Promise((r) => server.close(r))
        },
      })
    })
  })
}

/**
 * 捕获 `schedule()` 实际排定的 delay，**不真的定时**。
 *
 * 为什么替换全局 setTimeout：`schedule()` 直接调全局，没有注入点；而 node:test
 * 在单个文件内是顺序执行的，替换窗口内没有其他测试并发跑。try/finally 保证还原。
 */
function captureScheduledDelays(link, count) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const delays = []
  globalThis.setTimeout = (fn, delay) => {
    delays.push(delay)
    return { unref() { return this }, ref() { return this }, hasRef() { return false } }
  }
  globalThis.clearTimeout = () => {}
  try {
    for (let i = 0; i < count; i += 1) {
      link.timer = undefined // 让 schedule() 认为当前没有 timer
      link.schedule()
    }
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    link.timer = undefined
  }
  return delays
}

/** 退避公式（与实现契约一致，用于独立计算期望值）。 */
const expectedBase = (reconnectMs, attempt) =>
  Math.min(reconnectMs * 2 ** Math.min(attempt, 4), 60_000)

/* ═══════════════════════ 一、连接与握手 ═══════════════════════ */

test('RelayLink：start 后连上中继 —— ready=true、attempt=0、中继注册该 hub', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link, logs } = makeLink(srv.base)
  t.after(() => link.stop())

  assert.equal(link.ready, false, '未连接时 ready=false')
  assert.equal(link.stopped, true, '构造后默认 stopped=true（未启动）')
  assert.equal(link.conn, undefined, '构造后无连接')

  link.start()
  assert.equal(link.stopped, false, 'start 后 stopped=false')

  await waitFor(() => link.ready, { label: 'link ready' })
  assert.equal(link.ready, true, 'ready 必须翻真')
  assert.equal(link.conn?.closed, false, '持有的连接是活的')
  assert.equal(link.attempt, 0, '首次连接成功 attempt 应为 0')

  await waitFor(() => srv.relay.hubs.size === 1, { label: 'relay registered hub' })
  assert.equal(srv.relay.hubs.size, 1)

  const attached = logs.find((l) => l.msg === 'hub attached to relay')
  assert.ok(attached, '应有 "hub attached to relay" 日志')
  assert.equal(JSON.stringify(attached.extra).includes(HUB_TOKEN), false, '日志 extra 不得含 token')
})

test('RelayLink：未 ready 时 send / sendBinary / requestNodeList 返回 false 且不抛', async (t) => {
  const { link } = makeLink('ws://127.0.0.1:1/relay')
  t.after(() => link.stop())

  assert.equal(link.ready, false)
  assert.doesNotThrow(() => {
    assert.equal(link.send('n1', 'x'), false, 'send → false')
    assert.equal(link.sendBinary('n1', Buffer.from([1, 2, 3])), false, 'sendBinary → false')
    assert.equal(link.requestNodeList(), false, 'requestNodeList → false')
  })

  link.stop()
  assert.doesNotThrow(() => {
    assert.equal(link.send('n1', 'x'), false)
    assert.equal(link.sendBinary('n1', Buffer.from([1])), false)
    assert.equal(link.requestNodeList(), false)
  })
})

test('RelayLink：ready 时 requestNodeList 返回 true 且幂等', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link, frames } = makeLink(srv.base)
  t.after(() => link.stop())
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  assert.equal(link.requestNodeList(), true, 'ready 时 → true')
  assert.equal(link.requestNodeList(), true, '幂等：再次调用仍 true')

  // 中继对每次 node/list 都回一份目录
  await waitFor(() => frames.filter((f) => f.t === RELAY_FRAME.NODE_LIST).length >= 2, {
    label: 'two node/list replies',
  })
})

/* ═══════════ 二、节点目录对齐：hello/hub 会丢，必须显式请求 ═══════════ */

/**
 * 「中继立即推送」场景 —— 这一节验的是 RelayLink 注释里写的那条理由，不是推测。
 *
 * 中继在 `acceptUpgrade()` 之后**立刻** `sendJson(conn, HELLO_HUB, ...)`。此时 101
 * 响应刚写进 socket，两段字节几乎必然合并在同一个 TCP 段里到达客户端 —— Node 的
 * http 客户端把 101 头之后的字节放进 `head`，而 `head` 只在 `connect()` **resolve
 * 之前**被 `conn.parser.push(head)` 消费掉。RelayLink 是在 `await connect(...)` 之后
 * 才挂 `conn.on('message')` 的，所以这一帧必然丢。
 */
test('RelayLink：中继立即推送的 hello/hub 与 101 同段到达（head 里带帧）', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const url = `${srv.base}?role=hub&token=${encodeURIComponent(HUB_TOKEN)}`
  let headWithFrame = 0
  let sample
  const ROUNDS = 8
  for (let i = 0; i < ROUNDS; i += 1) {
    const { socket, head } = await rawUpgrade(url)
    const parsed = parseServerFrames(head)
    if (parsed.length > 0) {
      headWithFrame += 1
      if (!sample) sample = JSON.parse(parsed[0].payload.toString('utf8'))
    }
    socket.destroy()
  }

  assert.equal(headWithFrame, ROUNDS, `${ROUNDS} 次 upgrade 都应把 hello/hub 塞进 head（实际 ${headWithFrame}）`)
  assert.equal(sample.t, RELAY_FRAME.HELLO_HUB, 'head 里那一帧就是 hello/hub')
  assert.ok(Array.isArray(sample.d.nodes), 'hello/hub 带 nodes 目录')
})

test('RelayLink：真实链路里 hello/hub 收不到，但显式 node/list 每次都到', async (t) => {
  const ROUNDS = 8
  let helloSeen = 0
  let listSeen = 0

  for (let i = 0; i < ROUNDS; i += 1) {
    const srv = await startRelay()
    const { link, frames } = makeLink(srv.base)
    link.start()
    await waitFor(() => link.ready, { label: 'ready' })
    await waitFor(() => frames.some((f) => f.t === RELAY_FRAME.NODE_LIST), {
      label: 'node/list arrived',
      timeoutMs: 3000,
    })
    await sleep(60)
    if (frames.some((f) => f.t === RELAY_FRAME.HELLO_HUB)) helloSeen += 1
    if (frames.some((f) => f.t === RELAY_FRAME.NODE_LIST)) listSeen += 1
    link.stop()
    await closeRelay(srv)
  }

  assert.equal(listSeen, ROUNDS, `显式请求的 node/list 必须每次都到（实际 ${listSeen}/${ROUNDS}）`)
  // 上一条断言解释了原因：hello/hub 挤在 101 的同一个 TCP 段里，而 RelayLink 的
  // message 监听器要等 connect() resolve 之后才挂得上 —— 必然丢。
  assert.equal(helloSeen, 0, `hello/hub 应 100% 丢失（实际收到 ${helloSeen}/${ROUNDS}）`)
})

test('RelayLink：连上后自动 requestNodeList —— 目录里能看到已注册节点，且无 node/online 重播', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  // 先把 node 挂上，再让 link 连 —— 复现「hub 后到，中继不会为已连着的节点重播
  // node/online」的场景：此时唯一的对齐方式就是显式拉目录。
  const node = await openNode(srv.base, 'node-dir')
  t.after(() => node.conn.socket?.destroy?.())
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node registered' })

  const { link, frames } = makeLink(srv.base)
  t.after(() => link.stop())
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  const list = await waitFor(
    () => frames.find((f) => f.t === RELAY_FRAME.NODE_LIST && f.d?.nodes?.length > 0),
    { label: 'node/list with nodes' },
  )
  assert.equal(list.d.nodes.length, 1)
  assert.equal(list.d.nodes[0].nodeId, 'node-dir')
  assert.equal(list.d.nodes[0].os, 'windows')

  assert.equal(
    frames.some((f) => f.t === RELAY_FRAME.NODE_ONLINE),
    false,
    '中继不会为已连着的节点重播 node/online —— 所以显式请求是唯一可靠的对齐方式',
  )
})

/* ═══════════════════════ 三、重连退避 ═══════════════════════ */

test('RelayLink：退避公式 base=min(reconnectMs*2^min(attempt,4), 60s)，抖动在 [base, base*1.2]', async (t) => {
  const { link } = makeLink('ws://127.0.0.1:1/relay', { reconnectMs: 5000 })
  t.after(() => link.stop())
  link.stopped = false

  const delays = captureScheduledDelays(link, 8)
  assert.equal(delays.length, 8, '排定 8 次')

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const base = expectedBase(5000, attempt)
    const upper = base + Math.floor(base * 0.2)
    const d = delays[attempt]
    assert.ok(Number.isInteger(d), `attempt ${attempt}: delay 是整数（${d}）`)
    assert.ok(d >= base, `attempt ${attempt}: delay ${d} >= base ${base}（抖动不减小）`)
    assert.ok(d <= upper, `attempt ${attempt}: delay ${d} <= base*1.2 ${upper}（抖动上限 20%）`)
  }

  // 非递减
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(
      expectedBase(5000, i) >= expectedBase(5000, i - 1),
      `base 非递减：${expectedBase(5000, i - 1)} → ${expectedBase(5000, i)}`,
    )
  }

  // 封顶：reconnectMs=5000 时未封顶的 base 在 attempt>=4 会到 80000，
  // 实测必须被压到 60000（抖动上限 72000，远小于 80000）。
  assert.equal(expectedBase(5000, 4), 60_000, '独立计算：attempt=4 起基数被封到 60s')
  assert.equal(expectedBase(5000, 5), 60_000, '独立计算：attempt=5 仍封在 60s')
  assert.ok(
    delays[4] <= 72_000,
    `attempt=4 的 delay ${delays[4]} 不超过封顶+抖动（未封顶会是 80000+）`,
  )
  // 最后几次必须都落在封顶后的区间（若封顶被拿掉，这里会到 80000/160000…）
  for (const attempt of [4, 5, 6, 7]) {
    assert.ok(delays[attempt] <= 72_000, `attempt ${attempt}: delay ${delays[attempt]} 受 60s 封顶约束`)
  }
})

test('RelayLink：reconnectMs 本身就超 60s 时，封顶立即生效', async (t) => {
  const { link } = makeLink('ws://127.0.0.1:1/relay', { reconnectMs: 100_000 })
  t.after(() => link.stop())
  link.stopped = false

  const delays = captureScheduledDelays(link, 3)
  for (const [i, d] of delays.entries()) {
    assert.ok(d >= 60_000, `attempt ${i}: delay ${d} >= 60000（下限是封顶值）`)
    assert.ok(d <= 72_000, `attempt ${i}: delay ${d} <= 72000（封顶值 + 20% 抖动）`)
  }
  assert.equal(expectedBase(100_000, 0), 60_000, '独立计算：100s 的基数被立即封到 60s')
})

test('RelayLink：中继不可达时 schedule 被调用、attempt 递增、timer 有 unref', async (t) => {
  const deadPort = await freePort()
  const { link, logs } = makeLink(`ws://127.0.0.1:${deadPort}/relay`, { reconnectMs: 20 })
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.attempt >= 3, { label: 'several reconnect attempts', timeoutMs: 6000 })

  assert.ok(link.attempt >= 3, `attempt 应递增，实际 ${link.attempt}`)
  assert.ok(logs.some((l) => l.msg === 'relay connect failed'), '应记录 "relay connect failed"')
  assert.equal(link.ready, false, '连不上时 ready=false')

  // timer 必须 unref：否则一个连不上的 relay 会吊住整个进程退出
  assert.ok(link.timer !== undefined, '应有排定的重连 timer')
  assert.equal(typeof link.timer.unref, 'function', 'timer 暴露 unref')
  if (typeof link.timer.hasRef === 'function') {
    assert.equal(link.timer.hasRef(), false, 'timer 确实已 unref（hasRef()=false）')
  }
})

test('RelayLink：重连成功后 attempt 重置为 0（避免退避被永久拉长）', async (t) => {
  const port = await freePort()
  const url = `ws://127.0.0.1:${port}/relay`
  const { link } = makeLink(url, { reconnectMs: 30 })
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.attempt >= 3, { label: 'attempt grew while unreachable', timeoutMs: 6000 })
  const grew = link.attempt
  assert.ok(grew >= 3, `不可达期间 attempt 已涨到 ${grew}`)

  const relay = createRelay({ port, host: '127.0.0.1', hubToken: HUB_TOKEN, enrollToken: ENROLL_TOKEN })
  await new Promise((r) => relay.listen(r))
  t.after(async () => {
    for (const h of [...relay.hubs]) {
      try { h.socket?.destroy?.() } catch { /* 已断 */ }
    }
    await relay.close()
  })

  await waitFor(() => link.ready, { label: 'reconnected', timeoutMs: 8000 })
  assert.equal(link.attempt, 0, `连上后 attempt 必须归零（重连前是 ${grew}）`)
  assert.equal(link.timer, undefined, '连上后不应还挂着重连 timer')
})

test('RelayLink：当前连接掉线会重连（identity 守卫不能把正常掉线也吞掉）', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base, { reconnectMs: 30 })
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.ready, { label: 'ready' })
  const first = link.conn

  // 硬断底层 socket（不发 close 帧）—— 冻结层会走 'end' → finish(1006) → 'close'
  first.socket.destroy()

  await waitFor(() => link.ready && link.conn !== first && link.attempt === 0, {
    label: 'reconnected after hard drop',
    timeoutMs: 8000,
  })
  assert.notEqual(link.conn, first, '换上了新连接')
  assert.equal(link.ready, true)
  assert.equal(link.attempt, 0, '重连成功后又归零')
})

test('RelayLink：schedule() 幂等 —— 已有 timer 时不重复排', async (t) => {
  const { link } = makeLink('ws://127.0.0.1:1/relay', { reconnectMs: 60_000 })
  t.after(() => link.stop())
  link.stopped = false

  link.schedule()
  const first = link.timer
  assert.ok(first, '第一次排上了')
  assert.equal(link.attempt, 1, 'attempt 加一次')

  link.schedule()
  link.schedule()
  assert.equal(link.timer, first, '后续调用不覆盖已有 timer（幂等）')
  assert.equal(link.attempt, 1, 'attempt 不会重复累加')
})

test('RelayLink：stop() 后不再重连', async (t) => {
  const deadPort = await freePort()
  const { link } = makeLink(`ws://127.0.0.1:${deadPort}/relay`, { reconnectMs: 20 })
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.attempt >= 2, { label: 'attempt grew', timeoutMs: 6000 })

  link.stop()
  const attemptAtStop = link.attempt
  assert.equal(link.timer, undefined, 'stop 清掉 timer')

  link.schedule()
  assert.equal(link.timer, undefined, 'stopped 时 schedule 不排新 timer')
  assert.equal(link.attempt, attemptAtStop, 'stopped 时 attempt 不增长')

  await sleep(300)
  assert.equal(link.attempt, attemptAtStop, 'stop 后 attempt 不再变化')
  assert.equal(link.timer, undefined, 'stop 后没有新 timer')
  assert.equal(link.ready, false)
})

/* ═══════════════════════ 四、send / sendBinary ═══════════════════════ */

test('RelayLink：ready 时 send 返回 true 且文本帧经中继路由到目标 node', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base)
  t.after(() => link.stop())
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  const nodeA = await openNode(srv.base, 'node-a')
  const nodeB = await openNode(srv.base, 'node-b')
  t.after(() => nodeA.conn.socket?.destroy?.())
  t.after(() => nodeB.conn.socket?.destroy?.())
  await waitFor(() => srv.relay.nodes.size === 2, { label: 'two nodes registered' })

  // 中继靠帧里的 `to` 路由（RelayLink.send 是透传，`to` 由调用方 / NodeRegistry.send 补）
  const text = encodeFrame({
    ...envelope(RELAY_FRAME.DOWN, { taskId: 'task-1', goal: 'ping' }),
    to: 'node-a',
  })
  assert.equal(link.send('node-a', text), true, 'ready 时 send → true')

  const got = await waitFor(() => nodeA.frames.find((f) => f.t === RELAY_FRAME.DOWN), { label: 'node-a got frame' })
  assert.equal(got.d.taskId, 'task-1')
  assert.equal(got.to, 'node-a')

  await sleep(150)
  assert.equal(nodeB.frames.filter((f) => f.t === RELAY_FRAME.DOWN).length, 0, 'node-b 不应收到投给 node-a 的帧')
})

test('RelayLink：sendBinary 二进制净荷逐字节不变（含非法 UTF-8 字节）', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base)
  t.after(() => link.stop())
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  const node = await openNode(srv.base, 'node-bin')
  t.after(() => node.conn.socket?.destroy?.())
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node registered' })

  // 净荷刻意包含非法 UTF-8 序列：任何一次「当字符串处理」都会把它们变成 U+FFFD
  const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28, 0x41, 0x7f, 0xed, 0xa0, 0x80])
  const sent = encodeBinaryFrame({ v: 1, t: 'artifact/chunk', pullId: 'p-1', to: 'node-bin' }, payload)

  assert.equal(link.sendBinary('node-bin', sent), true, 'ready 时 sendBinary → true')

  const got = await waitFor(() => node.binaries[0], { label: 'node got binary frame' })
  assert.equal(got.length, sent.length, `长度一致（发出 ${sent.length}，收到 ${got.length}）`)
  assert.equal(Buffer.compare(got, sent), 0, '整帧逐字节一致')

  const dec = decodeBinaryFrame(got)
  assert.equal(dec.ok, true, '二进制布局可解析')
  assert.equal(dec.header.to, 'node-bin', '头部字段保留')
  assert.equal(dec.header.pullId, 'p-1')
  assert.equal(Buffer.compare(dec.payload, payload), 0, '净荷逐字节不变')
  assert.equal(
    dec.payload.includes(Buffer.from([0xef, 0xbf, 0xbd])),
    false,
    '净荷不含 U+FFFD（未被当字符串处理过）',
  )
})

test('RelayLink：上行二进制帧真的进了 link.onBinary', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link, binaries } = makeLink(srv.base)
  t.after(() => link.stop())
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  const node = await openNode(srv.base, 'node-up')
  t.after(() => node.conn.socket?.destroy?.())
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node registered' })

  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])
  node.conn.sendBinary(encodeBinaryFrame({ v: 1, t: 'artifact/chunk', pullId: 'p-up' }, payload))

  const got = await waitFor(() => binaries[0], { label: 'link.onBinary called' })
  assert.equal(got.header.from, 'node-up', '中继补上了 from')
  assert.equal(got.header.pullId, 'p-up')
  assert.equal(Buffer.compare(got.payload, payload), 0, '上行净荷逐字节不变')
})

test('RelayLink：真中继会先过滤畸形帧，hub 侧根本收不到（覆盖边界，非缺陷）', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link, logs, frames } = makeLink(srv.base)
  t.after(() => link.stop())
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  const node = await openNode(srv.base, 'node-bad')
  t.after(() => node.conn.socket?.destroy?.())
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node registered' })
  await sleep(80)

  const before = frames.length

  // ① 非 JSON 文本帧 ② 畸形二进制帧（长度不足）③ 缺 t 的 JSON 帧
  node.conn.send('this is not json')
  node.conn.sendBinary(Buffer.from([0x00]))
  node.conn.send(JSON.stringify({ v: 1, d: {} }))
  await sleep(300)

  // 中继自己先过了一遍 decodeFrame / decodeBinaryFrame，畸形帧被它挡下并回错误帧，
  // 所以 RelayLink 的 'relay frame undecodable' 分支在**真中继下不可达**。
  // 这是覆盖边界（不是缺陷）—— 该分支的护栏见下面「不可信中继」那条用例。
  assert.equal(frames.length, before, '真中继不应把畸形帧转发给 hub')
  assert.equal(
    logs.some((l) => l.msg === 'relay frame undecodable'),
    false,
    '真中继下 RelayLink 的 undecodable 分支不可达（中继已先过滤）',
  )
  assert.ok(
    node.frames.some((f) => f.t === RELAY_FRAME.ERROR && f.d?.code === 'malformed-json'),
    '中继应把畸形帧作为错误回给发送方',
  )

  // 链路仍然健康
  node.conn.send(encodeFrame(envelope('task/progress', { taskId: 't-ok', phase: 'alive' })))
  const ok = await waitFor(() => frames.find((f) => f.t === 'task/progress'), { label: 'link still alive' })
  assert.equal(ok.from, 'node-bad')
  assert.equal(link.ready, true)
})

/**
 * 不可信中继下的防御 —— 这条才真正打到 RelayLink 的解码防御分支。
 *
 * 为什么需要假中继：真中继会先做 decodeFrame/decodeBinaryFrame 校验（见上一条用例），
 * 畸形帧根本到不了 hub。而中继是**网络上的另一台机器**，一旦它被攻陷 / 版本不匹配 /
 * 被中间人替换，hub 侧就必须自己扛住垃圾字节。这条用例用最小假中继把原始垃圾直接
 * 推进 hub 连接，验 RelayLink「解析失败只记日志、绝不打断链路」这条不变式。
 */
test('RelayLink：面对不可信中继的畸形帧，只记日志、不打断链路', async (t) => {
  const fake = await startFakeRelay()
  t.after(() => fake.close())

  const logs = []
  const frames = []
  const link = new RelayLink({
    url: fake.base,
    token: HUB_TOKEN,
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
    onFrame: (f) => {
      if (f.t === 'boom') throw new Error('onFrame 故意抛')
      frames.push(f.t)
    },
    onBinary: (h) => {
      if (h.t === 'boom-bin') throw new Error('onBinary 故意抛')
    },
    reconnectMs: 5000,
    name: 'fake-relay-probe',
  })
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.ready, { label: 'ready against fake relay' })
  await waitFor(() => fake.hubConn, { label: 'fake relay accepted hub' })

  // ① 非 JSON 文本帧 → decodeFrame 失败
  fake.pushText('definitely not json {{{')
  await waitFor(() => logs.some((l) => l.msg === 'relay frame undecodable'), { label: 'undecodable logged' })
  assert.equal(link.ready, true, '解码失败后链路仍活')

  // ② 长度不足的二进制帧 → decodeBinaryFrame 失败
  fake.pushBinary(Buffer.from([0x00]))
  await waitFor(() => logs.some((l) => l.msg === 'relay binary frame undecodable'), {
    label: 'binary undecodable logged',
  })
  assert.equal(link.ready, true, '二进制解码失败后链路仍活')

  // ③ onFrame 抛错 → 被 try/catch 兜住，记 'relay frame handler failed'
  fake.pushText(encodeFrame(envelope('boom', {})))
  await waitFor(() => logs.some((l) => l.msg === 'relay frame handler failed'), { label: 'handler failure logged' })
  assert.equal(link.ready, true, 'onFrame 抛错不能打挂链路')

  // ④ onBinary 抛错 → 同样被兜住
  fake.pushBinary(encodeBinaryFrame({ v: 1, t: 'boom-bin' }, Buffer.from([1, 2, 3])))
  await waitFor(() => logs.filter((l) => l.msg === 'relay frame handler failed').length >= 2, {
    label: 'binary handler failure logged',
  })
  assert.equal(link.ready, true, 'onBinary 抛错不能打挂链路')

  // ⑤ 正常帧照样送达 —— 说明前面的异常没有污染链路
  fake.pushText(encodeFrame(envelope('task/progress', { taskId: 't-after', phase: 'alive' })))
  await waitFor(() => frames.includes('task/progress'), { label: 'healthy frame after garbage' })
  assert.equal(link.ready, true)
  assert.equal(link.conn?.closed, false, '连接全程未被打断')
})

/* ═══════════════════════ 五、stop() 清理 ═══════════════════════ */

test('RelayLink：stop 清 timer、关连接、conn=undefined，且幂等', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base)
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })
  const conn = link.conn

  link.stop()
  assert.equal(link.stopped, true, 'stopped 置真')
  assert.equal(link.conn, undefined, 'conn 清空')
  assert.equal(link.timer, undefined, 'timer 清空')
  assert.equal(link.ready, false, 'ready=false')
  assert.equal(conn.closed, true, '原连接已被关闭')

  assert.doesNotThrow(() => link.stop())
  assert.doesNotThrow(() => link.stop())
  assert.equal(link.conn, undefined)
  assert.equal(link.ready, false)

  assert.equal(link.send('n1', 'x'), false, 'stop 后 send → false')
  assert.equal(link.sendBinary('n1', Buffer.from([1])), false, 'stop 后 sendBinary → false')
  assert.equal(link.requestNodeList(), false, 'stop 后 requestNodeList → false')

  await waitFor(() => srv.relay.hubs.size === 0, { label: 'relay released hub', timeoutMs: 4000 })
})

test('RelayLink：stop 后可以重新 start（重启语义）', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base)
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.ready, { label: 'ready #1' })
  link.stop()
  await sleep(80)
  assert.equal(link.ready, false)

  link.start()
  await waitFor(() => link.ready, { label: 'ready #2' })
  assert.equal(link.stopped, false, '重启后 stopped=false')
  assert.equal(link.attempt, 0, '重启成功后 attempt=0')
})

test('RelayLink：连接在途时 stop，不留半开连接也不留 timer', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base, { reconnectMs: 20 })
  link.start()
  link.stop() // 覆盖 connectOnce 已 await 中的竞态
  await sleep(400)

  assert.equal(link.conn, undefined, '未留下连接')
  assert.equal(link.timer, undefined, '未留下 timer')
  assert.equal(link.ready, false)
  await waitFor(() => srv.relay.hubs.size === 0, { label: 'relay has no hub', timeoutMs: 4000 })
})

/* ═══════════════════════ 六、describe() 与凭证安全 ═══════════════════════ */

test('RelayLink：describe 回 origin+pathname，绝不含 token 或 query', async (t) => {
  const { link } = makeLink(`ws://127.0.0.1:12345/relay?role=hub&token=${HUB_TOKEN}&nodeId=secret`)
  t.after(() => link.stop())

  const d = link.describe()
  assert.equal(d, 'ws://127.0.0.1:12345/relay', 'origin+pathname，剥掉整个 query')
  assert.equal(d.includes(HUB_TOKEN), false, '不含 token')
  assert.equal(d.includes('secret'), false, '不含 query 里的其它值')
  assert.equal(d.includes('?'), false, '不含 query 分隔符')
})

test('RelayLink：describe 对非法 URL 返回占位且不抛', async (t) => {
  for (const bad of ['not-a-url', '', 'http://[', 'ws://']) {
    const { link } = makeLink(bad)
    t.after(() => link.stop())
    assert.doesNotThrow(() => link.describe(), `describe(${JSON.stringify(bad)}) 不抛`)
    assert.equal(link.describe(), '(invalid-relay-url)', `describe(${JSON.stringify(bad)}) 回占位`)
  }
})

test('RelayLink：URL 非法时 connectOnce 直接返回，不排无意义的重连', async (t) => {
  const { link, logs } = makeLink('not-a-url')
  t.after(() => link.stop())
  link.start()
  await sleep(100)

  assert.equal(link.conn, undefined)
  assert.equal(link.timer, undefined, 'URL 非法不该排重连（重试也没用）')
  assert.equal(link.ready, false)
  assert.ok(logs.some((l) => l.msg === 'relay url invalid'), '应记录 url invalid')
})

/* ═══════════ 七、并发不变式（t1 动态测试查出的两个真缺陷的回归护栏） ═══════════ */

/**
 * [缺陷 1 回归] `start()` 不幂等 → 泄漏一条无人引用的孤儿连接。
 *
 * 修复前实测：连调两次 `start()` → 中继侧 `hubs.size === 2`；`stop()` 只关得掉
 * `this.conn` 那一条，另一条永久占着中继的 hub 槽位，且此后**再无任何路径**能关掉它
 * （引用已丢）。根因：`connect()` 要等 101 才 resolve，这个窗口里 `this.conn` 仍是
 * undefined，任何重入都会再开一条 TCP 连接。
 */
test('[缺陷回归] start() 幂等：不泄漏第二条连接，stop 能关干净', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base)
  t.after(() => link.stop())

  link.start()
  link.start() // 第二次调用：必须无效
  await waitFor(() => link.ready, { label: 'ready' })
  await sleep(200) // 给可能存在的第二条连接足够时间注册到中继

  assert.equal(srv.relay.hubs.size, 1, `重复 start 只应产生 1 条连接（实际 ${srv.relay.hubs.size}）`)

  const conn = link.conn
  link.start()
  await sleep(150)
  assert.equal(link.conn, conn, '已连接时 start 不重建连接')
  assert.equal(srv.relay.hubs.size, 1, '仍然只有 1 条连接')

  // stop 必须能把中继侧清空 —— 泄漏时这里会剩 1
  link.stop()
  await waitFor(() => srv.relay.hubs.size === 0, {
    label: 'relay fully released after stop',
    timeoutMs: 4000,
  })
  assert.equal(srv.relay.hubs.size, 0, 'stop 后中继侧不应残留任何 hub 连接')
})

/**
 * [缺陷回归] `connectOnce()` 自身的并发闸门。
 *
 * 上一条用例覆盖的是 `start()` 幂等；这条覆盖**另一道独立的闸门**。两条路径都会调
 * `connectOnce()`：`start()` 与退避 timer 的回调。若 `connectOnce()` 自己不做重入
 * 拦截，一次「timer 刚触发 + 外部同时 start」就能开出第二条连接，而 `this.conn`
 * 只会保留最后一条 —— 先建好的那条成为孤儿（永久占着中继的 hub 槽位）。
 *
 * 为什么必须单独测：把 `connectOnce` 的闸门单独拿掉时，`start()` 的闸门**挡不住**
 * 这条路径（它拦的是「start 被调两次」，不是「两个 connectOnce 同时在跑」）。
 * 实测：注入 `if (false) return` 后，只有这条用例变红。
 */
test('[缺陷回归] 并发 connectOnce 只产生一条连接（timer + start 竞态）', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link } = makeLink(srv.base)
  t.after(() => link.stop())

  link.stopped = false
  link.connecting = false
  link.conn = undefined

  // 同时发起两次 —— 模拟「退避 timer 触发」与「外部 start」撞在一起
  const both = Promise.all([link.connectOnce(), link.connectOnce()])
  await waitFor(() => link.ready, { label: 'ready' })
  await both
  await sleep(200) // 给可能存在的第二条连接足够时间注册到中继

  assert.equal(srv.relay.hubs.size, 1, `并发 connectOnce 只应产生 1 条连接（实际 ${srv.relay.hubs.size}）`)
  assert.equal(link.connecting, false, '闸门在 finally 里被清掉')

  // stop 必须能把中继侧清空 —— 有孤儿时这里会剩 1
  link.stop()
  await waitFor(() => srv.relay.hubs.size === 0, {
    label: 'relay fully released after stop',
    timeoutMs: 4000,
  })
})

/**
 * [缺陷 2 回归] 陈旧连接的 'close' 把当前连接伪造成「掉线」。
 *
 * 修复前实测：存在两条连接时，断开其中**陈旧**的那条，会让 `ready` 由 true 翻成
 * false、`attempt` 涨到 1、并排出一个多余的 timer —— 也就是「活着的新连接」被一条
 * 早就死掉的旧连接清掉了。修复即 close 处理器先校验 `this.conn === conn`。
 *
 * 构造方式：直接把 `this.conn` 换成第二条连接，让第一条成为陈旧连接。
 */
test('[缺陷回归] 陈旧连接的 close 不 clobber 当前连接', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const { link, logs } = makeLink(srv.base, { reconnectMs: 5000 })
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.ready, { label: 'ready #1' })
  const stale = link.conn

  // 造出第二条连接并让它成为「当前连接」（绕过 start 闸门，模拟历史上发生过的
  // 双连接状态；修复后 start() 本身已不会产生这种状态）。
  link.connecting = false
  link.conn = undefined
  await link.connectOnce()
  await waitFor(() => link.ready, { label: 'ready #2' })
  const current = link.conn
  assert.notEqual(current, stale, '确实换成了第二条连接')

  const attemptBefore = link.attempt
  stale.close(1000, 'stale')
  await sleep(250)

  assert.equal(link.conn, current, '当前连接引用不被陈旧连接清掉')
  assert.equal(link.ready, true, '已连上的新连接不应被判为掉线')
  assert.equal(link.attempt, attemptBefore, '不应因陈旧连接断开而增加 attempt')
  assert.equal(link.timer, undefined, '不应排出多余的重连 timer')
  assert.ok(
    logs.some((l) => l.msg === 'stale relay connection closed'),
    '应记录 stale 连接关闭',
  )
})

/* ═══════════ 八、与真中继的集成：目录 → 派单全链路 ═══════════ */

test('RelayLink：node/list 目录与下行派单串起来（目录对齐的实际用途）', async (t) => {
  const srv = await startRelay()
  t.after(() => closeRelay(srv))

  const node = await openNode(srv.base, 'node-e2e')
  t.after(() => node.conn.socket?.destroy?.())
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node registered' })

  const { link, frames } = makeLink(srv.base)
  t.after(() => link.stop())
  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  // 1) 目录：link 自己拉到的 node/list 里能看到 node-e2e
  const list = await waitFor(
    () => frames.find((f) => f.t === RELAY_FRAME.NODE_LIST && f.d?.nodes?.length > 0),
    { label: 'directory aligned' },
  )
  const nodeId = list.d.nodes[0].nodeId
  assert.equal(nodeId, 'node-e2e')

  // 2) 派单：用目录里的 nodeId 作路由目标，帧真的到副机
  const dispatch = encodeFrame({
    ...envelope(RELAY_FRAME.DOWN, { taskId: 't-e2e', goal: 'say hi' }),
    to: nodeId,
  })
  assert.equal(link.send(nodeId, dispatch), true)
  const got = await waitFor(() => node.frames.find((f) => f.t === RELAY_FRAME.DOWN), { label: 'dispatch delivered' })
  assert.equal(got.d.goal, 'say hi')

  // 3) 副机上行：link.onFrame 收到且带 from
  node.conn.send(encodeFrame(envelope('task/accept', { taskId: 't-e2e', status: 'running' })))
  const up = await waitFor(() => frames.find((f) => f.t === 'task/accept'), { label: 'uplink delivered' })
  assert.equal(up.from, 'node-e2e')
  assert.equal(up.d.taskId, 't-e2e')
})

test('RelayLink：中继整体消失后进入退避重连', async (t) => {
  const srv = await startRelay()
  const { link } = makeLink(srv.base, { reconnectMs: 40 })
  t.after(() => link.stop())

  link.start()
  await waitFor(() => link.ready, { label: 'ready' })

  await closeRelay(srv)
  await waitFor(() => !link.ready, { label: 'link noticed relay gone', timeoutMs: 4000 })
  await waitFor(() => link.attempt >= 1, { label: 'backoff started', timeoutMs: 4000 })

  assert.ok(link.attempt >= 1, '中继消失后进入退避')
  assert.equal(link.ready, false)
  assert.ok(link.timer !== undefined, '退避 timer 已排定')
})
