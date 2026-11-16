import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bindRosterReport, rosterFrame } from '../lib/roster-report.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { NODE_TO_HUB, decodeFrame, encodeFrame, envelope } from '../lib/protocol.js'

const base = { nodeId: 'node-a', hostname: 'desk-1', bots: [{ id: 'bot-a', name: 'Bot A', role: 'test' }] }
const skill = { id: 'c319668b-2bea-4e99-9b06-b9df719a502b', name: 'review-code', description: 'Review changes', content: 'Read the diff and explain it.' }
const snapshot = { version: 1, items: [skill] }
const frameWith = skills => rosterFrame({ ...base, skills })

test('rosterFrame preserves a valid skill snapshot', () => {
  assert.deepEqual(frameWith(snapshot), { ...base, skills: snapshot })
})

test('rosterFrame without skills keeps exactly the original three fields', () => {
  const frame = rosterFrame(base)
  assert.deepEqual(frame, base)
  assert.deepEqual(Object.keys(frame), ['nodeId', 'hostname', 'bots'])
  assert.equal(Object.hasOwn(frame, 'skills'), false)
})

test('invalid snapshots drop only skills and keep the roster frame', () => {
  for (const skills of [undefined, null, [], false, 1, 'skills', {},
    { version: 2, items: [] }, { version: '1', items: [] },
    { version: 1 }, { version: 1, items: {} }, { version: 1, items: null }]) {
    assert.deepEqual(frameWith(skills), base)
    assert.equal(Object.hasOwn(frameWith(skills), 'skills'), false)
  }
})

test('overlong content drops that item while preserving the other skills', () => {
  const skills = { version: 1, items: [{ ...skill, content: 'x'.repeat(20001) }, skill] }
  assert.deepEqual(frameWith(skills), { ...base, skills: snapshot })
})

test('bindRosterReport sends payload.skills on the roster frame', () => {
  const sent = []
  let provided
  const report = bindRosterReport({ provide: (name, fn) => {
    assert.equal(name, 'remote-agent:roster-report')
    provided = fn
  } }, {
    nodeId: base.nodeId,
    hostname: base.hostname,
    send: (type, data) => { sent.push({ type, data }); return true },
  })
  assert.equal(provided, report)
  assert.equal(provided({ bots: base.bots, skills: snapshot }), true)
  assert.deepEqual(sent, [{ type: NODE_TO_HUB.ROSTER, data: { ...base, skills: snapshot } }])
})

test('items above 100 are truncated to the first 100', () => {
  const items = Array.from({ length: 101 }, (_, i) => ({ ...skill, id: String(i) }))
  items[100].content = 'x'.repeat(20001)
  assert.deepEqual(frameWith({ version: 1, items }).skills, { version: 1, items: items.slice(0, 100) })
})

test('skill items keep only four string fields and discard missing identities', () => {
  const skills = { version: 1, extra: true, items: [
    { ...skill, privateData: { secret: 'not shared' } },
    null, [], 42, 'bad', {}, { name: 'missing-id' }, { id: 'missing-name' },
    { ...skill, id: '' }, { ...skill, name: '  ' },
    { ...skill, id: 1 }, { ...skill, name: false },
    { id: 'minimal', name: 'minimal', description: 123, content: null },
  ] }
  assert.deepEqual(frameWith(skills).skills, { version: 1, items: [
    skill, { id: 'minimal', name: 'minimal', description: '', content: '' },
  ] })
})

test('each string field accepts its length limit and rejects longer items', () => {
  for (const [field, limit] of Object.entries({ id: 64, name: 120, description: 400, content: 20000 })) {
    const exact = { ...skill, [field]: 'x'.repeat(limit) }
    const long = { ...skill, [field]: 'x'.repeat(limit + 1) }
    assert.deepEqual(frameWith({ version: 1, items: [long, exact] }).skills, { version: 1, items: [exact] }, field)
  }
})

test('serialized snapshot accepts exactly 64 KiB and drops one byte more', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ ...skill, id: String(i), content: 'x'.repeat(16000) }))
  const skills = { version: 1, items }
  items[0].content += 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(skills), 'utf8'))
  assert.equal(Buffer.byteLength(JSON.stringify(skills), 'utf8'), 64 * 1024)
  assert.deepEqual(frameWith(skills).skills, skills)
  items[0].content += 'x'
  assert.deepEqual(frameWith(skills), base)
})

test('snapshot byte limit counts UTF-8 and JSON escaping after normalization', () => {
  for (const content of ['技'.repeat(12000), '\u0000'.repeat(6000)]) {
    const skills = { version: 1, items: [{ ...skill, content }, { ...skill, content }] }
    if (content.startsWith('技')) assert.ok(JSON.stringify(skills).length < 64 * 1024)
    assert.ok(Buffer.byteLength(JSON.stringify(skills), 'utf8') > 64 * 1024)
    assert.deepEqual(frameWith(skills), base)
  }
  assert.deepEqual(frameWith({ ...snapshot, ignored: 'x'.repeat(70000) }).skills, snapshot)
})

test('an empty snapshot remains valid without mutating its input', () => {
  assert.deepEqual(frameWith({ version: 1, items: [] }).skills, { version: 1, items: [] })
  const input = structuredClone(snapshot)
  Object.freeze(input.items[0])
  Object.freeze(input.items)
  Object.freeze(input)
  assert.deepEqual(frameWith(input).skills, snapshot)
})

function registryFor() {
  class Core extends EventEmitter {
    constructor() {
      super()
      this.nodes = new Map([[base.nodeId, { nodeId: base.nodeId, online: true }]])
    }
    log() {}
  }
  return new (withIngest(Core))()
}

test('hub ingest delivers skills after encoding and decoding the reported frame', () => {
  const registry = registryFor()
  const received = []
  registry.on('roster', report => received.push(report))
  const report = bindRosterReport(undefined, {
    nodeId: base.nodeId, hostname: base.hostname,
    send: (type, data) => {
      const decoded = decodeFrame(encodeFrame(envelope(type, data)))
      assert.equal(decoded.ok, true)
      registry.handleFrameFor(base.nodeId, decoded.frame)
      return true
    },
  })
  report({ bots: base.bots, skills: snapshot })
  assert.deepEqual(received, [{ ...base, skills: snapshot, online: true }])
  for (const skills of [undefined, { version: 2, items: [] }, { version: 1, items: {} },
    { version: 1, items: Array.from({ length: 4 }, () => ({ ...skill, content: 'x'.repeat(20000) })) }]) {
    registry.handleFrameFor(base.nodeId, envelope(NODE_TO_HUB.ROSTER, { ...base, skills }))
    assert.deepEqual(received.at(-1), { ...base, online: true })
    assert.equal(Object.hasOwn(received.at(-1), 'skills'), false)
  }
})

test('ds-bot snapshot reaches applySharedSkills through the real roster path', {
  skip: !process.env.DS_BOT_REPO && 'Set DS_BOT_REPO to exercise the ds-bot integration',
}, async () => {
  const { sharedSkillSnapshot, applySharedSkills } = await import(pathToFileURL(resolve(process.env.DS_BOT_REPO, 'src/host/skill-share.js')).href)
  const { reportableBots } = await import(pathToFileURL(resolve(process.env.DS_BOT_REPO, 'src/host/roster-join.js')).href)
  const source = { state: { capabilities: { items: {
    [skill.name]: { ...skill, kind: 'skill', sharedId: skill.id, teamReusable: true },
  } } } }
  const target = { state: { capabilities: { items: {} }, bots: {} }, save: async () => {} }
  const registry = registryFor()
  let applied
  registry.on('roster', report => {
    assert.deepEqual(report.bots, base.bots)
    applied = applySharedSkills(target, `node:${report.nodeId}`, report.skills)
  })
  const report = bindRosterReport(undefined, {
    nodeId: base.nodeId, hostname: base.hostname,
    send: (type, data) => {
      const decoded = decodeFrame(encodeFrame(envelope(type, data)))
      assert.equal(decoded.ok, true)
      registry.handleFrameFor(base.nodeId, decoded.frame)
      return true
    },
  })
  assert.equal(report({ bots: reportableBots({ 'bot-a': base.bots[0] }), skills: sharedSkillSnapshot(source) }), true)
  assert.equal(await applied, true)
  const imported = Object.values(target.state.capabilities.items)
  assert.equal(imported.length, 1)
  assert.equal(imported[0].sharedId, skill.id)
  assert.equal(imported[0].content, skill.content)
  assert.equal(imported[0].sharedFrom, `node:${base.nodeId}`)
})
