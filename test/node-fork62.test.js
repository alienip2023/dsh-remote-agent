// fork.62: three things the acceptance review of fork.61 asked for.
//  1. the default stderr write must not crash the node when the read end of the pipe is gone (EPIPE
//     arrives as an asynchronous 'error' event on process.stderr; try/catch cannot see it);
//  2. the duplicate-node default budget outlives the relay's idle eviction of a dead (no FIN) old
//     connection — proven on the REAL lib/relay.js with scaled-down idle/sweep times;
//  3. the two stop() sites that never emitted 'fatal' (hub identity, E2E without identity) now do,
//     with a whitelisted code and no detail.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { PROTOCOL_VERSION, RELAY_FRAME, encodeFrame, envelope } from '../lib/protocol.js'
import { createRelay, newRelayToken } from '../lib/relay.js'
import { connect } from '../lib/ws.js'
import { generateIdentity, signIdentity } from '../lib/identity.js'
import { NodeTransport, DUPLICATE_RETRY_DEFAULTS } from '../lib/node/transport.js'
import { attachLifecycleConsole, renderLifecycleLine } from '../lib/node/lifecycle-console.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONSOLE_URL = pathToFileURL(path.join(HERE, '../lib/node/lifecycle-console.js')).href

async function waitFor(fn, label, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/* ───────── 1. stderr EPIPE must not take the process down ───────── */

// The child uses the DEFAULT sink (no write function passed). Its stderr pipe's read end is closed by
// the parent before the child writes, so every write fails with EPIPE — asynchronously.
const CHILD = `
import { EventEmitter } from 'node:events'
import { attachLifecycleConsole } from ${JSON.stringify(CONSOLE_URL)}
const baseErr = process.stderr.listenerCount('error')
const baseOut = process.stdout.listenerCount('error')
const tr = new EventEmitter()
attachLifecycleConsole(tr, 'child-1')
process.stdin.once('data', async () => {
  for (let i = 0; i < 300; i += 1) {
    tr.emit('reconnecting', { attempt: i, delayMs: 10 })
    await new Promise((r) => setTimeout(r, 2))
  }
  setTimeout(() => {
    console.log(JSON.stringify({ done: true, errListeners: process.stderr.listenerCount('error') - baseErr, outListeners: process.stdout.listenerCount('error') - baseOut }))
    process.exit(0)
  }, 100)
})
console.log('ready')
`

function runChildWithClosedStderr() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => {
      out += b
      if (out.includes('ready') && !child.__go) {
        child.__go = true
        child.stderr.destroy() // the read end of the child's stderr pipe goes away
        child.stdin.write('go\n')
      }
    })
    child.stderr.on('data', (b) => { err += b })
    child.stderr.on('error', () => {})
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, out, err }))
    setTimeout(() => { child.kill('SIGKILL') }, 20_000).unref()
  })
}

test('S62-epipe: the default stderr write keeps the process alive after the pipe reader is gone, with one guard listener on stderr only', async () => {
  const r = await runChildWithClosedStderr()
  assert.equal(r.code, 0, `child exited ${r.code}/${r.signal}; stdout=${r.out.trim()} stderr=${r.err.slice(0, 200)}`)
  assert.equal(/EPIPE/.test(r.err), false, 'no write EPIPE crash text')
  const report = JSON.parse(r.out.trim().split('\n').at(-1))
  assert.equal(report.done, true)
  assert.equal(report.errListeners, 1, '300 writes leave exactly one guard listener on stderr')
  assert.equal(report.outListeners, 0, 'stdout is untouched')
})

test('S62-epipe-once: calling the default sink many times in one process never stacks listeners', async () => {
  const code = `
    import { EventEmitter } from 'node:events'
    import { attachLifecycleConsole } from ${JSON.stringify(CONSOLE_URL)}
    const base = process.stderr.listenerCount('error')
    const tr = new EventEmitter()
    attachLifecycleConsole(tr, 'n')
    attachLifecycleConsole(tr, 'n')
    for (let i = 0; i < 50; i += 1) tr.emit('online')
    console.log(process.stderr.listenerCount('error') - base)
  `
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'] })
    let s = ''
    child.stdout.on('data', (b) => { s += b })
    child.on('error', reject)
    child.on('close', () => resolve(s.trim()))
  })
  assert.equal(out, '1')
})

/* ───────── 2. the default budget outlives the relay's idle eviction (real relay, scaled time) ───────── */

const HUB_TOKEN = newRelayToken('rt')
const ENROLL_TOKEN = newRelayToken('en')
// the real relay defaults: idleMs 3 min, sweepMs 1 min (lib/relay.js:91-92); the budget is judged against that ratio
const RELAY_DEFAULT_IDLE_MS = 180_000
const IDLE_MS = 400
const SWEEP_MS = 100
const SCALE = IDLE_MS / RELAY_DEFAULT_IDLE_MS
// the retry cadence is scaled by hand (1s would make the test slow); only the BUDGET is the real default, scaled
const scaledConfig = () => ({ baseMs: 20, maxMs: 40, totalMs: Math.round(DUPLICATE_RETRY_DEFAULTS.totalMs * SCALE) })

function startRelay(t) {
  const events = []
  const relay = createRelay({ port: 0, host: '127.0.0.1', hubToken: HUB_TOKEN, enrollToken: ENROLL_TOKEN, idleMs: IDLE_MS, sweepMs: SWEEP_MS, onEvent: (e) => events.push({ ...e, at: Date.now() }) })
  return new Promise((resolve) => {
    relay.listen(() => {
      const srv = {
        relay,
        events,
        base: `ws://127.0.0.1:${relay.address().port}/relay`,
        close: async () => {
          for (const n of [...relay.nodes.values()]) { try { n.conn.socket?.destroy?.() } catch { /* gone */ } }
          await Promise.race([relay.close(), new Promise((r) => { const x = setTimeout(r, 2000); x.unref?.() })])
        },
      }
      t.after(() => srv.close())
      resolve(srv)
    })
  })
}

const helloFor = (nodeId) => ({ nodeId, protocol: PROTOCOL_VERSION, os: 'linux', arch: 'x64', hostname: nodeId, shells: ['bash'], roots: ['/tmp'], caps: ['exec'], profile: '', agentMode: true, time: Date.now() })

async function holdNodeId(srv, nodeId, t, { stuck }) {
  const conn = await connect(`${srv.base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}&nodeId=${encodeURIComponent(nodeId)}`, { name: `old:${nodeId}` })
  conn.on('error', () => {})
  conn.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, helloFor(nodeId))))
  await waitFor(() => srv.relay.nodes.has(nodeId), 'old holder registered')
  // A process that died without a FIN: it never reads again, so it never answers the relay's ping.
  if (stuck) conn.socket.pause()
  t.after(() => { try { conn.socket?.destroy() } catch { /* gone */ } })
  return conn
}

function startNode(srv, nodeId, t) {
  const tr = new NodeTransport({ mode: 'relay', url: srv.base, token: ENROLL_TOKEN, hello: helloFor(nodeId), e2e: false, duplicateRetry: scaledConfig() })
  const rec = { online: 0, fatal: [], reconnecting: [] }
  tr.on('online', () => { rec.online += 1 })
  tr.on('fatal', (i) => rec.fatal.push(i))
  tr.on('reconnecting', (i) => rec.reconnecting.push(i))
  tr.on('error', () => {})
  t.after(() => tr.stop())
  tr.start()
  return { tr, rec }
}

test('S62-evict: with the default-ratio budget the node comes online after the relay evicts a dead old connection', async (t) => {
  const srv = await startRelay(t)
  const started = Date.now()
  await holdNodeId(srv, 'node-evict', t, { stuck: true })
  const { tr, rec } = startNode(srv, 'node-evict', t)

  await waitFor(() => rec.online === 1, 'online after eviction', 10_000)
  const evicted = srv.events.find((e) => e.msg === 'node evicted: idle timeout')
  assert.ok(evicted, 'the real relay evicted the dead holder (idle sweep), nobody closed it')
  const evictedAfter = evicted.at - started
  // premise: the old 120s-ratio budget would already have been spent by then, so this test can tell the two defaults apart
  const oldBudget = Math.round(120_000 * SCALE)
  assert.ok(evictedAfter > oldBudget, `eviction at ${evictedAfter}ms is later than the old 120s-ratio budget (${oldBudget}ms)`)
  assert.equal(tr.stopped, false)
  assert.deepEqual(rec.fatal, [], 'no fatal on the way')
  assert.ok(rec.reconnecting.filter((r) => r.reason === 'duplicate-node').length >= 2, 'it really retried while the dead record was alive')
  assert.equal(srv.relay.nodes.has('node-evict'), true)
})

test('S62-evict-budget: a holder that stays healthy exhausts the same scaled budget — the node stops with the original fatal after about that long', async (t) => {
  const srv = await startRelay(t)
  await holdNodeId(srv, 'node-live', t, { stuck: false }) // answers pings, never evicted
  const cfg = scaledConfig()
  const started = Date.now()
  const { tr, rec } = startNode(srv, 'node-live', t)

  await waitFor(() => rec.fatal.length === 1, 'fatal once the budget is spent', 10_000)
  const elapsed = Date.now() - started
  assert.equal(rec.fatal[0].code, 'duplicate-node')
  assert.equal(tr.stopped, true)
  assert.equal(rec.online, 0)
  // planned waits sum to at most the budget, the last one that would not fit ended it; real time is at least the planned sum
  assert.ok(elapsed >= cfg.totalMs - cfg.maxMs, `stopped after ${elapsed}ms, budget ${cfg.totalMs}ms`)
})

/* ───────── 3. identity stops now say why (a whitelisted code, no detail) ───────── */

function makeHub() {
  const id = generateIdentity()
  const NONCE = 'ab'.repeat(16)
  return { id, nonce: NONCE, frame: () => ({ fp: id.fingerprint, pub: id.publicKeyB64, sig: signIdentity(id.privateKeyB64, { fingerprint: id.fingerprint, nodeId: 'n1', nonce: NONCE, at: Date.now() }), at: Date.now(), nonce: NONCE }) }
}

function identityTransport(extra = {}) {
  const hub = makeHub()
  const other = makeHub()
  const tr = new NodeTransport({
    mode: 'direct',
    url: 'ws://127.0.0.1:19387/api/remote-agent/node',
    hello: { nodeId: 'n1', nonce: hub.nonce },
    pinnedFingerprint: other.id.fingerprint, // a different hub than the one that answers
    pinStore: { get: () => null, set: () => true, clear: () => {} },
    identityGraceMs: 30,
    ...extra,
  })
  const rec = { fatal: [], errors: [], lines: [] }
  tr.on('fatal', (i) => rec.fatal.push(i))
  tr.on('error', (e) => rec.errors.push(String(e.message)))
  attachLifecycleConsole(tr, 'n1', (line) => rec.lines.push(line))
  return { tr, hub, rec }
}

test('S62-fatal-hub-identity: a hub whose fingerprint is not the pinned one stops the node with fatal code hub-identity, and the stderr line carries no detail', () => {
  const { tr, hub, rec } = identityTransport()
  tr.handleFrame({ t: 'welcome', d: { identity: hub.frame() } })
  assert.equal(tr.stopped, true)
  assert.deepEqual(rec.fatal, [{ code: 'hub-identity', attempts: 0 }])
  assert.ok(rec.errors.some((m) => m.includes('hub 身份验证失败')), 'the original error text is unchanged')
  assert.deepEqual(rec.lines, ['[dsh-remote-agent] node=n1 event=fatal code=hub-identity attempts=0'])
  for (const line of rec.lines) assert.equal(/mismatch|hubfp1-|fingerprint|ws:\/\//.test(line), false)
})

test('S62-fatal-e2e-identity: a hub/e2e answer with no verified hub identity stops the node with fatal code e2e-identity', () => {
  const { tr, rec } = identityTransport({ pinnedFingerprint: undefined })
  tr.e2eOffer = { nonce: 'n-1', publicKeyB64: 'AAAA' } // an offer in flight, but the hub identity was never verified
  tr.handleFrame({ t: 'hub/e2e', d: { pub: 'AAAA', sig: 'x', at: Date.now() } })
  assert.equal(tr.stopped, true)
  assert.deepEqual(rec.fatal, [{ code: 'e2e-identity', attempts: 0 }])
  assert.ok(rec.errors.some((m) => m.includes('hub 身份未验证')), 'the original error text is unchanged')
  assert.deepEqual(rec.lines, ['[dsh-remote-agent] node=n1 event=fatal code=e2e-identity attempts=0'])
})

test('S62-fatal-render: the two new codes are whitelisted; anything else is still dropped', () => {
  assert.equal(renderLifecycleLine('n', 'fatal', { code: 'hub-identity', attempts: 0 }), '[dsh-remote-agent] node=n event=fatal code=hub-identity attempts=0')
  assert.equal(renderLifecycleLine('n', 'fatal', { code: 'e2e-identity', attempts: 0 }), '[dsh-remote-agent] node=n event=fatal code=e2e-identity attempts=0')
  assert.equal(renderLifecycleLine('n', 'fatal', { code: 'hub-identity-detail: pin ws://x', attempts: 0 }), '[dsh-remote-agent] node=n event=fatal attempts=0')
})

test('S62-fatal-unaffected: a transient identity-less welcome (no pin configured) does not emit fatal', () => {
  const tr = new NodeTransport({ mode: 'direct', url: 'ws://127.0.0.1:1/x', hello: { nodeId: 'n1', nonce: 'ab'.repeat(16) }, pinStore: { get: () => null, set: () => true, clear: () => {} } })
  const fatal = []
  tr.on('fatal', (i) => fatal.push(i))
  tr.on('error', () => {})
  const emitter = new EventEmitter()
  assert.ok(emitter)
  tr.handleFrame({ t: 'welcome', d: { identity: undefined } })
  assert.equal(tr.stopped, false)
  assert.deepEqual(fatal, [])
})
