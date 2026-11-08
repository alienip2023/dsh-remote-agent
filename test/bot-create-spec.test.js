// The Bot spec (modelRef / effort / workDir / instructions) must survive the whole hop:
// main NodeRegistry.send → wire frame → node dispatch → validateBotCreate → receiver.
// validateBotCreate once whitelisted only {nodeId, requestId, name, role}, so the receiver
// always saw modelRef=null and its workDir check never ran.
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { handleBotCreateFrame, BOT_CREATE_RECEIVER } from '../lib/bot-create.js'
import { HUB_TO_NODE, decodeFrame, validateBotCreate } from '../lib/protocol.js'
import { E2E_MARKER } from '../lib/e2e.js'

const MODEL = 'siliconflow/deepseek-ai/DeepSeek-V4.1-Flash'
const fakeE2E = () => ({ sealFrame: (_type, _id, d) => ({ e2e: E2E_MARKER, inner: d }) })

// Send through a real NodeRegistry, open the frame as the node would, run the node handler.
async function hop(payload) {
  const wire = []
  const relay = { ready: true, send: (nodeId, text) => { wire.push(text); return true } }
  const registry = new NodeRegistry({ log() {}, relay })
  registry.nodes.set('n1', { nodeId: 'n1', online: true, lastSeen: 0, e2e: fakeE2E() })
  assert.equal(registry.send('n1', HUB_TO_NODE.BOT_CREATE, { nodeId: 'n1', requestId: 'req-1', name: 'test3', role: '', ...payload }), true)
  assert.equal(wire.length, 1)
  const decoded = decodeFrame(wire[0])
  assert.equal(decoded.ok, true)
  const frame = decoded.frame
  assert.equal(frame.t, HUB_TO_NODE.BOT_CREATE)
  const d = frame.d?.e2e === E2E_MARKER ? frame.d.inner : frame.d
  const specs = []
  const replies = []
  const ctx = { get: (name) => (name === BOT_CREATE_RECEIVER ? async (spec) => { specs.push(spec); return { ok: true, remoteBotId: 'session-1', name: spec.name, role: spec.role } } : undefined) }
  await handleBotCreateFrame({ frame, data: d, ctx, send: (type, data) => replies.push({ type, data }), sendError() {}, engine: {} })
  return { specs, replies }
}

test('1. modelRef (with slashes) reaches the receiver unchanged', async () => {
  const { specs } = await hop({ modelRef: MODEL })
  assert.equal(specs.length, 1)
  assert.equal(specs[0].modelRef, MODEL, 'receiver modelRef is ' + JSON.stringify(specs[0].modelRef))
})

test('2. effort, workDir and instructions reach the receiver unchanged', async () => {
  const instructions = '你是测试员。\nBe concise; answer in Chinese. "quotes" & <tags>'
  const { specs } = await hop({ modelRef: MODEL, effort: 'high', workDir: '/root/work/proj', instructions })
  assert.equal(specs[0].effort, 'high')
  assert.equal(specs[0].workDir, '/root/work/proj')
  assert.equal(specs[0].instructions, instructions)
})

test('3. long instructions are not cut at the protocol layer (8000-byte clamp is the sender\'s)', async () => {
  const instructions = 'x'.repeat(8000)
  const { specs } = await hop({ instructions })
  assert.equal(specs[0].instructions.length, 8000)
})

test('4. absent or wrong-typed fields become null, the frame is not refused', async () => {
  const { specs, replies } = await hop({ modelRef: 42, effort: {}, workDir: ['/x'], instructions: false })
  assert.equal(specs.length, 1, 'frame must still reach the receiver')
  assert.deepEqual([specs[0].modelRef, specs[0].effort, specs[0].workDir, specs[0].instructions], [null, null, null, null])
  assert.equal(replies[0].data.ok, true)
  const bare = await hop({})
  assert.deepEqual([bare.specs[0].modelRef, bare.specs[0].effort, bare.specs[0].workDir, bare.specs[0].instructions], [null, null, null, null])
})

test('5. validateBotCreate keeps name/role limits and still requires nodeId/requestId/name', () => {
  const v = validateBotCreate({ nodeId: 'n', requestId: 'r', name: ' A '.repeat(30), role: 'r'.repeat(40), modelRef: MODEL })
  assert.equal(v.ok, true)
  assert.equal(v.create.name.length, 40)
  assert.equal(v.create.role.length, 24)
  assert.equal(v.create.modelRef, MODEL)
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r' }).error, 'bot-create-name-missing')
})
