/**
 * 协议层单元测试（lib/protocol.js，冻结层，只测不改）。
 *
 * 覆盖：
 *   - envelope / encodeFrame / decodeFrame 往返
 *   - decodeFrame 对畸形 JSON / 缺 t / 版本不符分别返回正确的 error
 *   - validateHello 拒绝非法 nodeId、非法 os、协议不符，接受合法输入
 *   - validateTaskStart 默认值填充（mode 默认 agent、timeoutMs 默认 1h）
 *   - encodeBinaryFrame / decodeBinaryFrame 往返，截断输入返回 ok:false 而不抛
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIFACT_CHUNK_BYTES,
  ERROR_CODE,
  PROTOCOL_VERSION,
  TASK_MODE,
  decodeBinaryFrame,
  decodeFrame,
  encodeBinaryFrame,
  encodeFrame,
  envelope,
  newId,
  newPullId,
  newTaskId,
  validateHello,
  validateTaskStart,
} from '../lib/protocol.js'

/* ─────────────────────────── envelope / frame ─────────────────────────── */

test('envelope → encodeFrame → decodeFrame 往返一致', () => {
  const frame = envelope('task/start', { taskId: 't-1', goal: 'hi' })
  assert.equal(frame.v, PROTOCOL_VERSION)
  assert.equal(frame.t, 'task/start')
  assert.equal(typeof frame.id, 'string')
  assert.ok(frame.id.length > 0)
  assert.deepEqual(frame.d, { taskId: 't-1', goal: 'hi' })

  const raw = encodeFrame(frame)
  assert.equal(typeof raw, 'string')

  const dec = decodeFrame(raw)
  assert.equal(dec.ok, true)
  assert.deepEqual(dec.frame, frame)

  // Buffer 输入同样可解（传输层收到的是 Buffer）
  const dec2 = decodeFrame(Buffer.from(raw, 'utf8'))
  assert.equal(dec2.ok, true)
  assert.deepEqual(dec2.frame, frame)
})

test('envelope：缺省 d 收敛成 {}，replyTo 只在该出现时出现', () => {
  const a = envelope('ping')
  assert.deepEqual(a.d, {})
  assert.equal('r' in a, false)

  const b = envelope('pong', { echo: 'm-1' }, { replyTo: 'm-0' })
  assert.equal(b.r, 'm-0')
  assert.deepEqual(b.d, { echo: 'm-1' })

  const c = envelope('x', undefined, { id: 'fixed-id' })
  assert.equal(c.id, 'fixed-id')
})

test('newId / newTaskId / newPullId 形状稳定且不重复', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i += 1) ids.add(newId('x'))
  assert.equal(ids.size, 200)
  assert.match(newTaskId(), /^t-/)
  assert.match(newPullId(), /^p-/)
})

/* ─────────────────────────── decodeFrame 负例 ─────────────────────────── */

test('decodeFrame：畸形 JSON → malformed-json', () => {
  for (const bad of ['{not json', '', 'undefined', '[1,2', '\u0000\u0001']) {
    const dec = decodeFrame(bad)
    assert.equal(dec.ok, false, `input=${JSON.stringify(bad)}`)
    assert.equal(dec.error, 'malformed-json', `input=${JSON.stringify(bad)}`)
  }
})

test('decodeFrame：合法 JSON 但非对象 → malformed-envelope', () => {
  for (const bad of ['null', '42', '"str"', 'true', '[{"t":"x","v":1}]']) {
    const dec = decodeFrame(bad)
    assert.equal(dec.ok, false, `input=${bad}`)
    assert.equal(dec.error, 'malformed-envelope', `input=${bad}`)
  }
})

test('decodeFrame：缺 t / t 非字符串 / t 为空 → missing-type', () => {
  const cases = [
    { v: PROTOCOL_VERSION },
    { v: PROTOCOL_VERSION, t: 5 },
    { v: PROTOCOL_VERSION, t: '' },
    { v: PROTOCOL_VERSION, t: null },
    { v: PROTOCOL_VERSION, d: {} },
  ]
  for (const c of cases) {
    const dec = decodeFrame(JSON.stringify(c))
    assert.equal(dec.ok, false, JSON.stringify(c))
    assert.equal(dec.error, 'missing-type', JSON.stringify(c))
  }
})

test('decodeFrame：版本不符 → protocol-mismatch', () => {
  for (const v of [0, 2, 99, '1', null, undefined]) {
    const dec = decodeFrame(JSON.stringify({ v, t: 'ping', d: {} }))
    assert.equal(dec.ok, false, `v=${String(v)}`)
    assert.equal(dec.error, ERROR_CODE.PROTOCOL_MISMATCH, `v=${String(v)}`)
    assert.equal(dec.error, 'protocol-mismatch')
  }
})

test('decodeFrame：校验顺序 —— 先 JSON、再 t、最后版本', () => {
  // 既缺 t 又版本错 → 报 missing-type（t 在前）
  const dec = decodeFrame(JSON.stringify({ v: 999 }))
  assert.equal(dec.ok, false)
  assert.equal(dec.error, 'missing-type')
})

/* ─────────────────────────── validateHello ─────────────────────────── */

const VALID_HELLO = {
  nodeId: 'node-01',
  protocol: PROTOCOL_VERSION,
  os: 'windows',
  arch: 'x64',
  hostname: 'DESKTOP-ABC',
  dshVersion: '0.1.0',
  shells: ['pwsh', 'powershell'],
  roots: ['D:\\work'],
  caps: ['fs', 'exec', 'artifact', 'agent'],
  profile: 'worker',
  agentMode: true,
  // P2-11：连接级挑战随机数。缺失时归一化成 ''（旧版副机兼容路径）。
  nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  time: 1700000000000,
}

test('validateHello：接受合法输入并原样归一化', () => {
  const v = validateHello(VALID_HELLO)
  assert.equal(v.ok, true)
  assert.deepEqual(v.hello, VALID_HELLO)

  for (const os of ['windows', 'linux', 'darwin']) {
    const r = validateHello({ ...VALID_HELLO, os })
    assert.equal(r.ok, true, os)
    assert.equal(r.hello.os, os)
  }
})

test('validateHello：拒绝非法 nodeId', () => {
  const bad = [
    '',
    '-leading-dash',
    '.dot-start',
    '_under-start',
    'has space',
    '中文主机名',
    'a/b',
    'a\\b',
    'a'.repeat(65),
    null,
    42,
    undefined,
  ]
  for (const nodeId of bad) {
    const r = validateHello({ ...VALID_HELLO, nodeId })
    assert.equal(r.ok, false, `nodeId=${JSON.stringify(nodeId)}`)
    assert.equal(r.error, 'hello-nodeId-invalid', `nodeId=${JSON.stringify(nodeId)}`)
  }
  // 64 位合法，65 位非法 —— 边界
  assert.equal(validateHello({ ...VALID_HELLO, nodeId: 'a'.repeat(64) }).ok, true)
  assert.equal(validateHello({ ...VALID_HELLO, nodeId: 'a'.repeat(65) }).ok, false)
})

test('validateHello：拒绝非法 os', () => {
  for (const os of ['win32', 'Windows', 'freebsd', '', null, 42, undefined]) {
    const r = validateHello({ ...VALID_HELLO, os })
    assert.equal(r.ok, false, `os=${String(os)}`)
    assert.equal(r.error, 'hello-os-invalid', `os=${String(os)}`)
  }
})

test('validateHello：协议不符 → protocol-mismatch', () => {
  for (const protocol of [0, 2, '1', null, undefined]) {
    const r = validateHello({ ...VALID_HELLO, protocol })
    assert.equal(r.ok, false, `protocol=${String(protocol)}`)
    assert.equal(r.error, ERROR_CODE.PROTOCOL_MISMATCH)
  }
})

test('validateHello：d 缺失 / 非对象 → hello-missing', () => {
  for (const d of [undefined, null, 'str', 42]) {
    const r = validateHello(d)
    assert.equal(r.ok, false, String(d))
    assert.equal(r.error, 'hello-missing', String(d))
  }
  // 数组是 typeof 'object'，不会被 hello-missing 拦下（走 nodeId 校验后被拒）。
  // 最终结果同样是拒绝，只是 error 码不同 —— 记作低危不一致（见任务结果 D2）。
  assert.equal(validateHello([]).ok, false)
  assert.equal(validateHello([]).error, 'hello-nodeId-invalid')
})

test('validateHello：可选字段缺失时给出安全默认值，不抛', () => {
  const r = validateHello({ nodeId: 'n1', protocol: PROTOCOL_VERSION, os: 'linux' })
  assert.equal(r.ok, true)
  assert.equal(r.hello.arch, 'unknown')
  assert.equal(r.hello.hostname, 'n1')
  assert.equal(r.hello.dshVersion, '')
  assert.deepEqual(r.hello.shells, [])
  assert.deepEqual(r.hello.roots, [])
  assert.deepEqual(r.hello.caps, [])
  assert.equal(r.hello.profile, '')
  assert.equal(r.hello.agentMode, false)
  assert.equal(typeof r.hello.time, 'number')
})

test('validateHello：数组里的非字符串项被过滤', () => {
  const r = validateHello({
    ...VALID_HELLO,
    shells: ['pwsh', 42, null, 'powershell'],
    roots: ['D:\\work', {}, 'E:\\w'],
    caps: ['fs', false, 'exec'],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.hello.shells, ['pwsh', 'powershell'])
  assert.deepEqual(r.hello.roots, ['D:\\work', 'E:\\w'])
  assert.deepEqual(r.hello.caps, ['fs', 'exec'])
})

/* ─────────────────────────── validateTaskStart ─────────────────────────── */

test('validateTaskStart：默认值填充正确（mode=agent、timeoutMs=1h）', () => {
  const v = validateTaskStart({ taskId: 't-1', goal: 'do something' })
  assert.equal(v.ok, true)
  const s = v.spec

  assert.equal(s.taskId, 't-1')
  assert.equal(s.goal, 'do something')
  assert.equal(s.mode, TASK_MODE.AGENT)
  assert.equal(s.mode, 'agent')
  assert.equal(s.workspace, undefined)
  assert.equal(s.constraints.timeoutMs, 60 * 60 * 1000)
  assert.equal(s.constraints.timeoutMs, 3_600_000)
  assert.equal(s.constraints.maxBytesWritten, 2 * 1024 * 1024 * 1024)
  assert.equal(s.constraints.allowNetwork, true)
  assert.deepEqual(s.constraints.denyPaths, [])
  assert.deepEqual(s.constraints.extraEnv, {})
  assert.deepEqual(s.outputs, [])
  assert.equal(s.artifactRules, undefined)
  assert.equal(s.summaryPolicy, 'on-complete')
  assert.equal(typeof s.requestedAt, 'number')
  assert.equal(s.origin, 'hub')
})

test('validateTaskStart：显式值优先于默认值', () => {
  const v = validateTaskStart({
    taskId: 't-2',
    goal: 'x',
    workspace: 'D:\\work',
    mode: 'exec',
    outputs: ['dist/**', 42, 'report.md'],
    summaryPolicy: 'stream',
    origin: 'cli',
    artifactRules: { final: ['dist/**'] },
    constraints: {
      timeoutMs: 5000,
      maxBytesWritten: 1024,
      allowNetwork: false,
      denyPaths: ['D:\\secret', 7],
      extraEnv: { FOO: 'bar' },
    },
  })
  assert.equal(v.ok, true)
  const s = v.spec
  assert.equal(s.mode, 'exec')
  assert.equal(s.workspace, 'D:\\work')
  assert.deepEqual(s.outputs, ['dist/**', 'report.md'])
  assert.equal(s.summaryPolicy, 'stream')
  assert.equal(s.origin, 'cli')
  assert.deepEqual(s.artifactRules, { final: ['dist/**'] })
  assert.equal(s.constraints.timeoutMs, 5000)
  assert.equal(s.constraints.maxBytesWritten, 1024)
  assert.equal(s.constraints.allowNetwork, false)
  assert.deepEqual(s.constraints.denyPaths, ['D:\\secret'])
  assert.deepEqual(s.constraints.extraEnv, { FOO: 'bar' })
})

test('validateTaskStart：timeoutMs 有下限 1000ms，非法值回落默认', () => {
  assert.equal(validateTaskStart({ taskId: 't', goal: 'g', constraints: { timeoutMs: 1 } }).spec.constraints.timeoutMs, 1000)
  assert.equal(validateTaskStart({ taskId: 't', goal: 'g', constraints: { timeoutMs: -5 } }).spec.constraints.timeoutMs, 1000)
  assert.equal(validateTaskStart({ taskId: 't', goal: 'g', constraints: { timeoutMs: 0 } }).spec.constraints.timeoutMs, 1000)
  assert.equal(
    validateTaskStart({ taskId: 't', goal: 'g', constraints: { timeoutMs: Number.NaN } }).spec.constraints.timeoutMs,
    3_600_000,
  )
  assert.equal(
    validateTaskStart({ taskId: 't', goal: 'g', constraints: { timeoutMs: Infinity } }).spec.constraints.timeoutMs,
    3_600_000,
  )
  assert.equal(validateTaskStart({ taskId: 't', goal: 'g', constraints: { timeoutMs: 1000 } }).spec.constraints.timeoutMs, 1000)
})

test('validateTaskStart：未知 mode 一律回落 agent', () => {
  for (const mode of ['AGENT', 'shell', '', null, 42, undefined, 'agent ']) {
    const v = validateTaskStart({ taskId: 't', goal: 'g', mode })
    assert.equal(v.ok, true, String(mode))
    assert.equal(v.spec.mode, 'agent', String(mode))
  }
})

test('validateTaskStart：缺 taskId / 缺 goal → 对应 error', () => {
  assert.deepEqual(validateTaskStart(undefined), { ok: false, error: 'task-missing' })
  assert.deepEqual(validateTaskStart(null), { ok: false, error: 'task-missing' })
  assert.deepEqual(validateTaskStart('x'), { ok: false, error: 'task-missing' })
  assert.deepEqual(validateTaskStart({ goal: 'g' }), { ok: false, error: 'task-taskId-missing' })
  assert.deepEqual(validateTaskStart({ taskId: '', goal: 'g' }), { ok: false, error: 'task-taskId-missing' })
  assert.deepEqual(validateTaskStart({ taskId: 5, goal: 'g' }), { ok: false, error: 'task-taskId-missing' })
  assert.deepEqual(validateTaskStart({ taskId: 't' }), { ok: false, error: 'task-goal-missing' })
  assert.deepEqual(validateTaskStart({ taskId: 't', goal: '   ' }), { ok: false, error: 'task-goal-missing' })
  assert.deepEqual(validateTaskStart({ taskId: 't', goal: 42 }), { ok: false, error: 'task-goal-missing' })
})

test('validateTaskStart：constraints 非对象时回落默认，不抛', () => {
  for (const constraints of [null, 'x', 42, []]) {
    const v = validateTaskStart({ taskId: 't', goal: 'g', constraints })
    assert.equal(v.ok, true, String(constraints))
    assert.equal(v.spec.constraints.timeoutMs, 3_600_000)
    assert.equal(v.spec.constraints.allowNetwork, true)
  }
})

/* ────────────────────── 二进制帧编解码 ────────────────────── */

test('encodeBinaryFrame / decodeBinaryFrame 往返一致', () => {
  const header = { v: 1, t: 'artifact/chunk', pullId: 'p-1', path: 'dist/app.exe', offset: 0, total: 3 }
  const payload = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80])
  const buf = encodeBinaryFrame(header, payload)

  assert.ok(Buffer.isBuffer(buf))
  assert.equal(buf.readUInt16BE(0), Buffer.byteLength(JSON.stringify(header), 'utf8'))
  assert.equal(buf.length, 2 + buf.readUInt16BE(0) + payload.length)

  const dec = decodeBinaryFrame(buf)
  assert.equal(dec.ok, true)
  assert.deepEqual(dec.header, header)
  assert.equal(Buffer.compare(dec.payload, payload), 0)
})

test('encodeBinaryFrame / decodeBinaryFrame：空净荷与 UTF-8 头部', () => {
  const header = { t: 'artifact/done', path: '报告.md', note: '中文头部' }
  const buf = encodeBinaryFrame(header, Buffer.alloc(0))
  const dec = decodeBinaryFrame(buf)
  assert.equal(dec.ok, true)
  assert.deepEqual(dec.header, header)
  assert.equal(dec.payload.length, 0)
})

test('encodeBinaryFrame / decodeBinaryFrame：大净荷（> 单帧上限）往返', () => {
  const payload = Buffer.alloc(ARTIFACT_CHUNK_BYTES, 0xab)
  const buf = encodeBinaryFrame({ t: 'artifact/chunk', pullId: 'p-big' }, payload)
  const dec = decodeBinaryFrame(buf)
  assert.equal(dec.ok, true)
  assert.equal(dec.payload.length, ARTIFACT_CHUNK_BYTES)
  assert.equal(dec.payload[0], 0xab)
  assert.equal(dec.payload[ARTIFACT_CHUNK_BYTES - 1], 0xab)
})

test('decodeBinaryFrame：截断输入返回 ok:false 而不抛', () => {
  const header = { t: 'artifact/chunk', pullId: 'p-1' }
  const payload = Buffer.from('hello world')
  const full = encodeBinaryFrame(header, payload)
  const headLen = full.readUInt16BE(0)

  const cases = [
    ['空 buffer', Buffer.alloc(0), 'binary-frame-too-short'],
    ['1 字节', Buffer.from([0x00]), 'binary-frame-too-short'],
    ['非 buffer', 'not a buffer', 'binary-frame-too-short'],
    ['null', null, 'binary-frame-too-short'],
    ['undefined', undefined, 'binary-frame-too-short'],
    ['头部长度超出实际', full.subarray(0, 2 + headLen - 1), 'binary-frame-header-truncated'],
    ['只有长度前缀', full.subarray(0, 2), 'binary-frame-header-truncated'],
  ]
  for (const [label, input, want] of cases) {
    let dec
    assert.doesNotThrow(() => {
      dec = decodeBinaryFrame(input)
    }, label)
    assert.equal(dec.ok, false, label)
    assert.equal(dec.error, want, label)
  }

  // 头部完整但净荷被截断：头部可解，净荷是实际收到的部分（不抛）
  const headerOnly = full.subarray(0, 2 + headLen + 3)
  const dec = decodeBinaryFrame(headerOnly)
  assert.equal(dec.ok, true)
  assert.deepEqual(dec.header, header)
  assert.equal(dec.payload.toString('utf8'), 'hel')
})

test('decodeBinaryFrame：头部 JSON 损坏 / 非对象 → 对应 error', () => {
  const malformed = Buffer.from(JSON.stringify({ t: 'x' }).replace('{', '['), 'utf8')
  const buf = Buffer.allocUnsafe(2 + malformed.length)
  buf.writeUInt16BE(malformed.length, 0)
  malformed.copy(buf, 2)
  const dec = decodeBinaryFrame(buf)
  assert.equal(dec.ok, false)
  assert.equal(dec.error, 'binary-frame-header-malformed')

  for (const body of ['"str"', '42', 'null']) {
    const head = Buffer.from(body, 'utf8')
    const b = Buffer.allocUnsafe(2 + head.length)
    b.writeUInt16BE(head.length, 0)
    head.copy(b, 2)
    const d = decodeBinaryFrame(b)
    assert.equal(d.ok, false, body)
    assert.equal(d.error, 'binary-frame-header-not-object', body)
  }
})

test('encodeBinaryFrame：头部过大时抛 RemoteAgentError', () => {
  const huge = { t: 'x', pad: 'a'.repeat(0x10000) }
  assert.throws(() => encodeBinaryFrame(huge, Buffer.alloc(0)), /binary frame header too large/)
})

/* ─────────────────────────── 常量自洽 ─────────────────────────── */

test('协议常量形状稳定', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(ARTIFACT_CHUNK_BYTES, 256 * 1024)
  assert.ok(Object.isFrozen(TASK_MODE))
  assert.equal(TASK_MODE.AGENT, 'agent')
  assert.equal(TASK_MODE.EXEC, 'exec')
})
