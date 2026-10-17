/**
 * 健壮性修复的行为级回归（未提交工作区修复的验证 + 护栏）：
 *
 *   ① transport.js 握手超时 —— upgrade 后 welcome/accepted 不来必须毁连接重连，
 *      不允许"TCP 连着但永远上不了线"的哑状态。
 *   ② pull-manager.js offset 缺失 —— 畸形帧必须失败，不允许静默跳过校验继续写盘。
 *   ③ pull-manager.js 超时重臂 —— 必须用本条 pull 自己的 timeoutMs，
 *      不允许第一个分块之后回退到 limits.pullTimeoutMs（自定义短超时静默失效）。
 *
 * 这三条的逻辑分支此前只有源码级断言或没有断言；本文件用真实调用序列 +
 * mock timers 锁住**行为**。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { NodeTransport } from '../lib/node/transport.js'
import { PullManager } from '../lib/hub/pull-manager.js'
import { RemoteAgentError, ERROR_CODE, encodeBinaryFrame, decodeBinaryFrame } from '../lib/protocol.js'

const tmpdir = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-robust-')) // 交给进程退出清理即可

/** 最小 PullManager 依赖桩：一个永远在线的节点。 */
function stubRegistry() {
  const rec = { nodeId: 'n1', online: true, pendingPulls: new Map() }
  let sendResult = true
  return {
    rec,
    getNode: (id) => (id === 'n1' ? rec : undefined),
    send: () => sendResult,
    setSendResult: (v) => { sendResult = v },
  }
}

/** 造一个合法的二进制分块帧头 + 净荷。 */
function chunkHeader(pullId, offset, extra = {}) {
  return { t: 'artifact/chunk', pullId, offset, ...extra }
}

/* ══════════════════ ② offset 缺失必须失败 ══════════════════ */

test('pull-manager：分块帧缺 offset 视为畸形帧，session 以 hash-mismatch 失败', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({
    registry,
    log: () => {},
    limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 },
  })

  const dest = tmpdir()
  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })

  // 直接投喂一个没有 offset 的二进制帧头（畸形形态）
  pulls.ingestBinary({ t: 'artifact/chunk', pullId: [...pulls.sessions.keys()][0] }, Buffer.from('data'))

  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof RemoteAgentError)
    assert.equal(err.code, ERROR_CODE.HASH_MISMATCH)
    assert.match(err.message, /missing offset/)
    return true
  })
})

test('pull-manager：乱序分块仍然失败（既有语义，防止上面那条把校验改松）', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({
    registry,
    log: () => {},
    limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 },
  })

  const dest = tmpdir()
  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId = [...pulls.sessions.keys()][0]

  pulls.ingestBinary(chunkHeader(pullId, 5), Buffer.from('data'))

  await assert.rejects(promise, (err) => {
    assert.equal(err.code, ERROR_CODE.HASH_MISMATCH)
    assert.match(err.message, /out of order/)
    return true
  })
})

/* ══════════════════ ③ 重臂必须用本条 pull 的 timeoutMs ══════════════════ */

test('pull-manager：自定义短超时在分块之后仍然生效（重臂用 s.timeoutMs 而非 limits 值）', async (t) => {
  // 假时钟：limits 是 10 分钟，调用方只要 2 秒。收到一块后推进 2 秒 ——
  // 修复前这里会按 limits.pullTimeoutMs 重臂，2 秒后不会超时（静默失效）。
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const registry = stubRegistry()
  const pulls = new PullManager({
    registry,
    log: () => {},
    limits: { pullTimeoutMs: 600_000, maxPullBytes: 1024 },
  })

  const dest = tmpdir()
  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest, timeoutMs: 2_000 })
  const pullId = [...pulls.sessions.keys()][0]

  // 一块合法数据（offset 0），触发 armTimeout 重臂
  pulls.ingestBinary(chunkHeader(pullId, 0), Buffer.from('hello'))

  t.mock.timers.tick(2_000)

  await assert.rejects(promise, (err) => {
    assert.equal(err.code, ERROR_CODE.INTERNAL)
    // 超时信息里必须是本条 pull 的 2000ms，不是 limits 的 600000ms
    assert.match(err.message, /no chunk for 2000ms/)
    return true
  })
})

test('pull-manager：未传自定义超时时回退 limits.pullTimeoutMs（兼容默认路径）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const registry = stubRegistry()
  const pulls = new PullManager({
    registry,
    log: () => {},
    limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 },
  })

  const dest = tmpdir()
  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId = [...pulls.sessions.keys()][0]

  pulls.ingestBinary(chunkHeader(pullId, 0), Buffer.from('hello'))
  t.mock.timers.tick(60_000)

  await assert.rejects(promise, (err) => {
    assert.match(err.message, /no chunk for 60000ms/)
    return true
  })
})

/* ══════════════════ ① 握手超时 ══════════════════ */

/** 最小 WSConnection 桩：记录事件处理器，支持手动触发。 */
function fakeConn() {
  const listeners = new Map()
  const state = { destroyed: false, destroyErr: undefined, closed: false }
  const conn = {
    closed: false,
    bufferedBytes: 0,
    on: (evt, fn) => {
      const set = listeners.get(evt) ?? new Set()
      set.add(fn)
      listeners.set(evt, set)
    },
    emit: (evt, ...args) => {
      for (const fn of listeners.get(evt) ?? []) fn(...args)
    },
    send: () => true,
    sendBinary: () => true,
    ping: () => {},
    close: () => { conn.closed = true },
    destroy: (err) => { state.destroyed = true; state.destroyErr = err; conn.closed = true },
  }
  return { conn, listeners, state }
}

test('transport：握手超时（welcome 不来）必须报错并毁掉连接', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const transport = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', hello: { nodeId: 'n' } })
  const { conn, state } = fakeConn()
  const errors = []
  transport.on('error', (err) => errors.push(err))

  transport.attach(conn)
  transport.handshake()
  // connectOnce() 在真实路径里先设 this.conn 再 armHandshakeTimeout ——
  // 这里保持同一序列，否则实现的陈旧连接守卫（this.conn !== conn）会提前返回。
  transport.conn = conn
  transport.armHandshakeTimeout(conn)

  // 9.9s：还没到预算，必须什么都不发生
  t.mock.timers.tick(9_900)
  assert.equal(state.destroyed, false)
  assert.equal(errors.length, 0)

  // 到 10s：必须报 handshake timeout 且销毁连接（close 处理器随后走重连）
  t.mock.timers.tick(100)
  assert.equal(state.destroyed, true, '握手超时必须销毁连接（不允许哑挂起）')
  assert.match(errors[0].message, /handshake timeout/)
})

test('transport：markOnline（收到 welcome）后握手定时器必须解除', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const transport = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', hello: { nodeId: 'n' } })
  const { conn, state } = fakeConn()
  const errors = []
  transport.on('error', (err) => errors.push(err))

  transport.attach(conn)
  transport.armHandshakeTimeout(conn)
  transport.markOnline({})

  t.mock.timers.tick(60_000)
  assert.equal(state.destroyed, false, '已上线的连接不允许被握手定时器误杀')
  assert.equal(errors.length, 0)
})

test('transport：陈旧连接的握手定时器不得动新连接', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const transport = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', hello: { nodeId: 'n' } })
  const old = fakeConn()
  const fresh = fakeConn()
  const errors = []
  transport.on('error', (err) => errors.push(err))

  transport.attach(old.conn)
  transport.conn = old.conn
  transport.armHandshakeTimeout(old.conn)

  // 定时器已挂；此后连接被新的一条顶替（真实场景：重连在预算内完成，
  // 但旧定时器还没触发）。connectOnce 对新连接会重新 arm —— 但那条新定时器
  // 与本用例无关，这里只模拟"定时器触发时 this.conn 已经不是当初那条"。
  transport.conn = fresh.conn

  t.mock.timers.tick(60_000)
  // 守卫语义：this.conn !== conn → 什么都不做。陈旧定时器既不报错也不销毁任何连接。
  assert.equal(old.state.destroyed, false, '陈旧连接由其自身的 close 路径负责，定时器不碰')
  assert.equal(fresh.state.destroyed, false, '新连接绝不能被陈旧定时器误杀')
  assert.equal(errors.length, 0, '被顶替的定时器触发时不应产生错误事件')
})

test('transport：close 时必须清掉握手定时器（断连重连路径不留悬挂 timer）', async () => {
  const transport = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', hello: { nodeId: 'n' } })
  const { conn } = fakeConn()

  // ⚠ 2026-10-17 改：真实流程是 `this.conn = conn` 然后 `attach(conn)`
  // （connectOnce 里那两行）。close 处理器现在有**陈旧连接校验** ——
  // `this.conn !== conn` 时直接返回（防止陈旧连接的 close 把活着的新连接
  // 引用清掉）。所以测试必须先把 conn 设成"当前连接"，否则走不到清理分支。
  transport.conn = conn
  transport.attach(conn)
  transport.armHandshakeTimeout(conn)
  assert.ok(transport.hsTimer, 'arm 之后必须有定时器在位')

  // 对端断开：close 处理器应清掉 hsTimer（否则重连后旧 timer 会误伤新连接）
  conn.emit('close', 1006, 'test')
  assert.equal(transport.hsTimer, undefined, 'close 必须清握手定时器')
  assert.equal(transport.conn, undefined, 'close 必须清当前连接引用')
})

test('transport：陈旧连接的 close 不得清掉新连接的状态（2026-10-17 修 L1）', async () => {
  // 场景：start() 被调两次（cordis effect 热重载）→ 两条 TCP 连接。
  // 没有陈旧连接校验时，旧连接的 close 会把 this.conn 清成 undefined，
  // 活着的新连接变成引用丢失的孤儿 → 发送全失败 + 重连被 duplicate-node 拒
  // → 副机永久失联。这是 hub 侧 RelayLink 早已有的不变式，副机侧当时漏了。
  const transport = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', hello: { nodeId: 'n' } })
  const oldConn = fakeConn().conn
  const newConn = fakeConn().conn

  // 旧连接先 attach，然后被新连接取代
  transport.conn = oldConn
  transport.attach(oldConn)
  transport.conn = newConn
  transport.attach(newConn)
  transport.armHandshakeTimeout(newConn)

  // 旧连接迟到的 close —— 必须什么都不做
  oldConn.emit('close', 1006, 'stale')
  assert.equal(transport.conn, newConn, '陈旧连接的 close 不得清掉当前连接')
  assert.ok(transport.hsTimer, '陈旧连接的 close 不得清掉新连接的握手定时器')
})

/* ══════════════════ 边界：分块帧头构造走真实编码器 ══════════════════ */

test('encodeBinaryFrame：chunk 头部可解码往返（ingestBinary 的输入契约）', () => {
  const header = chunkHeader('p-1', 0, { total: 5 })
  const buf = encodeBinaryFrame(header, Buffer.from('hello'))
  const dec = decodeBinaryFrame(buf)
  assert.equal(dec.ok, true)
  assert.equal(dec.header.pullId, 'p-1')
  assert.equal(dec.header.offset, 0)
  assert.equal(dec.payload.toString(), 'hello')
})
