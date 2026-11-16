import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exposeRole, ROLE_SERVICE } from '../lib/expose-role.js'

// Match the strict provide/get semantics used by cordis-provide.test.js.
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
    get(name) {
      return store[name]?.value
    },
  }
}

test('ROLE_SERVICE names the deployment role service', () => {
  assert.equal(ROLE_SERVICE, 'remote-agent:role')
})

for (const role of ['hub', 'both', 'worker']) {
  test(`exposeRole: ${role} is available through ctx.get`, () => {
    const ctx = makeCtx()
    const dispose = exposeRole(ctx, role)
    assert.equal(ctx.get('remote-agent:role'), role)
    dispose()
  })
}

test('exposeRole: unconfigured role surfaces worker with least privilege', () => {
  const ctx = makeCtx()
  const dispose = exposeRole(ctx, '')
  assert.equal(ctx.get('remote-agent:role'), 'worker')
  dispose()
})

for (const role of ['HUBBY', 42, null, undefined]) {
  test(`exposeRole: unknown role ${String(role)} surfaces worker`, () => {
    const ctx = makeCtx()
    const dispose = exposeRole(ctx, role)
    assert.equal(ctx.get('remote-agent:role'), 'worker')
    dispose()
  })
}

test('exposeRole: older hosts without provide receive a harmless disposer', () => {
  for (const ctx of [{}, { provide: null }, null, undefined]) {
    const dispose = exposeRole(ctx, 'hub')
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(dispose)
  }
})

test('exposeRole: disposing removes the provided service', () => {
  const ctx = makeCtx()
  const dispose = exposeRole(ctx, 'hub')
  assert.equal(ctx.get('remote-agent:role'), 'hub')
  dispose()
  assert.equal(ctx.get('remote-agent:role'), undefined)
})

test('apply: re-apply releases the previous role and stale disposal preserves the current service', async (t) => {
  const { apply } = await import('../lib/index.js')
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ra-role-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const ctx = makeCtx()
  const logs = []
  ctx.logger = { info: (message) => logs.push(message), warn() {} }
  const first = apply(ctx, { role: '', stateDir })
  t.after(() => first.dispose())
  assert.equal(first.unconfigured, true)
  assert.equal(ctx.get('remote-agent:role'), 'worker')
  assert.ok(logs.some(message => message.includes('deployment role not configured; surfacing worker to other plugins')))

  const second = apply(ctx, { role: '', stateDir })
  t.after(() => second.dispose())
  first.dispose()
  assert.equal(ctx.get('remote-agent:role'), 'worker')
  second.dispose()
  assert.equal(ctx.get('remote-agent:role'), undefined)
})
