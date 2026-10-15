/**
 * 回归护栏：t7（C2-1 hub 心跳 / C1-1 中继下行背压）与 t5（D7 relay 超时 /
 * E3-1 ctx.get 服务探测）。
 *
 * 这几条此前**完全没有测试覆盖** —— 140/140 全绿也测不出来。
 * 尤其 E3-1：它只在真实 dsh host 里暴露（cordis 对未声明服务属性访问会抛错），
 * 单元测试用假 ctx 测不到，所以这里专门构造一个"属性访问会抛错"的 ctx 来复现。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRelay } from '../lib/relay.js'
import { connect, acceptUpgrade } from '../lib/ws.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { encodeFrame, envelope, RELAY_FRAME, PROTOCOL_VERSION } from '../lib/protocol.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ══════════════════ C2-1: hub 心跳必须真的在跑 ══════════════════ */

test('[C2-1 回归] NodeRegistry.startHeartbeat() 真的启动定时器，tick() 会断掉超时半开连接', async (t) => {
  const registry = new NodeRegistry({ log: () => {}, limits: { heartbeatMs: 1000 } })
  t.after(() => registry.dispose())

  // 修复前：startHeartbeat() 存在但全包无人调用，this.timer 恒 undefined
  assert.equal(registry.timer, undefined, '初始无定时器')

  registry.startHeartbeat()
  assert.ok(registry.timer, 'C2-1 修复：startHeartbeat() 必须真的创建定时器')

  // 幂等：重复调用不叠加
  const first = registry.timer
  registry.startHeartbeat()
  assert.equal(registry.timer, first, '重复调用不创建第二个定时器')

  // 直接调 tick() 验证超时巡检逻辑（startHeartbeat 有 1000ms 下限，等真实定时器太慢）
  let destroyed = false
  const fakeConn = {
    closed: false,
    ping() {},
    destroy() { destroyed = true },
    send() { return true },
  }
  registry.nodes.set('stale-node', {
    nodeId: 'stale-node',
    conn: fakeConn,
    online: true,
    lastSeen: Date.now() - 10_000, // 远超 heartbeatMs*4
    since: Date.now() - 20_000,
    tasks: new Map(),
    hello: { nodeId: 'stale-node', os: 'windows', arch: 'x64', hostname: 'stale-node' },
  })

  registry.tick()
  assert.equal(destroyed, true, 'C2-1 修复：超时的半开连接必须被 destroy，不能永久 online')

  registry.dispose()
  assert.equal(registry.timer, undefined, 'dispose 后定时器被清掉')
})

test('[C2-1 回归] 心跳不误杀刚活跃过的节点', async (t) => {
  const registry = new NodeRegistry({ log: () => {}, limits: { heartbeatMs: 1000 } })
  t.after(() => registry.dispose())
  registry.startHeartbeat()

  let destroyed = false
  let pinged = 0
  const conn = {
    closed: false,
    ping() { pinged += 1 },
    destroy() { destroyed = true },
    send() { return true },
  }
  registry.nodes.set('fresh-node', {
    nodeId: 'fresh-node',
    conn,
    online: true,
    lastSeen: Date.now(), // 刚活跃
    since: Date.now(),
    tasks: new Map(),
    hello: { nodeId: 'fresh-node', os: 'windows', arch: 'x64', hostname: 'fresh-node' },
  })

  registry.tick()
  assert.equal(destroyed, false, '刚活跃的节点不该被心跳超时杀掉')
  assert.equal(pinged, 1, '在线节点应被 ping')

  // 离线节点应被跳过（不 ping 也不 kill）
  registry.nodes.get('fresh-node').online = false
  registry.tick()
  assert.equal(pinged, 1, '离线节点不再被 ping')
})

/* ══════════════════ C1-1: 中继下行背压 ══════════════════ */

test('[C1-1 回归] ws 连接暴露 overBudget，且阈值来自 maxQueuedBytes', () => {
  const socket = { write() { return true }, on() {}, setNoDelay() {}, setTimeout() {}, writableLength: 0 }
  const conn = acceptUpgradeFake(socket, { maxQueuedBytes: 1024 })
  assert.equal(conn.overBudget, false, '空缓冲不超预算')
  socket.writableLength = 2048
  assert.equal(conn.overBudget, true, 'C1-1 修复：超过 maxQueuedBytes 即判超预算')
  socket.writableLength = 1024
  assert.equal(conn.overBudget, false, '等于阈值不算超（边界）')
})

test('[C1-1 回归] 中继对停滞节点断连而非无限排队（不 OOM）', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1', hubToken: 'H', enrollToken: 'E' })
  await new Promise((r) => relay.listen(r))
  t.after(() => relay.close())
  const port = relay.address().port

  const hub = await connect(`ws://127.0.0.1:${port}/relay?role=hub&token=H`)
  t.after(() => hub.close())

  // node 用真实客户端（它会正确发 hello/node 完成登记），随后**暂停底层 socket 的读取**
  // 制造停滞：数据在服务端写缓冲里堆积，触发背压。
  const node = await connect(`ws://127.0.0.1:${port}/relay?role=node&token=E`)
  t.after(() => node.close())
  node.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, {
    nodeId: 'stall', protocol: PROTOCOL_VERSION, os: 'windows',
  })))
  await sleep(300)
  assert.equal(relay.nodes.has('stall'), true, '前置：节点已完成 hello 登记')

  // 关键：暂停读取，让服务端写不出去
  node.socket.pause()

  const { encodeBinaryFrame } = await import('../lib/protocol.js')
  const big = Buffer.alloc(256 * 1024, 0x41)
  const header = { v: 1, t: 'artifact/chunk', pullId: 'bp', to: 'stall' }
  let peakBuffered = 0
  let pushed = 0
  for (let i = 0; i < 500; i += 1) {
    const rec = relay.nodes.get('stall')
    if (!rec) break // 已被背压断连
    peakBuffered = Math.max(peakBuffered, rec.conn.bufferedBytes)
    hub.sendBinary(encodeBinaryFrame(header, big))
    pushed += 1
    if (i % 25 === 0) await sleep(10)
  }
  await sleep(400)

  const dropped = relay.stats.backpressureDrops
  const nodeGone = !relay.nodes.has('stall')
  assert.ok(
    dropped > 0 || nodeGone,
    `C1-1 修复：停滞节点必须被背压处理（drops=${dropped}, nodeGone=${nodeGone}, pushed=${pushed}, peak=${peakBuffered}）`,
  )

  // 核心回归断言：缓冲被预算封顶，没有涨到 reviewer 实测的 339 MiB
  assert.ok(
    peakBuffered <= 20 * 1024 * 1024,
    `C1-1 修复：写缓冲必须被 16 MiB 预算封顶，实测峰值 ${(peakBuffered / 1024 / 1024).toFixed(1)} MiB`,
  )
  assert.equal(relay.server.listening, true, 'C1-1 修复：中继进程必须存活')
})

test('[C1-1 回归] 正常节点不受背压影响', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1', hubToken: 'H', enrollToken: 'E' })
  await new Promise((r) => relay.listen(r))
  t.after(() => relay.close())
  const port = relay.address().port

  const hub = await connect(`ws://127.0.0.1:${port}/relay?role=hub&token=H`)
  const node = await connect(`ws://127.0.0.1:${port}/relay?role=node&token=E`)
  t.after(() => { hub.close(); node.close() })

  const got = []
  node.on('message', (buf) => got.push(Buffer.from(buf)))

  node.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, { nodeId: 'ok', protocol: PROTOCOL_VERSION, os: 'windows' })))
  await sleep(300)

  hub.send(encodeFrame({ ...envelope('task/start', { taskId: 'x', goal: 'g' }), to: 'ok' }))
  await sleep(300)

  assert.equal(relay.stats.backpressureDrops, 0, '正常节点不该触发背压')
  assert.ok(got.length > 0, '正常节点仍能收到下行帧')
})

/* ══════════════════ D7: relay 模式心跳超时 ══════════════════ */

test('[D7 回归] relay 模式（rec.conn 为空）也走 lastSeen 超时下线', async (t) => {
  const registry = new NodeRegistry({ log: () => {}, limits: { heartbeatMs: 1000 } })
  t.after(() => registry.dispose())
  registry.startHeartbeat()

  // relay 模式：rec.conn === undefined（中继没有专属 socket）
  const rec = {
    nodeId: 'relay-stale',
    conn: undefined,
    online: true,
    lastSeen: Date.now() - 30_000, // 远超 heartbeatMs * 8
    since: Date.now() - 60_000,
    tasks: new Map(),
    hello: { nodeId: 'relay-stale', os: 'windows', arch: 'x64', hostname: 'relay-stale' },
  }
  registry.nodes.set('relay-stale', rec)

  // 修复前：超时判定整段在 `if (conn && !conn.closed)` 内 → relay 分支被跳过，
  // 中继自己死了就没人发 node/offline，online 永久为 true
  registry.tick()
  assert.equal(rec.online, false, 'D7 修复：relay 节点超时后必须下线')

  // 刚活跃的 relay 节点不该被误杀（阈值放宽到 8 倍防误杀）
  const fresh = {
    nodeId: 'relay-fresh',
    conn: undefined,
    online: true,
    lastSeen: Date.now(),
    since: Date.now(),
    tasks: new Map(),
    hello: { nodeId: 'relay-fresh', os: 'windows', arch: 'x64', hostname: 'relay-fresh' },
  }
  registry.nodes.set('relay-fresh', fresh)
  registry.tick()
  assert.equal(fresh.online, true, 'D7 修复：刚活跃的 relay 节点不被误杀')

  // 边界：relay 阈值是 heartbeatMs * 8（direct 是 *4），
  // 所以 5 倍心跳间隔的 relay 节点仍算在线（direct 此时已被杀）
  const mid = {
    nodeId: 'relay-mid',
    conn: undefined,
    online: true,
    lastSeen: Date.now() - 5000,
    since: Date.now(),
    tasks: new Map(),
    hello: { nodeId: 'relay-mid', os: 'windows', arch: 'x64', hostname: 'relay-mid' },
  }
  registry.nodes.set('relay-mid', mid)
  registry.tick()
  assert.equal(mid.online, true, 'relay 阈值更宽（8x），5x 心跳间隔仍在线')

  // 对照：direct 模式仍走 ping + destroy
  let destroyed = false
  const direct = {
    nodeId: 'direct-stale',
    conn: { closed: false, ping() {}, destroy() { destroyed = true } },
    online: true,
    lastSeen: Date.now() - 30_000,
    since: Date.now(),
    tasks: new Map(),
    hello: { nodeId: 'direct-stale', os: 'windows', arch: 'x64', hostname: 'direct-stale' },
  }
  registry.nodes.set('direct-stale', direct)
  registry.tick()
  assert.equal(destroyed, true, 'direct 模式仍走 conn.destroy 路径')
})

/* ══════════════════ E3-1: 服务探测必须用 ctx.get ══════════════════ */

test('[E3-1 回归] InProcessRunner 用 ctx.get 探测服务，属性访问抛错的 ctx 不炸', async () => {
  const { selectRunner, InProcessRunner } = await import('../lib/node/runner.js')

  // 模拟真实 cordis ctx：访问未声明的服务**属性**会抛错（不是返回 undefined）
  const makeCordisLikeCtx = (services) => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'get') return (name) => services[name]
      if (prop === 'on') return () => () => {}
      if (prop === 'effect') return (fn) => fn()
      // 关键：属性访问一律抛错，复现 cordis 的 "without inject" 行为
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })

  // (a) 无 agentLoop 的 ctx：available 必须为 false 且**不抛**
  const bare = makeCordisLikeCtx({})
  let runner
  assert.doesNotThrow(() => {
    runner = new InProcessRunner({ ctx: bare, nodeId: 'n' })
  }, 'E3-1 修复：构造 runner 不该抛')
  assert.doesNotThrow(() => {
    assert.equal(runner.available, false, 'E3-1 修复：无 agentLoop 时 available=false 且不抛')
  })

  // (b) selectRunner 必须回退到 headless，而不是让启动失败
  const picked = selectRunner({ ctx: bare, nodeId: 'n', profile: 'x', dshBin: 'dsh' })
  assert.equal(picked.kind, 'headless', 'E3-1 修复：服务缺失时回退 headless 后端')

  // (c) 服务齐全的 ctx：available 为 true
  const full = makeCordisLikeCtx({ agentLoop: { createAgent: async () => ({}) }, sessions: { get: () => undefined } })
  const r2 = new InProcessRunner({ ctx: full, nodeId: 'n' })
  assert.equal(r2.available, true, '服务齐全时 available=true')

  // (d) get() 自身抛错时也不炸（探测失败一律当作不可用）
  const throwing = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'get') return () => { throw new Error('get failed') }
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  const r3 = new InProcessRunner({ ctx: throwing, nodeId: 'n' })
  assert.doesNotThrow(() => assert.equal(r3.available, false), 'E3-1 修复：get() 抛错也不炸')
})

/* ── 辅助 ── */

function acceptUpgradeFake(socket, opts) {
  const req = {
    headers: {
      upgrade: 'websocket',
      'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
    },
  }
  return acceptUpgrade(req, socket, null, opts)
}
