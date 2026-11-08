import test from 'node:test'
import assert from 'node:assert/strict'
import { handleBotUpdateFrame, BOT_UPDATE_RECEIVER } from '../lib/bot-update.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotUpdate, validateBotUpdateResult } from '../lib/protocol.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'

// ── 1. validateBotUpdate ──────────────────────────────────────────────────────
test('1. validateBotUpdate rejects missing required fields', () => {
  assert.equal(validateBotUpdate(null).ok, false)
  assert.equal(validateBotUpdate({ nodeId: 'n1', remoteBotId: 'b1', requestId: 'r1' }).error, 'bot-update-all-null')
  assert.equal(validateBotUpdate({ nodeId: 'n1', remoteBotId: 'b1', requestId: 'r1', model: 123 }).error, 'bot-update-all-null')
})

test('2. validateBotUpdate accepts partial patch with wrong-type coercion', () => {
  const r = validateBotUpdate({ nodeId: 'n1', remoteBotId: 'b1', requestId: 'r1', model: 'prov/model-a', effort: 123 })
  assert.equal(r.ok, true)
  assert.equal(r.update.model, 'prov/model-a')
  assert.equal(r.update.effort, null)  // wrong type → null
})

// ── 3. handleBotUpdateFrame happy path ───────────────────────────────────────
test('3. handleBotUpdateFrame calls receiver and returns profile', async () => {
  const sent = []
  const receiverSpecs = []
  const fakeReceiver = async (spec) => {
    receiverSpecs.push(spec)
    return { ok: true, model: spec.model, effort: null, instructions: null, workDir: null }
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (n) => n === BOT_UPDATE_RECEIVER ? fakeReceiver : undefined,
  }
  const send = (type, data) => { sent.push({ type, data }); return true }
  const sendError = () => {}

  await handleBotUpdateFrame({
    frame: { id: 'f1', t: HUB_TO_NODE.BOT_UPDATE, d: {} },
    data: { nodeId: 'n1', remoteBotId: 'session-x', requestId: 'req-3', model: 'prov/modelB', effort: null, instructions: null, workDir: null },
    ctx, send, sendError,
  })

  assert.equal(receiverSpecs.length, 1, 'receiver must be called once')
  assert.equal(receiverSpecs[0].remoteBotId, 'session-x')
  assert.equal(receiverSpecs[0].model, 'prov/modelB')
  const reply = sent.find(s => s.type === NODE_TO_HUB.BOT_UPDATE_RESULT)
  assert.ok(reply, 'bot/update-result must be sent')
  assert.equal(reply.data.ok, true)
  assert.equal(reply.data.requestId, 'req-3')
  assert.equal(reply.data.model, 'prov/modelB')
})

// ── 4. createFrameDispatcher BOT_UPDATE (knife target) ───────────────────────
test('4. createFrameDispatcher: bot/update frame → receiver → bot/update-result', async () => {
  const sent = []
  const receiverSpecs = []
  const fakeReceiver = async (spec) => {
    receiverSpecs.push(spec)
    return { ok: true, model: 'prov/modelC', effort: null, instructions: null, workDir: null }
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (n) => n === BOT_UPDATE_RECEIVER ? fakeReceiver : undefined,
  }
  const send = (type, data) => { sent.push({ type, data }); return true }
  const dispatch = createFrameDispatcher({ ctx, send, sendError: () => {}, engine: null, logger: ctx.logger })

  dispatch({ id: 'f2', t: HUB_TO_NODE.BOT_UPDATE, d: { nodeId: 'n1', remoteBotId: 'session-y', requestId: 'req-4', model: 'prov/modelC', effort: null, instructions: null, workDir: null } })

  const started = Date.now()
  while (sent.length === 0 && Date.now() - started < 500) await new Promise(r => setImmediate(r))

  assert.equal(receiverSpecs.length, 1, 'receiver must be called')
  assert.equal(receiverSpecs[0].remoteBotId, 'session-y')
  const reply = sent.find(s => s.type === NODE_TO_HUB.BOT_UPDATE_RESULT)
  assert.ok(reply, 'bot/update-result must be sent (knife: delete BOT_UPDATE case → red here)')
  assert.equal(reply.data.requestId, 'req-4')
})

// ── 5. real ingest: BOT_UPDATE_RESULT → botUpdateResult event ────────────────
test('5. NodeRegistry.handleFrameFor BOT_UPDATE_RESULT → botUpdateResult event emitted', () => {
  const relay = { ready: true, send: () => true }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: null })
  const received = []
  registry.on('botUpdateResult', d => received.push(d))

  registry.handleFrameFor('n1', {
    t: NODE_TO_HUB.BOT_UPDATE_RESULT,
    d: { requestId: 'req-5', ok: true, model: 'prov/modelD', effort: null, instructions: null, workDir: null },
  })

  assert.equal(received.length, 1, 'botUpdateResult must be emitted (knife: delete emit → red here)')
  assert.equal(received[0].requestId, 'req-5')
  assert.equal(received[0].model, 'prov/modelD')
})
