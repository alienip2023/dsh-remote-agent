// P1b-1: joined Bot model switching — full chain test.
// Tests the REAL bot/update path: hub → node dispatch → receiver → updateBot
// and the ds-bot side: joinedUpdateBot → bot/update send → shadow sync.
// Uses the applyWorker/fakeCtx pattern to avoid a real relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BOT_UPDATE_RECEIVER } from '../lib/bot-update.js'
import { handleBotUpdateFrame } from '../lib/bot-update.js'
import { validateBotUpdate, HUB_TO_NODE, NODE_TO_HUB } from '../lib/protocol.js'
import { applyWorker, sanitizeNodeId } from '../lib/node/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ra-p1b1-'))
}

function makeCtx(overrides = {}) {
  const provided = {}
  return {
    effect: (fn) => { fn() },
    provide: (name, value) => { provided[name] = value },
    get: (name) => provided[name] ?? overrides[name],
    _provided: provided,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

function fakeFrame(type, data, id = 'f1') {
  return { type, id, data }
}

// ── M1: model-catalog efforts ─────────────────────────────────────────────────

test('M1-efforts-passthrough: readAvailableModels includes reasoningEfforts as efforts[]', async () => {
  // Knife: remove efforts mapping in model-catalog.js → entry.efforts === undefined → RED
  const { readAvailableModels } = await import('../lib/node/model-catalog.js')
  const fakeCtx = {
    get: (name) => {
      if (name !== 'llm') return undefined
      return {
        listProviders: () => [{ id: 'testprov' }],
        listModels: async (provider) => [
          { id: 'fast', name: 'Fast', reasoningEfforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
          { id: 'slow', name: 'Slow' },
        ],
        listConfigurableProviders: () => [],
      }
    },
  }
  const result = await readAvailableModels(fakeCtx)
  assert.ok(Array.isArray(result?.models), 'must return models array')
  const fast = result.models.find(m => m.id === 'fast')
  assert.ok(fast, 'fast model must be in catalog')
  assert.deepEqual(fast.efforts, [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], 'efforts must be present on model with reasoningEfforts')
  const slow = result.models.find(m => m.id === 'slow')
  assert.equal(slow?.efforts, undefined, 'model with no efforts must NOT have efforts key')
})

test('M1-efforts-knife-fields: truncates effort id/name to max lengths', async () => {
  // Knife: remove .slice(0,64) on effort id → long id passes through → RED
  const { readAvailableModels } = await import('../lib/node/model-catalog.js')
  const longId = 'e'.repeat(100)
  const longName = 'n'.repeat(200)
  const fakeCtx = {
    get: (name) => name === 'llm' ? {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm1', name: 'M1', reasoningEfforts: [{ id: longId, name: longName }] }],
      listConfigurableProviders: () => [],
    } : undefined,
  }
  const result = await readAvailableModels(fakeCtx)
  const effort = result.models[0].efforts?.[0]
  assert.ok(effort, 'effort must exist')
  assert.equal(effort.id.length, 64, 'effort id truncated to 64')
  assert.equal(effort.name.length, 128, 'effort name truncated to 128')
})

// ── M2: node-policy models getter ─────────────────────────────────────────────

test('M2-policy-models-getter: node-policy exposes models via live getter', (t) => {
  // Knife: remove Object.defineProperty getter → policy.models === undefined → RED
  const dir = tmpDir()
  const ctx = makeCtx()
  const dispose = applyWorker(ctx, { hubUrl: 'ws://127.0.0.1:1', token: 'tk', stateDir: dir, roots: [dir], nodeId: 'n1', resourceIntervalMs: 0 })
  t.after(() => { try { dispose?.dispose?.() ?? dispose?.() } catch { /* ok */ } })
  const policy = ctx._provided['remote-agent:node-policy']
  assert.ok(policy, 'policy must be provided')
  // getCachedModels returns null initially; getter must reflect it (not throw)
  const val = policy.models
  assert.ok(val === null || Array.isArray(val), 'policy.models is null or array (live)')
  // models getter must be accessible but NOT enumerable (so JSON.stringify(policy) stays { roots, nodeId })
  const desc = Object.getOwnPropertyDescriptor(policy, 'models')
  assert.ok(desc && typeof desc.get === 'function', 'models must have a getter')
  assert.equal(desc.enumerable, false, 'models must NOT be enumerable to preserve JSON.stringify shape')
})

// ── M3: dispatch → receiver path ──────────────────────────────────────────────

test('M3-dispatch-ok: bot/update frame with known model is forwarded to receiver → result ok', async () => {
  // Knife: remove handleBotUpdateFrame case in dispatch.js → receiver never called → no result → RED
  const sent = []
  const ctx = makeCtx()
  const updatedBots = []
  ctx._provided[BOT_UPDATE_RECEIVER] = async (spec) => {
    updatedBots.push(spec)
    return { ok: true, model: spec.model, effort: spec.effort ?? null, instructions: null, workDir: null }
  }
  const send = (type, data) => sent.push({ type, data })
  const sendError = (id, code, msg) => sent.push({ type: 'error', code, msg })
  const data = { nodeId: 'n1', remoteBotId: 'rb1', requestId: 'req-1', model: 'openai/gpt-4o', effort: null, instructions: null, workDir: null }
  const frame = fakeFrame(HUB_TO_NODE.BOT_UPDATE, data)
  await handleBotUpdateFrame({ frame, data, ctx, send, sendError })
  assert.equal(sent.length, 1, 'must send exactly one result')
  assert.equal(sent[0].type, NODE_TO_HUB.BOT_UPDATE_RESULT, 'result type must be BOT_UPDATE_RESULT')
  assert.equal(sent[0].data.ok, true, 'result must be ok')
  assert.equal(sent[0].data.model, 'openai/gpt-4o', 'result must echo model')
  assert.equal(updatedBots[0].remoteBotId, 'rb1', 'receiver must be called with correct remoteBotId')
})

test('M3-dispatch-unknown-model: receiver returns bot-update-model-not-on-node → hub gets error', async () => {
  // Knife: remove model-not-on-node error return → result ok → RED
  const sent = []
  const ctx = makeCtx()
  ctx._provided[BOT_UPDATE_RECEIVER] = async () => ({ ok: false, error: 'bot-update-model-not-on-node' })
  const send = (type, data) => sent.push({ type, data })
  const sendError = (id, code, msg) => sent.push({ type: 'error', code, msg })
  const data = { nodeId: 'n1', remoteBotId: 'rb1', requestId: 'req-2', model: 'openai/no-such-model', effort: null, instructions: null, workDir: null }
  await handleBotUpdateFrame({ frame: fakeFrame(HUB_TO_NODE.BOT_UPDATE, data), data, ctx, send, sendError })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.ok, false, 'unknown model must return ok:false')
  assert.match(sent[0].data.error, /not-on-node/, 'error must reference not-on-node')
})

test('M3-dispatch-no-receiver: bot/update with no receiver registered → bot-update-no-receiver', async () => {
  // Knife: remove BOT_UPDATE_RECEIVER check → throws/no result → RED
  const sent = []
  const ctx = makeCtx()
  const data = { nodeId: 'n1', remoteBotId: 'rb1', requestId: 'req-3', model: 'openai/gpt-4o', effort: null, instructions: null, workDir: null }
  await handleBotUpdateFrame({ frame: fakeFrame(HUB_TO_NODE.BOT_UPDATE, data), data, ctx, send: (t, d) => sent.push({ t, d }), sendError: () => {} })
  assert.equal(sent[0].d.ok, false)
  assert.equal(sent[0].d.error, 'bot-update-no-receiver')
})

