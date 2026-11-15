import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleConfigPush } from '../lib/node/config-sync.js'

// Use the real config writer and persisted state; every restart is a synchronous test double.
function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'config-sync-model-reload-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const statePath = join(dshHome, 'config-sync.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const events = []
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const push = (revision, models, extra = {}) => handleConfigPush({
    data: {
      schema: 2, revision, plugins: [],
      providers: [{ id: 'alpha', apiKeyEnv: 'ALPHA_KEY', ...(models === undefined ? {} : { models }) }],
    },
    dshHome, profileDir,
    logger() {},
    send(type, data) {
      assert.equal(type, 'hub/config-ack')
      assert.equal(state().appliedRevision, revision, 'revision must be persisted before ACK')
      events.push({ kind: 'ack', data })
    },
    _systemd: true,
    _restartFn(delay) {
      assert.equal(events.at(-1).kind, 'ack', 'ACK must precede the restart')
      assert.equal(state().appliedRevision, revision)
      events.push({ kind: 'restart', delay })
    },
    ...extra,
  })
  const legacyState = () => {
    const old = state()
    // fork.85 wrote schema:2, but no model information in lastPayload.
    for (const provider of old.lastPayload.providers) delete provider.modelsDigest
    writeFileSync(statePath, JSON.stringify(old))
  }
  return { push, state, legacyState, events, patch: () => readFileSync(patchPath, 'utf8') }
}

const a = { id: 'model-a', name: 'Model A' }
const b = { id: 'model-b', name: 'Model B' }

for (const [label, before, after] of [
  ['adding a model', [a], [a, b]],
  ['removing a model', [a, b], [a]],
  ['removing the last model', [a], []],
  ['renaming a model id', [a], [{ ...a, id: 'model-c' }]],
  ['changing a model display name', [a], [{ ...a, name: 'Renamed A' }]],
]) {
  test('model reload: ' + label + ' persists, ACKs, then requests restart', (t) => {
    const f = setup(t)
    assert.equal(f.push(1, before).ok, true)
    f.events.length = 0
    const result = f.push(2, after)
    assert.equal(result.ok, true)
    for (const model of after) {
      assert.ok(f.patch().includes('- id: ' + JSON.stringify(model.id)))
      assert.ok(f.patch().includes('name: ' + JSON.stringify(model.name)))
    }
    for (const model of before.filter((old) => !after.some((m) => m.id === old.id))) {
      assert.equal(f.patch().includes('- id: ' + JSON.stringify(model.id)), false)
    }
    assert.equal(result.shouldRestart, true)
    assert.equal(result.restartMode, 'systemd')
    assert.deepEqual(f.events.map((e) => e.kind), ['ack', 'restart'])
    assert.ok(f.events[1].delay >= 300)
    f.events.length = 0
    assert.equal(f.push(3, after).shouldRestart, false, 'persisted digest must survive the next push')
    assert.deepEqual(f.events.map((e) => e.kind), ['ack'])
  })
}

for (const [label, before, after] of [
  ['identical models', [a, b], [a, b]],
  ['model order and object key order', [a, b], [{ name: b.name, id: b.id }, { name: a.name, id: a.id }]],
  ['implicit model name', [{ id: 'model-a' }], [{ id: 'model-a', name: 'model-a' }]],
  ['absent and empty models', undefined, []],
  ['metadata not written to patch', [{ ...a, contextWindow: 1024 }], [{ ...a, contextWindow: 2048 }]],
]) {
  test('model reload: ' + label + ' does not request another restart', (t) => {
    const f = setup(t)
    assert.equal(f.push(1, before).ok, true)
    f.events.length = 0
    assert.equal(f.push(2, after).shouldRestart, false)
    assert.deepEqual(f.events.map((e) => e.kind), ['ack'])
    f.events.length = 0
    assert.equal(f.push(3, after).shouldRestart, false)
    assert.deepEqual(f.events.map((e) => e.kind), ['ack'])
  })
}

for (const models of [[a], [], undefined]) {
  test('model reload: fork.85 state without a digest reloads once (' + (models?.length ? 'nonempty' : models ? 'empty' : 'absent') + ')', (t) => {
    const f = setup(t)
    assert.equal(f.push(1, [a]).ok, true)
    f.legacyState()
    f.events.length = 0
    assert.equal(f.push(2, models).shouldRestart, true, 'unknown old models require one reload')
    assert.deepEqual(f.events.map((e) => e.kind), ['ack', 'restart'])
    assert.match(f.state().lastPayload.providers[0].modelsDigest, /^[a-f0-9]{16}$/)
    f.events.length = 0
    assert.equal(f.push(3, models).shouldRestart, false, 'migration must not cause a restart loop')
    assert.deepEqual(f.events.map((e) => e.kind), ['ack'])
  })
}

test('model reload: state stores a digest rather than the model list', (t) => {
  const f = setup(t)
  assert.equal(f.push(1, [a, b]).ok, true)
  const provider = f.state().lastPayload.providers[0]
  assert.match(provider.modelsDigest, /^[a-f0-9]{16}$/)
  assert.equal(Object.hasOwn(provider, 'models'), false)
  assert.equal(JSON.stringify(provider).includes(a.id), false)
})

test('model reload: non-systemd node uses the existing manual restart ACK', (t) => {
  const f = setup(t)
  assert.equal(f.push(1, [a]).ok, true)
  f.events.length = 0
  const result = f.push(2, [a, b], { _systemd: false })
  assert.equal(result.ok, true)
  assert.equal(result.shouldRestart, true)
  assert.equal(result.restartMode, 'manual')
  assert.deepEqual(f.events.map((e) => e.kind), ['ack'])
})
