import test from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../lib/protocol.js'
import { BOT_UPDATE_RECEIVER, handleBotUpdateFrame } from '../lib/bot-update.js'

const base = { nodeId: 'n1', remoteBotId: 'b1', requestId: 'r1' }
const profile = { name: 'Scout', role: 'Research', color: 'blue', avatar: { shape: 'cat' } }
const image = 'data:image/webp;base64,AAAA'

test('profile-only updates survive validation and normalise bounded strings', () => {
  const r = protocol.validateBotUpdate({ ...base, ...profile, name: ` ${'n'.repeat(41)} `, role: ` ${'r'.repeat(25)} `, color: ' blue ', sectionId: 'hub-only' })
  assert.equal(r.ok, true)
  assert.equal(r.update.name, 'n'.repeat(40))
  assert.equal(r.update.role, 'r'.repeat(24))
  assert.equal(r.update.color, 'blue')
  assert.deepEqual(r.update.avatar, profile.avatar)
  assert.equal(Object.hasOwn(r.update, 'sectionId'), false)
})

test('each profile field can be the only change', () => {
  for (const [key, value] of Object.entries(profile)) {
    const r = protocol.validateBotUpdate({ ...base, [key]: value })
    assert.equal(r.ok, true, key)
    assert.deepEqual(r.update[key], value)
  }
})

test('empty label and explicit appearance resets are changes, null remains no-op', () => {
  for (const [key, value] of Object.entries({ role: '', color: '', avatar: {} })) {
    const r = protocol.validateBotUpdate({ ...base, [key]: value })
    assert.equal(r.ok, true, key)
    assert.deepEqual(r.update[key], value)
  }
  assert.equal(protocol.validateBotUpdate({ ...base, name: null, role: null, color: null, avatar: null }).error, 'bot-update-all-null')
})

test('garbage profile fields become null without rejecting a valid model patch', () => {
  for (const bad of [7, true, [], { unexpected: true }]) {
    const r = protocol.validateBotUpdate({ ...base, model: 'p/m', name: bad, role: bad, color: bad, avatar: bad })
    assert.equal(r.ok, true)
    for (const key of Object.keys(profile)) assert.equal(r.update[key], null, key)
  }
  assert.equal(protocol.validateBotUpdate({ ...base, name: '   ' }).error, 'bot-update-all-null')
  assert.equal(protocol.validateBotUpdate({ ...base, avatar: ['cat'] }).error, 'bot-update-all-null')
})

test('avatar accepts only bounded shape and image properties', () => {
  const r = protocol.validateBotUpdate({ ...base, avatar: { shape: 'a'.repeat(32), image, extra: 'drop' } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.update.avatar, { shape: 'a'.repeat(32), image })
  for (const avatar of [{ shape: 'a'.repeat(33) }, { shape: 7 }, { image: 7 }, { image: 'https://example.test/a.png' }, { image: `data:image/png;base64,${'A'.repeat(160000)}` }]) {
    const checked = protocol.validateBotUpdate({ ...base, model: 'p/m', avatar })
    assert.equal(checked.ok, true)
    assert.equal(checked.update.avatar, null)
  }
  assert.equal(protocol.validateBotUpdate({ ...base, model: 'p/m', color: 'x'.repeat(33) }).update.color, null)
})

test('result validation keeps the applied profile and validates garbage', () => {
  const r = protocol.validateBotUpdateResult({ requestId: 'r1', ok: true, ...profile, avatar: { image, extra: true } })
  assert.equal(r.ok, true)
  assert.equal(r.result.name, profile.name)
  assert.equal(r.result.role, profile.role)
  assert.equal(r.result.color, profile.color)
  assert.deepEqual(r.result.avatar, { image })
  const bad = protocol.validateBotUpdateResult({ requestId: 'r1', ok: true, name: [], role: 4, color: {}, avatar: { image: 'bad' } })
  for (const key of Object.keys(profile)) assert.equal(bad.result[key], null, key)
  const cleared = protocol.validateBotUpdateResult({ requestId: 'r1', ok: true, role: '', color: null, avatar: null })
  assert.equal(cleared.result.role, '')
  assert.equal(cleared.result.color, null)
  assert.equal(cleared.result.avatar, null)
})

test('nodeCaps advertises the profile capability on every platform', () => {
  assert.equal(protocol.BOT_PROFILE_UPDATE_CAP, 'bot-profile-update/1')
  for (const platform of ['darwin', 'linux', 'win32']) {
    const caps = protocol.nodeCaps(['fs'], platform)
    assert.ok(caps.includes(protocol.BOT_PROFILE_UPDATE_CAP))
    assert.ok(caps.includes(protocol.BOT_MEMORY_UPDATE_CAP))
    assert.equal(caps.includes('desktop'), platform === 'win32')
  }
})

test('frame handler forwards the profile and echoes receiver values, never requested values', async () => {
  let received
  const applied = { name: 'Applied', role: '', color: 'red', avatar: { shape: 'dog' } }
  const replies = []
  await handleBotUpdateFrame({
    frame: { id: 'f1' }, data: { ...base, ...profile },
    ctx: { get: key => key === BOT_UPDATE_RECEIVER ? async spec => { received = spec; return { ok: true, ...applied } } : undefined },
    send: (type, data) => replies.push({ type, data }),
    sendError: (id, error) => assert.fail(error),
  })
  for (const key of Object.keys(profile)) assert.deepEqual(received[key], profile[key])
  assert.equal(replies[0].type, protocol.NODE_TO_HUB.BOT_UPDATE_RESULT)
  const checked = protocol.validateBotUpdateResult(replies[0].data)
  for (const key of Object.keys(profile)) assert.deepEqual(checked.result[key], applied[key])
})
