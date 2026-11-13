import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleBotCreateFrame } from '../lib/bot-create.js'
import { HUB_TO_NODE, NODE_TO_HUB, validateBotCreate, validateBotCreateResult } from '../lib/protocol.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { applyWorker } from '../lib/node/index.js'
import { NodeTransport } from '../lib/node/transport.js'
import { TaskEngine } from '../lib/node/task-engine.js'

// ── 协议校验 ─────────────────────────────────────────────────────
test('bot/create requires nodeId, requestId and name', () => {
  const ok = validateBotCreate({ nodeId: ' n ', requestId: ' req-1 ', name: ' Alpha ', role: '写' })
  assert.equal(ok.ok, true)
  assert.equal(ok.create.nodeId, 'n')
  assert.equal(ok.create.requestId, 'req-1')
  assert.equal(ok.create.name, 'Alpha')
  assert.equal(ok.create.role, '写')

  assert.equal(validateBotCreate({ requestId: 'r', name: 'A' }).error, 'bot-create-nodeId-missing')
  assert.equal(validateBotCreate({ nodeId: 'n', name: 'A' }).error, 'bot-create-requestId-missing')
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r' }).error, 'bot-create-name-missing')
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r', name: '' }).error, 'bot-create-name-missing')
})

test('bot/create carries the hub ownership marker and the default effort', async () => {
  const v = validateBotCreate({ nodeId: 'n', requestId: 'r', name: 'A', modelRef: 'p/m', managedBy: 'hub', defaultEffort: 'high' })
  assert.equal(v.ok, true)
  assert.equal(v.create.managedBy, 'hub')
  assert.equal(v.create.defaultEffort, 'high')
  assert.equal(v.create.effort, null, 'the explicit effort stays separate')

  // Through the real handler the receiver gets both fields, unmodified.
  const seen = []
  const sent = []
  const ctx = { get: name => (name === 'remote-agent:bot-create' ? async (spec) => { seen.push(spec); return { ok: true, remoteBotId: 'b1', name: 'A', role: '' } } : undefined) }
  await handleBotCreateFrame({ frame: { id: 'f1' }, data: { nodeId: 'n', requestId: 'r', name: 'A', modelRef: 'p/m', managedBy: 'hub', defaultEffort: 'high' }, ctx, send: (type, data) => sent.push({ type, data }), sendError: () => {} })
  assert.equal(seen[0].managedBy, 'hub')
  assert.equal(seen[0].defaultEffort, 'high')
  assert.equal(sent[0].type, NODE_TO_HUB.BOT_CREATE_RESULT)
})

test('bot/create refuses an unknown managedBy and reads a bad defaultEffort as absent', () => {
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r', name: 'A', managedBy: 'node' }).error, 'bot-create-managedBy-invalid')
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r', name: 'A', managedBy: 7 }).error, 'bot-create-managedBy-invalid')
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r', name: 'A' }).create.managedBy, null)
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r', name: 'A', defaultEffort: 7 }).create.defaultEffort, null)
  assert.equal(validateBotCreate({ nodeId: 'n', requestId: 'r', name: 'A', defaultEffort: 'x'.repeat(200) }).create.defaultEffort.length, 64)
})

test('bot/create-result validates success and failure shapes', () => {
  const ok = validateBotCreateResult({ requestId: 'r', ok: true, remoteBotId: 'bot-1', name: 'Alpha', role: '写' })
  assert.equal(ok.ok, true)
  assert.equal(ok.result.remoteBotId, 'bot-1')

  const fail = validateBotCreateResult({ requestId: 'r', ok: false, error: 'name-taken' })
  assert.equal(fail.ok, true)
  assert.equal(fail.result.ok, false)
  assert.equal(fail.result.error, 'name-taken')

  assert.equal(validateBotCreateResult({ ok: true }).error, 'bot-create-result-requestId-missing')
  // 成功但缺 remoteBotId
  assert.equal(validateBotCreateResult({ requestId: 'r', ok: true }).error, 'bot-create-result-remoteBotId-missing')
})

// ── handleBotCreateFrame 单元 ─────────────────────────────────────
test('bot/create does not enter the task engine', async () => {
  const accepted = { n: 0 }
  const eng = { accept() { accepted.n += 1 } }
  const sent = []
  const errors = []

  // 缺字段 → sendError
  const missing = await handleBotCreateFrame({
    frame: { id: 'f0', t: HUB_TO_NODE.BOT_CREATE },
    data: { nodeId: 'n', requestId: 'r' }, // missing name
    engine: eng,
    send(type, data) { sent.push({ type, data }) },
    sendError(id, code) { errors.push({ id, code }) },
  })
  assert.equal(missing.accepted, false)
  assert.equal(missing.error, 'bot-create-name-missing')
  assert.equal(accepted.n, 0)
  assert.equal(sent.length, 0)
  assert.equal(errors[0].code, 'bot-create-name-missing')

  // 有 receiver → 成功
  const replies = []
  const result = await handleBotCreateFrame({
    frame: { id: 'f1', t: HUB_TO_NODE.BOT_CREATE },
    data: { nodeId: 'n', requestId: 'req-1', name: 'Alpha', role: '写' },
    engine: eng,
    ctx: { get: () => async () => ({ ok: true, remoteBotId: 'bot-1', name: 'Alpha', role: '写' }) },
    send(type, data) { replies.push({ type, data }) },
    sendError() { throw new Error('valid bot/create must not sendError') },
  })
  assert.equal(result.accepted, true)
  assert.equal(result.remoteBotId, 'bot-1')
  assert.equal(accepted.n, 0, 'engine must not be called')
  assert.equal(replies[0].type, NODE_TO_HUB.BOT_CREATE_RESULT)
  assert.equal(replies[0].data.requestId, 'req-1')
  assert.equal(replies[0].data.remoteBotId, 'bot-1')
  assert.equal(replies[0].data.ok, true)
})

// ── 四刀第 2 刀：通过真实帧分发测试 ─────────────────────────────
async function dispatchBotCreate(frameData, receiverFn) {
  const sent = []
  const accepted = { n: 0 }
  const frameHandlers = []
  const origOn = NodeTransport.prototype.on
  const origSend = NodeTransport.prototype.send
  const origAccept = TaskEngine.prototype.accept
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-create-'))
  let dispose = () => {}
  NodeTransport.prototype.on = function on(evt, fn) {
    if (evt === 'frame') frameHandlers.push(fn)
    return origOn.call(this, evt, fn)
  }
  NodeTransport.prototype.send = function send(type, data, opts) {
    sent.push({ type, data, opts })
    return true
  }
  TaskEngine.prototype.accept = function accept(...args) {
    accepted.n += 1
    return origAccept.apply(this, args)
  }
  try {
    const receiver = receiverFn ?? (async () => ({ ok: true, remoteBotId: 'bot-1', name: 'Alpha', role: '' }))
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get(name) {
        if (name === 'remote-agent:bot-create') return receiver
        return undefined
      },
    }
    dispose = applyWorker(ctx, {
      hubUrl: '',
      stateDir,
      roots: [stateDir],
      resourceIntervalMs: 0,
      reposIntervalMs: 0,
      nodeId: 'node-a',
    })
    const handler = frameHandlers.at(-1)
    if (typeof handler === 'function') {
      handler({ id: 'f-dispatch', t: HUB_TO_NODE.BOT_CREATE, d: frameData })
    }
    const started = Date.now()
    while (!sent.some((item) => item.type === NODE_TO_HUB.BOT_CREATE_RESULT) && Date.now() - started < 500) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { sent, accepted: accepted.n }
  } finally {
    NodeTransport.prototype.on = origOn
    NodeTransport.prototype.send = origSend
    TaskEngine.prototype.accept = origAccept
    try { dispose() } catch { /* best-effort */ }
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

test('bot/create dispatched through real frame dispatch returns bot/create-result', async () => {
  // 刀2：通过真实帧分发，不直接调用处理函数
  const dispatched = await dispatchBotCreate({
    nodeId: 'node-a',
    requestId: 'req-dispatch',
    name: 'Alpha',
    role: '写',
  })
  const result = dispatched.sent.find((item) => item.type === NODE_TO_HUB.BOT_CREATE_RESULT)
  assert.ok(result, '没有 bot/create-result 帧')
  assert.equal(result.data.requestId, 'req-dispatch')
  assert.equal(result.data.remoteBotId, 'bot-1')
  assert.equal(result.data.ok, true)
  assert.equal(dispatched.accepted, 0, 'task engine must not be called')
})

test('bot/create dispatch without receiver returns error result, not task engine', async () => {
  // ctx.get('remote-agent:bot-create') 返回 undefined → 应回 bot-create-no-receiver
  const sent = []
  const accepted = { n: 0 }
  const frameHandlers = []
  const origOn = NodeTransport.prototype.on
  const origSend = NodeTransport.prototype.send
  const origAccept = TaskEngine.prototype.accept
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-create-norecv-'))
  let dispose = () => {}
  NodeTransport.prototype.on = function on(evt, fn) {
    if (evt === 'frame') frameHandlers.push(fn)
    return origOn.call(this, evt, fn)
  }
  NodeTransport.prototype.send = function send(type, data, opts) {
    sent.push({ type, data, opts })
    return true
  }
  TaskEngine.prototype.accept = function accept(...args) {
    accepted.n += 1
    return origAccept.apply(this, args)
  }
  try {
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get() { return undefined }, // no receiver
    }
    dispose = applyWorker(ctx, {
      hubUrl: '',
      stateDir,
      roots: [stateDir],
      resourceIntervalMs: 0,
      reposIntervalMs: 0,
      nodeId: 'node-a',
    })
    const handler = frameHandlers.at(-1)
    if (typeof handler === 'function') {
      handler({ id: 'f-norecv', t: HUB_TO_NODE.BOT_CREATE, d: { nodeId: 'node-a', requestId: 'req-no-recv', name: 'Alpha' } })
    }
    const started = Date.now()
    while (!sent.some((item) => item.type === NODE_TO_HUB.BOT_CREATE_RESULT) && Date.now() - started < 500) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const result = sent.find((item) => item.type === NODE_TO_HUB.BOT_CREATE_RESULT)
    assert.ok(result, '没有 bot/create-result 帧（no-receiver 时应回 error result）')
    assert.equal(result.data.ok, false)
    assert.equal(result.data.error, 'bot-create-no-receiver')
    assert.equal(accepted.n, 0, 'engine must not be called')
  } finally {
    NodeTransport.prototype.on = origOn
    NodeTransport.prototype.send = origSend
    TaskEngine.prototype.accept = origAccept
    try { dispose() } catch { /* best-effort */ }
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// ── hub 侧 botCreateResult 事件 ────────────────────────────────────
test('bot/create-result is emitted by requestId and a bad frame is dropped', () => {
  const listeners = {}
  class Core {
    constructor() {
      this.nodes = new Map([['n1', { nodeId: 'n1', lastSeen: 0, online: true }]])
      this.tasks = new Map()
    }
    log() {}
    send() {}
    on(name, fn) { (listeners[name] ??= []).push(fn) }
    emit(name, payload) { for (const fn of listeners[name] ?? []) fn(payload) }
  }
  const registry = new (withIngest(Core))()
  const got = []
  registry.on('botCreateResult', (payload) => got.push(payload))
  registry.handleFrameFor('n1', {
    t: NODE_TO_HUB.BOT_CREATE_RESULT,
    d: { requestId: 'req-1', ok: true, remoteBotId: 'bot-1', name: 'Alpha' },
  })
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.BOT_CREATE_RESULT, d: { ok: true } }) // missing requestId
  assert.equal(got.length, 1)
  assert.equal(got[0].requestId, 'req-1')
  assert.equal(got[0].remoteBotId, 'bot-1')
})

// 刀1：从 E2E_REQUIRED_TYPES 删掉 BOT_CREATE → isE2ERequired('bot/create') 返回 false → 测试红
test('E2E_REQUIRED_TYPES includes BOT_CREATE (isE2ERequired)', async () => {
  const { isE2ERequired } = await import('../lib/node/transport.js')
  assert.equal(isE2ERequired(HUB_TO_NODE.BOT_CREATE), true, 'bot/create must be in E2E_REQUIRED_TYPES')
  assert.equal(isE2ERequired('hello'), false, 'hello must NOT be in E2E_REQUIRED_TYPES')
  assert.equal(isE2ERequired('ping'), false, 'ping must NOT be in E2E_REQUIRED_TYPES')
})

// 刀2：把 !wasEncrypted 去掉 → checkE2EGate 对明文 bot/create 不再 reject → 测试红
test('checkE2EGate rejects unencrypted bot/create when e2e is active', async () => {
  const { checkE2EGate } = await import('../lib/node/transport.js')
  const rejected = checkE2EGate({ t: HUB_TO_NODE.BOT_CREATE }, { e2e: true, wasEncrypted: false })
  assert.equal(rejected.rejected, true, 'should reject cleartext bot/create when e2e is on')
  assert.equal(rejected.code, 'e2e-required', `expected code e2e-required, got ${rejected.code}`)
  assert.ok(typeof rejected.message === 'string' && rejected.message.includes('bot/create'), 'message should mention frame type')

  const passed = checkE2EGate({ t: HUB_TO_NODE.BOT_CREATE }, { e2e: true, wasEncrypted: true })
  assert.equal(passed.rejected, false, 'should pass encrypted bot/create')

  const noE2E = checkE2EGate({ t: HUB_TO_NODE.BOT_CREATE }, { e2e: false, wasEncrypted: false })
  assert.equal(noE2E.rejected, false, 'should pass when e2e is disabled')
})

// 刀3：让 checkE2EGate 恒返回 {rejected:false} → 明文 bot/create 走分发路径 → 测试红
test('NodeTransport dispatch rejects cleartext bot/create when e2e is active (dispatch path)', async () => {
  const errors = []
  const frames = []
  const sentRaw = []
  const transport = new NodeTransport({
    mode: 'direct',
    url: 'ws://127.0.0.1:1',
    token: 'tk',
    hello: { nodeId: 'n', hostname: 'h', version: '0.0.1', caps: [], agentMode: false },
    e2e: true,
  })
  // Simulate an active E2E session (handleFrame checks this.e2e, not e2eEnabled)
  transport.e2e = { openFrame: () => { throw new Error('should not decrypt cleartext') } }
  transport.on('error', (err) => { errors.push(err) })
  transport.on('frame', (frame) => { frames.push(frame) })
  const origSendRaw = transport.sendRaw.bind(transport)
  transport.sendRaw = function (type, data) { sentRaw.push({ type, data }); return origSendRaw(type, data) }
  // Feed a cleartext bot/create frame — no e2e marker → wasEncrypted stays false
  transport.handleFrame({ id: 'f-test', t: HUB_TO_NODE.BOT_CREATE, d: { nodeId: 'n', requestId: 'r', name: 'A' } })
  assert.ok(errors.length >= 1, `expected error event, got ${errors.length}`)
  assert.ok(frames.length === 0, `expected NO frame event, got ${frames.length}`)
  const errFrame = sentRaw.find((s) => s.type === NODE_TO_HUB.ERROR)
  assert.ok(errFrame, 'expected sendRaw with ERROR frame containing e2e-required')
  assert.equal(errFrame.data.code, 'e2e-required', `expected code e2e-required, got ${errFrame.data.code}`)
  assert.ok(errFrame.data.message.includes('bot/create'), 'error message should mention bot/create')
})

// remote-agent:node-policy is provided to ctx with roots from config (knife: delete provide → test red)
test('startWorker provides remote-agent:node-policy with roots to ctx', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-node-policy-'))
  const provided = {}
  const fakeCtx = {
    effect: (fn) => { fn() },
    provide: (name, val) => { provided[name] = val },
    get: () => undefined,
  }
  const dispose = applyWorker(fakeCtx, {
    hubUrl: 'ws://127.0.0.1:1',
    token: 'tk',
    nodeId: 'n1',
    roots: [dir],
    stateDir: dir,
  })
  // Cordis effect() runs synchronously; provide() is called during startWorker
  assert.ok('remote-agent:node-policy' in provided, 'remote-agent:node-policy must be provided to ctx')
  const policy = provided['remote-agent:node-policy']
  assert.ok(policy && Array.isArray(policy.roots), 'policy.roots must be an array')
  assert.ok(policy.roots.includes(dir), `policy.roots should include configured root ${dir}`)
  if (typeof dispose === 'function') dispose()
  else if (typeof dispose?.dispose === 'function') dispose.dispose()
})
