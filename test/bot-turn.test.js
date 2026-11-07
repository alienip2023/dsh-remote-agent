import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleBotTurnFrame } from '../lib/bot-turn.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotTurn, validateBotTurnResult, validateTaskStart } from '../lib/protocol.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { applyWorker } from '../lib/node/index.js'
import { NodeTransport } from '../lib/node/transport.js'
import { TaskEngine } from '../lib/node/task-engine.js'

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

async function dispatchBotTurn(frameData) {
  const sent = []
  const accepted = { n: 0 }
  const frameHandlers = []
  const origOn = NodeTransport.prototype.on
  const origSend = NodeTransport.prototype.send
  const origAccept = TaskEngine.prototype.accept
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-turn-'))
  let dispose = () => {}
  NodeTransport.prototype.on = function on(evt, fn) {
    if (evt === 'frame') frameHandlers.push(fn)
    return origOn.call(this, evt, fn)
  }
  NodeTransport.prototype.send = function send(type, data, opts) {
    sent.push({ type, data, opts })
    return true
  }
  TaskEngine.prototype.accept = function accept(...args) {
    accepted.n += 1
    return origAccept.apply(this, args)
  }
  try {
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get(name) {
        if (name === 'remote-agent:bot-turn') return async () => ({ ok: true, text: 'pong' })
        return undefined
      },
    }
    dispose = applyWorker(ctx, {
      hubUrl: '',
      stateDir,
      roots: [stateDir],
      resourceIntervalMs: 0,
      reposIntervalMs: 0,
      nodeId: 'node-a',
    })
    const handler = frameHandlers.at(-1)
    if (typeof handler === 'function') {
      handler({ id: 'f-dispatch', t: HUB_TO_NODE.BOT_TURN, d: frameData })
    }
    const started = Date.now()
    while (!sent.some((item) => item.type === NODE_TO_HUB.BOT_TURN_RESULT) && Date.now() - started < 500) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { sent, accepted: accepted.n }
  } finally {
    NodeTransport.prototype.on = origOn
    NodeTransport.prototype.send = origSend
    TaskEngine.prototype.accept = origAccept
    try { dispose() } catch { /* worker dispose is best-effort */ }
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

test('bot/turn does not enter the task engine', async () => {
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

  const dispatched = await dispatchBotTurn({
    nodeId: 'n',
    remoteBotId: 'alpha',
    exchangeId: 'e1',
    text: 'hi',
  })
  const turn = dispatched.sent.find((item) => item.type === NODE_TO_HUB.BOT_TURN_RESULT)
  assert.equal(turn?.type, NODE_TO_HUB.BOT_TURN_RESULT)
  assert.equal(turn?.data?.exchangeId, 'e1')
  assert.equal(turn?.data?.remoteBotId, 'alpha')
  assert.equal(turn?.data?.text, 'pong')
  assert.equal(dispatched.accepted, 0)
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
