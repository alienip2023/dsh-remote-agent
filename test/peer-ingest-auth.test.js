import test from 'node:test'
import assert from 'node:assert/strict'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { NODE_TO_HUB } from '../lib/protocol.js'

const CONNECTION = 'node-a'

/**
 * 与 test/roster-report.test.js 同款最小注册表：不需要真实连接，
 * `handleFrameFor(nodeId, frame)` 的 nodeId 就是认证后的连接身份。
 */
function registryFor(nodeId) {
  const listeners = {}
  class Core {
    constructor() {
      this.nodes = new Map([[nodeId, { nodeId, lastSeen: 0, online: true }]])
      this.tasks = new Map()
      this.logs = []
    }
    log(level, event, detail) {
      this.logs.push({ level, event, detail })
    }
    send() {}
    on(name, fn) {
      (listeners[name] ??= []).push(fn)
      return () => {}
    }
    emit(name, payload) {
      for (const fn of listeners[name] ?? []) fn(payload)
    }
  }
  return new (withIngest(Core))()
}

function frameFor(type, data) {
  return { t: type, d: data }
}

function collect(registry, event) {
  const seen = []
  registry.on(event, (payload) => seen.push(payload))
  return seen
}

function mismatches(registry) {
  return registry.logs.filter((row) => row.event === 'peer-node-mismatch')
}

test('a roster frame claiming another node is dropped without emitting', () => {
  const registry = registryFor(CONNECTION)
  const rosters = collect(registry, 'roster')

  registry.handleFrameFor(CONNECTION, frameFor(NODE_TO_HUB.ROSTER, {
    nodeId: 'node-b',
    hostname: 'intruder',
    bots: [{ id: 'alpha', name: 'Alpha' }],
  }))

  assert.equal(rosters.length, 0, 'claiming another node must not produce a roster row')
  const warned = mismatches(registry)
  assert.equal(warned.length, 1, 'the mismatch must be logged once for audit')
  assert.equal(warned[0].level, 'warn')
  assert.equal(warned[0].detail.connection, CONNECTION)
  assert.equal(warned[0].detail.claimed, 'node-b')
})

test('a roster frame from its own node is accepted with the connection id', () => {
  const registry = registryFor(CONNECTION)
  const rosters = collect(registry, 'roster')

  registry.handleFrameFor(CONNECTION, frameFor(NODE_TO_HUB.ROSTER, {
    nodeId: CONNECTION,
    hostname: 'desk-1',
    bots: [{ id: 'alpha', name: 'Alpha' }],
  }))

  assert.equal(rosters.length, 1)
  assert.equal(rosters[0].nodeId, CONNECTION)
  assert.equal(rosters[0].hostname, 'desk-1')
  assert.equal(rosters[0].online, true)
  assert.equal(mismatches(registry).length, 0)
})

test('a roster frame without nodeId falls back to the connection id', () => {
  const registry = registryFor(CONNECTION)
  const rosters = collect(registry, 'roster')

  registry.handleFrameFor(CONNECTION, frameFor(NODE_TO_HUB.ROSTER, {
    hostname: 'desk-1',
    bots: [{ id: 'alpha', name: 'Alpha' }],
  }))

  assert.equal(rosters.length, 1, 'older nodes that omit nodeId stay compatible')
  assert.equal(rosters[0].nodeId, CONNECTION)
  assert.equal(mismatches(registry).length, 0)
})

test('a bot turn result claiming another node is dropped without emitting', () => {
  const registry = registryFor(CONNECTION)
  const results = collect(registry, 'botTurnResult')

  registry.handleFrameFor(CONNECTION, frameFor(NODE_TO_HUB.BOT_TURN_RESULT, {
    nodeId: 'node-b',
    remoteBotId: 'remote-1',
    exchangeId: 'ex-1',
    seq: 0,
    text: 'forged',
  }))

  assert.equal(results.length, 0, 'claiming another node must not produce a turn result')
  const warned = mismatches(registry)
  assert.equal(warned.length, 1)
  assert.equal(warned[0].detail.connection, CONNECTION)
  assert.equal(warned[0].detail.claimed, 'node-b')
  assert.equal(warned[0].detail.frame, 'bot/turn-result')
})

test('a bot turn result from its own node is accepted with the connection id', () => {
  const registry = registryFor(CONNECTION)
  const results = collect(registry, 'botTurnResult')

  registry.handleFrameFor(CONNECTION, frameFor(NODE_TO_HUB.BOT_TURN_RESULT, {
    nodeId: CONNECTION,
    remoteBotId: 'remote-1',
    exchangeId: 'ex-1',
    seq: 2,
    text: 'hello',
  }))

  assert.equal(results.length, 1)
  assert.equal(results[0].nodeId, CONNECTION)
  assert.equal(results[0].remoteBotId, 'remote-1')
  assert.equal(results[0].exchangeId, 'ex-1')
  assert.equal(results[0].seq, 2)
  assert.equal(mismatches(registry).length, 0)
})
