import test from 'node:test'
import assert from 'node:assert/strict'
import { BOT_TURN_RECEIVER, handleBotTurnFrame } from '../lib/bot-turn.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotTurn } from '../lib/protocol.js'

const TURN = { nodeId: 'n', remoteBotId: 'alpha', exchangeId: 'e1', text: 'hi' }

test('bot/turn preserves and trims both sender fields', () => {
  assert.deepEqual(validateBotTurn({ ...TURN, senderBotId: ' ds-bot ', senderName: ' 主控 ' }), {
    ok: true,
    turn: { ...TURN, senderBotId: 'ds-bot', senderName: '主控' },
  })
})

test('bot/turn without sender fields keeps the original four-field shape', () => {
  assert.deepEqual(validateBotTurn(TURN), { ok: true, turn: TURN })
})

for (const field of ['senderBotId', 'senderName']) {
  test(`bot/turn accepts ${field} independently and trims it`, () => {
    assert.deepEqual(validateBotTurn({ ...TURN, [field]: '\t sender \n' }), {
      ok: true,
      turn: { ...TURN, [field]: 'sender' },
    })
  })

  test(`bot/turn accepts ${field} with exactly 80 characters after trimming`, () => {
    const value = 'a'.repeat(80)
    assert.deepEqual(validateBotTurn({ ...TURN, [field]: ` ${value} ` }), {
      ok: true,
      turn: { ...TURN, [field]: value },
    })
  })

  const invalidCases = [
    ['empty string', '', 'bot-turn-sender-invalid'],
    ['whitespace', ' \t\n ', 'bot-turn-sender-invalid'],
    ['undefined', undefined, 'bot-turn-sender-invalid'],
    ['null', null, 'bot-turn-sender-invalid'],
    ['number', 42, 'bot-turn-sender-invalid'],
    ['boolean', false, 'bot-turn-sender-invalid'],
    ['array', ['sender'], 'bot-turn-sender-invalid'],
    ['object', { name: 'sender' }, 'bot-turn-sender-invalid'],
    ['over 80 characters', ` ${'a'.repeat(81)} `, 'bot-turn-sender-too-long'],
  ]
  for (const [label, value, error] of invalidCases) {
    test(`bot/turn rejects ${field}: ${label}`, () => {
      assert.deepEqual(validateBotTurn({ ...TURN, [field]: value }), { ok: false, error })
    })
  }
}

test('handleBotTurnFrame forwards sender identity and preserves the result body', async () => {
  const received = []
  const sent = []
  const frame = {
    id: 'f-sender',
    t: HUB_TO_NODE.BOT_TURN,
    d: { ...TURN, senderBotId: ' ds-bot ', senderName: ' 主控 ' },
  }
  const result = await handleBotTurnFrame({
    frame,
    data: frame.d,
    ctx: {
      get(name) {
        assert.equal(name, BOT_TURN_RECEIVER)
        return async (turn) => {
          received.push(turn)
          return { ok: true, text: ' pong\n' }
        }
      },
    },
    turnSeq: {
      next(remoteBotId) {
        assert.equal(remoteBotId, TURN.remoteBotId)
        return 7
      },
    },
    send(type, data) { sent.push({ type, data }) },
    sendError() { assert.fail('valid bot/turn must not sendError') },
  })

  assert.deepEqual(result, { accepted: true, exchangeId: TURN.exchangeId })
  assert.deepEqual(received, [{ ...TURN, senderBotId: 'ds-bot', senderName: '主控' }])
  assert.deepEqual(sent, [{
    type: NODE_TO_HUB.BOT_TURN_RESULT,
    data: { ...TURN, text: ' pong\n', ok: true, seq: 7 },
  }])
})
