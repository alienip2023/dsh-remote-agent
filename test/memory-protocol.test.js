/**
 * M4 S2：mem/* 协议面。
 *
 * 这里只验「形状与闸门」：四个 validator 对任何输入都返回对象或 null（绝不抛），
 * memory-link 的四道发送闸门，以及 transport 的 E2E 正文门。
 * 真正的读写语义在 S4，hub 落盘在 S3。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_MEMORY_FRAME_BYTES,
  MEMORY,
  MEMORY_CAPS,
  isMemoryFrameType,
  validateMemAck,
  validateBotCreate,
  validateMemRead,
  validateMemSnapshot,
  validateMemWrite,
} from '../lib/protocol.js'
import { checkE2EGate, isE2ERequired } from '../lib/node/transport.js'
import { createMemoryLink } from '../lib/node/memory-link.js'

const READ = { requestId: 'r-1', remoteBotId: 'bot-1', scope: 'bot', query: 'deploy', limit: 5 }
const WRITE = { requestId: 'r-2', remoteBotId: 'bot-1', scope: 'bot', op: 'add', text: 'remember this' }
const SNAPSHOT = { seq: 3, team: '# team', node: '# node', bots: { 'bot-1': { text: '# bot' } } }

/* ─────────────────────────── validators ─────────────────────────── */

test('the four body validators accept a well-formed frame', () => {
  assert.deepEqual(validateMemRead(READ), READ)
  assert.deepEqual(validateMemWrite(WRITE), WRITE)
  assert.deepEqual(validateMemSnapshot(SNAPSHOT), SNAPSHOT)
  assert.deepEqual(validateMemAck({ seq: 7 }), { seq: 7 })
})

test('a malformed frame validates to null and never throws', () => {
  const bad = [null, undefined, 'mem/read', 42, [], {}, { requestId: 'r' }, { requestId: 'r', remoteBotId: 'b', scope: 'galaxy' }]
  for (const d of bad) {
    assert.doesNotThrow(() => validateMemRead(d))
    assert.equal(validateMemRead(d), null, `read accepted ${JSON.stringify(d)}`)
  }
  for (const d of [null, 'x', { requestId: 'r', remoteBotId: 'b', scope: 'bot', op: 'delete', text: 'x' }, { requestId: 'r', remoteBotId: 'b', scope: 'bot', op: 'add' }]) {
    assert.doesNotThrow(() => validateMemWrite(d))
    assert.equal(validateMemWrite(d), null, `write accepted ${JSON.stringify(d)}`)
  }
  for (const d of [null, 'x', { seq: -1, team: '', node: '', bots: {} }, { seq: 1, team: '', node: '', bots: { 'bad id': { text: 'x' } } }]) {
    assert.doesNotThrow(() => validateMemSnapshot(d))
    assert.equal(validateMemSnapshot(d), null, `snapshot accepted ${JSON.stringify(d)}`)
  }
  for (const d of [null, {}, { seq: -1 }, { seq: 1.5 }]) {
    assert.doesNotThrow(() => validateMemAck(d))
    assert.equal(validateMemAck(d), null, `ack accepted ${JSON.stringify(d)}`)
  }
})

test('a write carries no body for forget and requires text for add', () => {
  assert.equal(validateMemWrite({ requestId: 'r', remoteBotId: 'b', scope: 'bot', op: 'forget', replace: 'old' }).op, 'forget')
  assert.equal(validateMemWrite({ requestId: 'r', remoteBotId: 'b', scope: 'bot', op: 'add' }), null)
  assert.equal(validateMemWrite({ requestId: 'r', remoteBotId: 'b', scope: 'bot', op: 'add', text: 'x'.repeat(8193) }), null)
})

/* ─────────────────────────── memory-link gates ─────────────────────────── */

function linkFor(over = {}) {
  const sent = []
  const warnings = []
  const link = createMemoryLink({
    send: (type, data) => {
      sent.push({ type, data })
      return true
    },
    nodeId: 'n-1',
    hubCaps: () => [MEMORY_CAPS],
    e2eReady: () => true,
    appliedSeq: () => 9,
    logger: { warn: (msg, extra) => warnings.push({ msg, extra }) },
    ...over,
  })
  return { link, sent, warnings }
}

test('an old hub that never announced memory-sync/1 gets no memory frame at all', () => {
  const { link, sent } = linkFor({ hubCaps: () => [] })
  assert.equal(link.online(), false)
  assert.equal(link.send(MEMORY.READ, READ), false)
  assert.equal(link.send(MEMORY.HELLO, { appliedSeq: 0 }), false)
  assert.deepEqual(sent, [])
  assert.equal(link.stats.blocked, 3)
})

test('an offline or unbound link sends nothing', () => {
  const { link, sent } = linkFor()
  assert.equal(link.send(MEMORY.HELLO, {}), false)
  assert.equal(link.stats.blocked, 1)

  link.bind(null)
  link.online()
  assert.equal(link.isOnline, true)
  assert.equal(link.send(MEMORY.HELLO, {}), false)
  assert.equal(link.stats.blocked, 2)
  assert.deepEqual(sent, [])
})

test('the connection identity overwrites whatever nodeId the caller puts in the payload', () => {
  const { link, sent } = linkFor()
  link.bind('n-1')
  link.online()
  assert.equal(link.send(MEMORY.READ, { ...READ, nodeId: 'someone-else' }), true)
  assert.equal(sent.at(-1).data.nodeId, 'n-1')
  assert.equal(sent.at(-1).data.requestId, 'r-1')
})

test('read and write need an e2e session; hello and ack do not', () => {
  let e2e = false
  const { link, sent } = linkFor({ e2eReady: () => e2e })
  link.bind('n-1')
  link.online()
  assert.equal(link.send(MEMORY.HELLO, { appliedSeq: 1 }), true)
  assert.equal(link.send(MEMORY.ACK, { seq: 1 }), true)
  assert.equal(link.send(MEMORY.READ, READ), false)
  assert.equal(link.send(MEMORY.WRITE, WRITE), false)
  assert.equal(link.stats.e2eBlocked, 2)
  e2e = true
  assert.equal(link.send(MEMORY.READ, READ), true)
  assert.equal(sent.filter((f) => f.type === MEMORY.READ).length, 1)
})

test('an oversized memory frame is dropped and counted, not truncated', () => {
  const { link, sent, warnings } = linkFor()
  link.bind('n-1')
  link.online()
  sent.length = 0
  const huge = { seq: 1, team: 'x'.repeat(MAX_MEMORY_FRAME_BYTES), node: '', bots: {} }
  assert.equal(link.send(MEMORY.SNAPSHOT, huge), false)
  assert.equal(sent.length, 0)
  assert.equal(link.stats.oversize, 1)
  assert.equal(warnings.length, 1)
})

test('online announces the applied seq and dispatch routes by frame type', () => {
  const { link, sent } = linkFor()
  const seen = []
  const off = link.on(MEMORY.SNAPSHOT, (d) => seen.push(d))
  link.bind('n-1')
  assert.equal(link.online(), true)
  assert.deepEqual(sent[0], { type: MEMORY.HELLO, data: { appliedSeq: 9, nodeId: 'n-1' } })
  assert.equal(link.dispatch(MEMORY.SNAPSHOT, SNAPSHOT), true)
  assert.deepEqual(seen, [SNAPSHOT])
  off()
  assert.equal(link.dispatch(MEMORY.SNAPSHOT, SNAPSHOT), false)
  assert.equal(link.dispatch('mem/unknown', {}), false)
})

/* ─────────────────────────── transport gate ─────────────────────────── */

test('transport puts the whole mem family in the e2e-required set, and bodies wait for it', () => {
  for (const type of Object.values(MEMORY)) {
    assert.equal(isMemoryFrameType(type), true)
    assert.equal(isE2ERequired(type), true, `${type} is not e2e-required`)
  }
  for (const type of [MEMORY.SNAPSHOT, MEMORY.READ_RESULT, MEMORY.WRITE_RESULT]) {
    const verdict = checkE2EGate({ t: type }, { e2e: false, wasEncrypted: false })
    assert.equal(verdict.rejected, true, `${type} passed without e2e`)
  }
  // hello / ack 是控制帧：会话尚未建立时也能通过（正文帧不行）。
  for (const type of [MEMORY.HELLO, MEMORY.ACK]) {
    assert.equal(checkE2EGate({ t: type }, { e2e: false, wasEncrypted: false }).rejected, false)
  }
})


test('a node tells the hub how far its cache got, before and after it loads it', () => {
  const { link, sent } = linkFor({ appliedSeq: () => 0 })
  link.bind('n-1')
  // Online sends the first hello with the seq the link was built with (0 before the
  // node has loaded its cache).
  assert.equal(link.online(), true)
  assert.deepEqual(sent.at(-1), { type: MEMORY.HELLO, data: { nodeId: 'n-1', appliedSeq: 0 } })

  // S4 hands the link a thunk that reads the cache, then announces again: the hub sees
  // the applied seq instead of a needless full snapshot.
  let applied = 12
  assert.equal(link.setAppliedSeq(() => applied), 12)
  assert.equal(link.announce(), true)
  assert.deepEqual(sent.at(-1), { type: MEMORY.HELLO, data: { nodeId: 'n-1', appliedSeq: 12 } })
  applied = 13
  link.online()
  assert.deepEqual(sent.at(-1), { type: MEMORY.HELLO, data: { nodeId: 'n-1', appliedSeq: 13 } })

  link.offline()
  assert.equal(link.announce(), false)
})

test('bot/create carries the memory backend the main picked, and a bad shape is dropped', () => {
  const base = { nodeId: 'n', requestId: 'r', name: 'One', managedBy: 'hub' }
  const ok = validateBotCreate({ ...base, memoryConfig: { backend: 'federation' } })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.create.memoryConfig, { backend: 'federation' })
  // A field of the wrong type is "not given", never a refused frame: an older hub and
  // an older node must still be able to create Bots.
  for (const bad of [null, 'federation', [], { backend: 3 }, { backend: ' '.repeat(4) }, { backend: 'x'.repeat(40) }]) {
    const parsed = validateBotCreate({ ...base, memoryConfig: bad })
    assert.equal(parsed.ok, true, JSON.stringify(bad))
    assert.equal(parsed.create.memoryConfig, null, JSON.stringify(bad))
  }
})
