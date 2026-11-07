import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleBotTurnFrame } from '../lib/bot-turn.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotTurn, validateBotTurnResult, validateTaskStart } from '../lib/protocol.js'
import { withIngest } from '../lib/hub/registry-ingest.js'

function engine() {
  return { accepted: 0, accept() { this.accepted += 1 } }
}

test('bot/turn requires nodeId, remoteBotId, exchangeId and text', () => {
  const ok = validateBotTurn({ nodeId: ' n ', remoteBotId: ' alpha ', exchangeId: ' e1 ', text: 'hi', mode: 'exec' })
  assert.equal(ok.ok, true)
  assert.equal(ok.turn.nodeId, 'n')
  assert.equal(ok.turn.remoteBotId, 'alpha')
  assert.equal(ok.turn.exchangeId, 'e1')
  assert.equal(ok.turn.text, 'hi')
  assert.equal(ok.turn.mode, undefined)
  assert.equal(validateBotTurn({ nodeId: 'n', exchangeId: 'e', text: 'hi' }).error, 'bot-turn-remoteBotId-missing')
  assert.equal(validateBotTurn({ nodeId: 'n', remoteBotId: 'a', exchangeId: 'e' }).error, 'bot-turn-text-missing')
  assert.equal(validateBotTurnResult({ text: 'x' }).ok, false)
  const task = validateTaskStart({ nodeId: 'n', remoteBotId: 'a', exchangeId: 'e', text: 'hi' })
  assert.equal(task.ok, false)
  assert.notEqual(task.error, undefined)
})

test('bot/turn does not enter the task engine', async () => {
  const src = readFileSync(new URL('../lib/node/index.js', import.meta.url), 'utf8')
  assert.match(src, /case HUB_TO_NODE\.BOT_TURN:[\s\S]{0,180}swallow\(handleBotTurnFrame\(/)
  const task = engine()
  const sent = []
  const errors = []
  const missing = await handleBotTurnFrame({
    frame: { id: 'f0', t: HUB_TO_NODE.BOT_TURN },
    data: { nodeId: 'n', exchangeId: 'e', text: 'hi', mode: 'agent' },
    engine: task,
    send(type, data) { sent.push({ type, data }) },
    sendError(id, code) { errors.push({ id, code }) },
  })
  assert.equal(missing.accepted, false)
  assert.equal(missing.error, 'bot-turn-remoteBotId-missing')
  assert.equal(task.accepted, 0)
  assert.equal(sent.length, 0)
  assert.equal(errors[0].code, 'bot-turn-remoteBotId-missing')

  const answered = engine()
  const replies = []
  const result = await handleBotTurnFrame({
    frame: { id: 'f1', t: HUB_TO_NODE.BOT_TURN },
    data: { nodeId: 'n', remoteBotId: 'alpha', exchangeId: 'e1', text: 'hi' },
    engine: answered,
    ctx: { get: () => async () => ({ ok: true, text: 'pong' }) },
    send(type, data) { replies.push({ type, data }) },
    sendError() { throw new Error('valid bot/turn must not sendError') },
  })
  assert.equal(result.accepted, true)
  assert.equal(answered.accepted, 0)
  assert.equal(replies[0].type, NODE_TO_HUB.BOT_TURN_RESULT)
  assert.equal(replies[0].data.exchangeId, 'e1')
  assert.equal(replies[0].data.remoteBotId, 'alpha')
  assert.equal(replies[0].data.text, 'pong')
  assert.equal(replies[0].data.mode, undefined)
})

test('bot/turn-result is emitted by exchangeId and a bad frame is dropped', () => {
  const listeners = {}
  class Core {
    constructor() {
      this.nodes = new Map([['n1', { nodeId: 'n1', lastSeen: 0, online: true }]])
      this.tasks = new Map()
    }
    log() {}
    send() {}
    on(name, fn) { (listeners[name] ??= []).push(fn) }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
  }
  const registry = new (withIngest(Core))()
  const got = []
  registry.on('botTurnResult', (payload) => got.push(payload))
  registry.handleFrameFor('n1', {
    t: NODE_TO_HUB.BOT_TURN_RESULT,
    d: { nodeId: 'n1', remoteBotId: 'alpha', exchangeId: 'e1', text: 'pong', ok: true },
  })
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_TURN_RESULT, d: { text: 'no-id' } })
  assert.equal(got.length, 1)
  assert.equal(got[0].exchangeId, 'e1')
  assert.equal(got[0].text, 'pong')
})
