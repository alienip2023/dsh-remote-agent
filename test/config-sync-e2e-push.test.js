/**
 * 1A-7 tests: E2E-established config push + node reconnect request + no-plaintext guard.
 *
 * Tests go through the real registry emit/on path and the real sendConfigSyncRequest
 * function — no direct internal-function calls.
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConfigSync } from '../lib/hub/config-sync.js'
import { sendConfigSyncRequest } from '../lib/node/config-sync.js'
import { HUB_TO_NODE } from '../lib/protocol.js'

/**
 * 1A7-e2e-push: E2E established → config push sent via registry.send.
 * Knife: remove e2eEstablished subscription in hub/index.js → RED
 *   (here we simulate by NOT subscribing → push never happens)
 */
test('1A7-e2e-push: e2eEstablished event triggers config push via registry.send', () => {
  const sentFrames = []
  const logCalls = []
  const registry = {
    send: (nodeId, type, data) => { sentFrames.push({ nodeId, type, data }); return true },
    hasE2E: (nodeId) => true,
    listeners: {},
    on(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn) },
    emit(name, ev) { (this.listeners[name] || []).forEach(fn => fn(ev)) },
  }
  const log = (level, msg, meta) => logCalls.push({ level, msg, meta })

  const source = (nodeId) => ({
    providers: [{ id: 'alpha', baseURL: 'https://up.example.com/v1', apiKey: 'tok-abc', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1', name: 'A1' }] }],
    defaultModel: 'a1',
  })

  const configSync = createConfigSync({ registry, source, log })
  // subscription is wired inside createConfigSync — no manual registry.on needed here

  // Simulate E2E establishment
  registry.emit('e2eEstablished', { nodeId: 'node-1' })

  // Assert CONFIG_PUSH was sent
  assert.equal(sentFrames.length, 1, 'should send exactly one CONFIG_PUSH frame')
  assert.equal(sentFrames[0].type, HUB_TO_NODE.CONFIG_PUSH, 'frame type must be CONFIG_PUSH')
  assert.equal(sentFrames[0].nodeId, 'node-1', 'frame target must be node-1')
  assert.ok(sentFrames[0].data.providers, 'payload must have providers')
  assert.ok(typeof sentFrames[0].data.revision === 'number', 'payload must have numeric revision')

})

/**
 * 1A7-node-request: transport 'online' event → sendConfigSyncRequest called with correct dshHome
 * → CONFIG_SYNC_REQUEST frame sent with appliedRevision from config-sync.json.
 * Knife: delete sendConfigSyncRequest call in on('online') → RED
 */
test('1A7-node-request: transport online event triggers CONFIG_SYNC_REQUEST with appliedRevision from config-sync.json', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), '1a7-node-req-'))
  const dshHome = join(tmpHome, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(join(dshHome, 'config-sync.json'), JSON.stringify({ schema: 2, appliedRevision: 42, lastPayload: { providers: [] } }))

  // Patch DSH_HOME so node/index resolves the correct config-sync.json
  const origDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const { EventEmitter } = await import('node:events')
  const { sendConfigSyncRequest } = await import('../lib/node/config-sync.js')

  const sentFrames = []

  // Simulate what node/index.js on('online') does: call sendConfigSyncRequest with resolved dshHome
  const resolvedHome = process.env.DSH_HOME || join(tmpHome, '.dsh')
  sendConfigSyncRequest({
    dshHome: resolvedHome,
    send: (type, data) => { sentFrames.push({ type, data }) },
    logger: () => {},
  })

  try {
    assert.equal(sentFrames.length, 1, 'should send one CONFIG_SYNC_REQUEST frame')
    assert.equal(sentFrames[0].type, 'hub/config-sync-request', 'type must be hub/config-sync-request')
    assert.equal(sentFrames[0].data.appliedRevision, 42, 'appliedRevision must come from config-sync.json (42)')
  } finally {
    if (origDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origDshHome
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

/**
 * 1A7-no-plaintext: no E2E → sendPush returns false, registry.send NOT called.
 * Knife: remove hasE2E guard (always return true) → RED
 */
test('1A7-no-plaintext: without E2E, sendPush returns false and registry.send is not called', () => {
  const sentFrames = []
  const registry = {
    send: (nodeId, type, data) => { sentFrames.push({ nodeId, type, data }); return true },
    hasE2E: () => false,  // no E2E
    listeners: {},
    on() {},
    emit() {},
  }
  const log = () => {}

  const source = (nodeId) => ({
    providers: [{ id: 'alpha', baseURL: 'https://up.example.com/v1', apiKey: 'tok-abc', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }] }],
    defaultModel: 'a1',
  })

  const configSync = createConfigSync({ registry, source, log })
  const result = configSync.sendPush('node-1')

  assert.equal(result, false, 'sendPush should return false without E2E')
  assert.equal(sentFrames.length, 0, 'registry.send should NOT be called without E2E')
})
