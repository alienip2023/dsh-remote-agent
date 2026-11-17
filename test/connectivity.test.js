import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { parseFrpcToml, readSakuraState, probeTcp, collectConnectivity } from '../lib/node/connectivity.js'
import { applyWorker } from '../lib/node/index.js'
import { createSelfCheckService } from '../lib/node/selfcheck-service.js'
import { NodeTransport } from '../lib/node/transport.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { NODE_TO_HUB, PROTOCOL_VERSION } from '../lib/protocol.js'

const toml = '[common]\nserverAddr = "frps.example"\nserverPort = 7000\n[[proxies]]\nlocalPort = 19387\nremotePort = 29387\n'
const absent = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
const offlineInputs = { dshHome: '/fixture/dsh', readFile: absent, readdir: absent, now: () => 1234 }
const pause = () => new Promise(resolve => setImmediate(resolve))

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-connectivity-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('1 parseFrpcToml: common/proxies, snake_case, comments and modern root server', () => {
  const expected = { ok: true, server: 'frps.example:7000', localPort: 19387, remotePort: 29387 }
  assert.deepEqual(parseFrpcToml(toml), expected)
  assert.deepEqual(parseFrpcToml(toml.replace('localPort', 'local_port').replace('remotePort', 'remote_port') + '# comment'), expected)
  assert.deepEqual(parseFrpcToml(toml.replace('[common]\n', '').replace('7000', '7000 # port')), expected)
  assert.deepEqual(parseFrpcToml(toml.replace('"frps.example"', "'frps.example'")), expected)
})

test('1 parseFrpcToml: missing keys, malformed values/content and empty input fail quietly', () => {
  for (const input of ['', 'broken TOML', null, toml.replace('remotePort = 29387', ''), toml.replace('7000', '0'),
    toml.replace('7000', '65536'), toml.replace('19387', '"19387"'), toml.replace('"frps.example"', '"unterminated'),
    toml.replace('remotePort = 29387', '[[proxies]]\nremotePort = 29387'), toml.replace('[common]', '[unrelated]')]) {
    assert.deepEqual(parseFrpcToml(input), { ok: false }, String(input))
  }
})

test('2 readSakuraState: last started is ready, later error wins and later recovery wins', async t => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'current.log')
  await fs.writeFile(file, '2026-11-17 10:00:00 [INFO] started tunnel /private/run/tunnel.conf\nheartbeat\n')
  const ready = await readSakuraState(dir)
  assert.equal(ready.kind, 'sakura')
  assert.equal(ready.state, 'ready')
  assert.match(ready.summary, /started tunnel/)
  assert.doesNotMatch(ready.summary, /2026-11-17|\/private/)
  await fs.appendFile(file, '2026-11-17T10:01:00Z [ERROR] error: failed C:\\ProgramData\\SakuraFrpService\\Logs\\current.log\n')
  const error = await readSakuraState(dir)
  assert.equal(error.state, 'error')
  assert.doesNotMatch(error.summary, /2026-11-17|C:\\/)
  await fs.appendFile(file, '2026-11-17T10:02:00Z tunnel started again\n')
  assert.equal((await readSakuraState(dir)).state, 'ready')
  // The public collector must preserve the same state, not invent readiness.
  await fs.appendFile(file, 'error: connection lost\n')
  const sample = await collectConnectivity({ ...offlineInputs, readdir: () => fs.readdir(dir, { withFileTypes: true }),
    readFile: fileName => fs.readFile(path.join(dir, path.basename(fileName)), 'utf8'),
    stat: fileName => fs.stat(path.join(dir, path.basename(fileName))) })
  assert.equal(sample.tunnelState, 'error')
})

test('2 readSakuraState: mtime selects newest file, directories ignored, only last 200 lines matter', async t => {
  const dir = await tempDir(t)
  await fs.writeFile(path.join(dir, 'z-old.log'), 'error old\n')
  await fs.utimes(path.join(dir, 'z-old.log'), 1, 1)
  await fs.writeFile(path.join(dir, 'a-new.log'), 'started tunnel newest\n')
  await fs.mkdir(path.join(dir, 'newest-directory'))
  assert.equal((await readSakuraState(dir)).state, 'ready')
  await fs.writeFile(path.join(dir, 'a-new.log'), 'error outside tail\n' + Array(200).fill('heartbeat').join('\n'))
  assert.equal((await readSakuraState(dir)).state, 'configured')
  const sample = await readSakuraState(dir, { tailLines: 201 })
  assert.equal(sample.state, 'error')
})

test('2 readSakuraState: empty is configured; missing directory rejects and collector swallows as none', async t => {
  const dir = await tempDir(t)
  assert.deepEqual(await readSakuraState(dir), { kind: 'sakura', state: 'configured', summary: '' })
  await assert.rejects(readSakuraState(path.join(dir, 'missing')), { code: 'ENOENT' })
  const sample = await collectConnectivity(offlineInputs)
  assert.equal(sample.tunnelState, 'none')
  assert.equal(sample.tunnel, null)
})

test('3 probeTcp: real loopback listener opens with a nonnegative RTT; released port is closed', async t => {
  const server = net.createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { if (server.listening) server.close() })
  const target = `127.0.0.1:${server.address().port}`
  const open = await probeTcp(target)
  assert.equal(open.result, 'open')
  assert.ok(Number.isFinite(open.rttMs) && open.rttMs >= 0)
  await new Promise(resolve => server.close(resolve))
  assert.equal((await probeTcp(target)).result, 'closed')
})

test('3 probeTcp: real TEST-NET deadline is 800ms and finishes within 1.5s', async () => {
  const start = performance.now()
  const result = await probeTcp('192.0.2.1:19387')
  const elapsed = performance.now() - start
  assert.equal(result.result, 'timeout')
  assert.ok(elapsed >= 650 && elapsed <= 1500, `elapsed=${elapsed}`)
  assert.ok(result.rttMs >= 650 && result.rttMs <= 1500)
})

test('3 probeTcp: delayed connect survives default deadline; timeout destroys immediately and settles once', async () => {
  let destroyed = 0
  let socket
  const fakeNet = { connect() {
    socket = new EventEmitter()
    socket.destroy = () => { destroyed++ }
    return socket
  } }
  const pending = probeTcp('127.0.0.1:1234', { net: fakeNet })
  setTimeout(() => socket.emit('connect'), 20)
  assert.equal((await pending).result, 'open')
  assert.equal(destroyed, 1)
  const start = performance.now()
  const timed = await probeTcp('192.0.2.1:19387', { net: fakeNet, timeoutMs: 40 })
  assert.equal(timed.result, 'timeout')
  assert.equal(destroyed, 2)
  assert.ok(performance.now() - start >= 30)
  socket.emit('connect')
  socket.emit('error', new Error('late'))
  assert.equal(destroyed, 2)
  assert.equal((await probeTcp('bad target')).result, 'closed')
  assert.equal((await probeTcp('host:123', { net: { connect() { throw new Error('blocked') } } })).result, 'closed')
})

test('collectConnectivity: read-only capabilities, config overrides, hub plus hosts, no frps connect', async t => {
  const reads = [], dirs = [], connects = []
  const readFile = t.mock.fn(async file => { reads.push(file); return toml })
  const readdir = t.mock.fn(async dir => { dirs.push(dir); throw new Error('unreadable') })
  const fakeNet = { connect(options) {
    connects.push(options)
    const socket = new EventEmitter()
    socket.destroy = () => {}
    queueMicrotask(() => socket.emit('connect'))
    return socket
  } }
  const forbidden = ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'open', 'rename', 'copyFile', 'chmod', 'utimes']
  const writes = forbidden.map(name => t.mock.method(fs, name, () => { throw new Error(`forbidden ${name}`) }))
  const sample = await collectConnectivity({ dshHome: '/fixture/dsh', platform: 'linux', readFile, readdir, net: fakeNet, now: () => 1234,
    config: { tunnelConfigPaths: ['custom/frpc.toml'], hubUrl: 'wss://hub.example/path?token=secret', probeHosts: ['extra.example:443', 'hub.example:443'], probeTimeoutMs: 50 } })
  assert.deepEqual(sample, { transportMode: 'direct', tunnel: { kind: 'frpc', server: 'frps.example:7000', localPort: 19387, remotePort: 29387 },
    tunnelState: 'configured', probes: [ { target: 'hub.example:443', result: 'open', rttMs: sample.probes[0].rttMs },
      { target: 'extra.example:443', result: 'open', rttMs: sample.probes[1].rttMs } ], sampledAt: 1234 })
  assert.deepEqual(reads, ['/fixture/dsh/custom/frpc.toml'])
  assert.deepEqual(dirs, ['/var/log/sakurafrp'])
  assert.equal(connects.length, 2)
  assert.ok(connects.every(({ host }) => host !== 'frps.example'))
  assert.equal(readFile.mock.callCount(), 1)
  assert.equal(readdir.mock.callCount(), 1)
  for (const spy of writes) assert.equal(spy.mock.callCount(), 0)
  // Inspect the implementation in addition to observing the injected I/O.
  const source = await fs.readFile(new URL('../lib/node/connectivity.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /fs\.write|writeFile|appendFile|child_process|execSync|spawn|createWriteStream/)
})

test('collectConnectivity: defaults, Windows path selection, relay, IPv6 and timeout override', async () => {
  const reads = [], dirs = []
  const socketNet = { connect() { const s = new EventEmitter(); s.destroy = () => {}; return s } }
  const sample = await collectConnectivity({ ...offlineInputs, dshHome: 'C:\\DSH', platform: 'win32',
    readFile: async file => { reads.push(file); throw new Error('missing') },
    readdir: async dir => { dirs.push(dir); return [] }, net: socketNet,
    config: { transportMode: 'relay', hubUrl: 'wss://[::1]/hub', probeHosts: ['bad', '[::1]:443'], probeTimeoutMs: 25 } })
  assert.deepEqual(reads, ['C:\\DSH\\.runtime\\frpc\\frpc.toml'])
  assert.deepEqual(dirs, ['C:\\ProgramData\\SakuraFrpService\\Logs'])
  assert.equal(sample.transportMode, 'relay')
  assert.equal(sample.tunnel.kind, 'sakura')
  assert.equal(sample.tunnelState, 'configured')
  assert.deepEqual(sample.probes.map(p => [p.target, p.result]), [['[::1]:443', 'timeout']])
  assert.ok(sample.probes[0].rttMs >= 15 && sample.probes[0].rttMs < 600)
})

test('selfcheck samples connectivity afresh even when periodic reporting is disabled', async () => {
  let count = 0
  const service = createSelfCheckService({ connectivity: () => collectConnectivity({ ...offlineInputs,
    config: { connectivityProbe: false }, now: () => ++count }) })
  assert.equal((await service.check({ purpose: 'exec' })).connectivity.sampledAt, 1)
  assert.equal((await service.check({ purpose: 'exec' })).connectivity.sampledAt, 2)
})

async function workerFixture(t, config = {}) {
  const dir = await tempDir(t)
  const frames = [], logs = [], handlers = []
  const services = new Map()
  let transport
  const originalOn = NodeTransport.prototype.on
  t.mock.method(NodeTransport.prototype, 'on', function (...args) { transport = this; return originalOn.apply(this, args) })
  t.mock.method(NodeTransport.prototype, 'send', (type, data) => { frames.push({ t: type, d: data }); return true })
  const dispose = applyWorker({ get: key => services.get(key), set: (key, value) => services.set(key, value),
    logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
    webServer: { register: route => { handlers.push(route); return () => {} } } },
  { nodeId: 'connectivity-node', hubUrl: '', stateDir: dir, roots: [dir], resourceIntervalMs: 0, reposIntervalMs: 0, tunnelConfigPaths: [], ...config })
  t.after(dispose)
  const reports = () => frames.filter(f => f.t === 'node/connectivity')
  // Real filesystem promises need an event-loop turn after advancing fake timers.
  const settle = async () => { for (let i = 0; i < 20; i++) await pause() }
  return { transport, frames, reports, logs, handlers, dispose, settle }
}

test('4 node → registry → remote_nodes: initial delay, default interval, overwrite and null fallback', async t => {
  assert.equal(NODE_TO_HUB.CONNECTIVITY, 'node/connectivity')
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const w = await workerFixture(t)
  t.mock.timers.tick(70_000)
  await w.settle()
  assert.equal(w.reports().length, 0, 'no reporting before online')
  w.transport.online = true
  w.transport.emit('online', {})
  t.mock.timers.tick(4999)
  await w.settle()
  assert.equal(w.reports().length, 0)
  t.mock.timers.tick(1)
  await w.settle()
  assert.equal(w.reports().length, 1)
  const r = new NodeRegistry()
  t.after(() => r.dispose())
  r.ingestHello({ helloData: { nodeId: 'connectivity-node', protocol: PROTOCOL_VERSION, os: 'linux', roots: [] },
    conn: { send() {}, close() {} }, transport: 'direct' })
  assert.equal(r.list()[0].connectivity, null)
  r.handleFrameFor('connectivity-node', w.reports()[0])
  assert.deepEqual(r.getNode('connectivity-node').connectivity, w.reports()[0].d)
  assert.deepEqual(r.list()[0].connectivity, w.reports()[0].d)
  const next = { ...w.reports()[0].d, tunnelState: 'error', sampledAt: 4321 }
  r.handleFrameFor('connectivity-node', { t: 'node/connectivity', d: next })
  assert.deepEqual(r.list()[0].connectivity, next)
  t.mock.timers.tick(59_999)
  await w.settle()
  assert.equal(w.reports().length, 1)
  t.mock.timers.tick(1)
  await w.settle()
  assert.equal(w.reports().length, 2)
  w.dispose()
  t.mock.timers.tick(120_000)
  await w.settle()
  assert.equal(w.reports().length, 2)
})

test('4 connectivityProbe:false never sends; local status still samples fresh connectivity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const w = await workerFixture(t, { connectivityProbe: false })
  w.transport.online = true
  w.transport.emit('online', {})
  t.mock.timers.tick(180_000)
  await w.settle()
  assert.equal(w.reports().length, 0)
  const route = w.handlers.find(r => r.path === '/api/remote-agent/status')
  let body
  await route.handler({ method: 'GET' }, { setHeader() {}, end(text) { body = JSON.parse(text) } })
  assert.equal(body.connectivity.tunnelState, 'none')
  assert.ok(Number.isFinite(body.connectivity.sampledAt))
})

test('4 interval clamp/overrides, reconnect, offline and debug-only send failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const w = await workerFixture(t, { connectivityIntervalMs: 1, connectivityInitialDelayMs: 20 })
  w.transport.online = true
  w.transport.emit('online', {})
  t.mock.timers.tick(20)
  await w.settle()
  assert.equal(w.reports().length, 1)
  t.mock.timers.tick(14_999)
  await w.settle()
  assert.equal(w.reports().length, 1)
  t.mock.timers.tick(1)
  await w.settle()
  assert.equal(w.reports().length, 2)
  w.transport.online = false
  w.transport.emit('offline', 'test')
  t.mock.timers.tick(30_000)
  await w.settle()
  assert.equal(w.reports().length, 2)
  t.mock.method(NodeTransport.prototype, 'send', type => { if (type === 'node/connectivity') throw new Error('send broken'); return true })
  w.transport.online = true
  w.transport.emit('online', {})
  t.mock.timers.tick(20)
  await w.settle()
  const failures = w.logs.filter(([, message]) => /connectivity.*fail/.test(message))
  assert.ok(failures.length > 0)
  assert.ok(failures.every(([level]) => level === 'debug'))
})
