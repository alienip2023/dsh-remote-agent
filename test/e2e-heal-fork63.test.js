// fork.63: the e2e session heals by itself after the hub (master) reopens or a node falls back
// to plaintext. Everything below runs the REAL lib/relay.js, the REAL hub (NodeRegistry +
// RelayLink) and the REAL NodeTransport; the only things the tests touch are spies that call
// through (frame/offer counters) and timers scaled down through public options / instance
// fields (the hub's `e2eHeal` option, the transport's E2E_* fields).
//
// Real incidents these model (master reopened twice, node stayed online on the relay):
//   14:23 type  hub restarts with an empty registry while the node keeps its connection;
//               nothing ever told the hub to re-key unless the node happened to send a sealed frame.
//   14:43 type  the node's own offer timed out (5s) so it sat in plaintext for good; the hub
//               came back and had no session either; nobody could start the handshake.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODE, HUB_TO_NODE, NODE_TO_HUB, PROTOCOL_VERSION, RELAY_FRAME, decodeFrame, encodeFrame, envelope } from '../lib/protocol.js'
import { createRelay, newRelayToken } from '../lib/relay.js'
import { connect } from '../lib/ws.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { RelayLink } from '../lib/hub/relay-link.js'
import { createConfigSync } from '../lib/hub/config-sync.js'
import { E2E_HEAL_DEFAULTS, e2eHealDelayMs, resolveE2EHeal } from '../lib/hub/e2e-heal.js'
import { NodeTransport } from '../lib/node/transport.js'
import { attachLifecycleConsole, renderLifecycleLine } from '../lib/node/lifecycle-console.js'
import { E2E_MARKER, createSession, generateEphemeral } from '../lib/e2e.js'
import { generateIdentity } from '../lib/identity.js'

const HUB_TOKEN = newRelayToken('rt')
const ENROLL_TOKEN = newRelayToken('en')
const ID = generateIdentity()
// Hub timers scaled down: attempts at 40, 80, 160, 160, 160, 160 ms; at most 6; a reset after a
// failed open at most every 300 ms.
const FAST = { baseMs: 40, maxMs: 160, maxAttempts: 6, resetMinMs: 300 }
const OFF = { baseMs: 40, maxMs: 160, maxAttempts: 0, resetMinMs: 300 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, label, timeoutMs = 6000) {
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

/** A real hub: NodeRegistry + RelayLink against the real relay. `resets` records every e2e-reset it sends. */
function startHub(srv, t, o = {}) {
  const logs = []
  const registry = new NodeRegistry({
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    identity: 'identity' in o ? o.identity : ID,
    e2eHeal: o.heal ?? FAST,
  })
  const resets = []
  const send = registry.send.bind(registry)
  let failLeft = o.failFirst ?? 0
  registry.send = (nodeId, type, data, opts) => {
    // a link that is down: the frame does not leave, send() says so
    if (failLeft > 0 && type === HUB_TO_NODE.ERROR) { failLeft -= 1; resets.push({ nodeId, at: Date.now(), ok: false }); return false }
    // a slow hub: the ack leaves late (the 11s lag seen at 14:23), after the node gave up waiting
    if ((o.ackDelayMs && !hub.fast) && type === HUB_TO_NODE.E2E_ACK) { setTimeout(() => { if (!hub.stopped) send(nodeId, type, data, opts) }, o.ackDelayMs); return true }
    const ok = send(nodeId, type, data, opts)
    if (type === HUB_TO_NODE.ERROR && data?.code === ERROR_CODE.E2E_RESET) resets.push({ nodeId, at: Date.now(), ok })
    return ok
  }
  const link = new RelayLink({
    url: srv.base,
    token: HUB_TOKEN,
    log: () => {},
    onFrame: (f) => registry.handleRelayFrame(f),
    onBinary: (h, p) => registry.handleRelayBinary(h, p),
    reconnectMs: 50,
  })
  registry.attachRelay(link)
  const hub = { registry, link, logs, resets, established: 0, stopped: false, fast: false }
  registry.on('e2eEstablished', () => { hub.established += 1 })
  hub.stop = async () => {
    if (hub.stopped) return
    hub.stopped = true
    registry.dispose()
    await waitFor(() => !srv.relay.hubs.size || srv.relay.hubs.size < 1, 'hub gone from relay', 3000).catch(() => {})
  }
  link.start()
  t.after(() => hub.stop())
  return hub
}

/** A real NodeTransport on the real relay; spies call through. */
function startNode(srv, nodeId, t, o = {}) {
  const tr = new NodeTransport({ mode: 'relay', url: srv.base, token: ENROLL_TOKEN, hello: helloFor(nodeId), e2e: o.e2e !== false })
  if (o.ackTimeoutMs !== undefined) tr.E2E_ACK_TIMEOUT_MS = o.ackTimeoutMs
  if (o.retryBaseMs !== undefined) tr.E2E_RETRY_BASE_MS = o.retryBaseMs
  if (o.retryMaxMs !== undefined) tr.E2E_RETRY_MAX_MS = o.retryMaxMs
  if (o.reofferMinMs !== undefined) tr.E2E_REOFFER_MIN_MS = o.reofferMinMs
  const rec = { online: 0, onlineAt: [], offers: [], e2e: [], frames: [], errors: [] }
  const sendRaw = tr.sendRaw.bind(tr)
  tr.sendRaw = (type, data, ...rest) => {
    if (type === NODE_TO_HUB.E2E_OFFER) rec.offers.push(Date.now())
    return sendRaw(type, data, ...rest)
  }
  tr.on('online', () => { rec.online += 1; rec.onlineAt.push(Date.now()) })
  tr.on('e2e', (status, info) => rec.e2e.push({ status, info, at: Date.now() }))
  tr.on('frame', (f) => rec.frames.push(f))
  tr.on('error', (e) => rec.errors.push(String(e?.message ?? e)))
  tr.on('hubIdentity', () => {})
  t.after(() => tr.stop())
  tr.start()
  return { tr, rec, nodeId, count: (status) => rec.e2e.filter((e) => e.status === status).length }
}

/** An "old node": a raw connection on the real relay that registers and then ignores every frame. */
async function startOldNode(srv, nodeId, t) {
  const conn = await connect(`${srv.base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}&nodeId=${encodeURIComponent(nodeId)}`, { name: `old:${nodeId}` })
  const rec = { resets: [], conn }
  conn.on('error', () => {})
  conn.on('message', (payload, isBinary) => {
    if (isBinary) return
    let f
    try { f = decodeFrame(payload.toString()) } catch { return }
    const fr = f?.ok === false ? null : (f?.frame ?? f)
    if (fr?.t === HUB_TO_NODE.ERROR && fr?.d?.code === ERROR_CODE.E2E_RESET) rec.resets.push(Date.now())
  })
  conn.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, helloFor(nodeId))))
  await waitFor(() => srv.relay.nodes.has(nodeId), 'old node registered')
  t.after(() => { try { conn.socket?.destroy() } catch { /* gone */ } })
  return rec
}

const gaps = (ts) => ts.slice(1).map((x, i) => x - ts[i])
const inRange = (v, lo, hi) => v >= lo && v <= hi

/** Establish a session the normal way: hub up, node connects, offer/ack. */
async function establishedPair(srv, t, nodeId, o = {}) {
  const hub = startHub(srv, t, { heal: o.heal ?? OFF })
  const node = startNode(srv, nodeId, t, o.node)
  await waitFor(() => hub.registry.hasE2E(nodeId) && node.tr.e2e, 'initial session on both sides')
  return { hub, node }
}

/* ───────── pure helpers: defaults and fallbacks ───────── */

test('E63-defaults: hub backoff is 2s/4s/8s/16s then 30s, ten attempts; invalid options fall back field by field', () => {
  assert.deepEqual(resolveE2EHeal(undefined), E2E_HEAL_DEFAULTS)
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => e2eHealDelayMs(n, E2E_HEAL_DEFAULTS)), [2000, 4000, 8000, 16000, 30000, 30000, 30000])
  assert.equal(E2E_HEAL_DEFAULTS.maxAttempts, 10)
  assert.equal(E2E_HEAL_DEFAULTS.resetMinMs, 5000)
  assert.deepEqual(resolveE2EHeal({ baseMs: 50, maxMs: 400, maxAttempts: 3, resetMinMs: 100 }), { baseMs: 50, maxMs: 400, maxAttempts: 3, resetMinMs: 100 })
  assert.equal(resolveE2EHeal({ maxAttempts: 0 }).maxAttempts, 0, 'zero attempts is a valid way to switch it off')
  for (const bad of [-1, NaN, Infinity, '5', null, [], {}, true, 0]) {
    assert.equal(resolveE2EHeal({ baseMs: bad }).baseMs, E2E_HEAL_DEFAULTS.baseMs, `baseMs ${String(bad)}`)
    if (bad !== 0) assert.equal(resolveE2EHeal({ maxAttempts: bad }).maxAttempts, E2E_HEAL_DEFAULTS.maxAttempts, `maxAttempts ${String(bad)}`)
    assert.equal(resolveE2EHeal({ resetMinMs: bad }).resetMinMs, E2E_HEAL_DEFAULTS.resetMinMs, `resetMinMs ${String(bad)}`)
  }
  assert.equal(resolveE2EHeal({ maxAttempts: 1.5 }).maxAttempts, E2E_HEAL_DEFAULTS.maxAttempts, 'attempts must be whole')
  assert.equal(resolveE2EHeal({ baseMs: 5000, maxMs: 100 }).maxMs, 5000, 'max never below base')
})

/* ───────── H1: the hub starts the handshake ───────── */

test('E63-h1-hub-reopen: 14:23 type — a fresh hub re-keys a node that keeps its connection and says nothing', async (t) => {
  const srv = await startRelay(t)
  const { hub: hubA, node } = await establishedPair(srv, t, 'node-a', { heal: OFF })
  const lines = []
  attachLifecycleConsole(node.tr, 'node-a', (l) => lines.push(l))
  assert.equal(node.rec.online, 1)
  // The master reopens: same hub identity, empty registry. The node's connection stays up and the
  // node sends nothing (no periodic uplink in this transport).
  await hubA.stop()
  const hubB = startHub(srv, t, { heal: FAST })
  await waitFor(() => hubB.registry.hasE2E('node-a'), 'the new hub got a session on its own')
  await waitFor(() => node.tr.e2e && node.count('ok') >= 2, 'node holds the new session')
  assert.equal(node.rec.online, 1, 'the node never reconnected: this was the hub starting the handshake')
  // the new session carries traffic in both directions
  assert.equal(hubB.registry.send('node-a', HUB_TO_NODE.TASK_QUERY, { taskId: 'probe-1' }), true)
  const got = await waitFor(() => node.rec.frames.find((f) => f.t === HUB_TO_NODE.TASK_QUERY), 'sealed frame opened by the node')
  assert.equal(got.d.taskId, 'probe-1')
  // bounded: one session needs one reset, and nothing more is sent once it exists
  const sent = hubB.resets.filter((r) => r.ok).length
  assert.ok(sent >= 1 && sent <= 2, `resets sent ${sent}`)
  const offersAfter = node.rec.offers.length
  await sleep(500)
  assert.equal(hubB.resets.filter((r) => r.ok).length, sent, 'no reset once the session exists')
  assert.equal(node.rec.offers.length, offersAfter, 'no further offers once the session exists')
  assert.ok(offersAfter <= 3, `offers ${offersAfter}`)
  // and the node's e2e events reach the console in a form that carries no key material
  assert.ok(lines.some((l) => /event=e2e status=reset\b/.test(l)), lines.join('\n'))
  assert.ok(lines.some((l) => /event=e2e status=established\b/.test(l)), lines.join('\n'))
})

test('E63-h1-offer-timeout-then-hub: 14:43 type — the node timed out into plaintext; the hub heals it, and the config push follows', async (t) => {
  const srv = await startRelay(t)
  // no hub yet: the node's offer goes nowhere and times out. Node-side retry is parked far away so
  // only the hub can heal this within the test.
  const node = startNode(srv, 'node-b', t, { ackTimeoutMs: 60, retryBaseMs: 600_000, retryMaxMs: 600_000 })
  await waitFor(() => node.count('timeout') >= 1, 'node offer timed out')
  assert.equal(node.tr.e2e, null)
  const source = () => ({ providers: [{ id: 'alpha', api: 'openai-completions', apiKeyEnv: 'ALPHA_KEY', apiKey: 'sk-fake-not-a-key', models: [{ id: 'm1' }] }], defaultModel: 'alpha/m1' })
  const hub = startHub(srv, t, { heal: FAST })
  createConfigSync({ registry: hub.registry, source, log: (level, msg, meta) => hub.logs.push({ level, msg, meta }) })
  await waitFor(() => hub.registry.hasE2E('node-b') && node.tr.e2e, 'session established on both sides')
  assert.equal(node.rec.online, 1)
  const push = await waitFor(() => node.rec.frames.find((f) => f.t === HUB_TO_NODE.CONFIG_PUSH), 'config push after heal')
  assert.equal(push.d.providers[0].apiKey, 'sk-fake-not-a-key')
  assert.equal(hub.logs.some((l) => /refuse to push/.test(l.msg)), false, 'the push waited for the session, it was not refused')
})

test('E63-h1-old-node: a node that never answers is reset on the backoff schedule and then left alone', async (t) => {
  const srv = await startRelay(t)
  const hub = startHub(srv, t, { heal: FAST })
  const old = await startOldNode(srv, 'node-old', t)
  await waitFor(() => old.resets.length >= FAST.maxAttempts, 'all attempts delivered', 4000)
  await sleep(700)
  assert.equal(old.resets.length, FAST.maxAttempts, 'capped: not reset forever')
  assert.equal(hub.resets.filter((r) => r.ok).length, FAST.maxAttempts)
  const g = gaps(old.resets)
  const want = [80, 160, 160, 160, 160]
  g.forEach((v, i) => assert.ok(inRange(v, want[i] - 10, want[i] + 90), `gap ${i} = ${v}, want ~${want[i]}`))
})

test('E63-h1-failed-sends: attempts that never left the hub do not use up the budget', async (t) => {
  const srv = await startRelay(t)
  const hub = startHub(srv, t, { heal: FAST, failFirst: 3 })
  const old = await startOldNode(srv, 'node-fail', t)
  await waitFor(() => old.resets.length >= FAST.maxAttempts, 'the full budget reaches the node despite three failed sends', 5000)
  await sleep(600)
  assert.equal(old.resets.length, FAST.maxAttempts)
  assert.equal(hub.resets.filter((r) => !r.ok).length, 3)
})

test('E63-h1-directory-repeat: the node directory arriving again does not restart the backoff', async (t) => {
  const srv = await startRelay(t)
  const hub = startHub(srv, t, { heal: FAST })
  const old = await startOldNode(srv, 'node-dir', t)
  const spam = setInterval(() => hub.link.requestNodeList(), 15)
  t.after(() => clearInterval(spam))
  await waitFor(() => old.resets.length >= 4, 'four attempts despite repeated directories', 4000)
  clearInterval(spam)
  const g = gaps(old.resets).slice(0, 3)
  const want = [80, 160, 160]
  g.forEach((v, i) => assert.ok(inRange(v, want[i] - 10, want[i] + 90), `gap ${i} = ${v}, want ~${want[i]}`))
  await sleep(500)
  assert.equal(old.resets.length, FAST.maxAttempts, 'still capped')
})

test('E63-h1-offline-restart: going offline stops the resets; coming back starts the count again', async (t) => {
  const srv = await startRelay(t)
  const hub = startHub(srv, t, { heal: FAST })
  const first = await startOldNode(srv, 'node-flap', t)
  await waitFor(() => first.resets.length >= 3, 'three attempts')
  first.conn.socket.destroy()
  await waitFor(() => !srv.relay.nodes.has('node-flap') && !hub.registry.nodes.get('node-flap')?.online, 'node offline on the hub')
  assert.equal(hub.registry.e2eHealState.has('node-flap'), false, 'no schedule is left behind for a node that is gone')
  const attemptsAtOffline = hub.resets.length
  await sleep(450)
  assert.equal(hub.resets.length, attemptsAtOffline, 'nothing is sent to an offline node')
  const back = await startOldNode(srv, 'node-flap', t)
  const cameBackAt = Date.now()
  await waitFor(() => back.resets.length >= 3, 'attempts restarted after the node came back', 4000)
  assert.ok(back.resets[0] - cameBackAt <= 40 + 150, `first attempt after ${back.resets[0] - cameBackAt}ms, want ~base`)
  const g = gaps(back.resets)
  assert.ok(inRange(g[0], 70, 140), `second gap ${g[0]} ~ 80: the schedule restarted, it did not continue at the cap`)
})

test('E63-h1-dispose: a disposed hub sends nothing more', async (t) => {
  const srv = await startRelay(t)
  const hub = startHub(srv, t, { heal: { baseMs: 80, maxMs: 80, maxAttempts: 6, resetMinMs: 300 } })
  const old = await startOldNode(srv, 'node-dispose', t)
  await waitFor(() => old.resets.length >= 1, 'first attempt')
  assert.ok(hub.registry.e2eHealState.size >= 1, 'premise: a schedule is running')
  hub.registry.dispose()
  assert.equal(hub.registry.e2eHealState.size, 0, 'no schedule survives dispose')
  await hub.stop()
  const seen = old.resets.length
  await sleep(400)
  assert.equal(old.resets.length, seen)
})

test('E63-h1-no-identity: a hub without an identity cannot sign an e2e ack, so it does not ask for an offer', async (t) => {
  const srv = await startRelay(t)
  const hub = startHub(srv, t, { heal: FAST, identity: null })
  const old = await startOldNode(srv, 'node-noid', t)
  await waitFor(() => hub.registry.nodes.get('node-noid')?.online, 'node adopted by the hub')
  await sleep(500)
  assert.equal(old.resets.length, 0)
  assert.equal(hub.resets.length, 0)
})

/* ───────── H2: a frame the hub cannot open ───────── */

test('E63-h2-open-failed: a frame that cannot be opened makes the hub re-key, at most once per interval', async (t) => {
  const srv = await startRelay(t)
  const { hub, node } = await establishedPair(srv, t, 'node-h2', { heal: OFF })
  let wrong = null
  const desync = () => {
    // The node's key no longer matches the hub's (what a lost ack or a half restart leaves behind):
    // a real session, derived from other ephemerals.
    const mine = generateEphemeral()
    const theirs = generateEphemeral()
    wrong = createSession({ role: 'node', ownPrivB64: mine.privateKeyB64, peerPubB64: theirs.publicKeyB64, nodePubB64: mine.publicKeyB64, hubPubB64: theirs.publicKeyB64 })
    node.tr.e2e = wrong
  }
  const before = hub.resets.length
  desync()
  for (let i = 0; i < 10; i += 1) node.tr.sendRaw(NODE_TO_HUB.RESOURCE, { n: i })
  await waitFor(() => hub.resets.length > before, 'hub asked the node to re-key')
  await sleep(60)
  assert.equal(hub.resets.length - before, 1, 'ten unreadable frames, one reset')
  await waitFor(() => node.tr.e2e && node.tr.e2e !== wrong && hub.established >= 2, 'both sides share a fresh session')
  // outside the interval a second desync is answered again
  await sleep(FAST.resetMinMs + 50)
  const mid = hub.resets.length
  desync()
  node.tr.sendRaw(NODE_TO_HUB.RESOURCE, { n: 99 })
  await waitFor(() => hub.resets.length > mid, 'second desync answered after the interval')
  assert.equal(hub.resets.length - mid, 1)
})

/* ───────── N1: the node answers a sealed frame it cannot open ───────── */

test('E63-n1-half-session: the hub holds a session the node never got; the first sealed frame makes the node re-offer', async (t) => {
  const srv = await startRelay(t)
  const hub = startHub(srv, t, { heal: OFF, ackDelayMs: 250 })
  // the ack arrives after the node gave up: the hub has a session, the node has none
  const node = startNode(srv, 'node-n1', t, { ackTimeoutMs: 60, retryBaseMs: 600_000, retryMaxMs: 600_000 })
  node.tr.on('e2e', (status) => { if (status === 'timeout') node.tr.E2E_ACK_TIMEOUT_MS = 5000 })
  await waitFor(() => hub.registry.hasE2E('node-n1') && node.count('timeout') >= 1, 'premise: hub has a session, node timed out')
  await sleep(300) // the late ack has arrived by now and was ignored
  hub.fast = true // later acks are not delayed
  assert.equal(node.tr.e2e, null, 'premise: the node has no session')
  const offersBefore = node.rec.offers.length
  assert.equal(hub.registry.send('node-n1', HUB_TO_NODE.TASK_QUERY, { taskId: 'q1' }), true)
  await waitFor(() => node.tr.e2e && hub.established >= 2, 're-offer produced a session on both sides')
  assert.equal(node.rec.offers.length - offersBefore, 1)
  assert.equal(hub.registry.send('node-n1', HUB_TO_NODE.TASK_QUERY, { taskId: 'q2' }), true)
  const got = await waitFor(() => node.rec.frames.find((f) => f.t === HUB_TO_NODE.TASK_QUERY && f.d.taskId === 'q2'), 'second sealed frame opened')
  assert.equal(got.d.taskId, 'q2')
})

/** A hub-shaped raw connection that injects sealed-looking frames at a node (a confused or hostile hub). */
async function rawHub(srv, t) {
  const conn = await connect(`${srv.base}?role=hub`, { name: 'raw-hub', headers: { 'x-relay-token': HUB_TOKEN } })
  conn.on('error', () => {})
  t.after(() => { try { conn.socket?.destroy() } catch { /* gone */ } })
  return {
    sealed: (nodeId, n = 1) => {
      for (let i = 0; i < n; i += 1) conn.send(encodeFrame({ ...envelope(HUB_TO_NODE.TASK_QUERY, { e2e: E2E_MARKER, n: 'AAAAAAAAAAAAAAAA', c: 'AAAAAAAAAAAAAAAA' }), to: nodeId }))
    },
  }
}

test('E63-n1-rate-limit: unreadable frames in bursts produce one re-offer per interval, not one per frame', async (t) => {
  const srv = await startRelay(t)
  const hub = await rawHub(srv, t)
  const node = startNode(srv, 'node-n1b', t, { ackTimeoutMs: 30, retryBaseMs: 600_000, retryMaxMs: 600_000, reofferMinMs: 5000 })
  await waitFor(() => node.count('timeout') >= 1, 'connect offer timed out (nobody answers)')
  assert.equal(node.rec.offers.length, 1)
  hub.sealed('node-n1b', 20)
  await waitFor(() => node.rec.offers.length >= 2, 'a re-offer')
  await sleep(120) // the offer times out
  hub.sealed('node-n1b', 20)
  await sleep(150)
  assert.equal(node.rec.offers.length, 2, 'one re-offer for 40 unreadable frames inside the interval')
})

/* ───────── N2: the node retries after its offer timed out ───────── */

test('E63-n2-retry-backoff: after a timeout the node retries with a growing delay and a cap, and a reconnect starts over', async (t) => {
  const srv = await startRelay(t)
  const node = startNode(srv, 'node-n2', t, { ackTimeoutMs: 30, retryBaseMs: 80, retryMaxMs: 160 })
  await waitFor(() => node.count('timeout') >= 4, 'four consecutive timeouts', 4000)
  const timeouts = node.rec.e2e.filter((e) => e.status === 'timeout')
  assert.deepEqual(timeouts.slice(0, 4).map((e) => e.info.delayMs), [80, 160, 160, 160], 'delays announced with the timeouts')
  timeouts.slice(0, 3).forEach((e, i) => {
    const next = node.rec.offers[i + 1]
    assert.ok(next - e.at >= e.info.delayMs - 10, `offer ${i + 1} came ${next - e.at}ms after the timeout, announced ${e.info.delayMs}`)
  })
  assert.ok(node.rec.offers.length >= 4)
  // a new connection starts the schedule again
  for (const n of [...srv.relay.nodes.values()]) n.conn.socket.destroy()
  await waitFor(() => node.rec.online >= 2, 'node reconnected', 6000)
  const fresh = await waitFor(() => node.rec.e2e.find((e) => e.status === 'timeout' && e.at >= node.rec.onlineAt[1]), 'first timeout on the new connection')
  assert.equal(fresh.info.delayMs, 80, 'the delay is back at the base after a reconnect')
})

test('E63-n2-heals-alone: with the hub unable to start it, the node retry alone gets the session once a hub exists', async (t) => {
  const srv = await startRelay(t)
  const node = startNode(srv, 'node-n2b', t, { ackTimeoutMs: 40, retryBaseMs: 80, retryMaxMs: 160 })
  await waitFor(() => node.count('timeout') >= 1, 'first timeout with no hub')
  const hub = startHub(srv, t, { heal: OFF })
  await waitFor(() => hub.registry.hasE2E('node-n2b') && node.tr.e2e, 'the node retry produced a session', 5000)
  assert.equal(hub.resets.length, 0, 'the hub did not do it')
  assert.equal(node.rec.online, 1)
})

test('E63-n-disabled: a node with e2e switched off never offers, whatever it receives', async (t) => {
  const srv = await startRelay(t)
  const hub = await rawHub(srv, t)
  const node = startNode(srv, 'node-off', t, { e2e: false, ackTimeoutMs: 20, retryBaseMs: 30, retryMaxMs: 30 })
  await waitFor(() => node.rec.online >= 1, 'online')
  hub.sealed('node-off', 5)
  await sleep(300)
  assert.equal(node.rec.offers.length, 0)
})

/* ───────── lifecycle console ───────── */

test('E63-console: e2e events are one whitelisted line each, with numbers only, never key material', () => {
  const key = 'k3y'.repeat(20)
  for (const [status, expect] of [['ok', 'established'], ['offer', 'offer'], ['reset', 'reset'], ['timeout', 'timeout']]) {
    const line = renderLifecycleLine('n-1', 'e2e', { status, delayMs: 160, attempt: 2, pub: key, sig: key, privateKeyB64: key, message: key })
    assert.match(line, new RegExp(`^\\[dsh-remote-agent\\] node=n-1 event=e2e status=${expect}( attempt=2)?( delayMs=160)?$`), line)
    assert.equal(line.includes(key), false)
  }
  assert.equal(renderLifecycleLine('n-1', 'e2e', { status: 'ok' }), '[dsh-remote-agent] node=n-1 event=e2e status=established')
  const odd = renderLifecycleLine('n-1', 'e2e', { status: 'weird\nstatus' })
  assert.equal(odd, '[dsh-remote-agent] node=n-1 event=e2e', 'an unknown status is left out')
})
