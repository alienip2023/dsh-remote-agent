import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { generateIdentity } from '../lib/identity.js'
import { generateEphemeral } from '../lib/e2e.js'
import { PEER, PROTOCOL_VERSION, envelope, encodeFrame, validateHello } from '../lib/protocol.js'
import { startListenServer } from '../lib/listen-server.js'
import { createPeerRouter, PeerLink } from '../lib/node/peer-link.js'
import { attachPeerConnection, startPeerListener, validPeerSecret } from '../lib/node/peer-listener.js'
import { createTurnReplay } from '../lib/node/turn-replay.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { BOT_MESSAGE_REPLAY_MS } from '../lib/node/bot-network.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createHubBotNetwork } from '../lib/hub/bot-network.js'
import { applyWorker, buildNodeHello } from '../lib/node/index.js'
import { NodeTransport } from '../lib/node/transport.js'

const secret = 'ab'.repeat(32)
const tick = () => new Promise(resolve => setImmediate(resolve))

/** Same HTTP/WS entry points and codecs, with only the OS sockets replaced. */
function useMemoryNetwork(t) {
  const endpoints = new Map()
  let nextPort = 24000
  class Socket extends EventEmitter {
    writableLength = 0
    destroyed = false
    remoteAddress = '127.0.0.1'
    write(bytes) {
      if (this.destroyed) return false
      if (bytes.toString().startsWith('HTTP/1.1')) return true
      const copy = Buffer.from(bytes)
      queueMicrotask(() => { if (!this.peer.destroyed) this.peer.emit('data', copy) })
      return true
    }
    setNoDelay() {}
    setTimeout() {}
    end() { this.destroy() }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('close')
      if (!this.peer.destroyed) { this.peer.destroyed = true; this.peer.emit('end'); this.peer.emit('close') }
    }
  }
  t.mock.method(http.Server.prototype, 'listen', function (port, host, callback) {
    this.memoryAddress = { address: host, port: port || ++nextPort }
    endpoints.set(this.memoryAddress.port, this)
    queueMicrotask(callback)
    return this
  })
  t.mock.method(http.Server.prototype, 'address', function () { return this.memoryAddress ?? null })
  t.mock.method(http.Server.prototype, 'close', function (callback) {
    endpoints.delete(this.memoryAddress?.port)
    this.memoryAddress = null
    callback?.()
    return this
  })
  t.mock.method(http, 'request', options => {
    const request = new EventEmitter()
    request.destroy = () => {}
    request.end = () => queueMicrotask(() => {
      const server = endpoints.get(Number(options.port))
      if (!server) { request.emit('error', new Error('ECONNREFUSED')); return }
      const client = new Socket()
      const remote = new Socket()
      client.peer = remote
      remote.peer = client
      const headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]))
      const accept = createHash('sha1').update(headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      // The HTTP parser belongs to the replaced OS layer; retain the plugin's socket tracking.
      for (const listener of server.listeners('connection')) if (listener.name !== 'connectionListener') listener.call(server, remote)
      server.emit('upgrade', { url: options.path, headers, socket: remote }, remote, Buffer.alloc(0))
      request.emit('upgrade', { headers: { 'sec-websocket-accept': accept } }, client, Buffer.alloc(0))
    })
    return request
  })
}
async function until(predicate, message = 'condition', timeoutMs = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
class FakeConn extends EventEmitter {
  closed = false
  sent = []
  send(raw) { this.sent.push(JSON.parse(raw)); return !this.closed }
  close() { this.closed = true; this.emit('close') }
  destroy() { this.close() }
}
const hello = (data = {}) => envelope(PEER.HELLO, { nodeId: 'a', protocol: PROTOCOL_VERSION, time: Date.now(),
  secret, pub: generateEphemeral().publicKeyB64, ...data })

test('peer secret rejects wrong, missing, empty and malformed credentials without logging secrets', () => {
  for (const received of [undefined, null, '', 'x', 'cd'.repeat(32), 'ab'.repeat(31), '中'.repeat(64), [], {}]) {
    assert.equal(validPeerSecret(secret, received), false)
    const conn = new FakeConn()
    const logs = []
    attachPeerConnection(conn, { nodeId: 'b', getSecret: () => secret, onFrame: () => assert.fail('unauthorized dispatch'),
      remote: '127.0.0.2', log: (...args) => logs.push(args) })
    conn.emit('message', encodeFrame(hello({ secret: received })), false)
    assert.equal(conn.closed, true)
    assert.equal(conn.sent[0].t, 'error')
    assert.equal(conn.sent[0].d.code, 'peer-auth-failed')
    assert.equal(logs[0][2].remote, '127.0.0.2')
    assert.equal(JSON.stringify(logs).includes(secret), false)
  }
  assert.equal(validPeerSecret('', ''), false)
  assert.equal(validPeerSecret(secret, secret), true)
})

test('peer hello is mandatory within five seconds; wrong protocol is rejected', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const conn = new FakeConn()
  attachPeerConnection(conn, { nodeId: 'b', getSecret: () => secret })
  t.mock.timers.tick(4999)
  assert.equal(conn.closed, false)
  t.mock.timers.tick(1)
  assert.equal(conn.closed, true)
  const wrong = new FakeConn()
  attachPeerConnection(wrong, { nodeId: 'b', getSecret: () => secret })
  wrong.emit('message', encodeFrame(hello({ protocol: 999 })), false)
  assert.equal(wrong.sent[0].d.code, 'peer-auth-failed')
})

test('peer whitelist rejects task, control, unknown and binary frames after authentication', () => {
  for (const type of ['task/start', 'task/cancel', 'fs/req', PEER.DIRECTORY, PEER.HELLO, 'unknown', 'binary']) {
    const conn = new FakeConn()
    attachPeerConnection(conn, { nodeId: 'b', getSecret: () => secret, onFrame: () => assert.fail('forbidden dispatch') })
    conn.emit('message', encodeFrame(hello()), false)
    assert.equal(conn.sent[0].t, PEER.WELCOME)
    conn.emit('message', type === 'binary' ? Buffer.from('bad') : encodeFrame(envelope(type, {})), type === 'binary')
    assert.equal(conn.sent.at(-1).d.code, 'peer-frame-forbidden')
    assert.equal(conn.closed, true)
  }
})

test('turn replay caches pending and completed results for five minutes with a 512 entry bound', async () => {
  let now = 1000
  const replay = createTurnReplay({ now: () => now })
  let calls = 0
  let release
  const sent = []
  const execute = async () => { calls++; await new Promise(resolve => { release = resolve }); return ['bot/turn-result', { text: 'cached', seq: 0 }] }
  const first = replay.run('one', execute, (...args) => sent.push(args))
  const second = replay.run('one', execute, (...args) => sent.push(args))
  await tick()
  assert.equal(calls, 1)
  release()
  await Promise.all([first, second])
  assert.deepEqual(sent[0], sent[1])
  now += 299999
  await replay.run('one', () => assert.fail('still cached'), (...args) => sent.push(args))
  now++
  await replay.run('one', async () => { calls++; return ['bot/turn-result', {}] }, () => {})
  assert.equal(calls, 2)
  for (let i = 0; i < 512; i++) await replay.run(String(i), async () => null, () => {})
  assert.equal(replay.size, 512)
  await replay.run('one', async () => { calls++; return null }, () => {})
  assert.equal(calls, 3)
  replay.clear()
  assert.equal(replay.size, 0)
})

test('shared dispatcher executes once and returns the same seq/result on both paths', async () => {
  let calls = 0
  let release
  const replies = []
  const send = (...args) => { replies.push(args); return true }
  const dispatch = createFrameDispatcher({ peerDirect: true, send, ctx: { get: () => async () => {
    calls++; await new Promise(resolve => { release = resolve }); return { text: 'answer' }
  } } })
  const frame = envelope('bot/turn', { nodeId: 'b', remoteBotId: 'bot', exchangeId: 'same', text: 'hello' })
  dispatch(frame)
  dispatch({ ...frame, id: 'hub-replay' }, undefined, send)
  await tick()
  assert.equal(calls, 1)
  release()
  await until(() => replies.length === 2)
  dispatch(frame)
  await until(() => replies.length === 3)
  assert.equal(calls, 1)
  assert.deepEqual(replies[0], replies[1])
  assert.deepEqual(replies[1], replies[2])
})

test('peer failure falls back exactly once, including throwing fallback and repeated disconnect', async () => {
  for (const mode of ['false', 'throw', 'disconnect']) {
    let fallbacks = 0
    let dials = 0
    const logs = []
    const link = new EventEmitter()
    Object.assign(link, { url: 'ws://127.0.0.1:1/api/remote-agent/peer', secret,
      stop() {}, async send() { if (mode === 'throw') throw new Error('write failed'); return mode === 'disconnect' } })
    const router = createPeerRouter({ nodeId: 'a', makeLink: () => { dials++; return link },
      fallback: () => { fallbacks++; throw new Error('hub failed too') }, log: (...args) => logs.push(args) })
    router.directory([{ nodeId: 'b', url: link.url }])
    router.credentials([{ nodeId: 'b', secret }])
    assert.equal(router.send('b', 'bot/turn', { exchangeId: 'once' }), true)
    await tick()
    link.emit('disconnect')
    link.emit('disconnect')
    await tick()
    assert.equal(fallbacks, 1, mode)
    assert.equal(logs.length, 1, mode)
    assert.equal(dials, 1)
    router.stop()
  }
})

test('forwarded Bot messages remain replayable when TCP accepts a write before reporting disconnect', async () => {
  for (const kind of ['ask', 'reply']) {
    const link = new EventEmitter()
    let writes = 0
    const fallbacks = []
    const logs = []
    Object.assign(link, { url: 'ws://127.0.0.1:1/api/remote-agent/peer', secret,
      stop() {}, async send() { writes++; return true } })
    const router = createPeerRouter({ nodeId: '@hub', makeLink: () => link,
      fallback: (...args) => { fallbacks.push(args); return true }, log: (...args) => logs.push(args) })
    router.directory([{ nodeId: 'b', url: link.url }])
    router.credentials([{ nodeId: 'b', secret }])
    const message = { exchangeId: `forwarded-${kind}`, kind,
      from: { nodeId: 'a', id: 'alpha', name: 'Alpha' }, to: { nodeId: 'b', id: 'beta', name: 'Beta' },
      text: 'queued before disconnect', depth: 0 }
    assert.equal(router.send('b', 'bot/message', message), true)
    await tick()
    assert.equal(writes, 1)
    assert.equal(fallbacks.length, 0)
    link.emit('disconnect')
    link.emit('disconnect')
    await tick()
    assert.deepEqual(fallbacks, [['b', 'bot/message', message, undefined]])
    assert.equal(logs.length, 1)
    router.stop()
  }
})

test('disconnect replay of Bot messages expires within the receiver dedupe window', async t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  for (const age of [BOT_MESSAGE_REPLAY_MS - 1, BOT_MESSAGE_REPLAY_MS]) {
    const link = new EventEmitter()
    let fallbacks = 0
    Object.assign(link, { url: 'ws://127.0.0.1:1/api/remote-agent/peer', secret,
      stop() {}, async send() { return true } })
    const router = createPeerRouter({ nodeId: '@hub', makeLink: () => link,
      fallback: () => { fallbacks++; return true } })
    router.directory([{ nodeId: 'b', url: link.url }])
    router.credentials([{ nodeId: 'b', secret }])
    router.send('b', 'bot/message', { exchangeId: `expires-${age}`, kind: 'reply' })
    await tick()
    now += age
    link.emit('disconnect')
    assert.equal(fallbacks, age < BOT_MESSAGE_REPLAY_MS ? 1 : 0)
    router.stop()
  }
})

for (const mode of ['tcp', 'memory']) test(`PeerLink is lazy, shares concurrent dial, encrypts Bot frames and measures heartbeat RTT (${mode})`, async t => {
  if (mode === 'memory') useMemoryNetwork(t)
  const received = []
  const listener = await startPeerListener({ nodeId: 'b', host: '127.0.0.1', port: 0, getSecret: () => secret,
    onFrame: (frame, reply) => { received.push(frame); reply('bot/turn-result', { exchangeId: frame.d.exchangeId }) } })
  const link = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: listener.url, secret, heartbeatMs: 10 })
  t.after(async () => { link.stop(); await listener.close() })
  assert.equal(link.state, 'idle')
  const p1 = link.ready()
  const p2 = link.ready()
  assert.equal(p1, p2)
  await p1
  assert.equal(link.state, 'connected')
  const write = link.conn.send.bind(link.conn)
  link.conn.send = raw => {
    const frame = JSON.parse(raw)
    if (frame.t === 'bot/turn') {
      assert.equal(frame.d.e2e, 1)
      assert.equal(raw.includes('private body'), false)
    }
    return write(raw)
  }
  const result = once(link, 'frame')
  assert.equal(await link.send('bot/turn', { exchangeId: 'test', text: 'private body' }), true)
  assert.equal((await result)[0].t, 'bot/turn-result')
  assert.equal(received[0].d.text, 'private body')
  await until(() => link.pingAt !== undefined && link.lastPong >= link.pingAt, 'heartbeat')
  assert.ok(link.rttMs >= 0)
  assert.equal(await link.send('task/start', {}), false)
  Object.defineProperty(link.conn, 'bufferedBytes', { value: 3 * 1024 * 1024, configurable: true })
  assert.equal(await link.send('bot/message', {}), false)
})

for (const mode of ['tcp', 'memory']) test(`PeerLink bounds upgrade plus hello by 800ms and ignores late connections after stop (${mode})`, async t => {
  if (mode === 'memory') useMemoryNetwork(t)
  const server = await startListenServer({ host: '127.0.0.1', port: 0, path: '/api/remote-agent/peer',
    onUpgrade: conn => conn.on('error', () => {}) })
  const link = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', url: `ws://127.0.0.1:${server.port}/api/remote-agent/peer`, secret })
  t.after(async () => { link.stop(); await server.close() })
  const started = Date.now()
  assert.equal(await link.send('bot/turn', {}), false)
  assert.ok(Date.now() - started < 1500)
  assert.equal(link.state, 'failed')
  let resolve
  const late = new PeerLink({ nodeId: 'a', remoteNodeId: 'b', secret, connectFn: () => new Promise(done => { resolve = done }) })
  const send = late.send('bot/message', {})
  await tick()
  late.stop()
  const conn = new FakeConn()
  resolve(conn)
  assert.equal(await send, false)
  await tick()
  assert.equal(conn.closed, true)
})

test('disabled hello and WELCOME retain the original fields; peer directory contains no secret', () => {
  const registry = new NodeRegistry({ log() {} })
  const conn = new FakeConn()
  const original = buildNodeHello({ peerDirect: false })
  assert.equal(Object.hasOwn(original, 'peerUrl'), false)
  registry.ingestHello({ helloData: original, conn, transport: 'direct' })
  assert.equal(Object.hasOwn(conn.sent[0].d, 'peerSecret'), false)
  assert.equal(conn.sent.some(frame => frame.t === PEER.DIRECTORY), false)
  assert.equal(validateHello({ ...original, peerUrl: 'ws://user:secret@127.0.0.1/api/remote-agent/peer' }).hello.peerUrl, undefined)
  registry.dispose()
})

for (const mode of ['tcp', 'memory']) test(`one hub and two assembled workers use peer Bot paths, replay once, then fall back after peer removal (${mode})`, async t => {
  if (mode === 'memory') useMemoryNetwork(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-peer-integration-'))
  const logs = []
  const hubFrames = []
  const servers = new Map()
  const transports = new Map()
  const originalListen = http.Server.prototype.listen
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    const sockets = new Set()
    this.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    servers.set(this, sockets)
    return originalListen.apply(this, args)
  })
  const originalOn = NodeTransport.prototype.on
  t.mock.method(NodeTransport.prototype, 'on', function (...args) { transports.set(this.hello.nodeId, this); return originalOn.apply(this, args) })
  const registry = new NodeRegistry({ identity: generateIdentity(), log: (...args) => logs.push(args) })
  const originalHubSend = registry.sendViaHub.bind(registry)
  registry.sendViaHub = (nodeId, type, ...args) => { hubFrames.push({ nodeId, type }); return originalHubSend(nodeId, type, ...args) }
  const hub = await startListenServer({ host: '127.0.0.1', port: 0, path: '/api/remote-agent/node',
    onUpgrade: conn => registry.attachDirect(conn) })
  const contexts = []
  const disposers = []
  const quiet = { info() {}, debug() {}, warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }
  const botHub = createHubBotNetwork({ registry, ctx: { get: () => payload => botHub.sendMessage(payload.to.nodeId, payload) } })
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose()
    botHub.dispose()
    registry.dispose()
    await hub.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  let turns = 0
  let release
  for (const nodeId of ['a', 'b']) {
    const services = new Map()
    const routes = new Map()
    services.set('webServer', { register: route => { routes.set(route.path, route.handler) } })
    services.set('test:routes', routes)
    services.set('remote-agent:bot-turn', async () => {
      turns++
      if (release === undefined) await new Promise(resolve => { release = resolve })
      return { text: 'turn answer' }
    })
    const ctx = { logger: quiet, get: key => services.get(key), provide: (key, value) => services.set(key, value), set: (key, value) => services.set(key, value) }
    contexts.push(ctx)
    disposers.push(applyWorker(ctx, { nodeId, transportMode: 'direct', hubUrl: `ws://127.0.0.1:${hub.port}/api/remote-agent/node`,
      stateDir: path.join(root, nodeId), roots: [root], peerDirect: true, peerListenHost: '127.0.0.1', peerListenPort: 0,
      resourceIntervalMs: 0, reposIntervalMs: 0 }))
  }
  await until(() => [...transports.values()].length === 2 && [...transports.values()].every(transport => transport.e2e), 'hub E2E')
  await until(() => contexts.every(ctx => ctx.get('remote-agent:peer-direct').snapshot().peers.length === 1), 'peer directory')
  const directories = []
  transports.get('a').on('frame', frame => { if (frame.t === PEER.DIRECTORY) directories.push(frame) })
  registry.sendPeerCredentials(registry.nodes.get('a'))
  await until(() => directories.length > 0)
  assert.equal(JSON.stringify(directories).includes(registry.nodes.get('b').peerSecret), false)
  for (const peer of directories[0].d.peers) assert.deepEqual(Object.keys(peer).sort(), ['nodeId', 'url'])
  const turn = { nodeId: 'b', remoteBotId: 'beta', exchangeId: 'direct-turn', text: 'hello' }
  const results = []
  registry.on('botTurnResult', result => results.push(result))
  const before = hubFrames.length
  assert.equal(registry.send('b', 'bot/turn', turn), true)
  await until(() => turns === 1, 'peer turn execution')
  assert.equal(hubFrames.slice(before).some(frame => frame.type === 'bot/turn'), false)
  // The hub path replays while the direct execution is still pending.
  originalHubSend('b', 'bot/turn', turn)
  release()
  await until(() => results.length === 2, 'cached result on both paths')
  assert.equal(turns, 1)
  assert.deepEqual(results[0], results[1])
  const peerResults = []
  contexts[0].set('remote-agent:bot-turn-result', result => peerResults.push(result))
  const nodeTurnStart = hubFrames.length
  contexts[0].get('remote-agent:peer-direct').send('b', 'bot/turn', { ...turn, exchangeId: 'node-turn' })
  await until(() => peerResults.length === 1, 'node-to-node turn result')
  assert.equal(hubFrames.slice(nodeTurnStart).some(frame => ['bot/turn', 'bot/turn-result'].includes(frame.type)), false)
  const messages = []
  const a = contexts[0].get('remote-agent:bot-network')
  const b = contexts[1].get('remote-agent:bot-network')
  a.onMessage(payload => { messages.push(payload); return null })
  b.onMessage(() => 'peer answer')
  const message = { exchangeId: 'peer-message', kind: 'ask', text: 'hello', depth: 0,
    from: { nodeId: 'a', id: 'alpha', name: 'Alpha' }, to: { nodeId: 'b', id: 'beta', name: 'Beta' } }
  const messageStart = hubFrames.length
  assert.equal(a.send(message), true)
  await until(() => messages.length === 1, 'node peer ask/reply')
  assert.equal(messages[0].text, 'peer answer')
  assert.equal(hubFrames.slice(messageStart).some(frame => frame.type === 'bot/message'), false)
  const snapshot = contexts[0].get('remote-agent:peer-direct').snapshot()
  assert.equal(snapshot.enabled, true)
  assert.equal(snapshot.peers[0].state, 'connected')
  assert.equal(typeof snapshot.peers[0].rttMs, 'number')
  assert.equal(contexts[1].get('remote-agent:peer-direct').snapshot().peers[0].state, 'connected')
  const check = await registry.fsRequest('a', 'selfcheck', { purpose: 'exec' })
  assert.deepEqual(check.peerDirect, contexts[0].get('remote-agent:peer-direct').snapshot())
  let status
  await contexts[0].get('test:routes').get('/api/remote-agent/status')({ method: 'GET' }, { setHeader() {}, end: raw => { status = JSON.parse(raw) } })
  assert.deepEqual(status.peerDirect, check.peerDirect)
  const peerPort = Number(contexts[1].get('remote-agent:peer-direct').snapshot().listening.split(':').at(-1))
  for (const [server, sockets] of servers) {
    if (server.address()?.port !== peerPort) continue
    server.close()
    for (const socket of sockets) socket.destroy()
  }
  await tick()
  const fallbackStart = hubFrames.length
  registry.send('b', 'bot/turn', { ...turn, exchangeId: 'fallback-turn' })
  contexts[0].get('remote-agent:peer-direct').send('b', 'bot/turn', { ...turn, exchangeId: 'fallback-node-turn' })
  a.send({ ...message, exchangeId: 'fallback-message' })
  try {
    await until(() => results.length === 3 && messages.length === 2 && peerResults.length === 2, 'hub fallback delivery')
  } catch (error) {
    assert.fail(`${error.message} ${JSON.stringify({ turns, results, peerResults, messages, hubFrames: hubFrames.slice(fallbackStart), logs })}`)
  }
  assert.equal(turns, 4)
  assert.equal(hubFrames.slice(fallbackStart).filter(frame => frame.type === 'bot/turn').length, 2)
  assert.equal(logs.some(args => args.includes('peer-direct-fallback')), true)
  registry.markOffline('b', 'test authority')
  await until(() => contexts[0].get('remote-agent:peer-direct').snapshot().peers.length === 0, 'offline removes directory')
  assert.equal(registry.nodes.get('b').online, false)
})
