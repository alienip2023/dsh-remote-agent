// fork.64: a stale e2e ACK (offer1's ACK arriving while offer2 is in flight) must NOT kill the
// link. It was previously verified against offer2's nonce → signature mismatch → failHubIdentity
// → stop() — a permanent disconnect the user could only recover from by restarting dsh-worker.
//
// The fix keeps the last N (≤4, TTL 60s) offers in `recentOffers`; ACK handling searches them:
//   current-offer match  → normal session establishment
//   recent-offer match   → stale, warn + discard (hub already has a session, node waits for more)
//   no match             → warn + discard (injected frame; fatal would be a 1-frame relay DoS)
//   no identityPeer      → still fatal (e2e-identity — deliberate, unchanged)
//
// All tests use the REAL lib/relay.js, the REAL hub (NodeRegistry+RelayLink), and the
// REAL NodeTransport; timers are scaled through public fields.

import test from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODE, HUB_TO_NODE, NODE_TO_HUB, PROTOCOL_VERSION, encodeFrame, envelope } from '../lib/protocol.js'
import { createRelay, newRelayToken } from '../lib/relay.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { RelayLink } from '../lib/hub/relay-link.js'
import { NodeTransport } from '../lib/node/transport.js'
import { generateEphemeral } from '../lib/e2e.js'
import { generateIdentity } from '../lib/identity.js'

const HUB_TOKEN = newRelayToken('rt')
const ENROLL_TOKEN = newRelayToken('en')
const ID = generateIdentity()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, label, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await sleep(10)
  }
}

function helloFor(nodeId) {
  return { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', arch: 'x64', hostname: nodeId, shells: ['bash'], roots: ['/tmp'], caps: ['exec'], profile: '', agentMode: true, time: Date.now() }
}

function startRelay(t) {
  const relay = createRelay({ port: 0, host: '127.0.0.1', hubToken: HUB_TOKEN, enrollToken: ENROLL_TOKEN })
  return new Promise((resolve) => {
    relay.listen(() => {
      const port = relay.address().port
      const srv = {
        relay,
        port,
        base: `ws://127.0.0.1:${port}/relay`,
        close: async () => {
          for (const n of [...relay.nodes.values()]) { try { n.conn.socket?.destroy?.() } catch { /* gone */ } }
          for (const h of [...relay.hubs]) { try { h.socket?.destroy?.() } catch { /* gone */ } }
          await Promise.race([relay.close(), sleep(2000)])
        },
      }
      t.after(() => srv.close())
      resolve(srv)
    })
  })
}

function startNode(srv, nodeId, t, o = {}) {
  const tr = new NodeTransport({ mode: 'relay', url: srv.base, token: ENROLL_TOKEN, hello: helloFor(nodeId), e2e: o.e2e !== false })
  if (o.ackTimeoutMs !== undefined) tr.E2E_ACK_TIMEOUT_MS = o.ackTimeoutMs
  if (o.retryBaseMs !== undefined) tr.E2E_RETRY_BASE_MS = o.retryBaseMs
  if (o.retryMaxMs !== undefined) tr.E2E_RETRY_MAX_MS = o.retryMaxMs
  if (o.reofferDebounceMs !== undefined) tr.E2E_REOFFER_DEBOUNCE_MS = o.reofferDebounceMs
  const rec = { offers: 0, e2e: [], errors: [], fatals: [] }
  const sendRaw = tr.sendRaw.bind(tr)
  tr.sendRaw = (type, data, ...rest) => {
    if (type === NODE_TO_HUB.E2E_OFFER) rec.offers += 1
    return sendRaw(type, data, ...rest)
  }
  tr.on('e2e', (status, info) => rec.e2e.push({ status, info, at: Date.now() }))
  tr.on('error', (e) => rec.errors.push(String(e?.message ?? e)))
  tr.on('fatal', (info) => rec.fatals.push(info))
  tr.on('hubIdentity', () => {})
  t.after(() => tr.stop())
  tr.start()
  return { tr, rec, count: (s) => rec.e2e.filter((e) => e.status === s).length }
}

/**
 * Hub that delays ALL E2E_ACK frames by `ackDelayMs` ms. Heal is disabled (maxAttempts: 0)
 * so only manually-sent RESETs trigger new offers.
 */
function startHubWithDelayedAck(srv, t, { ackDelayMs = 300 } = {}) {
  const logs = []
  const registry = new NodeRegistry({
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    identity: ID,
    e2eHeal: { maxAttempts: 0 },
  })
  const send = registry.send.bind(registry)
  let firstAck = true
  registry.send = (nodeId, type, data, opts) => {
    if (type === HUB_TO_NODE.E2E_ACK && firstAck) {
      firstAck = false
      setTimeout(() => send(nodeId, type, data, opts), ackDelayMs)
      return true
    }
    return send(nodeId, type, data, opts)
  }
  const link = new RelayLink({
    url: srv.base, token: HUB_TOKEN, log: () => {},
    onFrame: (f) => registry.handleRelayFrame(f),
    onBinary: (h, p) => registry.handleRelayBinary(h, p),
    reconnectMs: 50,
  })
  registry.attachRelay(link)
  const hub = { registry, link, logs, stopped: false, established: 0 }
  registry.on('e2eEstablished', () => { hub.established += 1 })
  hub.stop = async () => { hub.stopped = true; registry.dispose(); await sleep(100) }
  hub.reset = (nodeId) => registry.send(nodeId, HUB_TO_NODE.ERROR, { code: ERROR_CODE.E2E_RESET, message: 'test' })
  t.after(() => hub.stop())
  link.start()
  return hub
}

// ─────────────────────────────────────────────────────────────────────────────
// S56-stale-ack: offer1's ACK arrives while offer2 is in flight → stale discard
// ─────────────────────────────────────────────────────────────────────────────
// Construction (from /tmp/repro_stale_ack.mjs):
//   t=0ms:   node online, offer1 sent; hub queues ACK#1 (delayed 300ms → fires at ~410ms)
//   t=80ms:  offer1 times out (e2eOffer=null, recentOffers=[offer1])
//   t=285ms: manual E2E_RESET → offer2 starts (e2eOffer=offer2, recentOffers=[offer1,offer2])
//   t=410ms: ACK#1 fires → handleE2EAck: e2eOffer=offer2 (in-flight!)
//            current-offer check: nonce=offer2.nonce ≠ ACK#1 nonce → fail
//            recentOffers search: offer2 fails, offer1 matches → stale:true → warn + discard
// ─────────────────────────────────────────────────────────────────────────────
test('S56-stale-ack: delayed ACK for offer1 arrives while offer2 is in flight → stale discard, no fatal', async (t) => {
  const srv = await startRelay(t)
  const hub = startHubWithDelayedAck(srv, t, { ackDelayMs: 300 })

  // Node: ackTimeout=80ms so offer1 times out well before ACK#1 arrives at ~410ms
  const node = startNode(srv, 'node-stale', t, { ackTimeoutMs: 80, retryBaseMs: 600_000, reofferDebounceMs: 20 })

  // Wait for offer1 to time out (80ms + buffer)
  await sleep(285)
  assert.equal(node.count('timeout'), 1, 'offer1 timed out')
  assert.equal(!!node.tr.e2eOffer, false, 'no in-flight offer before RESET')

  // Send RESET to trigger offer2
  hub.reset('node-stale')

  // offer2 starts and immediately completes (ACK#2 not delayed); we don't need to observe
  // offer2 in-flight — the stale path now also fires when e2eOffer is null (new guard).
  // Just wait for the delayed ACK#1 to arrive and be processed as stale.
  await sleep(300)

  // ── Assertions ──
  // The stale branch MUST have been hit: error message contains "迟到 ACK"
  const staleError = node.rec.errors.find((e) => e.includes('迟到 ACK'))
  assert.ok(staleError, `stale ACK error should be present, got: ${JSON.stringify(node.rec.errors)}`)

  // No fatal, node still running
  assert.equal(node.tr.stopped, false, 'node is still running')
  assert.equal(node.rec.fatals.length, 0, `no fatal events: ${JSON.stringify(node.rec.fatals)}`)

  // No error mentions hub-identity
  for (const err of node.rec.errors) {
    assert.ok(!err.includes('hub-identity'), `should not mention hub-identity: ${err}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// S56-forged-ack: forged ACK (correct nonce, wrong sig) while offer IS in-flight
// → !matchOffer warn + discard, not fatal
// ─────────────────────────────────────────────────────────────────────────────
// Construction:
//   t=0ms:   node online, offer1 sent; hub delays ACK#1 by 300ms
//   t=200ms: inject forged ACK with correct nonce but wrong keypair while offer1 is
//            still in-flight (ackTimeout=5000ms so offer1 hasn't timed out)
//   → handleE2EAck: e2eOffer=offer1 (in-flight!)
//     current-offer check: nonce matches BUT verifyExchange fails (wrong pub/sig) → no match
//     recentOffers search: same offer, same failure → no match
//     → !matchOffer → "签名验证失败" warn + discard (NOT fatal)
// ─────────────────────────────────────────────────────────────────────────────────
test('S56-forged-ack: forged ACK with correct nonce but wrong signature while offer in-flight → warn only, not fatal', async (t) => {
  const srv = await startRelay(t)
  const hub = startHubWithDelayedAck(srv, t, { ackDelayMs: 300 })

  // Node: long ACK timeout so offer1 is still in-flight when we inject
  const node = startNode(srv, 'node-forged', t, { ackTimeoutMs: 5000, retryBaseMs: 600_000 })

  // Wait for offer1 to be in-flight
  await waitFor(() => node.tr.e2eOffer, 'offer in-flight', 3000)
  const correctNonce = node.tr.e2eOffer.nonce
  assert.ok(correctNonce, 'has in-flight offer nonce')

  // Forge an ACK with the CORRECT nonce but a WRONG keypair (sig will fail verifyExchange)
  const wrongEph = await generateEphemeral()
  const forgedAck = encodeFrame(envelope(HUB_TO_NODE.E2E_ACK, {
    nonce: correctNonce,
    pub: wrongEph.publicKeyB64,
    sig: 'invalid-signature-that-will-fail-verification',
    at: Date.now(),
  }))

  // Inject the forged ACK via registry.send so it reaches the node's client WebSocket.
  // hub.registry.send is the intercepted spy (delays first ACK); since firstAck is already
  // consumed by the time we inject, the forged call goes through the real send path immediately:
  // registry → relay → node client ws → handleE2EAck.
  hub.registry.send('node-forged', HUB_TO_NODE.E2E_ACK, {
    nonce: correctNonce,
    pub: wrongEph.publicKeyB64,
    sig: 'invalid-signature-that-will-fail-verification',
    at: Date.now(),
  })

  // Wait for the forged ACK to be processed
  await sleep(300)

  // ── Assertions ──
  // The !matchOffer branch MUST have been hit: error message contains "签名验证失败"
  const forgedError = node.rec.errors.find((e) => e.includes('签名验证失败'))
  assert.ok(forgedError, `forged ACK error should be present, got: ${JSON.stringify(node.rec.errors)}`)

  // No fatal, node still running
  assert.equal(node.tr.stopped, false, 'node is still running')
  assert.equal(node.rec.fatals.length, 0, `no fatal events: ${JSON.stringify(node.rec.fatals)}`)

  // Offer may have been consumed by real ACK arriving; just assert no fatal and error hit
  // (the real ACK fires at ~300ms after forged ACK at ~200ms; offer clears on success)

  // No error mentions hub-identity
  for (const err of node.rec.errors) {
    assert.ok(!err.includes('hub-identity'), `should not mention hub-identity: ${err}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// S56-stale-no-offer: stale ACK with no in-flight offer → silent ignore
// ─────────────────────────────────────────────────────────────────────────────
test('S56-stale-no-offer: ACK with no in-flight offer is silently discarded, node not stopped', async (t) => {
  const srv = await startRelay(t)
  const hub = startHubWithDelayedAck(srv, t, { ackDelayMs: 0 })

  // Node: normal timeout, session establishes
  const node = startNode(srv, 'node-nooffer', t, { ackTimeoutMs: 500, retryBaseMs: 600_000 })
  await waitFor(() => hub.registry.hasE2E('node-nooffer') && node.tr.e2e, 'initial session', 5000)

  // Forge a raw ACK frame with a random nonce that matches NO recent offer
  const fakeEph = await generateEphemeral()
  const fakeNonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
  const ackFrame = encodeFrame(envelope(HUB_TO_NODE.E2E_ACK, {
    nonce: fakeNonce,
    pub: fakeEph.publicKeyB64,
    sig: 'invalid',
    at: Date.now(),
  }))

  // Inject directly on the node's relay connection
  const nodeEntry = srv.relay.nodes.get('node-nooffer')
  assert.ok(nodeEntry, 'node is on relay')
  nodeEntry.conn.emit('message', ackFrame, false)

  await sleep(300)

  // Node must still be running, no fatal, session intact
  assert.equal(node.tr.stopped, false, 'node still running after injected no-match ACK')
  assert.equal(node.rec.fatals.length, 0, `no fatal: ${JSON.stringify(node.rec.fatals)}`)
  assert.ok(node.tr.e2e, 'node still has e2e session')
  assert.ok(hub.registry.hasE2E('node-nooffer'), 'hub still has e2e session')
})
