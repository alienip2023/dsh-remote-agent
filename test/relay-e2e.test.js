/**
 * 中继端到端测试（lib/relay.js + lib/ws.js，冻结层，只测不改）。
 *
 * 用随机端口起真中继，真 WebSocket 客户端接入，断言：
 *   - 两个 hub（同 token）+ 一个 node（enroll token）能同时接入
 *   - node 发 hello/node 后 hub 收到 node/online
 *   - node 上行帧 hub 收到且带 from=nodeId
 *   - hub 下行帧带 to=nodeId 能到达 node
 *   - 错误 token 被 403 拒绝
 *   - 同 nodeId 第二个连接被 duplicate-node 拒绝，且第一个仍在
 *   - node 断开后 hub 收到 node/offline
 *
 * ─────────────────────────── 两条测试约定 ───────────────────────────
 *
 * 【约定 1】"断连"类断言只看**状态**（nodes 减少、连接释放、收到 node/offline），
 *   不断言日志行数或 close 回调次数。冻结层 close 修复与上层兜底并存会让 close
 *   类回调触发两次（reason 也不同：'peer closed without close frame' vs
 *   'peer closed (FIN)'），那是预期行为。同理不断言 reason 精确文本。
 *
 * 【约定 2】注意 hub/node 两侧的 WSConnection 是**不同对象**：
 *   relay 注册表里存的是**服务端** conn，测试里拿到的 client 对象永远不等于它。
 *   所以"注册表仍持有原连接"要用注册表记录本身（rec 引用 / online / 可上行）来断言，
 *   不要用 `rec.conn === clientConn`。
 *
 * 【已知冻结层缺陷 — 见文件末尾 [D2] / [D3] 注释】
 *   D2: protocol.js 的 RELAY_FRAME 没有 ERROR 常量（undefined），relay 的错误帧
 *       因此不带 t 字段 → 接收方 decodeFrame 判 missing-type，双方
 *       `frame.t === RELAY_FRAME.ERROR` 恒为 false，中继错误通知被静默忽略。
 *   D3: relay.js:139 forwardToNode 用 send()（TEXT 帧）转发二进制下行帧，
 *       净荷被 UTF-8 有损转换（0xff/0xfe/0x80 → efbfbd），artifact 分块不可用。
 *   两个缺陷的回归护栏在文件末尾，断言的是**当前实际行为**，修复后需同步更新。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  PROTOCOL_VERSION,
  RELAY_FRAME,
  decodeBinaryFrame,
  decodeFrame,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
} from '../lib/protocol.js'
import { createRelay, newRelayToken, tokenFingerprint } from '../lib/relay.js'
import { connect } from '../lib/ws.js'

const HUB_TOKEN = newRelayToken('rt')
const ENROLL_TOKEN = newRelayToken('en')

/**
 * 一个最小的 HTTP 请求助手。
 *
 * **刻意不用全局 fetch()**：undici 的连接池默认 keep-alive，会在测试跑完后
 * 继续持有 socket，导致 `node --test` 事件循环不退出、整个套件挂住。
 * 这里显式 `agent: false` + `connection: close`，请求结束即释放。
 */
function httpRequest(port, { method = 'GET', path = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          connection: 'close',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode, text, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 起一个真中继，随机端口。 */
function startRelay(t) {
  const events = []
  const relay = createRelay({
    port: 0,
    host: '127.0.0.1',
    hubToken: HUB_TOKEN,
    enrollToken: ENROLL_TOKEN,
    onEvent: (e) => events.push(e),
  })
  return new Promise((resolve) => {
    relay.listen(() => {
      const port = relay.address().port
      resolve({
        relay,
        events,
        port,
        base: `ws://127.0.0.1:${port}/relay`,
        close: async () => {
          // 先硬销毁 relay 侧的全部 socket。
          //
          // 为什么必须这样：upgrade 过的 socket 是 allowHalfOpen=true，
          // relay.close() 内部的 socket.end() 只发 FIN，对端若不回 FIN，
          // 服务端 socket 不会进入 'close'，于是 server.close(cb) 的回调永不触发
          // → relay.close() 的 promise 永远 pending → node:test 的 after 钩子挂死。
          // 再加一道超时兜底，保证任何情况下测试都能收尾。
          for (const n of [...relay.nodes.values()]) {
            try {
              n.conn.socket?.destroy?.()
            } catch {
              /* 已断 */
            }
          }
          for (const h of [...relay.hubs]) {
            try {
              h.socket?.destroy?.()
            } catch {
              /* 已断 */
            }
          }
          await Promise.race([
            relay.close(),
            new Promise((r) => {
              const timer = setTimeout(r, 3000)
              if (timer.unref) timer.unref()
            }),
          ])
        },
      })
    })
  })
}

/**
 * 建一条客户端连接，收集文本帧 / 二进制帧 / 原始消息，并始终挂上 error 监听器。
 *
 * `raw` 保留每一条消息的原始字节与 isBinary 标志 —— 有些场景（见 D3）帧以 TEXT
 * 送达但内容是二进制布局，JSON.parse 必然失败，只能用原始字节断言。
 */
async function connectRaw(url, name, t) {
  const conn = await connect(url, { name })
  // 不挂 error 监听器会在清理阶段冒 ECONNRESET uncaughtException
  conn.on('error', () => {})
  const frames = []
  const binaries = []
  const raw = []
  conn.on('message', (payload, isBinary) => {
    raw.push({ isBinary, buf: Buffer.from(payload) })
    if (isBinary) {
      binaries.push(payload)
      return
    }
    let j
    try {
      j = JSON.parse(payload.toString('utf8'))
    } catch {
      j = { __unparsable: payload.subarray(0, 80).toString('latin1') }
    }
    frames.push(j)
  })
  if (t) {
    t.after(() => {
      try {
        conn.socket?.destroy()
      } catch {
        /* 已断 */
      }
    })
  }
  return { conn, frames, binaries, raw }
}

/** 连一个 hub 角色。 */
function connectHub(base, t, token = HUB_TOKEN) {
  return connectRaw(`${base}?role=hub&token=${encodeURIComponent(token)}`, 'test-hub', t)
}

/** 连一个 node 角色并完成 hello/node 握手。 */
async function connectNode(base, nodeId, { token = ENROLL_TOKEN, helloExtra = {}, t } = {}) {
  const r = await connectRaw(
    `${base}?role=node&token=${encodeURIComponent(token)}&nodeId=${encodeURIComponent(nodeId)}`,
    `test-node:${nodeId}`,
    t,
  )
  r.conn.send(
    encodeFrame(
      envelope(RELAY_FRAME.HELLO_NODE, {
        nodeId,
        protocol: PROTOCOL_VERSION,
        os: 'windows',
        arch: 'x64',
        hostname: nodeId,
        shells: ['powershell'],
        roots: ['D:\\work'],
        caps: ['fs', 'exec', 'artifact', 'agent'],
        profile: 'worker',
        agentMode: true,
        time: Date.now(),
        ...helloExtra,
      }),
    ),
  )
  return r
}

/** 等一个条件成立（轮询）。 */
async function waitFor(fn, { timeoutMs = 8000, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 在帧数组里等某一类型的帧。 */
function waitFrame(frames, type, opts) {
  return waitFor(() => frames.find((f) => f.t === type), { label: `frame ${type}`, ...opts })
}

/**
 * 等一个中继错误帧。
 *
 * 【D2 已修复】中继的错误帧现在**带** `t: 'error'`（RELAY_FRAME.ERROR 已在 protocol.js
 * 中定义）。此前该常量为 undefined，展开进对象后键被省略，错误帧没有 t 字段，
 * 接收侧 decodeFrame 判 missing-type 直接丢弃 —— 所有中继错误都送不到，
 * transport.js / node-registry.js 的 ERROR 分支也永不触发。
 *
 * 本函数原先按缺陷行为断言 `f.t === undefined`；修复后改为按正确行为断言
 * `f.t === RELAY_FRAME.ERROR`。两种写法都能靠 d.code 兜底识别，但必须优先匹配 t，
 * 否则会同时匹配到无关帧。
 */
function waitRelayError(frames, code, opts) {
  return waitFor(
    () => frames.find((f) => f.t === RELAY_FRAME.ERROR && f.d && f.d.code === code),
    { label: `relay error ${code}`, ...opts },
  )
}

/* ─────────────────────────── 基础接入 ─────────────────────────── */

test('relay：在随机端口启动，/healthz 可用', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  assert.ok(srv.port > 0)
  assert.equal(srv.relay.nodes.size, 0)
  assert.equal(srv.relay.hubs.size, 0)

  const res = await httpRequest(srv.port, { path: '/healthz' })
  assert.equal(res.status, 200)
  const body = res.json
  assert.equal(body.ok, true)
  assert.equal(body.protocol, PROTOCOL_VERSION)
  assert.equal(body.nodes, 0)
  assert.equal(body.hubs, 0)
  assert.ok(body.stats)
})

test('relay：两个 hub（同 token）+ 一个 node 同时接入', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hubA = await connectHub(srv.base, t)
  const hubB = await connectHub(srv.base, t)
  await waitFor(() => srv.relay.hubs.size === 2, { label: 'two hubs registered' })

  const node = await connectNode(srv.base, 'node-alpha', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node registered' })

  // node 收到 hello/node accepted 回执
  const ack = await waitFrame(node.frames, RELAY_FRAME.HELLO_NODE)
  assert.equal(ack.d.accepted, true)
  assert.equal(ack.d.nodeId, 'node-alpha')
  assert.equal(ack.d.protocol, PROTOCOL_VERSION)

  // 两个 hub 都收到 node/online
  for (const [name, hub] of [['A', hubA], ['B', hubB]]) {
    const online = await waitFrame(hub.frames, RELAY_FRAME.NODE_ONLINE)
    assert.equal(online.d.node.nodeId, 'node-alpha', `hub ${name}`)
    assert.equal(online.d.node.os, 'windows', `hub ${name}`)
    assert.equal(online.d.node.agentMode, true, `hub ${name}`)
    assert.deepEqual(online.d.node.roots, ['D:\\work'], `hub ${name}`)
  }

  const rec = srv.relay.nodes.get('node-alpha')
  assert.ok(rec)
  assert.equal(rec.hello.nodeId, 'node-alpha')
  assert.equal(typeof rec.since, 'number')
  assert.equal(rec.bytesUp, 0)
})

/* ─────────────────────────── 双向转发 ─────────────────────────── */

test('relay：node 上行帧 hub 收到且带 from=nodeId（两个 hub 都收到）', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hubA = await connectHub(srv.base, t)
  const hubB = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-up', { t })
  await waitFor(() => srv.relay.nodes.size === 1 && srv.relay.hubs.size === 2, { label: 'both connected' })
  hubA.frames.length = 0
  hubB.frames.length = 0

  node.conn.send(
    encodeFrame(envelope('task/accept', { taskId: 't-up-1', nodeId: 'node-up', status: 'queued', duplicate: false })),
  )

  const up = await waitFrame(hubA.frames, 'task/accept')
  assert.equal(up.from, 'node-up', '上行帧必须带来源 nodeId')
  assert.equal(up.d.taskId, 't-up-1')
  assert.equal(up.v, PROTOCOL_VERSION)

  const up2 = await waitFrame(hubB.frames, 'task/accept')
  assert.equal(up2.from, 'node-up')
  assert.equal(up2.d.taskId, 't-up-1')

  assert.ok(srv.relay.stats.upFrames >= 1)
  assert.ok(srv.relay.nodes.get('node-up').bytesUp > 0)
  assert.ok(srv.relay.nodes.get('node-up').lastSeen > 0)
})

test('relay：hub 下行帧带 to=nodeId 能到达对应 node', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  const nodeA = await connectNode(srv.base, 'node-a', { t })
  const nodeB = await connectNode(srv.base, 'node-b', { t })
  await waitFor(() => srv.relay.nodes.size === 2, { label: 'two nodes' })
  nodeA.frames.length = 0
  nodeB.frames.length = 0

  hub.conn.send(encodeFrame({ ...envelope('task/start', { taskId: 't-down-1', goal: 'ping' }), to: 'node-a' }))

  const got = await waitFrame(nodeA.frames, 'task/start')
  assert.equal(got.d.taskId, 't-down-1')
  assert.equal(got.d.goal, 'ping')
  assert.equal(got.to, 'node-a')

  // 只应投给 node-a
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(nodeB.frames.filter((f) => f.t === 'task/start').length, 0, 'node-b 不应收到投给 node-a 的帧')

  // to 指向不存在的节点 → 回 node-offline 错误
  hub.frames.length = 0
  hub.conn.send(encodeFrame({ ...envelope('task/start', { taskId: 'x' }), to: 'node-ghost' }))
  const err = await waitRelayError(hub.frames, 'node-offline')
  assert.equal(err.d.nodeId, 'node-ghost')
})

test('relay：node 上行二进制帧转发给 hub（净荷逐字节不变）', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-bin', { t })
  await waitFor(() => srv.relay.nodes.size === 1 && srv.relay.hubs.size === 1, { label: 'connected' })

  const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0xc3, 0x28])
  node.conn.sendBinary(encodeBinaryFrame({ v: 1, t: 'artifact/chunk', pullId: 'p-1', path: 'a.bin' }, payload))

  const got = await waitFor(() => hub.binaries[0], { label: 'hub binary frame' })
  const dec = decodeBinaryFrame(got)
  assert.equal(dec.ok, true)
  assert.equal(dec.header.from, 'node-bin', '二进制上行帧头必须带 from')
  assert.equal(dec.header.pullId, 'p-1')
  assert.equal(Buffer.compare(dec.payload, payload), 0, '净荷必须逐字节不变（中继不重新编码）')
})

test('relay：node/list 请求返回当前节点目录', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  await connectNode(srv.base, 'node-list', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node registered' })

  hub.frames.length = 0
  hub.conn.send(encodeFrame(envelope(RELAY_FRAME.NODE_LIST, {})))
  const list = await waitFrame(hub.frames, RELAY_FRAME.NODE_LIST)
  assert.equal(list.d.nodes.length, 1)
  assert.equal(list.d.nodes[0].nodeId, 'node-list')
  assert.equal(list.d.nodes[0].os, 'windows')
})

/* ─────────────────────────── 鉴权 ─────────────────────────── */

test('relay：错误 hub token 被 403 拒绝', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  await assert.rejects(
    () => connect(`${srv.base}?role=hub&token=wrong-token`, { timeoutMs: 5000 }),
    /handshake rejected: HTTP 403/,
  )
  await assert.rejects(
    () => connect(`${srv.base}?role=hub`, { timeoutMs: 5000 }),
    /handshake rejected: HTTP 403/,
  )
  assert.equal(srv.relay.hubs.size, 0)
  assert.ok(srv.relay.stats.rejected >= 2)
})

test('relay：错误 enroll token 被 403 拒绝', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  await assert.rejects(
    () => connect(`${srv.base}?role=node&token=nope&nodeId=x`, { timeoutMs: 5000 }),
    /handshake rejected: HTTP 403/,
  )
  await assert.rejects(
    () => connect(`${srv.base}?role=node&nodeId=x`, { timeoutMs: 5000 }),
    /handshake rejected: HTTP 403/,
  )
  assert.equal(srv.relay.nodes.size, 0)
})

test('relay：未知 role 被 400 拒绝；错误路径直接断开连接', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  await assert.rejects(
    () => connect(`${srv.base}?role=admin&token=${HUB_TOKEN}`, { timeoutMs: 5000 }),
    /handshake rejected: HTTP 400/,
  )
  // 非 /relay 路径：relay 直接 socket.destroy()，不写响应 → 客户端见 socket hang up
  await assert.rejects(
    () => connect(`ws://127.0.0.1:${srv.port}/nope?role=hub&token=${HUB_TOKEN}`, { timeoutMs: 5000 }),
    /socket hang up|handshake rejected: HTTP 40[0-9]/,
  )
  assert.equal(srv.relay.hubs.size, 0)
})

test('relay：一次性 token 可用且只能用一次', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const oneTime = srv.relay.mintToken({ nodeId: 'node-ot', ttlMs: 60_000 })
  assert.match(oneTime, /^en_/)
  assert.notEqual(tokenFingerprint(oneTime), tokenFingerprint(ENROLL_TOKEN))

  const first = await connectNode(srv.base, 'node-ot', { token: oneTime, t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'one-time node online' })
  assert.equal(first.conn.closed, false)

  await assert.rejects(
    () => connect(`${srv.base}?role=node&token=${encodeURIComponent(oneTime)}&nodeId=node-ot2`, { timeoutMs: 5000 }),
    /handshake rejected: HTTP 403/,
  )
})

test('relay：一次性 token 绑定 nodeId，别的 nodeId 被拒', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const bound = srv.relay.mintToken({ nodeId: 'node-bound', ttlMs: 60_000 })
  const ok = await connectNode(srv.base, 'node-bound', { token: bound, t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'bound node online' })

  const other = srv.relay.mintToken({ nodeId: 'node-bound', ttlMs: 60_000 })
  const wrong = await connectRaw(
    `${srv.base}?role=node&token=${encodeURIComponent(other)}&nodeId=node-other`,
    'wrong-node',
    t,
  )
  wrong.conn.send(
    encodeFrame(
      envelope(RELAY_FRAME.HELLO_NODE, { nodeId: 'node-other', protocol: PROTOCOL_VERSION, os: 'windows' }),
    ),
  )

  const err = await waitRelayError(wrong.frames, 'unauthorized')
  assert.match(err.d.message, /token bound to another nodeId/)
  await waitFor(() => wrong.conn.closed === true, { label: 'wrong node closed' })
  // 绑定校验失败不应污染节点表
  assert.equal(srv.relay.nodes.has('node-other'), false)
  assert.equal(srv.relay.nodes.has('node-bound'), true)
  assert.equal(ok.conn.closed, false)
})

/* ─────────────────────────── 重复 nodeId ─────────────────────────── */

test('relay：同 nodeId 第二个连接被 duplicate-node 拒绝，第一个仍在', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  const first = await connectNode(srv.base, 'node-dup', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'first node online' })
  const firstRec = srv.relay.nodes.get('node-dup')

  const second = await connectNode(srv.base, 'node-dup', { t })
  const err = await waitRelayError(second.frames, 'duplicate-node')
  assert.equal(err.d.nodeId, 'node-dup')

  await waitFor(() => second.conn.closed === true, { label: 'second conn closed' })
  assert.equal(first.conn.closed, false, '第一个连接必须保住（正在跑的任务不能被打断）')
  assert.equal(srv.relay.nodes.size, 1)
  assert.equal(srv.relay.nodes.get('node-dup'), firstRec, '注册表里仍是原记录')

  // 第一个仍能正常上行
  hub.frames.length = 0
  first.conn.send(encodeFrame(envelope('task/progress', { taskId: 't-dup', phase: 'alive' })))
  const up = await waitFrame(hub.frames, 'task/progress')
  assert.equal(up.from, 'node-dup')
  assert.equal(up.d.phase, 'alive')

  assert.ok(srv.events.some((e) => e.msg === 'duplicate node rejected' && e.nodeId === 'node-dup'))
})

test('relay：hello/node 的 nodeId 非法 → node-id-invalid 并关闭', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const conn = await connectRaw(
    `${srv.base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}&nodeId=bad`,
    'bad-node',
    t,
  )
  conn.conn.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, { nodeId: '-bad id', protocol: PROTOCOL_VERSION })))

  const err = await waitRelayError(conn.frames, 'node-id-invalid')
  assert.equal(err.d.code, 'node-id-invalid')
  await waitFor(() => conn.conn.closed === true, { label: 'bad node closed' })
  assert.equal(srv.relay.nodes.size, 0)
})

test('relay：未 hello 就发上行帧 → unauthorized', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const conn = await connectRaw(`${srv.base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}`, 'silent-node', t)
  conn.conn.send(encodeFrame(envelope('task/accept', { taskId: 't' })))

  const err = await waitRelayError(conn.frames, 'unauthorized')
  assert.match(err.d.message, /hello\/node required first/)
  assert.equal(srv.relay.nodes.size, 0)
})

/* ─────────────────────────── 断连 ─────────────────────────── */

test('relay：node 断开后 hub 收到 node/offline，注册表释放该节点', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-bye', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node online' })
  await waitFrame(hub.frames, RELAY_FRAME.NODE_ONLINE)
  hub.frames.length = 0

  node.conn.close(1000, 'done')

  const offline = await waitFrame(hub.frames, RELAY_FRAME.NODE_OFFLINE)
  assert.equal(offline.d.nodeId, 'node-bye')
  await waitFor(() => srv.relay.nodes.size === 0, { label: 'node removed from registry' })
  assert.equal(srv.relay.nodes.has('node-bye'), false)

  const res = await httpRequest(srv.port, { path: '/healthz' })
  assert.equal(res.json.nodes, 0)
})

test('relay：node 硬断（不发 close 帧）也清理 —— 修复 3 回归防线', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-hard', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node online' })
  await waitFrame(hub.frames, RELAY_FRAME.NODE_ONLINE)
  hub.frames.length = 0

  // 直接销毁底层 socket：不发 WebSocket close 帧，只发 FIN
  node.conn.socket.destroy()

  const offline = await waitFrame(hub.frames, RELAY_FRAME.NODE_OFFLINE)
  assert.equal(offline.d.nodeId, 'node-hard')
  await waitFor(() => srv.relay.nodes.size === 0, { label: 'hard-closed node removed' })

  // 同一 nodeId 可以重新上线（配额未被死连接永久占用）
  const again = await connectNode(srv.base, 'node-hard', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node reconnected' })
  assert.equal(again.conn.closed, false)
  const rec = srv.relay.nodes.get('node-hard')
  assert.ok(rec, '重连后节点表里有该 nodeId')
  assert.equal(rec.conn.closed, false, '注册表持有的是活的连接')
  assert.equal(again.conn.closed, false)
})

test('relay：hub 断开不影响 node 与其余 hub', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hubA = await connectHub(srv.base, t)
  const hubB = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-h', { t })
  await waitFor(() => srv.relay.hubs.size === 2 && srv.relay.nodes.size === 1, { label: 'all connected' })

  hubA.conn.close(1000, 'bye')
  await waitFor(() => srv.relay.hubs.size === 1, { label: 'hubA removed' })
  assert.equal(srv.relay.nodes.size, 1, 'hub 断开不应影响 node 注册')
  assert.equal(node.conn.closed, false)

  hubB.frames.length = 0
  node.conn.send(encodeFrame(envelope('task/end', { taskId: 't-h', status: 'completed' })))
  const up = await waitFrame(hubB.frames, 'task/end')
  assert.equal(up.from, 'node-h')
  assert.equal(up.d.status, 'completed')
})

/* ─────────────────────────── 管理接口 ─────────────────────────── */

test('relay：/api/relay/nodes 需要 hub token；/api/relay/token 铸造一次性 token', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  assert.equal((await httpRequest(srv.port, { path: '/api/relay/nodes?token=bad' })).status, 403)
  assert.equal((await httpRequest(srv.port, { path: '/api/relay/nodes' })).status, 403)

  await connectNode(srv.base, 'node-api', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node online' })

  const ok = await httpRequest(srv.port, { path: `/api/relay/nodes?token=${encodeURIComponent(HUB_TOKEN)}` })
  assert.equal(ok.status, 200)
  const body = ok.json
  assert.equal(body.nodes.length, 1)
  assert.equal(body.nodes[0].nodeId, 'node-api')
  // 只读接口不得回显任何 token
  const text = JSON.stringify(body)
  assert.equal(/hubToken|enrollToken|"token"/.test(text), false, `节点目录不得含凭证字段: ${text.slice(0, 200)}`)

  const minted = await httpRequest(srv.port, {
    method: 'POST',
    path: `/api/relay/token?token=${encodeURIComponent(HUB_TOKEN)}`,
    body: JSON.stringify({ nodeId: 'node-minted', ttlMs: 30_000 }),
  })
  assert.equal(minted.status, 200)
  const { token, expiresInMs } = minted.json
  assert.match(token, /^en_/)
  assert.equal(expiresInMs, 30_000)

  const viaMinted = await connectNode(srv.base, 'node-minted', { token, t })
  await waitFor(() => srv.relay.nodes.size === 2, { label: 'minted node online' })
  assert.equal(viaMinted.conn.closed, false)
})

test('relay：kickNode 主动断开节点', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-kick', { t })
  await waitFor(() => srv.relay.nodes.size === 1, { label: 'node online' })
  hub.frames.length = 0

  assert.equal(srv.relay.kickNode('node-kick', 'revoked'), true)
  assert.equal(srv.relay.kickNode('node-absent'), false)

  await waitFor(() => node.conn.closed === true, { label: 'kicked node closed' })
  const offline = await waitFrame(hub.frames, RELAY_FRAME.NODE_OFFLINE)
  assert.equal(offline.d.nodeId, 'node-kick')
  await waitFor(() => srv.relay.nodes.size === 0, { label: 'kicked node removed' })
})

test('relay：close() 关掉全部连接并停止监听', async (t) => {
  const srv = await startRelay(t)
  const hub = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-close', { t })
  await waitFor(() => srv.relay.nodes.size === 1 && srv.relay.hubs.size === 1, { label: 'connected' })

  await srv.close()
  await waitFor(() => hub.conn.closed === true, { label: 'hub closed' })
  await waitFor(() => node.conn.closed === true, { label: 'node closed' })
  assert.equal(srv.relay.nodes.size, 0)
  assert.equal(srv.relay.hubs.size, 0)
  assert.equal(srv.relay.address(), null, '监听应已停止')
})

test('createRelay：缺 token 直接抛', () => {
  assert.throws(() => createRelay({ port: 0 }), /hubToken and enrollToken/)
  assert.throws(() => createRelay({ port: 0, hubToken: 'a' }), /hubToken and enrollToken/)
})

test('tokenFingerprint：稳定、不泄露原文', () => {
  const tok = newRelayToken('rt')
  const fp = tokenFingerprint(tok)
  assert.equal(fp.length, 12)
  assert.equal(fp, tokenFingerprint(tok))
  assert.notEqual(fp, tok)
  assert.equal(tok.includes(fp), false)
})

/* ══════════════════════════════════════════════════════════════════════
 * 冻结层缺陷回归护栏
 * 以下用例断言的是**当前实际（缺陷）行为**，用于让缺陷可见、可追踪、可回归。
 * 修复后这些断言会失败 —— 那是修复成功的信号，届时同步更新即可。
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * [D2 已修复] RELAY_FRAME.ERROR 常量补齐 → 中继错误帧带 t，双方可正确识别。
 *
 * 原缺陷：lib/protocol.js 的 RELAY_FRAME 里没有 ERROR，而 lib/relay.js 有 8 处
 * `sendJson(conn, RELAY_FRAME.ERROR, ...)`。`RELAY_FRAME.ERROR` === undefined，
 * 对象展开时该键被省略 → 错误帧变成 `{"v":1,"id":..,"d":{"code":..}}`，**没有 t**。
 * 接收方先过 decodeFrame()，缺 t 判 `missing-type` 直接丢弃。
 *
 * 真实后果（不只是日志）：lib/node/transport.js 靠这个分支实现
 * 「duplicate-node / node-id-invalid / unauthorized / revoked 不重连，停下等人工」，
 * 缺陷存在时这些结构化错误全部退化成通用 bad-frame，stop() 分支永不执行
 * → 被拒的节点会一直指数退避重连，反复撞中继。
 *
 * 修复：protocol.js 的 RELAY_FRAME 增加 `ERROR: 'error'`。
 * 本用例现断言**修复后的正确行为**。
 */
test('[D2 回归] 中继错误帧带 t=error，可过 decodeFrame 并被接收侧识别', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  // 常量已补齐
  assert.equal(RELAY_FRAME.ERROR, 'error', 'D2 修复：RELAY_FRAME.ERROR 必须是 "error"')

  const conn = await connectRaw(`${srv.base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}`, 'd2-node', t)
  conn.conn.send(encodeFrame(envelope('task/accept', { taskId: 't' })))

  const raw = await waitFor(
    () => conn.frames.find((f) => f.d && f.d.code === 'unauthorized'),
    { label: 'unauthorized error frame' },
  )

  // 修复后：错误帧带 t
  assert.equal('t' in raw, true, 'D2 修复：错误帧必须带 t 字段')
  assert.equal(raw.t, RELAY_FRAME.ERROR, 'D2 修复：t 必须等于 RELAY_FRAME.ERROR')
  assert.equal(raw.v, PROTOCOL_VERSION, 'v 仍在')

  // 关键回归防线：错误帧能过 decodeFrame —— 缺陷存在时这里会返回 missing-type
  const dec = decodeFrame(Buffer.from(JSON.stringify(raw), 'utf8'))
  assert.equal(dec.ok, true, 'D2 修复：错误帧必须能过 decodeFrame')
  assert.equal(dec.frame.t, RELAY_FRAME.ERROR, 'D2 修复：解出的 t 正确')
  assert.equal(dec.frame.d.code, 'unauthorized', 'D2 修复：code 保留')

  // 识别有语义：错误帧匹配，正常帧不匹配（缺陷时二者都是 undefined===undefined 的巧合匹配）
  assert.equal(raw.t === RELAY_FRAME.ERROR, true, 'D2 修复：错误帧匹配')
  assert.equal('ping' === RELAY_FRAME.ERROR, false, 'D2 修复：正常帧不误匹配')

  // 接收侧真实路径能拿到结构化错误（transport.js 的 stop() 分支依赖它）
  const normal = decodeFrame(encodeFrame(envelope('ping', {})))
  assert.equal(normal.ok, true)

  // 对照：node-id-invalid 等错误帧同样带 t
  const bad = await connectRaw(
    `${srv.base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}&nodeId=bad`,
    'd2-bad',
    t,
  )
  bad.conn.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, { nodeId: '-bad id', protocol: PROTOCOL_VERSION })))
  const badFrame = await waitFor(() => bad.frames.find((f) => f.d && f.d.code === 'node-id-invalid'), {
    label: 'node-id-invalid frame',
  })
  assert.equal(badFrame.t, RELAY_FRAME.ERROR, 'D2 修复：所有中继错误帧都带 t')
  assert.equal(decodeFrame(Buffer.from(JSON.stringify(badFrame), 'utf8')).ok, true)
})

/**
 * [D3] relay 用 TEXT 帧转发二进制下行帧 → 净荷被 UTF-8 有损转换。
 *
 * 位置：lib/relay.js:136-144 forwardToNode() 内部用 `rec.conn.send(text)`，
 *       而 lib/relay.js:234 的 hub 二进制分支调用 `forwardToNode(to, out, out.length)`
 *       时 `out` 是 encodeBinaryFrame() 产出的 Buffer。
 *       ws.js:243 send() 会做 `Buffer.from(String(text),'utf8')` ——
 *       String(Buffer) 走 UTF-8 解码，非法字节序列变成 U+FFFD。
 *
 * 现象（本机实测，hub → relay → node 方向）：
 *   发出(hex): 00377b2276223a312c...7d 00fffe8001c32841   (65 字节)
 *   收到(hex): 00377b2276223a312c...7d 00efbfbdefbfbdefbfbd01efbfbd2841 (73 字节)
 *   isBinary = false（应以 BINARY 送达）
 *   0xff/0xfe/0x80 全部变成 EF BF BD（U+FFFD 替换字符），长度膨胀 65→73。
 *
 * ⚠ 严重性评级（本仓实测后修正）：
 *   这是**潜伏缺陷，v0.1 产品流程不可达**。hub → node 二进制下行通道
 *   没有任何调用者 —— NodeRegistry.sendBinary（node-registry.js:1034）在全仓
 *   只被自己引用，pull-manager / tools / hub/index 都不调用它。
 *   产物分块是 **node → hub** 方向，走 broadcastHubsBinary() → sendBinary()
 *   （BINARY 帧，字节安全），所以 relay 模式下 pull 实际是好的
 *   （见 hub-worker-e2e.test.js 的 relay pull 用例）。
 *   但一旦有人用上这条通道（例如后续做双向文件同步 / hub 主动推产物），
 *   就会立刻踩中，所以仍需修复并保留本护栏。
 */
test('[D3 回归] relay 以 BINARY 转发二进制下行帧，净荷逐字节无损', async (t) => {
  const srv = await startRelay(t)
  t.after(() => srv.close())

  const hub = await connectHub(srv.base, t)
  const node = await connectNode(srv.base, 'node-bin3', { t })
  await waitFor(() => srv.relay.nodes.size === 1 && srv.relay.hubs.size === 1, { label: 'connected' })
  node.binaries.length = 0
  node.frames.length = 0
  node.raw.length = 0

  // 净荷刻意包含非法 UTF-8 序列：修复前它们会被替换成 U+FFFD 而损坏整帧
  const payload = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28, 0x41])
  const sent = encodeBinaryFrame({ v: 1, t: 'artifact/chunk', pullId: 'p-3', to: 'node-bin3' }, payload)
  hub.conn.sendBinary(sent)

  // 修复后：以 BINARY 送达，落进 binaries
  const got = await waitFor(() => node.binaries[0], { label: 'downward binary frame (BINARY)' })
  assert.equal(node.binaries.length, 1, 'D3 修复：hub→node 二进制帧以 BINARY 送达')

  // 长度与逐字节都必须一致 —— 缺陷存在时这里长度会膨胀（65→73）且字节被替换
  assert.equal(got.length, sent.length, `D3 修复：长度一致 ${sent.length}`)
  assert.equal(Buffer.compare(sent, got), 0, 'D3 修复：hub→node 二进制帧净荷逐字节一致')

  // 净荷区不含 U+FFFD，原始非法 UTF-8 序列完整保留
  const headLen = sent.readUInt16BE(0)
  const payloadGot = got.subarray(2 + headLen)
  assert.equal(payloadGot.includes(Buffer.from([0xef, 0xbf, 0xbd])), false, 'D3 修复：净荷无 U+FFFD 替换字符')
  assert.equal(payloadGot.includes(Buffer.from([0xff, 0xfe, 0x80])), true, 'D3 修复：原始 0xff 0xfe 0x80 序列保留')

  // 解码后与发出内容完全一致
  const dec = decodeBinaryFrame(got)
  assert.equal(dec.ok, true, '二进制布局可解析')
  assert.equal(Buffer.compare(dec.payload, payload), 0, 'D3 修复：净荷与发出内容一致')
  assert.equal(dec.header.pullId, 'p-3', 'D3 修复：头部字段保留')

  // 对照：node → hub 方向本就正确
  hub.binaries.length = 0
  node.conn.sendBinary(encodeBinaryFrame({ v: 1, t: 'artifact/chunk', pullId: 'p-4' }, payload))
  const upOk = await waitFor(() => hub.binaries[0], { label: 'upward binary frame' })
  const upDec = decodeBinaryFrame(upOk)
  assert.equal(upDec.ok, true)
  assert.equal(Buffer.compare(upDec.payload, payload), 0, 'node→hub 方向逐字节正确（对照组）')
})
