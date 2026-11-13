// M2: node → hub Bot inventory. Drives the real sender, the real validator and the
// real ingest path; no mock of the module under test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotInventory, validateBotInventoryAck } from '../lib/protocol.js'
import { startBotInventory } from '../lib/node/bot-inventory.js'
import { isE2ERequired } from '../lib/node/transport.js'
import { buildNodeHello } from '../lib/node/index.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'

const bot = (i) => ({ id: `b${i}`, name: `Bot ${i}`, role: 'r', createdAt: i })

function makeCtx(provider) {
  return { get: (key) => (key === 'remote-agent:node-bots' ? provider : undefined) }
}

function makeInventory({ bots = [bot(1)], enabled = true, sendOk = true } = {}) {
  const frames = []
  let clock = 1_000
  const provider = { enabled: () => enabled, list: () => bots }
  const inventory = startBotInventory({
    ctx: makeCtx(provider),
    send: (type, data) => { frames.push({ type, data }); return sendOk },
    logger: { warn() {} },
    nodeId: 'n1',
    hostname: 'box-1',
    now: () => clock,
    autoStart: false,
  })
  return { frames, inventory, provider, advance: (ms) => { clock += ms } }
}

test('R1 the same list is sent once, not every tick', () => {
  const { frames, inventory } = makeInventory()
  inventory.tick()
  inventory.tick()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, NODE_TO_HUB.BOT_INVENTORY)
  assert.equal(frames[0].data.nodeId, 'n1')
  assert.equal(frames[0].data.hostname, 'box-1')
  assert.equal(frames[0].data.enabled, true)
  assert.deepEqual(frames[0].data.bots, [bot(1)])
})

test('R2 a reconnect sends the current list immediately', () => {
  const { frames, inventory, advance } = makeInventory()
  inventory.tick()
  advance(10_000)
  inventory.onOnline()
  assert.equal(frames.length, 2)
})

test('R3 no provider → nothing is sent', () => {
  const frames = []
  const inventory = startBotInventory({
    ctx: { get: () => undefined },
    send: (type, data) => { frames.push({ type, data }); return true },
    logger: { warn() {} },
    nodeId: 'n1',
    hostname: 'box-1',
    now: () => 1,
    autoStart: false,
  })
  inventory.tick()
  inventory.onOnline()
  assert.equal(frames.length, 0)
})

test('R4 65 bots → oldest 64 with truncated:true', () => {
  const bots = Array.from({ length: 65 }, (_, i) => bot(i + 1))
  const { frames, inventory } = makeInventory({ bots })
  inventory.tick()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].data.bots.length, 64)
  assert.equal(frames[0].data.bots[0].id, 'b1')
  assert.equal(frames[0].data.bots[63].id, 'b64')
  assert.equal(frames[0].data.truncated, true)
})

test('R5 hello advertises node-bots/1', () => {
  const hello = buildNodeHello({}, { roots: [], nodeId: 'n1' })
  assert.ok(Array.isArray(hello.caps))
  assert.ok(hello.caps.includes('node-bots/1'), `caps: ${hello.caps.join(',')}`)
})

test('R6 a rejected ack backs off before resending', () => {
  const { frames, inventory, advance } = makeInventory()
  inventory.tick()
  assert.equal(frames.length, 1)
  inventory.onAck({ nodeId: 'n1', ok: false, applied: 0, at: 1 })
  inventory.tick()
  assert.equal(frames.length, 1, 'must wait for the backoff')
  advance(5_000)
  inventory.tick()
  assert.equal(frames.length, 2, 'resends after the backoff')
  inventory.onAck({ nodeId: 'n1', ok: true, applied: 1, at: 2 })
  advance(1_000)
  inventory.tick()
  assert.equal(frames.length, 2, 'accepted inventory is not resent')
})

test('R6b a failed send is retried on the next tick', () => {
  const frames = []
  let ok = false
  const provider = { enabled: () => true, list: () => [bot(1)] }
  const inventory = startBotInventory({
    ctx: makeCtx(provider), send: (type, data) => { frames.push({ type, data }); return ok },
    logger: { warn() {} }, nodeId: 'n1', hostname: 'box-1', now: () => 1, autoStart: false,
  })
  inventory.tick()
  assert.equal(frames.length, 1)
  ok = true
  inventory.tick()
  assert.equal(frames.length, 2, 'a frame the transport did not take is not remembered as sent')
})

test('R7 the hub drops a frame whose nodeId does not match the connection', () => {
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: null })
  const received = []
  registry.on('botInventory', (d) => received.push(d))
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_INVENTORY, d: {
    nodeId: 'n2', hostname: 'x', enabled: true, bots: [bot(1)], at: 1,
  } })
  assert.equal(received.length, 0, 'a claimed nodeId must not be rewritten to the connection id')
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_INVENTORY, d: {
    nodeId: 'n1', hostname: 'box-1', enabled: true, bots: [bot(1)], at: 1,
  } })
  assert.equal(received.length, 1)
  assert.equal(received[0].nodeId, 'n1')
})

test('R7b malformed inventory is refused by the validator', () => {
  assert.equal(validateBotInventory({ nodeId: 'n', enabled: true }).error, 'bot-inventory-bots-missing')
  assert.equal(validateBotInventory({ nodeId: 'n', enabled: true, bots: [] }).ok, true)
  assert.equal(validateBotInventory({ nodeId: '', enabled: true, bots: [] }).ok, false)
  assert.equal(validateBotInventory({ nodeId: 'n', enabled: 'yes', bots: [] }).ok, false)
  assert.equal(validateBotInventory({ nodeId: 'n', enabled: true, bots: Array.from({ length: 65 }, (_, i) => bot(i)) }).error, 'bot-inventory-bots-too-many')
  assert.equal(validateBotInventory({ nodeId: 'n', enabled: false }).value.bots.length, 0)
  assert.equal(validateBotInventoryAck({ nodeId: 'n', ok: true, applied: 2, at: 1 }).ok, true)
  assert.equal(validateBotInventoryAck({ nodeId: 'n', ok: 'yes' }).ok, false)
})

test('R8 bot/inventory is E2E-required and ack is not', () => {
  assert.equal(isE2ERequired(NODE_TO_HUB.BOT_INVENTORY), true)
  assert.equal(isE2ERequired(HUB_TO_NODE.BOT_INVENTORY_ACK), false)
})

test('R9 disabling the switch sends enabled:false once and clears the list', () => {
  const frames = []
  let enabled = true
  const provider = { enabled: () => enabled, list: () => [bot(1)] }
  const inventory = startBotInventory({
    ctx: makeCtx(provider), send: (type, data) => { frames.push({ type, data }); return true },
    logger: { warn() {} }, nodeId: 'n1', hostname: 'box-1', now: () => 1, autoStart: false,
  })
  inventory.tick()
  enabled = false
  inventory.tick()
  inventory.tick()
  assert.equal(frames.length, 2)
  assert.equal(frames[1].data.enabled, false)
  assert.equal(frames[1].data.bots, undefined)
})
