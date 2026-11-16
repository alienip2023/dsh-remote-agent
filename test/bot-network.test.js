import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as protocol from '../lib/protocol.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { applyWorker } from '../lib/node/index.js'
import { NodeTransport, isE2ERequired } from '../lib/node/transport.js'

const from = { id: 'alpha', name: 'Alpha', nodeId: 'node-a' }
const to = { id: 'beta', name: 'Beta', nodeId: 'node-b' }
const message = () => ({ exchangeId: 'exchange-1', kind: 'ask', from: { ...from }, to: { ...to }, text: 'hello', depth: 0 })
const invalidMessage = { code: 'bot-message-invalid' }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function createNetwork(options = {}) {
  const { createBotNetwork } = await import('../lib/node/bot-network.js')
  return createBotNetwork({ nodeId: 'node-b', ...options })
}

test('bot network frame constants and E2E gate', () => {
  assert.equal(protocol.HUB_TO_NODE.BOT_DIRECTORY, 'bot/directory')
  assert.equal(protocol.HUB_TO_NODE.BOT_MESSAGE, 'bot/message')
  assert.equal(protocol.NODE_TO_HUB.BOT_MESSAGE, 'bot/message')
  assert.equal(isE2ERequired('bot/directory'), true)
  assert.equal(isE2ERequired('bot/message'), true)
})

test('validateBotMessage rebuilds the payload and nested identities', () => {
  const input = { ...message(), extra: true, from: { ...from, secret: 'drop' } }
  const checked = protocol.validateBotMessage(input)
  assert.deepEqual(checked, message())
  assert.notEqual(checked.from, input.from)
  assert.deepEqual(protocol.validateBotMessage({ ...message(), kind: 'reply', text: '', depth: 3 }), { ...message(), kind: 'reply', text: '', depth: 3 })
  assert.equal(protocol.validateBotMessage({ ...message(), text: 'x'.repeat(65536) }).text.length, 65536)
})

test('validateBotMessage rejects missing, mistyped and oversized required fields', () => {
  for (const input of [null, [], 'message', {}, { ...message(), from: { id: 'alpha', name: 'Alpha' } },
    { ...message(), depth: 4 }, { ...message(), depth: -1 }, { ...message(), depth: 0.5 },
    { ...message(), text: 'x'.repeat(65537) }, { ...message(), text: 1 }, { ...message(), kind: 'unknown' }]) {
    assert.throws(() => protocol.validateBotMessage(input), invalidMessage)
  }
  for (const field of ['exchangeId', 'kind', 'from', 'to', 'text', 'depth']) {
    const input = message()
    delete input[field]
    assert.throws(() => protocol.validateBotMessage(input), invalidMessage, field)
  }
  for (const side of ['from', 'to']) {
    for (const [field, limit] of [['id', 200], ['name', 80], ['nodeId', 80]]) {
      for (const value of [undefined, null, 1, '', '   ', 'x'.repeat(limit + 1)]) {
        assert.throws(() => protocol.validateBotMessage({ ...message(), [side]: { ...message()[side], [field]: value } }), invalidMessage)
      }
      assert.equal(protocol.validateBotMessage({ ...message(), [side]: { ...message()[side], [field]: 'x'.repeat(limit) } })[side][field].length, limit)
    }
  }
  for (const exchangeId of ['', '   ', 1, 'x'.repeat(201)]) {
    assert.throws(() => protocol.validateBotMessage({ ...message(), exchangeId }), invalidMessage)
  }
})

test('validateBotDirectory drops invalid entries and rebuilds valid entries', () => {
  const bot = { ...to, role: 'helper' }
  const checked = protocol.validateBotDirectory({ bots: [null, [], {}, { ...bot, id: 'x'.repeat(201) },
    { ...bot, name: 'x'.repeat(81) }, { ...bot, nodeId: 'x'.repeat(81) }, { ...bot, name: '' },
    { ...bot, role: 1 }, { ...bot, extra: true }, { ...from, role: null }, from], at: 123, extra: true })
  assert.deepEqual(checked, { bots: [bot, { ...from, role: '' }, { ...from, role: '' }], at: 123 })
  assert.throws(() => protocol.validateBotDirectory({ bots: 'no' }), { code: 'bot-directory-invalid' })
  assert.throws(() => protocol.validateBotDirectory({ bots: Array(501).fill(bot) }), { code: 'bot-directory-invalid' })
  assert.equal(protocol.validateBotDirectory({ bots: Array(500).fill(bot) }).bots.length, 500)
})

test('node directory cache is replaced through the dispatcher and emits an isolated snapshot', async t => {
  const network = await createNetwork()
  t.after(() => network.dispose())
  assert.deepEqual(network.directory(), [])
  const events = []
  network.on('directory', bots => { events.push(bots); if (bots[0]) bots[0].name = 'changed' })
  const dispatch = createFrameDispatcher({ network })
  assert.equal(dispatch({ t: 'bot/directory', d: { bots: [{ ...to, role: '' }], at: 123 } }), true)
  assert.equal(events.length, 1)
  assert.deepEqual(network.directory(), [{ ...to, role: '' }])
  network.directory().pop()
  assert.equal(network.directory().length, 1)
  dispatch({ t: 'bot/directory', d: { bots: 'invalid' } })
  assert.equal(network.directory().length, 1)
  dispatch({ t: 'bot/directory', d: { bots: [] } })
  assert.deepEqual(network.directory(), [])
  assert.equal(dispatch({ t: 'future/frame' }), false)
})

test('node send returns false with no connection or a throwing transport', async t => {
  for (const send of [undefined, () => false, () => { throw new Error('closed') }]) {
    const network = await createNetwork({ send })
    t.after(() => network.dispose())
    assert.equal(network.send({ ...message(), from: to, to: from }), false)
  }
})

test('node send validates the local sender and rebuilds outbound payloads', async t => {
  const sent = []
  const network = await createNetwork({ send: (type, data) => { sent.push({ type, data }); return true } })
  t.after(() => network.dispose())
  const payload = { ...message(), from: to, to: from }
  assert.equal(network.send({ ...payload, extra: true }), true)
  assert.deepEqual(sent, [{ type: 'bot/message', data: payload }])
  assert.throws(() => network.send(message()), invalidMessage)
  assert.equal(network.send({ ...payload, depth: 4 }), false)
  network.dispose()
  assert.equal(network.send(payload), false)
  assert.deepEqual(network.directory(), [])
})

test('node handles an ask and automatically replies with swapped identities and bounded text', async t => {
  const sent = []
  const network = await createNetwork({ send: (type, data) => { sent.push({ type, data }); return true } })
  t.after(() => network.dispose())
  network.onMessage(async payload => { assert.deepEqual(payload, message()); return 'x'.repeat(65537) })
  const dispatch = createFrameDispatcher({ network })
  assert.equal(dispatch({ t: 'bot/message', d: message() }), true)
  await tick()
  assert.deepEqual(sent, [{ type: 'bot/message', data: { ...message(), kind: 'reply', from: to, to: from, text: 'x'.repeat(65536), depth: 1 } }])
})

test('handler errors, null results, invalid frames and unsubscribed handlers do not reply', async t => {
  const sent = []
  const network = await createNetwork({ send: (...args) => { sent.push(args); return true } })
  t.after(() => network.dispose())
  let calls = 0
  const off = network.onMessage(async () => { calls++; throw new Error('handler failed') })
  await network.receiveMessage(message())
  assert.equal(calls, 1)
  off()
  off()
  const offNull = network.onMessage(async () => null)
  await network.receiveMessage({ ...message(), exchangeId: 'null' })
  offNull()
  await network.receiveMessage({ ...message(), exchangeId: 'no-handler' })
  await network.receiveMessage({ ...message(), depth: 4 })
  assert.equal(calls, 1)
  assert.deepEqual(sent, [])
})

test('duplicate asks are suppressed while in flight and for 60 seconds; replies remain deliverable', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const network = await createNetwork()
  t.after(() => network.dispose())
  let calls = 0
  let release
  network.onMessage(async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve }); return null })
  const first = network.receiveMessage(message())
  await network.receiveMessage(message())
  assert.equal(calls, 1)
  release()
  await first
  t.mock.timers.tick(59999)
  await network.receiveMessage(message())
  assert.equal(calls, 1)
  await network.receiveMessage({ ...message(), kind: 'reply' })
  assert.equal(calls, 2)
  t.mock.timers.tick(1)
  await network.receiveMessage(message())
  assert.equal(calls, 3)
})

test('node worker exposes bot-network and wires real transport frames without a connection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-bot-network-'))
  const services = new Map()
  let transport
  const originalOn = NodeTransport.prototype.on
  t.mock.method(NodeTransport.prototype, 'on', function (...args) { transport = this; return originalOn.apply(this, args) })
  const dispose = applyWorker({ provide: (key, value) => services.set(key, value),
    set: (key, value) => services.set(key, value), get: key => services.get(key) },
  { nodeId: 'node-b', hubUrl: '', stateDir: dir, roots: [dir], resourceIntervalMs: 0, reposIntervalMs: 0 })
  try {
    const network = services.get('remote-agent:bot-network')
    assert.ok(network)
    transport.emit('frame', { t: 'bot/directory', d: { bots: [from] } })
    assert.deepEqual(network.directory(), [{ ...from, role: '' }])
    assert.equal(network.send({ ...message(), from: to, to: from }), false)
    let delivered
    network.onMessage(async payload => { delivered = payload; return null })
    transport.emit('frame', { t: 'bot/message', d: message() })
    await tick()
    assert.deepEqual(delivered, message())
  } finally { dispose(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('hub helpers send validated directory/message and forward authenticated messages to the host', async () => {
  const { createHubBotNetwork } = await import('../lib/hub/bot-network.js')
  class Core extends EventEmitter {
    constructor() { super(); this.nodes = new Map([['node-a', { nodeId: 'node-a' }], ['node-b', { nodeId: 'node-b' }]]); this.sent = []; this.logs = [] }
    send(nodeId, type, data) { this.sent.push({ nodeId, type, data }); return true }
    log(...args) { this.logs.push(args) }
  }
  const registry = new (withIngest(Core))()
  const received = []
  let handler
  const network = createHubBotNetwork({ registry, ctx: { get: () => handler }, log: (...args) => registry.log(...args) })
  try {
    assert.equal(network.sendDirectory('node-b', [{ ...from, role: '' }]), true)
    assert.equal(registry.sent[0].type, 'bot/directory')
    assert.deepEqual(registry.sent[0].data.bots, [{ ...from, role: '' }])
    assert.equal(typeof registry.sent[0].data.at, 'number')
    assert.equal(network.sendMessage('node-b', { ...message(), extra: 'drop' }), true)
    assert.deepEqual(registry.sent[1], { nodeId: 'node-b', type: 'bot/message', data: message() })
    registry.handleFrameFor('node-a', { t: 'bot/message', d: message() })
    assert.ok(registry.logs.some(([level]) => level === 'debug'))
    handler = async payload => { received.push(payload) }
    registry.handleFrameFor('node-a', { t: 'bot/message', d: { ...message(), extra: 'drop' } })
    registry.handleFrameFor('node-a', { t: 'bot/message', d: { ...message(), from: { ...from, nodeId: 'spoof' } } })
    registry.handleFrameFor('node-a', { t: 'bot/message', d: { ...message(), depth: 4 } })
    await tick()
    assert.deepEqual(received, [message()])
    handler = async () => { throw new Error('host failed') }
    registry.handleFrameFor('node-a', { t: 'bot/message', d: message() })
    await tick()
  } finally { network.dispose() }
  assert.equal(registry.listenerCount('botMessage'), 0)
})

test('assembled nodes exchange ask/reply through the hub registry and serialized transport frames', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-bot-network-roundtrip-'))
  const quiet = { info() {}, warn() {}, error() {}, debug() {} }
  const makeCtx = () => {
    const services = new Map()
    return { logger: quiet, get: key => services.get(key),
      provide(key, value) { assert.equal(services.has(key), false); services.set(key, value) },
      set(key, value) { assert.equal(services.has(key), true); services.set(key, value) } }
  }
  const ctx = makeCtx()
  const { createHubBotNetwork } = await import('../lib/hub/bot-network.js')
  const hub = { registry: new NodeRegistry({ log() {} }) }
  hub.botNetwork = createHubBotNetwork({ ctx, registry: hub.registry })
  const disposers = []
  let transport
  const originalOn = NodeTransport.prototype.on
  t.mock.method(NodeTransport.prototype, 'on', function (...args) { transport = this; return originalOn.apply(this, args) })
  try {
    const networks = []
    for (const identity of [from, to]) {
      const nodeCtx = makeCtx()
      const stateDir = path.join(dir, identity.nodeId)
      disposers.push(applyWorker(nodeCtx, { nodeId: identity.nodeId, hubUrl: '', stateDir, roots: [dir], resourceIntervalMs: 0, reposIntervalMs: 0 }))
      const nodeTransport = transport
      nodeTransport.conn = { send(raw) { hub.registry.handleFrameFor(identity.nodeId, JSON.parse(raw)); return true } }
      hub.registry.nodes.set(identity.nodeId, { nodeId: identity.nodeId, online: true, transport: 'direct',
        conn: { send(raw) { nodeTransport.emit('frame', JSON.parse(raw)) } } })
      networks.push(nodeCtx.get('remote-agent:bot-network'))
    }
    // 路由是宿主回调，测试显式安装；remote-agent 本身不决定目的地。
    ctx.provide('remote-agent:bot-message', payload => hub.botNetwork.sendMessage(payload.to.nodeId, payload))
    const received = []
    networks[0].onMessage(async payload => { received.push(payload); return null })
    networks[1].onMessage(async payload => { assert.deepEqual(payload, message()); return 'pong' })
    assert.equal(hub.botNetwork.sendDirectory('node-a', [from, to]), true)
    assert.deepEqual(networks[0].directory(), [{ ...from, role: '' }, { ...to, role: '' }])
    assert.equal(networks[0].send(message()), true)
    await tick()
    assert.deepEqual(received, [{ ...message(), kind: 'reply', from: to, to: from, text: 'pong', depth: 1 }])
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    hub.botNetwork.dispose()
    hub.registry.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(hub.registry.listenerCount('botMessage'), 0)
})
