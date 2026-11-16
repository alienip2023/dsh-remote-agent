import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as protocol from '../lib/protocol.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { registerRemoteTools } from '../lib/hub/tools.js'
import { applyWorker } from '../lib/node/index.js'
import { NodeTransport } from '../lib/node/transport.js'

const job = () => ({ id: '301-1800000010000', name: 'openapi_v3.py', pid: 301, cwd: '/root/work', startedAt: 1800000010000, status: 'running', progressLines: 3 })
const frame = () => ({ at: 1800000100000, jobs: [job()] })

test('jobs frame constant and strict whitelist validation', () => {
  assert.equal(protocol.NODE_TO_HUB.JOBS, 'node/jobs')
  const input = frame()
  input.jobs[0].cmd = 'secret command'
  input.jobs[0].progressFile = '/private/results.tsv'
  const checked = protocol.validateJobsFrame(input)
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.jobs, frame())
  input.jobs[0].name = 'mutated'
  assert.equal(checked.jobs.jobs[0].name, 'openapi_v3.py')
  assert.equal(protocol.validateJobsFrame({ at: 1, jobs: [] }).ok, true)
  assert.equal(protocol.validateJobsFrame({ at: 1, jobs: Array.from({ length: 200 }, (_, i) => ({ ...job(), id: `id-${i}`, pid: i + 1 })) }).ok, true)
})

test('jobs rejects invalid types, nonfinite/negative numbers and invalid optional fields as a whole', () => {
  const bad = [null, [], {}, { at: 1, jobs: {} }, { at: '1', jobs: [] }, { at: NaN, jobs: [] }]
  for (const [key, values] of Object.entries({ id: [1, ''], name: [null, 5, ''], pid: ['301', -1, 1.5], cwd: [false, ''], startedAt: [Infinity, -1, 'now'], status: ['completed', null], progressLines: [null, '3', -1, 1.5], duplicateOf: [null, 4, ''] })) {
    for (const value of values) bad.push({ ...frame(), jobs: [job(), { ...job(), [key]: value }] })
  }
  for (const input of bad) {
    const result = protocol.validateJobsFrame(input)
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.equal(typeof result.error, 'string')
  }
})

test('jobs rejects more than 200 entries with a distinct error code', () => {
  assert.deepEqual(protocol.validateJobsFrame({ at: 1, jobs: Array(201).fill(job()) }), { ok: false, error: 'jobs-too-many' })
})

function registry(t, options = {}) {
  const logs = []
  const r = new NodeRegistry({ ...options, log: (...args) => logs.push(args) })
  t.after(() => r.dispose())
  r.ingestHello({ helloData: { nodeId: 'node001', protocol: protocol.PROTOCOL_VERSION, os: 'linux', roots: ['/root/work'], nonce: '', time: Date.now() }, conn: { send() {}, close() {} }, transport: 'direct' })
  return { r, logs }
}

test('hub stores validated jobs, rejects bad snapshot atomically and renders grouped node_jobs/remote_nodes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-job-frames-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { r, logs } = registry(t, { stateDir: dir })
  const input = frame()
  input.jobs.push({ ...job(), id: '302-next', pid: 302, startedAt: job().startedAt + 1000, duplicateOf: job().id })
  input.jobs.push({ ...job(), id: '303-done', pid: 303, status: 'done' })
  r.handleFrameFor('node001', { t: 'node/jobs', d: input })
  assert.deepEqual(r.list()[0].jobs, input.jobs)
  r.handleFrameFor('node001', { t: 'node/jobs', d: { at: 1, jobs: [job(), { ...job(), pid: 'bad' }] } })
  assert.deepEqual(r.list()[0].jobs, input.jobs)
  assert.ok(logs.some(args => args.some(x => x?.code === 'jobs-invalid')))
  const defs = new Map()
  registerRemoteTools({ ctx: { tools: { register(def) { defs.set(def.name, def); return () => {} } } }, registry: r })
  const tool = defs.get('node_jobs')
  assert.ok(tool)
  const result = await tool.execute({ node: 'node001' })
  const rendered = tool.output.render({}, result).map(x => x.text).join('\n')
  assert.match(rendered, /node001.*在跑 2.*已完成 1/)
  assert.match(rendered, /running/)
  assert.match(rendered, /id=302-next.*duplicate/)
  assert.match(rendered, /⚠ 与 301-1800000010000 重复/)
  assert.match(rendered, /3 行/)
  const remote = defs.get('remote_nodes')
  assert.match(remote.output.render({}, await remote.execute({}))[0].text, /任务: 2 在跑 \/ 1 已完成 \/ 1 重复/)
  assert.deepEqual((await tool.execute({ node: 'missing' })).nodes, [])
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'node-jobs.json'), 'utf8'))
  assert.deepEqual(saved.node001, input)
  const restored = new NodeRegistry({ stateDir: dir })
  t.after(() => restored.dispose())
  assert.deepEqual(restored.list()[0].jobs, input.jobs)
  assert.equal(restored.list()[0].online, false)
})

test('worker reports every 15s with whitelisted fields and ctx.effect stops its timer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-job-worker-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setInterval'] })
  const services = new Map()
  const effects = []
  const reports = []
  const { r } = registry(t)
  let transport
  const originalOn = NodeTransport.prototype.on
  t.mock.method(NodeTransport.prototype, 'on', function (...args) { transport = this; return originalOn.apply(this, args) })
  t.mock.method(NodeTransport.prototype, 'send', function (type, data) {
    if (type === 'node/jobs') { reports.push(data); r.handleFrameFor('node001', { t: type, d: data }) }
    return true
  })
  const dispose = applyWorker({ get: key => services.get(key), set: (key, value) => services.set(key, value),
    effect: start => { effects.push(start()) } },
  { nodeId: 'node001', hubUrl: '', stateDir: dir, roots: [dir], resourceIntervalMs: 0, reposIntervalMs: 0 })
  t.after(dispose)
  const ledger = services.get('remote-agent:jobs')
  assert.ok(ledger)
  // Let the real initial /proc scan settle before replacing only its input.
  await ledger.scan()
  await new Promise(resolve => setImmediate(resolve))
  const scripted = { ...job(), cmd: 'private flags', progressFile: '/private/result.tsv', progressMtime: 5 }
  let scans = 0
  t.mock.method(ledger, 'scan', async () => { scans++; return [scripted] })
  const before = reports.length
  t.mock.timers.tick(14_999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reports.length, before)
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scans, 1)
  assert.deepEqual(reports.at(-1).jobs, [job()])
  assert.equal(r.list()[0].jobs[0].status, 'running')
  transport.emit('online', {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scans, 2)
  t.mock.method(ledger, 'scan', async () => [
    ...Array.from({ length: 205 }, (_, i) => ({ ...job(), id: `done-${i}`, pid: i + 1000, status: 'done' })),
    job(),
  ])
  t.mock.timers.tick(15_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reports.at(-1).jobs.length, 200)
  assert.equal(reports.at(-1).jobs[0].id, job().id)
  const beforeStop = reports.length
  let release
  let slowScans = 0
  t.mock.method(ledger, 'scan', () => { slowScans++; return new Promise(resolve => { release = resolve }) })
  t.mock.timers.tick(45_000)
  assert.equal(slowScans, 1)
  for (const cleanup of effects) cleanup?.()
  release([job()])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reports.length, beforeStop)
  t.mock.timers.tick(30_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(slowScans, 1)
})

test('hub with unwritable stateDir retains valid jobs in memory and logs persistence failure', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-job-hub-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateDir = path.join(dir, 'file')
  fs.writeFileSync(stateDir, 'not a directory')
  const { r, logs } = registry(t, { stateDir })
  assert.doesNotThrow(() => r.handleFrameFor('node001', { t: 'node/jobs', d: frame() }))
  assert.deepEqual(r.list()[0].jobs, frame().jobs)
  assert.ok(logs.some(args => args.includes('jobs snapshot save failed')))
})
