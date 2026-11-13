// M4 S6 补片：主控改 joined Bot 的记忆后端，必须真的到达节点。
//
// 这里钉住三件事：bot/update 的校验（只带 memoryConfig 也能成立、坏形状拒绝）、
// 帧处理器把它原样交给副机 ds-bot 的 receiver 并把应用后的值带回去、
// hello 宣告 bot-memory-update/1（hub 凭它决定敢不敢发这条字段）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOT_MEMORY_UPDATE_CAP,
  HUB_TO_NODE,
  NODE_TO_HUB,
  nodeCaps,
  validateBotUpdate,
  validateBotUpdateResult,
} from '../lib/protocol.js'
import { BOT_UPDATE_RECEIVER, handleBotUpdateFrame } from '../lib/bot-update.js'

const base = { nodeId: 'n1', remoteBotId: 'b1', requestId: 'r1' }

test('1. a frame that changes only the memory backend is valid', () => {
  const r = validateBotUpdate({ ...base, memoryConfig: { backend: 'file' } })
  assert.equal(r.ok, true, 'memoryConfig alone must pass (the old all-null rule refused it)')
  assert.deepEqual(r.update.memoryConfig, { backend: 'file' })
  assert.equal(r.update.model, null)
  assert.equal(r.update.effort, null)
})

test('2. the backend travels with the rest of the patch', () => {
  const r = validateBotUpdate({ ...base, model: 'prov/m', memoryConfig: { backend: 'federation' } })
  assert.equal(r.ok, true)
  assert.equal(r.update.model, 'prov/m')
  assert.deepEqual(r.update.memoryConfig, { backend: 'federation' })
})

test('3. a malformed backend refuses the whole frame', () => {
  for (const bad of [[], 'file', { backend: 7 }, { backend: '   ' }, { backend: 'x'.repeat(33) }, { backend: '' }]) {
    const r = validateBotUpdate({ ...base, memoryConfig: bad })
    assert.equal(r.ok, false, `must refuse ${JSON.stringify(bad)}`)
    assert.equal(r.error, 'bot-update-memoryConfig-invalid')
  }
})

test('4. an unknown backend value is passed through, not judged here', () => {
  // 枚举属于节点上 ds-bot 的 roster（它丢弃未知值）；协议层只校验形状，不拒帧。
  const r = validateBotUpdate({ ...base, memoryConfig: { backend: 'sqlite' } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.update.memoryConfig, { backend: 'sqlite' })
})

test('5. no backend reads as null and an otherwise empty patch still refuses', () => {
  assert.equal(validateBotUpdate({ ...base, memoryConfig: null }).error, 'bot-update-all-null')
  assert.equal(validateBotUpdate({ ...base, instructions: 'x' }).update.memoryConfig, null)
})

test('6. handleBotUpdateFrame hands memoryConfig to the receiver and returns the applied backend', async () => {
  const sent = []
  const specs = []
  const receiver = async (spec) => {
    specs.push(spec)
    return { ok: true, model: spec.model, effort: null, instructions: null, workDir: null, memoryConfig: { backend: 'file' } }
  }
  const ctx = { logger: { info() {}, warn() {}, error() {}, debug() {} }, get: (n) => n === BOT_UPDATE_RECEIVER ? receiver : undefined }
  await handleBotUpdateFrame({
    frame: { id: 'f1', t: HUB_TO_NODE.BOT_UPDATE, d: {} },
    data: { ...base, memoryConfig: { backend: 'file' } },
    ctx,
    send: (type, data) => { sent.push({ type, data }); return true },
    sendError: () => {},
  })
  assert.equal(specs.length, 1)
  assert.deepEqual(specs[0].memoryConfig, { backend: 'file' })
  const reply = sent.find(s => s.type === NODE_TO_HUB.BOT_UPDATE_RESULT)
  assert.ok(reply, 'bot/update-result must be sent')
  assert.equal(reply.data.ok, true)
  assert.deepEqual(reply.data.memoryConfig, { backend: 'file' })
})

test('7. bot/update-result carries an applied backend, and null when the frame had none', () => {
  const withBackend = validateBotUpdateResult({ requestId: 'r1', ok: true, memoryConfig: { backend: 'file' } })
  assert.deepEqual(withBackend.result.memoryConfig, { backend: 'file' })
  const without = validateBotUpdateResult({ requestId: 'r1', ok: true })
  assert.equal(without.result.memoryConfig, null)
})

test('8. node hello advertises the update capability', () => {
  const darwin = nodeCaps(['fs', 'exec', 'artifact', 'agent'], 'darwin')
  assert.ok(darwin.includes(BOT_MEMORY_UPDATE_CAP), 'hello must advertise bot-memory-update/1')
  assert.ok(!darwin.includes('desktop'), 'desktop/gui stay Windows-only')
  const win = nodeCaps(['fs'], 'win32')
  assert.ok(win.includes('desktop') && win.includes('gui'))
  assert.ok(win.includes(BOT_MEMORY_UPDATE_CAP))
})
