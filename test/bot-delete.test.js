/**
 * s57-B: bot/delete propagation — ra dispatch tests using applyWorker intercept.
 * Uses same pattern as test/bot-create.test.js for frame dispatch.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NodeTransport } from '../lib/node/transport.js'
import { applyWorker } from '../lib/node/index.js'
import { HUB_TO_NODE, NODE_TO_HUB } from '../lib/protocol.js'
import { BOT_DELETE_RECEIVER } from '../lib/bot-delete.js'

async function dispatchBotDelete(frameData, receiverFn) {
  const sent = []
  const frameHandlers = []
  const origOn = NodeTransport.prototype.on
  const origSend = NodeTransport.prototype.send
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-delete-'))
  let dispose = () => {}
  NodeTransport.prototype.on = function on(evt, fn) {
    if (evt === 'frame') frameHandlers.push(fn)
    return origOn.call(this, evt, fn)
  }
  NodeTransport.prototype.send = function send(type, data, opts) {
    sent.push({ type, data, opts })
    return true
  }
  try {
    const receiver = receiverFn
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get(name) {
        if (name === BOT_DELETE_RECEIVER) return receiver
        return undefined
      },
    }
    dispose = applyWorker(ctx, { hubUrl: '', stateDir, roots: [stateDir], resourceIntervalMs: 0, reposIntervalMs: 0, nodeId: 'n1' })
    const handler = frameHandlers.at(-1)
    if (typeof handler === 'function') {
      handler({ id: 'f-dispatch', t: HUB_TO_NODE.BOT_DELETE, d: frameData })
    }
    const started = Date.now()
    while (!sent.some((s) => s.type === NODE_TO_HUB.BOT_DELETE_RESULT) && Date.now() - started < 1000) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { sent }
  } finally {
    NodeTransport.prototype.on = origOn
    NodeTransport.prototype.send = origSend
    try { dispose() } catch {}
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

test('S57-B-dispatch: bot/delete frame routed to receiver; result returned', async () => {
  // Knife: comment out case HUB_TO_NODE.BOT_DELETE in dispatch.js → no result → timeout → RED
  const deletedWith = []
  const { sent } = await dispatchBotDelete(
    { nodeId: 'n1', requestId: 'req-1', remoteBotId: 'rb1' },
    async ({ remoteBotId }) => { deletedWith.push(remoteBotId); return { ok: true } }
  )
  const result = sent.find((s) => s.type === NODE_TO_HUB.BOT_DELETE_RESULT)
  assert.deepEqual(deletedWith, ['rb1'], 'receiver must be called with remoteBotId')
  assert.ok(result, 'must have sent BOT_DELETE_RESULT')
  assert.equal(result.data.ok, true)
  assert.equal(result.data.requestId, 'req-1')
})

test('S57-B-no-receiver: bot/delete with no receiver → bot-delete-no-receiver error', async () => {
  // Knife: remove 'if (typeof receiver !== \'function\')...' guard in handleBotDeleteFrame → goes to receiver → TypeError → different error → RED
  const { sent } = await dispatchBotDelete(
    { nodeId: 'n1', requestId: 'req-2', remoteBotId: 'rb2' },
    undefined  // no receiver
  )
  const result = sent.find((s) => s.type === NODE_TO_HUB.BOT_DELETE_RESULT)
  assert.ok(result, 'must have sent BOT_DELETE_RESULT')
  assert.equal(result.data.ok, false)
  assert.equal(result.data.error, 'bot-delete-no-receiver')
})

test('S57-B-receiver-fail: receiver throws → failure error returned', async () => {
  // Knife: remove try/catch in handleBotDeleteFrame → uncaught throw, no result sent → timeout → RED
  const { sent } = await dispatchBotDelete(
    { nodeId: 'n1', requestId: 'req-3', remoteBotId: 'rb3' },
    async () => { throw new Error('disk full') }
  )
  const result = sent.find((s) => s.type === NODE_TO_HUB.BOT_DELETE_RESULT)
  assert.ok(result, 'must have sent BOT_DELETE_RESULT')
  assert.equal(result.data.ok, false)
  assert.match(result.data.error ?? '', /disk full/)
})
