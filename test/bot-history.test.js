// M3: bot/history — spec walks through the full hop:
// real NodeRegistry.send → wire frame → node dispatch → handleBotHistoryFrame → receiver.
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { handleBotHistoryFrame, BOT_PAGE_RECEIVER } from '../lib/bot-history.js'
import { HUB_TO_NODE, decodeFrame, validateBotHistory, validateBotHistoryResult } from '../lib/protocol.js'
import { isE2ERequired } from '../lib/node/transport.js'
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
