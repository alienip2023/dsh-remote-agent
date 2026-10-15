/**
 * 配对码（lib/pairing.js）回归：
 *
 *   - encode/decode 往返：字段一个不丢
 *   - decode 容错矩阵：空白/换行/引号/大小写 scheme；垃圾输入一律结构化报错（永不抛）
 *   - expandPairConfig：展开矩阵 + 显式配置优先 + 失败原样返回
 *   - doctorChecks / buildWorkerYaml / startWorker 的 pair 接线
 *
 * 配对码含 token（等同凭证），所以 decode 的每一类坏输入都必须给出
 * "人话修法"而不是抛异常 —— 抛到 worker 启动路径会让副机 dsh 起不来。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodePairCode, decodePairCode, expandPairConfig, PAIR_SCHEME } from '../lib/pairing.js'
import { buildWorkerYaml, doctorChecks } from '../lib/setup.js'
import { applyWorker } from '../lib/node/index.js'

/* ══════════════════ encode ══════════════════ */

test('encodePairCode：dshra1:// 前缀 + base64url 字符集（可安全进 YAML）', () => {
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', token: 'nt_abc', nodeId: 'slave-pc' })
  assert.ok(code.startsWith(PAIR_SCHEME))
  const b64 = code.slice(PAIR_SCHEME.length)
  assert.match(b64, /^[A-Za-z0-9_-]+$/)
})

test('encodePairCode：没有任何地址 → 返回空串（无法构成有效配对码）', () => {
  assert.equal(encodePairCode({}), '')
  assert.equal(encodePairCode({ token: 'nt_x' }), '')
})

test('encodePairCode：nodeId 非法就不放进载荷（防止经配对码注入坏 id）', () => {
  const dec = decodePairCode(encodePairCode({ hubUrl: 'ws://h:1/x', nodeId: 'has space!!' }))
  assert.ok(dec.ok)
  assert.equal(dec.payload.nodeId, undefined)
})

/* ══════════════════ decode：往返与容错 ══════════════════ */

test('decodePairCode：往返后字段一个不丢', () => {
  const want = { hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', token: 'nt_abc', nodeId: 'slave-pc' }
  const dec = decodePairCode(encodePairCode(want))
  assert.ok(dec.ok, dec.ok ? '' : dec.error)
  assert.equal(dec.payload.v, 1)
  assert.equal(dec.payload.hubUrl, want.hubUrl)
  assert.equal(dec.payload.token, want.token)
  assert.equal(dec.payload.nodeId, want.nodeId)
})

test('decodePairCode：中间换行 / 成对引号 / 首尾空白 都能容错（终端复制形态）', () => {
  const code = encodePairCode({ hubUrl: 'ws://h/x', token: 'nt_t' })
  for (const variant of [
    `  ${code}  `,
    `'${code}'`,
    `"${code}"`,
    code.slice(0, 20) + '\n' + code.slice(20),
  ]) {
    const dec = decodePairCode(variant)
    assert.ok(dec.ok, `variant failed: ${dec.ok ? '' : dec.error}`)
    assert.equal(dec.payload.hubUrl, 'ws://h/x')
    assert.equal(dec.payload.token, 'nt_t')
  }
})

test('decodePairCode：relay 载荷往返（transportMode=relay + relayUrl）', () => {
  const code = encodePairCode({ relayUrl: 'ws://relay.example:9090', token: 'nt_r' })
  const dec = decodePairCode(code)
  assert.ok(dec.ok, dec.ok ? '' : dec.error)
  assert.equal(dec.payload.transportMode, 'relay')
  assert.equal(dec.payload.relayUrl, 'ws://relay.example:9090')
  assert.equal(dec.payload.hubUrl, undefined)
})

test('decodePairCode：坏输入矩阵 —— 全部结构化报错且带人话，永不抛', () => {
  const cases = [
    ['', /为空/],
    ['   ', /为空/],
    ['not-a-pair-code', /不是配对码/],
    ['https://example.com', /不是配对码/],
    [`${PAIR_SCHEME}`, /内容不完整/],
    [`${PAIR_SCHEME}!!!bad!!!`, /内容不完整/],
    [`${PAIR_SCHEME}${Buffer.from('{"v":1}', 'utf8').toString('base64url')}`, /没有主机地址/], // 缺 hubUrl
    [`${PAIR_SCHEME}${Buffer.from('{"v":2,"hubUrl":"ws://h"}', 'utf8').toString('base64url')}`, /版本不受支持/],
    [`${PAIR_SCHEME}${Buffer.from('garbage-not-json', 'utf8').toString('base64url')}`, /解析不了|载荷/],
    [`${PAIR_SCHEME}${Buffer.from('"a string"', 'utf8').toString('base64url')}`, /载荷/],
    [`${PAIR_SCHEME}${Buffer.from('{"v":1,"hubUrl":"ws://h","nodeId":"中文 id"}', 'utf8').toString('base64url')}`, /nodeId 不合法/],
  ]
  for (const [input, re] of cases) {
    const dec = decodePairCode(input)
    assert.equal(dec.ok, false, `input should fail: ${JSON.stringify(input)}`)
    assert.match(dec.error, re)
    // 人话修法：报错必须能直接展示给小白（非空、无堆栈）
    assert.ok(dec.error.length > 5 && !dec.error.includes('at '))
  }
})

test('decodePairCode：超长输入 → 明确报错而不是傻解析', () => {
  const dec = decodePairCode(`${PAIR_SCHEME}${'A'.repeat(5000)}`)
  assert.equal(dec.ok, false)
  assert.match(dec.error, /过长/)
})

/* ══════════════════ expandPairConfig ══════════════════ */

test('expandPairConfig：pair 展开成 hubUrl/token/nodeId/transportMode，并删掉 pair 键', () => {
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', token: 'nt_abc', nodeId: 'slave-pc' })
  const { config, error } = expandPairConfig({ pair: code, roots: ['D:\\work'] })
  assert.equal(error, '')
  assert.equal(config.hubUrl, 'ws://192.168.1.10:19387/api/remote-agent/node')
  assert.equal(config.token, 'nt_abc')
  assert.equal(config.nodeId, 'slave-pc')
  assert.equal(config.transportMode, 'direct')
  assert.equal(config.roots?.[0], 'D:\\work')
  assert.equal(config.pair, undefined, 'pair 展开后必须删掉（token 不存两份）')
})

test('expandPairConfig：显式配置优先 —— 手写的 hubUrl/token 不被配对码覆盖', () => {
  const code = encodePairCode({ hubUrl: 'ws://from-pair:1/x', token: 'nt_pair', nodeId: 'from-pair' })
  const { config, error } = expandPairConfig({ pair: code, hubUrl: 'ws://explicit:2/y', token: 'nt_explicit' })
  assert.equal(error, '')
  assert.equal(config.hubUrl, 'ws://explicit:2/y')
  assert.equal(config.token, 'nt_explicit')
  assert.equal(config.nodeId, 'from-pair', '未显式配置的字段仍由配对码补齐')
})

test('expandPairConfig：relay 载荷展开成 transportMode=relay + relayUrl', () => {
  const code = encodePairCode({ relayUrl: 'ws://relay:9090', token: 'nt_r' })
  const { config, error } = expandPairConfig({ pair: code })
  assert.equal(error, '')
  assert.equal(config.transportMode, 'relay')
  assert.equal(config.relayUrl, 'ws://relay:9090')
})

test('expandPairConfig：坏 pair 原样返回 config + error（永不抛、不半展开）', () => {
  const original = { pair: 'dshra1://not-valid', hubUrl: 'ws://keep:1/x', roots: ['D:\\w'] }
  const { config, error } = expandPairConfig(original)
  assert.ok(error.length > 5)
  assert.equal(config.hubUrl, 'ws://keep:1/x')
  assert.equal(config.pair, 'dshra1://not-valid', '无效时保持原样，调用方决定怎么降级')
})

test('expandPairConfig：无 pair / null / undefined → 原样返回且 error 为空', () => {
  assert.equal(expandPairConfig({ hubUrl: 'ws://h' }).error, '')
  assert.equal(expandPairConfig({ hubUrl: 'ws://h' }).config.hubUrl, 'ws://h')
  assert.equal(expandPairConfig(null).error, '')
  assert.deepEqual(expandPairConfig(undefined).config, {})
  // 空串 pair 视为没配
  assert.equal(expandPairConfig({ pair: '   ' }).error, '')
})

/* ══════════════════ 接线：doctor / YAML 生成 / worker 启动 ══════════════════ */

test('doctorChecks（worker）：只有 pair 没有 hubUrl —— 不再报缺 hubUrl，且配对码检查绿', () => {
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', token: 'nt_abc' })
  const checks = doctorChecks({ role: 'worker', config: { role: 'worker', pair: code } })
  const noHub = checks.find((c) => !c.ok && c.label.includes('hubUrl'))
  assert.equal(noHub, undefined, 'pair 展开后不应再报缺 hubUrl')
  const pairCheck = checks.find((c) => c.label.includes('配对码'))
  assert.ok(pairCheck && pairCheck.ok)
})

test('doctorChecks（worker）：坏 pair → 配对码检查红且带修法（其余检查照常）', () => {
  const checks = doctorChecks({ role: 'worker', config: { role: 'worker', pair: 'dshra1://broken' } })
  const pairCheck = checks.find((c) => !c.ok && c.label.includes('配对码'))
  assert.ok(pairCheck, '坏 pair 必须有一条红检查')
  assert.ok(pairCheck.fix.length > 5)
})

test('buildWorkerYaml：pair 模式输出 pair 一行，且不再出现 hubUrl/token', () => {
  const code = encodePairCode({ hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node', token: 'nt_abc' })
  const yaml = buildWorkerYaml({ pair: code, nodeId: 'slave-pc', roots: ['D:\\work'] })
  assert.match(yaml, /inject:\s*\[\]/, 'pair 模式同样必须自带 inject: []')
  assert.match(yaml, /pair:\s*dshra1:\/\//, 'base64url 字符集 YAML 安全，无需引号')
  assert.ok(!/hubUrl:/.test(yaml))
  assert.ok(!/token:/.test(yaml))
  assert.match(yaml, /- D:\\work/)
})

test('applyWorker：pair 无效只降级不炸（返回可用 disposer，且走的是降级警告路径）', () => {
  const warnings = []
  const dispose = applyWorker(
    {
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} },
      on: () => () => {},
      get: () => undefined,
    },
    { pair: 'dshra1://broken', hubUrl: '' },
  )
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.ok(warnings.some((w) => w.includes('配对码')), '无效 pair 必须有一条人话警告')
})
