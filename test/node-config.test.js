// 并发上限可配：节点默认 8、范围 1–64、主控下发后运行时生效并立即 pump、
// 旧节点不回执时主控据超时标「不支持」。这里钉住节点侧的协议、引擎与回执。
import test from 'node:test'
import assert from 'node:assert/strict'
import { HUB_TO_NODE, NODE_TO_HUB, validateNodeConfig, validateNodeConfigResult } from '../lib/protocol.js'
import { TaskEngine, clampMaxConcurrent } from '../lib/node/task-engine.js'
import { handleNodeConfigFrame } from '../lib/node/node-config.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { isE2ERequired } from '../lib/node/transport.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'

function engine() {
  return new TaskEngine({
    store: { get: id => ({ id, status: 'queued', createdAt: 1 }) },
    artifacts: {},
    runner: {},
    nodeId: 'n1',
    roots: ['/tmp'],
    send: () => {},
  })
}

test('node/config requires a nodeId, a requestId and 1–64', () => {
  assert.equal(validateNodeConfig({ nodeId: 'n', requestId: 'r', maxConcurrent: 12 }).ok, true)
  assert.equal(validateNodeConfig({ requestId: 'r', maxConcurrent: 12 }).error, 'node-config-nodeId-missing')
  assert.equal(validateNodeConfig({ nodeId: 'n', maxConcurrent: 12 }).error, 'node-config-requestId-missing')
  assert.equal(validateNodeConfig({ nodeId: 'n', requestId: 'r', maxConcurrent: 0 }).error, 'node-config-maxConcurrent-invalid')
  assert.equal(validateNodeConfig({ nodeId: 'n', requestId: 'r', maxConcurrent: 65 }).error, 'node-config-maxConcurrent-invalid')
  assert.equal(validateNodeConfig({ nodeId: 'n', requestId: 'r', maxConcurrent: 1.5 }).error, 'node-config-maxConcurrent-invalid')
  assert.equal(validateNodeConfig({ nodeId: 'n', requestId: 'r', maxConcurrent: '12' }).error, 'node-config-maxConcurrent-invalid')
})

test('node/config-result keeps the applied value and a refusal reason', () => {
  const ok = validateNodeConfigResult({ requestId: 'r', nodeId: 'n1', ok: true, maxConcurrent: 12 })
  assert.equal(ok.result.ok, true)
  assert.equal(ok.result.maxConcurrent, 12)
  const bad = validateNodeConfigResult({ requestId: 'r', ok: false, maxConcurrent: 99, error: 'node-config-maxConcurrent-invalid' })
  assert.equal(bad.result.maxConcurrent, null, 'a value outside 1–64 is not reported as applied')
  assert.equal(bad.result.error, 'node-config-maxConcurrent-invalid')
  assert.equal(validateNodeConfigResult({ ok: true }).error, 'node-config-result-requestId-missing')
})

test('a node runs 8 tasks by default', () => {
  const engineUnderTest = engine()
  assert.equal(engineUnderTest.maxConcurrent, 8)
  assert.equal(clampMaxConcurrent(64), 64)
  assert.equal(clampMaxConcurrent(65), undefined)
  assert.equal(clampMaxConcurrent(0), undefined)
})

test('setting 12 lets the same node run 12 at once, without a restart', async () => {
  const engineUnderTest = engine()
  // Count what the pump starts; the tasks never finish, which is what saturation looks like.
  engineUnderTest.execute = async function (id) { this.running.set(id, { startedAt: Date.now() }) }
  engineUnderTest.queue = Array.from({ length: 10 }, (_, i) => `t${i + 1}`)
  await engineUnderTest.pump()
  assert.equal(engineUnderTest.running.size, 8, 'the default limit holds')

  assert.equal(engineUnderTest.setMaxConcurrent(12), 12)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(engineUnderTest.running.size, 10, 'the two queued tasks start immediately after the change')

  engineUnderTest.queue = Array.from({ length: 5 }, (_, i) => `u${i + 1}`)
  await engineUnderTest.pump()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(engineUnderTest.running.size, 12, 'a new task runs at 12, not 8')
  assert.equal(engineUnderTest.queue.length, 3)
})

test('an out-of-range limit is refused, never clipped, and changes nothing', async () => {
  const engineUnderTest = engine()
  assert.equal(engineUnderTest.setMaxConcurrent(65), undefined)
  assert.equal(engineUnderTest.setMaxConcurrent(0), undefined)
  assert.equal(engineUnderTest.setMaxConcurrent(2.5), undefined)
  assert.equal(engineUnderTest.maxConcurrent, 8)
})

test('node/config applies the limit and answers with what it applied', async () => {
  const engineUnderTest = engine()
  const sent = []
  await handleNodeConfigFrame({
    data: { nodeId: 'n1', requestId: 'r1', maxConcurrent: 12 },
    nodeId: 'n1',
    engine: engineUnderTest,
    send: (type, data) => { sent.push([type, data]) },
  })
  assert.equal(engineUnderTest.maxConcurrent, 12)
  assert.deepEqual(sent, [[NODE_TO_HUB.NODE_CONFIG_RESULT, { requestId: 'r1', nodeId: 'n1', ok: true, maxConcurrent: 12 }]])
})

test('node/config for another node is refused and leaves the limit alone', async () => {
  const engineUnderTest = engine()
  const sent = []
  await handleNodeConfigFrame({
    data: { nodeId: 'other', requestId: 'r2', maxConcurrent: 12 },
    nodeId: 'n1',
    engine: engineUnderTest,
    send: (type, data) => { sent.push([type, data]) },
  })
  assert.equal(engineUnderTest.maxConcurrent, 8)
  assert.equal(sent[0][1].ok, false)
  assert.equal(sent[0][1].error, 'node-config-node-mismatch')
})

test('the hub takes the result from the connection, not the payload', () => {
  const listeners = {}
  class Core {
    constructor() { this.nodes = new Map() }
    log() {}
    send() {}
    on(name, fn) { (listeners[name] ??= []).push(fn) }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
  }
  const registry = new (withIngest(Core))()
  const got = []
  registry.on('nodeConfigResult', payload => got.push(payload))
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.NODE_CONFIG_RESULT, d: { requestId: 'r1', nodeId: 'lied', ok: true, maxConcurrent: 12 } })
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.NODE_CONFIG_RESULT, d: { ok: true } })
  assert.equal(got.length, 1)
  assert.equal(got[0].requestId, 'r1')
  assert.equal(got[0].maxConcurrent, 12)
  assert.equal(got[0].nodeId, 'n1', 'the authenticated connection wins over the frame')
})

test('node/config is an encrypted frame', () => {
  assert.equal(isE2ERequired(HUB_TO_NODE.NODE_CONFIG), true)
  assert.equal(isE2ERequired('hello'), false)
})

test('a node coming back online is announced, so a hub can re-apply its settings', () => {
  const registry = new NodeRegistry({ log: () => {} })
  const got = []
  registry.on('nodeOnline', ev => got.push(ev))
  registry.ingestHello({
    helloData: { nodeId: 'n1', protocol: 1, os: 'linux', nonce: '', time: Date.now() },
    conn: { send: () => {}, close: () => {} },
    transport: 'direct',
    pending: undefined,
  })
  assert.equal(got.length, 1)
  assert.equal(got[0].nodeId, 'n1')
})
