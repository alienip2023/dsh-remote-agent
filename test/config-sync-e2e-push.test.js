/**
 * 1A-7 tests: E2E-established config push + node reconnect request + no-plaintext guard.
 *
 * 1A7-e2e-push goes through the real handleE2EOffer/emit path via NodeRegistry.
 * 1A7-node-request goes through the real attachOnlineHooks/transport.emit path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { createConfigSync } from '../lib/hub/config-sync.js'
import { generateEphemeral } from '../lib/e2e.js'
import { generateIdentity } from '../lib/identity.js'
import { HUB_TO_NODE, NODE_TO_HUB } from '../lib/protocol.js'
import { attachOnlineHooks } from '../lib/node/online-hooks.js'

/**
 * 1A7-e2e-push: real handleE2EOffer → emit('e2eEstablished') → configSync.handleSyncRequest → CONFIG_PUSH.
 * Knife: delete emit('e2eEstablished') from registry-handshake.js → RED
 */
test('1A7-e2e-push: real handleE2EOffer triggers e2eEstablished → config push', () => {
  const sentFrames = []
  const logs = []
  const relay = {
    ready: true,
    send: (nodeId, text) => { sentFrames.push({ nodeId, text }); return true },
    sendBinary: () => false,
  }

  // Build real identity (needed for handleE2EOffer signature verification)
  const identity = generateIdentity()

  const registry = new NodeRegistry({
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    relay,
    identity,
  })

  // Wire configSync to the registry
  const source = () => ({
    providers: [{ id: 'alpha', api: 'openai-completions', apiKeyEnv: 'ALPHA_KEY', apiKey: 'sk-x', models: [{ id: 'm1' }] }],
    defaultModel: 'alpha/m1',
  })
  createConfigSync({
    registry,
    source,
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
  })
  registry.on('configSyncRequest', (ev) => configSync.handleSyncRequest(ev))

  // Register a node with a real E2E-capable connection (needs online + a conn for send)
  const nodeConn = {
    frames: [],
    send: (text) => nodeConn.frames.push(text),
    close: () => {},
  }
  const rec = registry.ingestHello({
    helloData: {
      nodeId: 'node-1', protocol: 1, os: 'linux', arch: 'arm64',
      hostname: 'n1', dshVersion: '0.10.1', shells: ['bash'], roots: ['/'],
      caps: ['exec'], profile: 'worker', agentMode: true,
      nonce: 'a1b2c3d4e5f60718', time: Date.now(),
    },
    conn: nodeConn, transport: 'direct', pending: undefined,
  })
  assert.ok(rec, 'hello must be accepted')

  // Generate ephemeral key pair as if the node is proposing E2E
  const nodeEph = generateEphemeral()
  const nonce = 'a1b2c3d4e5f60718'

  // Call real handleE2EOffer — this emits e2eEstablished on success
  const result = registry.handleE2EOffer('node-1', { pub: nodeEph.publicKeyB64, nonce })
  assert.equal(result, true, 'handleE2EOffer must succeed')

  // Assert CONFIG_PUSH was sent via the direct connection (nodeConn.send)
  // registry.send() uses direct conn.send when connected, relay is only a fallback
  const pushFrames = nodeConn.frames.filter(text => {
    try { const p = JSON.parse(text); return p.t === HUB_TO_NODE.CONFIG_PUSH } catch { return false }
  })
  assert.ok(pushFrames.length >= 1, 'CONFIG_PUSH must have been sent after e2eEstablished')
})

/**
 * 1A7-node-request: transport online → attachOnlineHooks → sendConfigSyncRequest.
 * Knife A: delete sendConfigSyncRequest() call in attachOnlineHooks → RED
 * Knife B: remove env.DSH_HOME priority in resolveNodeDshHome → RED (uses wrong dir → no file → appliedRevision 0)
 */
test('1A7-node-request: transport online triggers CONFIG_SYNC_REQUEST with appliedRevision from DSH_HOME/config-sync.json', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), '1a7-hooks-'))
  const dshHome = join(tmpHome, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(join(dshHome, 'config-sync.json'), JSON.stringify({ schema: 2, appliedRevision: 99 }))

  const origDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const transport = new EventEmitter()
  const sentFrames = []
  const send = (type, data) => sentFrames.push({ type, data })

  attachOnlineHooks(transport, { send, env: process.env, logger: () => {} })
  transport.emit('online', {})

  try {
    assert.equal(sentFrames.length, 1, 'must send exactly one CONFIG_SYNC_REQUEST frame')
    assert.equal(sentFrames[0].type, 'hub/config-sync-request', 'type must be hub/config-sync-request')
    assert.equal(sentFrames[0].data.appliedRevision, 99, 'appliedRevision must come from DSH_HOME config-sync.json')
  } finally {
    if (origDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origDshHome
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

/**
 * 1A7-node-request-dsh-home-priority: env.DSH_HOME beats ~/.dsh for config-sync.json.
 * Knife: remove env.DSH_HOME from resolveNodeDshHome → uses wrong dir (no file) → appliedRevision=0 → RED
 */
test('1A7-node-request-dsh-home-priority: DSH_HOME env beats homedir/.dsh for config-sync.json', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), '1a7-prio-'))
  const dshHome = join(tmpHome, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(join(dshHome, 'config-sync.json'), JSON.stringify({ schema: 2, appliedRevision: 77 }))

  // homedir()/.dsh might have a config-sync.json with different revision; DSH_HOME should win
  const origDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const transport = new EventEmitter()
  const sentFrames = []
  attachOnlineHooks(transport, { send: (t, d) => sentFrames.push({ type: t, data: d }), env: process.env })
  transport.emit('online', {})

  try {
    assert.equal(sentFrames[0]?.data.appliedRevision, 77, 'DSH_HOME revision (77) must win over any homedir/.dsh value')
  } finally {
    if (origDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origDshHome
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

/**
 * 1A7-no-plaintext: no E2E → sendPush returns false, registry.send NOT called.
 * Knife: remove hasE2E guard → RED
 */
test('1A7-no-plaintext: without E2E, sendPush returns false and registry.send is not called', () => {
  const sentFrames = []
  const registry = {
    send: (nodeId, type, data) => { sentFrames.push({ nodeId, type, data }); return true },
    hasE2E: () => false,
    listeners: {},
    on() {},
    emit() {},
  }
  const log = () => {}

  const source = () => ({
    providers: [{ id: 'alpha', baseURL: 'https://up.example.com/v1', apiKey: 'tok-abc', apiKeyEnv: 'ALPHA_KEY', models: [{ id: 'a1' }] }],
    defaultModel: 'a1',
  })

  const configSync = createConfigSync({ registry, source, log })
  const result = configSync.sendPush('node-1')

  assert.equal(result, false, 'sendPush should return false without E2E')
  assert.equal(sentFrames.length, 0, 'registry.send should NOT be called without E2E')
})
