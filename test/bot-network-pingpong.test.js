import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createBotNetwork } from '../lib/node/bot-network.js'
import { createHubBotNetwork } from '../lib/hub/bot-network.js'

const from = { id: 'alpha', name: 'Alpha', nodeId: 'node-a' }
const to = { id: 'beta', name: 'Beta', nodeId: 'node-b' }
const message = () => ({ exchangeId: 'pingpong-1', kind: 'ask', from: { ...from }, to: { ...to }, text: 'ping', depth: 0 })

test('A: two nodes whose handlers always return text stop exchanging frames', async t => {
  const frames = []
  const pending = new Set()
  const nodes = new Map()
  for (const identity of [from, to]) {
    const network = createBotNetwork({ nodeId: identity.nodeId, send(type, data) {
      frames.push({ type, data })
      // Yield like a transport so a broken reply loop cannot starve the test timer.
      const handle = setImmediate(() => {
        pending.delete(handle)
        void nodes.get(data.to.nodeId).receiveMessage(JSON.parse(JSON.stringify(data)))
      })
      pending.add(handle)
      return true
    } })
    nodes.set(identity.nodeId, network)
    network.onMessage(() => 'pong')
  }
  t.after(() => {
    for (const network of nodes.values()) network.dispose()
    for (const handle of pending) clearImmediate(handle)
  })
  assert.equal(nodes.get(from.nodeId).send(message()), true)
  await delay(200)
  const count = frames.length
  await delay(50)
  t.diagnostic(`frames at 200ms: ${count}; at 250ms: ${frames.length}`)
  assert.ok(count <= 6, `expected <= 6 frames, got ${count}`)
  assert.equal(frames.length, count, 'frame exchange must stop')
  assert.deepEqual(frames.map(({ data }) => [data.kind, data.depth]), [['ask', 0], ['reply', 1]])
})

test('B: reply is delivered but its handler text never generates an automatic reply', async t => {
  const sent = []
  const received = []
  const network = createBotNetwork({ nodeId: to.nodeId, send: (...args) => { sent.push(args); return true } })
  t.after(() => network.dispose())
  network.onMessage(payload => { received.push(payload); return 'must not send' })
  const reply = { ...message(), kind: 'reply', depth: 1 }
  await network.receiveMessage(reply)
  assert.deepEqual(received, [reply])
  assert.deepEqual(sent, [])
})

test('C: inbound depth 4 is dropped without delivery or reply and warns with routing context', async t => {
  const warnings = []
  const sent = []
  let calls = 0
  const network = createBotNetwork({ nodeId: to.nodeId,
    send: (...args) => { sent.push(args); return true },
    logger: { warn: (...args) => warnings.push(args) } })
  t.after(() => network.dispose())
  network.onMessage(() => { calls++; return 'must not send' })
  const payload = { ...message(), depth: 4 }
  await network.receiveMessage(payload)
  assert.equal(calls, 0)
  assert.deepEqual(sent, [])
  assert.equal(warnings.length, 1)
  const [, context] = warnings[0]
  assert.equal(context.exchangeId, payload.exchangeId)
  assert.deepEqual(context.from, from)
  assert.deepEqual(context.to, to)
})

test('D: exchangeId + kind deduplication covers in-flight replies and expires after 60 seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const network = createBotNetwork({ nodeId: to.nodeId })
  t.after(() => network.dispose())
  const received = []
  let release
  network.onMessage(async payload => {
    received.push(payload.kind)
    if (received.length === 1) await new Promise(resolve => { release = resolve })
    return null
  })
  const reply = { ...message(), kind: 'reply', depth: 1 }
  const first = network.receiveMessage(reply)
  await network.receiveMessage(reply)
  const inFlightCalls = received.length
  release()
  await first
  assert.equal(inFlightCalls, 1)
  await network.receiveMessage(message())
  await network.receiveMessage(message())
  await network.receiveMessage(reply)
  assert.deepEqual(received, ['reply', 'ask'])
  t.mock.timers.tick(59999)
  await network.receiveMessage(reply)
  assert.equal(received.length, 2)
  t.mock.timers.tick(1)
  await network.receiveMessage(reply)
  assert.deepEqual(received, ['reply', 'ask', 'reply'])
})

test('automatic replies increment inbound depth; depth 3 cannot produce depth 4', async t => {
  const sent = []
  const warnings = []
  const network = createBotNetwork({ nodeId: to.nodeId,
    send: (type, payload) => { sent.push(payload); return true },
    logger: { warn: (...args) => warnings.push(args) } })
  t.after(() => network.dispose())
  network.onMessage(() => 'pong')
  for (const depth of [0, 1, 2, 3]) {
    await network.receiveMessage({ ...message(), exchangeId: `depth-${depth}`, depth })
  }
  assert.deepEqual(sent.map(payload => payload.depth), [1, 2, 3])
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][1].exchangeId, 'depth-3')
  assert.deepEqual(warnings[0][1].from, to)
  assert.deepEqual(warnings[0][1].to, from)
})

test('local sends default to depth 0 and outbound depth 4 is dropped with a warning', t => {
  const sent = []
  const warnings = []
  const network = createBotNetwork({ nodeId: from.nodeId,
    send: (type, payload) => { sent.push(payload); return true },
    logger: { warn: (...args) => warnings.push(args) } })
  t.after(() => network.dispose())
  const local = message()
  delete local.depth
  assert.equal(network.send(local), true)
  assert.deepEqual(sent, [message()])
  assert.equal(network.send({ ...message(), depth: 4 }), false)
  assert.equal(sent.length, 1)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][1].exchangeId, local.exchangeId)
  assert.deepEqual(warnings[0][1].from, from)
  assert.deepEqual(warnings[0][1].to, to)
})

test('hub sendMessage rejects unknown destinations and mismatched to.nodeId before sending', t => {
  const registry = new EventEmitter()
  registry.nodes = new Map([[from.nodeId, {}], [to.nodeId, {}]])
  const sent = []
  registry.send = (...args) => { sent.push(args); return true }
  const network = createHubBotNetwork({ registry })
  t.after(() => network.dispose())
  const invalid = { code: 'bot-message-invalid' }
  assert.throws(() => network.sendMessage(to.nodeId, { ...message(), to: from }), invalid)
  assert.throws(() => network.sendMessage(to.nodeId, { ...message(), to: { ...to, nodeId: 'unknown' } }), invalid)
  assert.throws(() => network.sendMessage('unknown', { ...message(), to: { ...to, nodeId: 'unknown' } }), invalid)
  assert.deepEqual(sent, [])
})
