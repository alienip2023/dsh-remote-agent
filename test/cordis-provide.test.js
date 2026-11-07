// Tests for ctx.set → ctx.provide fix (cordis-provide-fix-20261107).
// Uses a minimal cordis 4.0.2-compatible ctx stub (no cordis dependency needed).
// Tests directly call product functions: exposeRegistry() from lib/hub/index.js
// and bindRosterReport() from lib/roster-report.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { exposeRegistry } from '../lib/hub/expose-registry.js'
import { bindRosterReport } from '../lib/roster-report.js'

// Minimal ctx stub: precise replication of cordis 4.0.2 set/provide/get semantics
// from lib/index.js:781-812.
function makeCtx() {
  const store = Object.create(null)
  return {
    provide(name, value) {
      if (Object.prototype.hasOwnProperty.call(store, name)) {
        throw new Error(`service "${name}" has been registered`)
      }
      store[name] = { value }
      return () => { delete store[name] }
    },
    set(name, value) {
      if (!Object.prototype.hasOwnProperty.call(store, name)) {
        throw new Error(`cannot set property "${name}" without provide`)
      }
      store[name].value = value
    },
    get(name) {
      return store[name]?.value
    },
  }
}

// ── Test 1: exposeRegistry provides registry to ctx, get returns same object ──
// Knife: provide→set in exposeRegistry → ctx.get returns undefined → fails.
test('exposeRegistry: after call, ctx.get returns the same registry object', () => {
  const ctx = makeCtx()
  const reg = { id: 'reg-1', onlineNodes: () => [{ nodeId: 'n1' }] }

  exposeRegistry(ctx, reg)

  const got = ctx.get('remote-agent:registry')
  assert.ok(got !== undefined, 'ctx.get returned undefined — exposeRegistry did not register')
  assert.equal(got, reg, 'ctx.get returned a different object than provided')
  assert.equal(typeof got.onlineNodes, 'function', 'registry methods are accessible')
  assert.deepEqual(got.onlineNodes(), [{ nodeId: 'n1' }])
})

// ── Test 2: bindRosterReport provide once, report() called multiple times, no throw ──
// Knife: provide→set in bindRosterReport → ctx.get returns undefined → fails.
test('bindRosterReport: provide once, report() called multiple times does not throw', () => {
  const ctx = makeCtx()
  const sent = []
  const send = (type, frame) => { sent.push({ type, frame }); return true }

  // bindRosterReport calls ctx.provide under the hood (after the fix)
  const report = bindRosterReport(ctx, { send, nodeId: 'n1', hostname: 'host-1' })

  // The report fn is available in the store
  const stored = ctx.get('remote-agent:roster-report')
  assert.ok(typeof stored === 'function', 'roster-report not registered in ctx')

  // Calling report() multiple times must not throw
  assert.doesNotThrow(() => report({ bots: [{ id: 'b1', name: 'Alpha', role: '工' }] }))
  assert.doesNotThrow(() => report({ bots: [] }))
  assert.doesNotThrow(() => report({ bots: [] }))
  assert.equal(sent.length, 3, 'send should have been called 3 times')
})

// ── Test 3: repeated provide (same name) throws service-already-registered ──
test('ctx.provide twice on the same name throws service-has-been-registered', () => {
  const ctx = makeCtx()
  ctx.provide('remote-agent:roster-report', () => {})
  assert.throws(
    () => ctx.provide('remote-agent:roster-report', () => {}),
    /service .remote-agent:roster-report. has been registered/,
    'second provide should throw service-already-registered'
  )
})

// ── Test 4: bindRosterReport called only once per node assembly (not in hot path) ──
// Simulates what node/index.js:750 does: one assembly, many report() calls.
test('bindRosterReport is called once (assembly), not inside the report hot-path', () => {
  const ctx = makeCtx()
  const sent = []
  const send = (type, frame) => { sent.push(frame); return true }

  // Assembly phase: one bindRosterReport call
  const report = bindRosterReport(ctx, { send, nodeId: 'n1', hostname: 'host-1' })
  assert.ok(typeof report === 'function')

  // Hot-path: report many times — no second provide, no throw
  for (let i = 0; i < 10; i++) {
    assert.doesNotThrow(() => report({ bots: [] }), `report() call ${i} threw`)
  }
  assert.equal(sent.length, 10)
})
