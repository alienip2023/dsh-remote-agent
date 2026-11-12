import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePeerRoster, HUB_TO_NODE } from '../lib/protocol.js'
import { deliverPeerRoster } from '../lib/node/index.js'

function roster(overrides = {}) {
  return {
    hubId: 'hub-3f9c2a1b',
    level: 'roster',
    hostname: 'chief-mac',
    bots: [{ id: 'main', name: '秘书', role: '秘书', main: true }],
    ...overrides,
  }
}

test('peer/roster has its own frame type', () => {
  assert.equal(HUB_TO_NODE.PEER_ROSTER, 'peer/roster')
})

test('validatePeerRoster accepts a well-formed roster and keeps main/model', () => {
  const checked = validatePeerRoster(roster({ level: 'dispatch' }))
  assert.equal(checked.ok, true)
  assert.equal(checked.value.hubId, 'hub-3f9c2a1b')
  assert.equal(checked.value.level, 'dispatch')
  assert.equal(checked.value.hostname, 'chief-mac')
  assert.equal(checked.value.bots.length, 1)
  assert.deepEqual(checked.value.bots[0], { id: 'main', name: '秘书', role: '秘书', main: true })

  const withModel = validatePeerRoster(roster({
    bots: [{ id: 'a', name: 'A', role: 'r', model: 'deepseek-v4' }],
  }))
  assert.equal(withModel.ok, true)
  assert.equal(withModel.value.bots[0].model, 'deepseek-v4')
  assert.equal(withModel.value.bots[0].main, undefined)
})

test('validatePeerRoster trims names/roles and clamps them to the wire limits', () => {
  const checked = validatePeerRoster(roster({
    hostname: 'h'.repeat(100),
    bots: [{ id: 'a', name: 'n'.repeat(60), role: 'r'.repeat(40) }],
  }))
  assert.equal(checked.ok, true)
  assert.equal(checked.value.hostname.length, 80)
  assert.equal(checked.value.bots[0].name.length, 40)
  assert.equal(checked.value.bots[0].role.length, 24)
})

test('validatePeerRoster rejects a missing or malformed hubId', () => {
  assert.equal(validatePeerRoster(roster({ hubId: undefined })).error, 'peer-roster-hubId-missing')
  assert.equal(validatePeerRoster(roster({ hubId: '' })).error, 'peer-roster-hubId-invalid')
  assert.equal(validatePeerRoster(roster({ hubId: 'a'.repeat(65) })).error, 'peer-roster-hubId-invalid')
  assert.equal(validatePeerRoster(roster({ hubId: 'hub/1' })).error, 'peer-roster-hubId-invalid')
})

test('validatePeerRoster rejects an unknown level and non-array bots', () => {
  assert.equal(validatePeerRoster(roster({ level: 'root' })).error, 'peer-roster-level-invalid')
  assert.equal(validatePeerRoster(roster({ level: undefined })).error, 'peer-roster-level-invalid')
  assert.equal(validatePeerRoster(roster({ bots: undefined })).error, 'peer-roster-bots-missing')
  const many = Array.from({ length: 65 }, (_, i) => ({ id: `b${i}`, name: 'n', role: 'r' }))
  assert.equal(validatePeerRoster(roster({ bots: many })).error, 'peer-roster-bots-too-many')
})

test('validatePeerRoster rejects a bot without id and keeps the first duplicate', () => {
  assert.equal(validatePeerRoster(roster({ bots: [{ name: 'n', role: 'r' }] })).error, 'peer-roster-bot-id-missing')
  assert.equal(validatePeerRoster(roster({ bots: [{ id: 'a', role: 'r' }] })).error, 'peer-roster-bot-invalid')
  const checked = validatePeerRoster(roster({
    bots: [
      { id: 'dup', name: 'first', role: 'r' },
      { id: 'dup', name: 'second', role: 'r' },
      { id: 'other', name: 'o', role: 'r' },
    ],
  }))
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.value.bots.map((b) => b.id), ['dup', 'other'])
  assert.equal(checked.value.bots[0].name, 'first')
})

test('an empty bot list stays legal (the off/clear frame)', () => {
  const checked = validatePeerRoster(roster({ level: 'off', bots: [] }))
  assert.equal(checked.ok, true)
  assert.equal(checked.value.level, 'off')
  assert.deepEqual(checked.value.bots, [])
})

test('deliverPeerRoster hands the payload to the provider once', () => {
  const calls = []
  const ctx = {
    get(name) {
      assert.equal(name, 'remote-agent:peer-roster')
      return { onRoster: (d) => calls.push(d) }
    },
  }
  const data = roster()
  deliverPeerRoster(ctx, data)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], data)
})

test('deliverPeerRoster is a no-op without a provider and never throws', () => {
  assert.doesNotThrow(() => deliverPeerRoster({ get: () => undefined }, roster()))
  assert.doesNotThrow(() => deliverPeerRoster(undefined, roster()))
})

test('deliverPeerRoster swallows a provider error and logs one warn', () => {
  const warnings = []
  const ctx = { get: () => ({ onRoster() { throw new Error('boom') } }) }
  assert.doesNotThrow(() => deliverPeerRoster(ctx, roster(), { warn: (...args) => warnings.push(args) }))
  assert.equal(warnings.length, 1)
})
