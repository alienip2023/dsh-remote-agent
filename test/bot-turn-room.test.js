import test from 'node:test'
import assert from 'node:assert/strict'
import { BOT_TURN_RECEIVER, handleBotTurnFrame } from '../lib/bot-turn.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotTurn, validateBotTurnResult } from '../lib/protocol.js'

const TURN = { nodeId: 'n', remoteBotId: 'alpha', exchangeId: 'e1', text: 'hi' }
const ROOM = { roomId: 'room-1', roomName: '项目群' }
const RESULT = { ...TURN, text: 'pong', ok: true, seq: 7 }

test('1. bot/turn preserves roomId and roomName alongside sender identity', () => {
  const turn = { ...TURN, senderBotId: 'ds-bot', senderName: '主控', ...ROOM }
  assert.deepEqual(validateBotTurn(turn), { ok: true, turn })
})

test('2. bot/turn without room fields keeps the exact legacy shape with or without sender', () => {
  for (const sender of [{}, { senderBotId: 'ds-bot' }, { senderName: '主控' }, { senderBotId: 'ds-bot', senderName: '主控' }]) {
    const turn = { ...TURN, ...sender }
    const checked = validateBotTurn(turn)
    assert.deepEqual(checked, { ok: true, turn })
    assert.equal(Object.hasOwn(checked.turn, 'roomId'), false)
    assert.equal(Object.hasOwn(checked.turn, 'roomName'), false)
  }
})

test('3. bot/turn rejects invalid roomId with bot-turn-room-invalid', () => {
  for (const roomId of [undefined, null, 42, false, [], {}, '', ' \t\n ', 'r'.repeat(201)]) {
    assert.deepEqual(validateBotTurn({ ...TURN, roomId }), {
      ok: false, error: 'bot-turn-room-invalid',
    }, `roomId=${JSON.stringify(roomId)}`)
  }
})

test('4. bot/turn rejects invalid roomName including over 80 characters', () => {
  for (const roomName of [undefined, null, 42, false, [], {}, '', ' \t\n ', '名'.repeat(81)]) {
    assert.deepEqual(validateBotTurn({ ...TURN, roomName }), {
      ok: false, error: 'bot-turn-room-invalid',
    }, `roomName=${JSON.stringify(roomName)}`)
  }
})

test('5. handleBotTurnFrame forwards room identity and returns the same roomId through result validation', async () => {
  const received = []
  const sent = []
  const frame = { id: 'f-room', t: HUB_TO_NODE.BOT_TURN, d: { ...TURN, ...ROOM } }
  const result = await handleBotTurnFrame({
    frame,
    data: frame.d,
    ctx: {
      get(name) {
        assert.equal(name, BOT_TURN_RECEIVER)
        return async (turn) => {
          received.push(turn)
          return { ok: true, text: RESULT.text }
        }
      },
    },
    turnSeq: { next: () => RESULT.seq },
    send(type, data) { sent.push({ type, data }) },
    sendError() { assert.fail('valid bot/turn must not sendError') },
  })

  assert.deepEqual(result, { accepted: true, exchangeId: TURN.exchangeId })
  assert.deepEqual(received, [{ ...TURN, ...ROOM }])
  assert.deepEqual(sent, [{ type: NODE_TO_HUB.BOT_TURN_RESULT, data: { ...RESULT, roomId: ROOM.roomId } }])
  assert.deepEqual(validateBotTurnResult(sent[0].data), { ok: true, result: sent[0].data })
})

for (const [field, limit] of [['roomId', 200], ['roomName', 80]]) {
  test(`bot/turn trims ${field} independently and accepts its exact length limit`, () => {
    for (const value of ['群聊', 'r'.repeat(limit)]) {
      assert.deepEqual(validateBotTurn({ ...TURN, [field]: ` \t${value}\n ` }), {
        ok: true, turn: { ...TURN, [field]: value },
      })
    }
  })
}

test('bot/turn-result preserves roomId and keeps the legacy shape when absent', () => {
  assert.deepEqual(validateBotTurnResult({ ...RESULT, roomId: ` ${ROOM.roomId} ` }), {
    ok: true, result: { ...RESULT, roomId: ROOM.roomId },
  })
  const checked = validateBotTurnResult(RESULT)
  assert.deepEqual(checked, { ok: true, result: RESULT })
  assert.equal(Object.hasOwn(checked.result, 'roomId'), false)
  const roomId = 'r'.repeat(200)
  assert.deepEqual(validateBotTurnResult({ ...RESULT, roomId }), {
    ok: true, result: { ...RESULT, roomId },
  })
})

test('bot/turn-result rejects malformed roomId', () => {
  for (const roomId of [undefined, null, 42, false, [], {}, '', ' \t\n ', 'r'.repeat(201)]) {
    assert.deepEqual(validateBotTurnResult({ ...RESULT, roomId }), {
      ok: false, error: 'bot-turn-result-room-invalid',
    }, `roomId=${JSON.stringify(roomId)}`)
  }
})
