import test from 'node:test'
import assert from 'node:assert/strict'
import { handleBotStopFrame, BOT_STOP_RECEIVER } from '../lib/bot-stop.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotStop, validateBotStopResult } from '../lib/protocol.js'
import { createFrameDispatcher } from '../lib/node/dispatch.js'

// ── 1. validateBotStop ───────────────────────────────────────────────────────
test('1. validateBotStop rejects a frame without nodeId / remoteBotId / requestId', () => {
  assert.equal(validateBotStop(null).ok, false)
  assert.equal(validateBotStop({ remoteBotId: 'b1', requestId: 'r1' }).error, 'bot-stop-nodeId-missing')
  assert.equal(validateBotStop({ nodeId: 'n1', requestId: 'r1' }).error, 'bot-stop-remoteBotId-missing')
  assert.equal(validateBotStop({ nodeId: 'n1', remoteBotId: 'b1' }).error, 'bot-stop-requestId-missing')
})

test('2. validateBotStop trims the identity fields', () => {
  const r = validateBotStop({ nodeId: ' n1 ', remoteBotId: ' b1 ', requestId: ' r1 ' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.stop, { nodeId: 'n1', remoteBotId: 'b1', requestId: 'r1' })
})

test('3. validateBotStopResult requires ok and stopped booleans', () => {
  assert.equal(validateBotStopResult({ requestId: 'r1', stopped: true }).error, 'bot-stop-result-ok-missing')
  assert.equal(validateBotStopResult({ requestId: 'r1', ok: true }).error, 'bot-stop-result-stopped-missing')
  const r = validateBotStopResult({ requestId: 'r1', ok: true, stopped: false, error: null })
  assert.equal(r.ok, true)
  assert.equal(r.result.stopped, false)
})

// ── 2. handleBotStopFrame ───────────────────────────────────────────────────
function frameCtx(receiver) {
  const sent = []
  const errors = []
  return {
    sent,
    errors,
    ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} }, get: (n) => n === BOT_STOP_RECEIVER ? receiver : undefined },
    send: (type, data, opts) => { sent.push({ type, data, opts }); return true },
    sendError: (id, code, message) => { errors.push({ id, code, message }) },
  }
}

test('4. handleBotStopFrame: no receiver → ok:false bot-stop-no-receiver', async () => {
  const h = frameCtx(undefined)
  await handleBotStopFrame({
    frame: { id: 'f1', t: HUB_TO_NODE.BOT_STOP },
    data: { nodeId: 'n1', remoteBotId: 'session-x', requestId: 'req-4' },
    ctx: h.ctx, send: h.send, sendError: h.sendError,
  })
  const reply = h.sent.find(s => s.type === NODE_TO_HUB.BOT_STOP_RESULT)
  assert.ok(reply, 'bot/stop-result must be sent')
  assert.equal(reply.data.requestId, 'req-4')
  assert.equal(reply.data.ok, false)
  assert.equal(reply.data.stopped, false)
  assert.equal(reply.data.error, 'bot-stop-no-receiver')
  assert.equal(reply.opts.replyTo, 'f1')
})

test('5. handleBotStopFrame: receiver stopped the turn → ok:true stopped:true', async () => {
  const seen = []
  const h = frameCtx(async (spec) => { seen.push(spec); return { ok: true, stopped: true } })
  await handleBotStopFrame({
    frame: { id: 'f2', t: HUB_TO_NODE.BOT_STOP },
    data: { nodeId: 'n1', remoteBotId: 'session-y', requestId: 'req-5' },
    ctx: h.ctx, send: h.send, sendError: h.sendError,
  })
  assert.deepEqual(seen, [{ remoteBotId: 'session-y' }])
  const reply = h.sent.find(s => s.type === NODE_TO_HUB.BOT_STOP_RESULT)
  assert.equal(reply.data.ok, true)
  assert.equal(reply.data.stopped, true)
  assert.equal(reply.data.error, null)
})

test('6. handleBotStopFrame: nothing running is a successful result, not a failure', async () => {
  const h = frameCtx(async () => ({ ok: true, stopped: false }))
  await handleBotStopFrame({
    frame: { id: 'f3', t: HUB_TO_NODE.BOT_STOP },
    data: { nodeId: 'n1', remoteBotId: 'session-z', requestId: 'req-6' },
    ctx: h.ctx, send: h.send, sendError: h.sendError,
  })
  const reply = h.sent.find(s => s.type === NODE_TO_HUB.BOT_STOP_RESULT)
  assert.equal(reply.data.ok, true)
  assert.equal(reply.data.stopped, false)
})

test('7. handleBotStopFrame: a throwing receiver becomes ok:false with the message', async () => {
  const h = frameCtx(async () => { throw new Error('boom') })
  await handleBotStopFrame({
    frame: { id: 'f4', t: HUB_TO_NODE.BOT_STOP },
    data: { nodeId: 'n1', remoteBotId: 'session-w', requestId: 'req-7' },
    ctx: h.ctx, send: h.send, sendError: h.sendError,
  })
  const reply = h.sent.find(s => s.type === NODE_TO_HUB.BOT_STOP_RESULT)
  assert.equal(reply.data.ok, false)
  assert.match(reply.data.error, /boom/)
})

test('8. handleBotStopFrame: an invalid frame is refused with sendError and no result', async () => {
  const h = frameCtx(async () => ({ ok: true, stopped: true }))
  await handleBotStopFrame({
    frame: { id: 'f5', t: HUB_TO_NODE.BOT_STOP },
    data: { nodeId: 'n1' },
    ctx: h.ctx, send: h.send, sendError: h.sendError,
  })
  assert.equal(h.sent.length, 0)
  assert.equal(h.errors[0].code, 'bot-stop-remoteBotId-missing')
})

// ── 3. dispatcher (the real node entry) ─────────────────────────────────────
test('9. createFrameDispatcher routes bot/stop to the receiver and answers', async () => {
  const h = frameCtx(async ({ remoteBotId }) => ({ ok: true, stopped: remoteBotId === 'session-live' }))
  const dispatch = createFrameDispatcher({ ctx: h.ctx, send: h.send, sendError: h.sendError, engine: {}, logger: h.ctx.logger, stateDir: process.cwd() })
  const handled = dispatch({ id: 'f6', t: HUB_TO_NODE.BOT_STOP, d: { nodeId: 'n1', remoteBotId: 'session-live', requestId: 'req-9' } })
  assert.equal(handled, true)
  await new Promise(r => setTimeout(r, 10))
  const reply = h.sent.find(s => s.type === NODE_TO_HUB.BOT_STOP_RESULT)
  assert.ok(reply, 'result must be sent through the dispatcher')
  assert.equal(reply.data.stopped, true)
})
