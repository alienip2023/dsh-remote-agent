import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotNetwork } from '../lib/node/bot-network.js'

const message = nodeId => ({
  from: { id: 'b1', name: 'B1', nodeId },
  to: { id: 'b2', name: 'B2', nodeId: 'node-b' },
  exchangeId: 'identity-1', kind: 'ask', text: 'hello', depth: 0,
})

test('node network exposes its constructor nodeId', t => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  t.after(() => network.dispose())
  assert.equal(network.nodeId, 'node-a')
})

test('node network nodeId cannot be overwritten', t => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  t.after(() => network.dispose())
  try { network.nodeId = 'node-b' } catch (err) {
    assert.ok(err instanceof TypeError)
  }
  assert.equal(network.nodeId, 'node-a')
})

test('node network sends a bot/message using its exposed nodeId', t => {
  const sent = []
  const network = createBotNetwork({ nodeId: 'node-a', send(type, data) {
    sent.push({ type, data })
    return true
  } })
  t.after(() => network.dispose())
  assert.doesNotThrow(() => assert.equal(network.send(message(network.nodeId)), true))
  assert.deepEqual(sent, [{ type: 'bot/message', data: message('node-a') }])
})

test('node network still rejects a sender from another node', t => {
  const sent = []
  const network = createBotNetwork({ nodeId: 'node-a', send: (...args) => {
    sent.push(args)
    return true
  } })
  t.after(() => network.dispose())
  assert.throws(() => network.send(message('node-b')), { code: 'bot-message-invalid' })
  assert.deepEqual(sent, [])
})
