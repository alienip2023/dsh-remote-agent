// fork.61: duplicate-node is a restart race (the relay still holds the old process's record),
// not a configuration error. The node retries with backoff and only then stops. All relay
// behaviour below is the REAL lib/relay.js server; its duplicate decision is not mocked.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION, RELAY_FRAME, encodeFrame, envelope } from '../lib/protocol.js'
import { createRelay, newRelayToken } from '../lib/relay.js'
import { connect } from '../lib/ws.js'
import {
  NodeTransport,
  DUPLICATE_RETRY_DEFAULTS,
  duplicateBackoffMs,
  resolveDuplicateRetry,
} from '../lib/node/transport.js'
import { attachLifecycleConsole, renderLifecycleLine } from '../lib/node/lifecycle-console.js'
import { applyWorker } from '../lib/node/index.js'

const HUB_TOKEN = newRelayToken('rt')
const ENROLL_TOKEN = newRelayToken('en')

function startRelay(t) {
  const events = []
  const relay = createRelay({ port: 0, host: '127.0.0.1', hubToken: HUB_TOKEN, enrollToken: ENROLL_TOKEN, onEvent: (e) => events.push(e) })
  return new Promise((resolve) => {
    relay.listen(() => {
      const port = relay.address().port
      const srv = {
        relay,
        events,
        port,
        base: `ws://127.0.0.1:${port}/relay`,
        dupRejects: () => events.filter((e) => e.msg === 'duplicate node rejected').length,
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

/** An "old process": a raw node connection that holds the nodeId on the real relay. */
async function holdNodeId(srv, nodeId, t) {
  const conn = await connect(`${srv.base}?role=node&token=${encodeURIComponent(ENROLL_TOKEN)}&nodeId=${encodeURIComponent(nodeId)}`, { name: `old:${nodeId}` })
  conn.on('error', () => {})
  conn.send(encodeFrame(envelope(RELAY_FRAME.HELLO_NODE, { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', arch: 'x64', hostname: nodeId, shells: ['bash'], roots: ['/tmp'], caps: ['exec'], profile: '', agentMode: true, time: Date.now() })))
  await waitFor(() => srv.relay.nodes.has(nodeId), 'old holder registered')
  t.after(() => { try { conn.socket?.destroy() } catch { /* gone */ } })
  return conn
}

async function waitFor(fn, label, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function helloFor(nodeId) {
  return { nodeId, protocol: PROTOCOL_VERSION, os: 'linux', arch: 'x64', hostname: nodeId, shells: ['bash'], roots: ['/tmp'], caps: ['exec'], profile: '', agentMode: true, time: Date.now() }
}

/** A real NodeTransport against the real relay, recording every lifecycle event. */
function startNode(srv, nodeId, t, o = {}) {
  const tr = new NodeTransport({ mode: 'relay', url: srv.base, token: o.token ?? ENROLL_TOKEN, hello: o.hello ?? helloFor(nodeId), e2e: false, ...o.extra })
  const rec = { online: 0, offline: [], reconnecting: [], fatal: [], errors: [] }
  tr.on('online', () => { rec.online += 1 })
  tr.on('offline', (r) => rec.offline.push(r))
  tr.on('reconnecting', (i) => rec.reconnecting.push(i))
  tr.on('fatal', (i) => rec.fatal.push(i))
  tr.on('error', (e) => rec.errors.push(String(e?.message ?? e)))
  t.after(() => tr.stop())
  tr.start()
  return { tr, rec }
}

const FAST = { baseMs: 30, maxMs: 60, totalMs: 200 }

/* ───────── defaults, config fallback (pure behaviour of the exported helpers) ───────── */

test('D61-schedule: default backoff is 1s/2s/4s/8s/16s then capped, within a ~10 minute budget (fork.62)', () => {
  const cfg = resolveDuplicateRetry(undefined)
  assert.deepEqual(cfg, DUPLICATE_RETRY_DEFAULTS)
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => duplicateBackoffMs(n, cfg)), [1000, 2000, 4000, 8000, 16000, 16000, 16000])
  let n = 0
  let spent = 0
  while (spent + duplicateBackoffMs(n + 1, cfg) <= cfg.totalMs) { n += 1; spent += duplicateBackoffMs(n, cfg) }
  assert.equal(cfg.totalMs, 600000)
  assert.equal(n, 40)
  assert.ok(spent <= 600000 && spent >= 580000, `spent ${spent}`)
})

test('D61-config: valid overrides are honoured, every invalid field falls back to its default', () => {
  assert.deepEqual(resolveDuplicateRetry({ baseMs: 50, maxMs: 400, totalMs: 5000 }), { baseMs: 50, maxMs: 400, totalMs: 5000 })
  const d = DUPLICATE_RETRY_DEFAULTS
  for (const bad of [0, -5, NaN, Infinity, '5', null, undefined, [], {}, true]) {
    assert.equal(resolveDuplicateRetry({ baseMs: bad }).baseMs, d.baseMs, `baseMs ${String(bad)}`)
    assert.equal(resolveDuplicateRetry({ maxMs: bad }).maxMs, d.maxMs, `maxMs ${String(bad)}`)
    assert.equal(resolveDuplicateRetry({ totalMs: bad }).totalMs, d.totalMs, `totalMs ${String(bad)}`)
  }
  for (const raw of [null, 'x', 7, [], undefined]) assert.deepEqual(resolveDuplicateRetry(raw), d)
  assert.equal(resolveDuplicateRetry({ totalMs: 3_600_001 }).totalMs, d.totalMs, 'absurd total falls back')
  assert.equal(resolveDuplicateRetry({ baseMs: 5000, maxMs: 100 }).maxMs, 5000, 'max never below base')
})

/* ───────── real relay: the restart race ───────── */

test('D61-race: the old connection closes after the new one arrives; the new one ends up online, with the expected backoff', async (t) => {
  const srv = await startRelay(t)
  const old = await holdNodeId(srv, 'node-race', t)
  const { tr, rec } = startNode(srv, 'node-race', t, { extra: { duplicateRetry: FAST } })

  await waitFor(() => rec.reconnecting.length >= 2, 'two retries')
  assert.equal(rec.online, 0, 'still rejected while the old record is alive')
  assert.equal(tr.stopped, false, 'duplicate-node must not stop the node while within budget')
  old.close(1000, 'late close') // the stale record finally goes away
  await waitFor(() => rec.online === 1, 'new connection online')

  assert.equal(srv.relay.nodes.has('node-race'), true)
  assert.equal(tr.online, true)
  // every retry really reached the relay and was refused by the real duplicate check
  const dupRetries = rec.reconnecting.filter((r) => r.reason === 'duplicate-node')
  assert.ok(dupRetries.length >= 2)
  assert.equal(srv.dupRejects(), dupRetries.length)
  const [a, b] = dupRetries
  assert.equal(a.attempt, 1)
  assert.equal(b.attempt, 2)
  assert.ok(a.delayMs >= 30 && a.delayMs <= 36, `first delay ${a.delayMs}`)
  assert.ok(b.delayMs >= 60 && b.delayMs <= 72, `second delay ${b.delayMs}`)
  if (dupRetries[2]) assert.ok(dupRetries[2].delayMs >= 60 && dupRetries[2].delayMs <= 72, 'capped at maxMs')
})

test('D61-reset: going online clears the duplicate counter (a second episode gets a fresh budget)', async (t) => {
  const srv = await startRelay(t)
  const old1 = await holdNodeId(srv, 'node-reset', t)
  const { tr, rec } = startNode(srv, 'node-reset', t, { extra: { duplicateRetry: FAST } })
  await waitFor(() => rec.reconnecting.filter((r) => r.reason === 'duplicate-node').length >= 2, 'episode 1 retries')
  old1.close(1000, 'late close')
  await waitFor(() => rec.online === 1, 'episode 1 online')
  assert.equal(srv.relay.nodes.has('node-reset'), true)

  // episode 2: the relay drops us and a new "old process" grabs the id first
  const before = rec.reconnecting.length
  srv.relay.nodes.get('node-reset').conn.close(1001, 'relay dropped')
  await waitFor(() => !srv.relay.nodes.has('node-reset'), 'record gone')
  const old2 = await holdNodeId(srv, 'node-reset', t)
  // budget 200 with 30/60/60: episode 1 spent 90. Without a reset only one more retry fits; with a reset, three.
  await waitFor(() => rec.reconnecting.slice(before).filter((r) => r.reason === 'duplicate-node').length >= 3, 'three fresh retries', 12000)
  assert.equal(tr.stopped, false)
  const ep2 = rec.reconnecting.slice(before).filter((r) => r.reason === 'duplicate-node')
  assert.ok(ep2[0].delayMs >= 30 && ep2[0].delayMs <= 36, `episode 2 starts from the base delay, got ${ep2[0].delayMs}`)
  old2.close(1000, 'late close')
  await waitFor(() => rec.online === 2, 'episode 2 online')
})

test('D61-limit: past the budget the node really stops, with the original fatal error text, and stops hitting the relay', async (t) => {
  const srv = await startRelay(t)
  await holdNodeId(srv, 'node-limit', t)
  const { tr, rec } = startNode(srv, 'node-limit', t, { extra: { duplicateRetry: { baseMs: 20, maxMs: 40, totalMs: 100 } } })
  await waitFor(() => rec.fatal.length === 1, 'fatal after budget')
  assert.equal(tr.stopped, true)
  assert.deepEqual(rec.fatal[0], { code: 'duplicate-node', attempts: 3 })
  assert.equal(rec.reconnecting.length, 3, '20 + 40 + 40 = 100 fits, the next 40 does not')
  assert.ok(rec.errors.some((e) => e.startsWith('relay error: duplicate-node')), 'original error text kept')
  const rejects = srv.dupRejects()
  assert.equal(rejects, 4, 'first attempt + 3 retries')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(srv.dupRejects(), rejects, 'no further attempts once stopped')
  assert.equal(rec.online, 0)
})

test('D61-defaults-live: with no config the first retry waits 1s (+ up to 20% jitter); invalid config behaves like no config', async (t) => {
  const srv = await startRelay(t)
  await holdNodeId(srv, 'node-def', t)
  const a = startNode(srv, 'node-def', t)
  const b = startNode(srv, 'node-def', t, { extra: { duplicateRetry: { baseMs: -1, maxMs: 'x', totalMs: NaN } } })
  await waitFor(() => a.rec.reconnecting.length >= 1 && b.rec.reconnecting.length >= 1, 'first retry scheduled')
  for (const r of [a.rec.reconnecting[0], b.rec.reconnecting[0]]) {
    assert.equal(r.reason, 'duplicate-node')
    assert.ok(r.delayMs >= 1000 && r.delayMs <= 1200, `delay ${r.delayMs}`)
  }
})

/* ───────── other fatal codes stay immediate (real relay frames) ───────── */

async function assertImmediateStop(srv, rec, tr, code) {
  await waitFor(() => rec.fatal.length === 1, `fatal ${code}`)
  assert.equal(rec.fatal[0].code, code)
  assert.equal(tr.stopped, true)
  assert.equal(rec.reconnecting.length, 0, 'no retry for a non-duplicate fatal code')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(rec.reconnecting.length, 0)
  assert.equal(srv.dupRejects(), 0)
}

test('D61-fatal-node-id-invalid: stops immediately, never retries', async (t) => {
  const srv = await startRelay(t)
  const { tr, rec } = startNode(srv, 'x', t, { hello: helloFor('-bad id'), extra: { duplicateRetry: FAST } })
  await assertImmediateStop(srv, rec, tr, 'node-id-invalid')
})

test('D61-fatal-unauthorized: stops immediately, never retries', async (t) => {
  const srv = await startRelay(t)
  const token = srv.relay.mintToken({ nodeId: 'someone-else' }) // a one-time token bound to another id
  const { tr, rec } = startNode(srv, 'node-un', t, { token: typeof token === 'string' ? token : token.token, extra: { duplicateRetry: FAST } })
  await assertImmediateStop(srv, rec, tr, 'unauthorized')
})

test('D61-fatal-revoked: stops immediately, never retries', async (t) => {
  const srv = await startRelay(t)
  const { tr, rec } = startNode(srv, 'node-rev', t, { extra: { duplicateRetry: FAST } })
  await waitFor(() => rec.online === 1, 'online')
  srv.relay.kickNode('node-rev', 'revoked')
  await assertImmediateStop(srv, rec, tr, 'revoked')
})

/* ───────── stderr lifecycle lines ───────── */

const LINE = /^\[dsh-remote-agent\] node=[A-Za-z0-9._-]+ event=(online|offline|reconnecting|fatal)( [A-Za-z]+=[A-Za-z0-9._-]+)*$/

test('C61-render: a line only carries the node id, the event, numbers and whitelisted short codes', () => {
  assert.equal(renderLifecycleLine('n1', 'online'), '[dsh-remote-agent] node=n1 event=online')
  assert.equal(renderLifecycleLine('n1', 'reconnecting', { attempt: 2, delayMs: 2043.7, reason: 'duplicate-node' }), '[dsh-remote-agent] node=n1 event=reconnecting attempt=2 delayMs=2044 reason=duplicate-node')
  assert.equal(renderLifecycleLine('n1', 'offline', { reason: 'closed 1008: duplicate-node' }), '[dsh-remote-agent] node=n1 event=offline closeCode=1008')
  assert.equal(renderLifecycleLine('n1', 'fatal', { code: 'duplicate-node', attempts: 10 }), '[dsh-remote-agent] node=n1 event=fatal code=duplicate-node attempts=10')
  // hostile / sensitive content never gets through
  const evil = [
    renderLifecycleLine('n 1\nINJECT event=online', 'offline', { reason: 'closed 1008: token=sk-SECRET url=wss://h/relay?token=abc' }),
    renderLifecycleLine('n1', 'reconnecting', { attempt: 'x', delayMs: NaN, reason: 'sk-SECRET' }),
    renderLifecycleLine('n1', 'fatal', { code: 'sk-SECRET wss://h/?token=abc', attempts: 'many' }),
    renderLifecycleLine('n1', 'offline', { reason: 'ws://host:1/relay?token=abc' }),
  ]
  for (const line of evil) {
    assert.doesNotMatch(line, /SECRET|token|wss?:|abc|\n/)
    assert.match(line, LINE)
  }
})

test('C61-attach: online / offline / reconnecting / fatal each write one line; a throwing sink never breaks the transport', async (t) => {
  const srv = await startRelay(t)
  await holdNodeId(srv, 'node-con', t)
  const lines = []
  const tr = new NodeTransport({ mode: 'relay', url: srv.base, token: ENROLL_TOKEN, hello: helloFor('node-con'), e2e: false, duplicateRetry: { baseMs: 20, maxMs: 40, totalMs: 100 } })
  tr.on('error', () => {})
  t.after(() => tr.stop())
  attachLifecycleConsole(tr, 'node-con', (l) => lines.push(l))
  tr.start()
  await waitFor(() => lines.some((l) => l.includes('event=fatal')), 'fatal line')
  const rec = lines.filter((l) => l.includes('event=reconnecting'))
  assert.equal(rec.length, 3)
  assert.match(rec[0], /attempt=1 delayMs=\d+ reason=duplicate-node$/)
  assert.match(rec[2], /attempt=3 /)
  assert.match(lines.at(-1), /event=fatal code=duplicate-node attempts=3$/)
  assert.ok(lines.some((l) => /event=offline closeCode=\d+$/.test(l)) === false, 'never online, so no offline line')
  for (const l of lines) assert.match(l, LINE)

  // a throwing sink must not throw out of the transport
  const srv2 = await startRelay(t)
  const tr2 = new NodeTransport({ mode: 'relay', url: srv2.base, token: ENROLL_TOKEN, hello: helloFor('node-con2'), e2e: false })
  tr2.on('error', () => {})
  t.after(() => tr2.stop())
  attachLifecycleConsole(tr2, 'node-con2', () => { throw new Error('stderr closed') })
  let online = false
  tr2.on('online', () => { online = true })
  tr2.start()
  await waitFor(() => online, 'online despite throwing sink')
})

test('C61-offline: an established connection dropped by the relay writes offline (close code only), then reconnecting, then online', async (t) => {
  const srv = await startRelay(t)
  const lines = []
  const tr = new NodeTransport({ mode: 'relay', url: srv.base, token: ENROLL_TOKEN, hello: helloFor('node-off'), e2e: false })
  tr.on('error', () => {})
  t.after(() => tr.stop())
  attachLifecycleConsole(tr, 'node-off', (l) => lines.push(l))
  tr.start()
  await waitFor(() => lines.length === 1, 'first online')
  srv.relay.nodes.get('node-off').conn.close(1001, 'relay secret restart note')
  await waitFor(() => lines.filter((l) => l.includes('event=online')).length === 2, 'back online', 12000)
  assert.deepEqual(lines.map((l) => l.replace(/delayMs=\d+/, 'delayMs=N')), [
    '[dsh-remote-agent] node=node-off event=online',
    '[dsh-remote-agent] node=node-off event=offline closeCode=1001',
    '[dsh-remote-agent] node=node-off event=reconnecting attempt=1 delayMs=N',
    '[dsh-remote-agent] node=node-off event=online',
  ])
})

function captureStderr() {
  const lines = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const l of s.split('\n')) if (l.startsWith('[dsh-remote-agent]')) lines.push(l)
    return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true
  }
  return { lines, restore: () => { process.stderr.write = orig } }
}

test('C61-wired: the real worker writes the lines to stderr and still logs through ctx.logger; no token/url/relay text in any line', async (t) => {
  const srv = await startRelay(t)
  const old = await holdNodeId(srv, 'wired-1', t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-dup-wired-'))
  const logs = []
  const ctx = {
    effect: (fn) => { fn() },
    provide: () => {},
    get: () => undefined,
    logger: { info: (m, e) => logs.push(['info', m, e]), warn: (m, e) => logs.push(['warn', m, e]), error: (m, e) => logs.push(['error', m, e]), debug: () => {} },
  }
  const cap = captureStderr()
  let dispose
  try {
    dispose = applyWorker(ctx, { transportMode: 'relay', relayUrl: srv.base, token: ENROLL_TOKEN, nodeId: 'wired-1', stateDir: dir, roots: [dir], relayE2E: false, duplicateRetry: { baseMs: 20, maxMs: 40, totalMs: 1000 } })
    await waitFor(() => cap.lines.some((l) => l.includes('event=reconnecting')), 'reconnecting line', 5000)
    old.close(1000, 'late close')
    await waitFor(() => cap.lines.some((l) => l.includes('event=online')), 'online line', 5000)
  } finally {
    const stop = () => { if (typeof dispose === 'function') dispose(); else dispose?.dispose?.() }
    stop()
    cap.restore()
  }
  assert.ok(cap.lines.length >= 2)
  for (const l of cap.lines) {
    assert.match(l, LINE)
    assert.ok(l.includes('node=wired-1'))
    assert.ok(!l.includes(ENROLL_TOKEN))
    assert.doesNotMatch(l, /127\.0\.0\.1|relay\?|token|ws:/)
  }
  assert.ok(cap.lines.some((l) => /event=reconnecting attempt=1 delayMs=\d+ reason=duplicate-node$/.test(l)))
  const first = /delayMs=(\d+)/.exec(cap.lines.find((l) => l.includes('event=reconnecting')))
  assert.ok(Number(first[1]) >= 20 && Number(first[1]) <= 24, `config duplicateRetry reached the transport: ${first[1]}`)
  // ctx.logger behaviour is unchanged
  assert.ok(logs.some(([lvl, m]) => lvl === 'info' && /online/.test(m)), 'online still goes to ctx.logger')
  assert.ok(logs.some(([lvl, m]) => lvl === 'info' && /reconnecting/.test(m)), 'reconnecting still goes to ctx.logger')
  assert.ok(logs.some(([, m, e]) => /relay error|error/.test(String(m)) || JSON.stringify(e ?? '').includes('duplicate-node')), 'duplicate-node error still logged')
})

test('C61-wired-fatal: a revoked node writes one fatal line with its code and no relay message text', async (t) => {
  const srv = await startRelay(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-dup-fatal-'))
  const ctx = { effect: (fn) => { fn() }, provide: () => {}, get: () => undefined, logger: { info() {}, warn() {}, error() {}, debug() {} } }
  const cap = captureStderr()
  let dispose
  try {
    dispose = applyWorker(ctx, { transportMode: 'relay', relayUrl: srv.base, token: ENROLL_TOKEN, nodeId: 'wired-2', stateDir: dir, roots: [dir], relayE2E: false })
    await waitFor(() => cap.lines.some((l) => l.includes('event=online')), 'online', 5000)
    srv.relay.kickNode('wired-2', 'operator said: secret-reason-text')
    await waitFor(() => cap.lines.some((l) => l.includes('event=fatal')), 'fatal line', 5000)
  } finally {
    const stop = () => { if (typeof dispose === 'function') dispose(); else dispose?.dispose?.() }
    stop()
    cap.restore()
  }
  const fatal = cap.lines.filter((l) => l.includes('event=fatal'))
  assert.equal(fatal.length, 1)
  assert.match(fatal[0], /node=wired-2 event=fatal code=revoked attempts=0$/)
  for (const l of cap.lines) assert.doesNotMatch(l, /secret-reason-text|operator/)
})
