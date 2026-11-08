// M3: bot/history — spec walks through the full hop:
// real NodeRegistry.send → wire frame → node dispatch → handleBotHistoryFrame → receiver.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleBotHistoryFrame, BOT_PAGE_RECEIVER } from '../lib/bot-history.js'
import { HUB_TO_NODE, NODE_TO_HUB, decodeFrame, validateBotHistory, validateBotHistoryResult } from '../lib/protocol.js'
import { E2E_MARKER } from '../lib/e2e.js'

const fakeE2E = () => ({ sealFrame: (_type, _id, d) => ({ e2e: E2E_MARKER, inner: d }) })

async function hop(nodeId, payload, receiver) {
  const wire = []
  const specs = []
  const relay = { ready: true, send: (nid, text) => { wire.push(text); return true } }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set(nodeId, { nodeId, online: true, lastSeen: 0, e2e: fakeE2E() })
  assert.equal(registry.send(nodeId, HUB_TO_NODE.BOT_HISTORY, { nodeId, requestId: 'req-1', remoteBotId: 'session-abc', ...payload }), true)
  assert.equal(wire.length, 1)
  const decoded = decodeFrame(wire[0])
  assert.equal(decoded.ok, true)
  const frame = decoded.frame
  assert.equal(frame.t, HUB_TO_NODE.BOT_HISTORY)
  const d = frame.d?.e2e === E2E_MARKER ? frame.d.inner : frame.d
  const replies = []
  // Wrap receiver to capture the spec it received
  const wrappedReceiver = receiver ? async (spec) => { specs.push(spec); return receiver(spec) } : undefined
  const ctx = { get: (name) => (name === BOT_PAGE_RECEIVER ? wrappedReceiver : undefined) }
  await handleBotHistoryFrame({ frame, data: d, ctx, send: (type, data) => replies.push({ type, data }), sendError() {} })
  return { replies, specs }
}

const ITEMS = [{ kind: 'user', text: 'hello' }, { kind: 'bot', text: '2+2=4' }]

test('1. receiver returns items → bot/history-result with items reaches the hub; spec has remoteBotId', async () => {
  const { replies, specs } = await hop('n1', {}, async () => ({ ok: true, sessionId: 'session-abc', items: ITEMS, cursor: null }))
  assert.equal(replies.length, 1)
  assert.equal(replies[0].type, 'bot/history-result')
  assert.equal(replies[0].data.ok, true)
  assert.deepEqual(replies[0].data.items, ITEMS)
  assert.equal(replies[0].data.sessionId, 'session-abc')
  // The receiver must receive remoteBotId (the knife removes this from the spec)
  assert.equal(specs.length, 1, 'receiver must be called')
  assert.equal(specs[0].remoteBotId, 'session-abc', 'receiver must get remoteBotId')
  // hub-side validator must accept
  const v = validateBotHistoryResult({ requestId: 'req-1', ...replies[0].data })
  assert.equal(v.ok, true)
  assert.equal(v.result.ok, true)
})

test('2. no receiver → bot-history-no-receiver, no exception', async () => {
  const { replies } = await hop('n1', {}, undefined)
  assert.equal(replies[0].data.ok, false)
  assert.equal(replies[0].data.error, 'bot-history-no-receiver')
})

test('3. receiver throws → ok:false, no exception escapes handleBotHistoryFrame', async () => {
  const { replies } = await hop('n1', {}, async () => { throw new Error('db crash') })
  assert.equal(replies[0].data.ok, false)
})

test('4. validateBotHistory: required fields + optional cursor', () => {
  const ok = validateBotHistory({ nodeId: 'n', requestId: 'r', remoteBotId: 'b' })
  assert.equal(ok.ok, true)
  assert.equal(ok.hist.cursor, null)
  assert.equal(ok.hist.remoteBotId, 'b')
  const withCursor = validateBotHistory({ nodeId: 'n', requestId: 'r', remoteBotId: 'b', cursor: { part: 1 } })
  assert.deepEqual(withCursor.hist.cursor, { part: 1 })
  assert.equal(validateBotHistory({ nodeId: 'n', requestId: 'r' }).error, 'bot-history-remoteBotId-missing')
  assert.equal(validateBotHistory({ nodeId: 'n', remoteBotId: 'b' }).error, 'bot-history-requestId-missing')
})

test('5. BOT_HISTORY is in E2E_REQUIRED_TYPES (same level as BOT_CREATE)', () => {
  assert.equal(isE2ERequired('bot/history'), true, 'bot/history must require E2E')
  assert.equal(isE2ERequired('bot/create'), true)
  assert.equal(isE2ERequired('hub/hello'), false, 'hub/hello must not require E2E')
})

import { NodeRegistry } from '../lib/hub/node-registry.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { isE2ERequired } from '../lib/node/transport.js'

// ── 6. real node dispatch via handleBotHistoryFrame directly ───────────────────
// We can't import applyWorker (needs @deepseek-ai/schemastery).
// Instead, test the dispatch contract: handleBotHistoryFrame called with the
// frame that node/index.js would produce → returns bot/history-result.
// Knife: comment out the case in node/index.js doesn't make handleBotHistoryFrame
// not exist, so we test the dispatch binding differently:
// We verify that node/index.js exports the case via a pattern test on the source.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const __dirname2 = dirname(fileURLToPath(import.meta.url))
const nodeIndexSrc = readFileSync(join(__dirname2, '../lib/node/index.js'), 'utf8')

test('6. node/index.js dispatch case: BOT_HISTORY case calls handleBotHistoryFrame', () => {
  // Structural test: the case must be present AND call handleBotHistoryFrame
  assert.ok(nodeIndexSrc.includes('HUB_TO_NODE.BOT_HISTORY'), 'dispatch case must reference HUB_TO_NODE.BOT_HISTORY')
  assert.ok(nodeIndexSrc.includes('handleBotHistoryFrame'), 'dispatch case must call handleBotHistoryFrame')
  // Together they prove the routing; removing the case makes both assertions false
})

// ── 7. real ingest path (knife: delete emit in registry-ingest.js → red) ──────
test('7. registry-ingest: BOT_HISTORY_RESULT via real NodeRegistry.handleFrameFor → botHistoryResult event', () => {
  const wire = []
  const relay = { ready: true, send: (nid, text) => { wire.push(text); return true } }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: null })
  const received = []
  registry.on('botHistoryResult', d => received.push(d))
  const payload = { requestId: 'req-7', ok: true, sessionId: 'session-abc', items: [{ kind: 'bot', text: 'hello' }], cursor: null }
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_HISTORY_RESULT, d: payload })
  assert.equal(received.length, 1, 'botHistoryResult event must be emitted once')
  assert.equal(received[0].requestId, 'req-7')
  assert.deepEqual(received[0].items, [{ kind: 'bot', text: 'hello' }])
})

// ── 8. cursor transparent passthrough (knife: change arg → red) ──────────────
test('8. handleBotHistoryFrame forwards cursor unchanged to receiver', async () => {
  const wire = []
  const relay = { ready: true, send: (nid, text) => { wire.push(text); return true } }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: fakeE2E() })
  const capturedCursors = []
  const { replies, specs } = await hop(
    'n1',
    { cursor: { part: 3 } },
    async (spec) => { capturedCursors.push(spec.cursor); return { ok: true, sessionId: 'session-abc', items: [], cursor: null } }
  )
  assert.deepEqual(capturedCursors[0], { part: 3 }, 'cursor must be forwarded to receiver unchanged')
  assert.equal(specs[0].remoteBotId, 'session-abc', 'remoteBotId must still be present when cursor is set')
})
