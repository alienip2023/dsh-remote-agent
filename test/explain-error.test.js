/**
 * 错误翻译层（`lib/explain-error.js`）测试。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（用户体验提升 ④，2026-10-20）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户反馈：**出了问题不知道原因**。而原始错误长这样：
 *
 *     connect ECONNREFUSED 100.86.48.54:19387
 *     handshake timeout: no welcome/accepted within 15000ms
 *     task t-xxx terminal: timeout after 40000ms
 *     HTTP 401 {"error":"unauthorized"}
 *
 * 本项目**已经**有一份 friendlyConnectError（lib/setup.js），但只覆盖 5 类
 * 网络错误，且没用到协议错误码。本模块统一到一处。
 *
 * ── 设计约束（逐条钉住）────────────────────────────────────────────────
 *
 *   · 每条都给"下一步做什么" —— 只说"连接失败"等于没说
 *   · 保留原始信息（raw）—— 翻译不能丢排查线索
 *   · 绝不抛：任何输入都返回结构
 *   · 不猜：拿不准的如实说"未知，请附原始错误"
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ERROR_CODE } from '../lib/protocol.js'
import { explainError, formatExplained } from '../lib/explain-error.js'

/** 断言一条翻译结果的基本质量。 */
function assertGood(t, label) {
  assert.ok(t && typeof t === 'object', `${label}: 应返回对象`)
  assert.ok(typeof t.title === 'string' && t.title !== '', `${label}: 必须有 title`)
  assert.ok(typeof t.hint === 'string' && t.hint !== '', `${label}: 必须有 hint（下一步做什么）`)
  assert.ok(typeof t.raw === 'string', `${label}: 必须有 raw（原始信息）`)
}

/* ═══════════════ 1. 网络层错误（errno）═══════════════ */

test('errno：ECONNREFUSED → 说明"没人监听" + 检查清单', () => {
  const t = explainError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 100.86.48.54:19387' }, { where: '100.86.48.54:19387' })
  assertGood(t, 'ECONNREFUSED')
  assert.match(t.title, /没有服务在监听/)
  assert.match(t.detail, /端口没程序在听/)
  assert.match(t.hint, /DSH 是否在跑/)
  assert.match(t.raw, /ECONNREFUSED/, 'raw 必须保留原始错误')
})

test('errno：ETIMEDOUT → 说明"网络不通" + Tailscale/防火墙提示', () => {
  const t = explainError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, { where: '100.72.146.73:19387' })
  assertGood(t, 'ETIMEDOUT')
  assert.match(t.title, /连不上（超时）/)
  assert.match(t.hint, /Tailscale|防火墙/)
})

test('errno：EADDRINUSE → 端口占用 + 查占用的命令', () => {
  const t = explainError({ code: 'EADDRINUSE', message: 'listen EADDRINUSE :19387' })
  assertGood(t, 'EADDRINUSE')
  assert.match(t.title, /端口已被占用/)
  assert.match(t.hint, /netstat|换一个端口/)
})

test('errno：ENOTFOUND → 建议写 IP 而不是主机名', () => {
  const t = explainError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND myhost' })
  assertGood(t, 'ENOTFOUND')
  assert.match(t.hint, /IP/)
})

test('errno：EADDRNOTAVAIL → 提示 IP 不属于本机', () => {
  const t = explainError({ code: 'EADDRNOTAVAIL', message: 'bind EADDRNOTAVAIL' })
  assertGood(t, 'EADDRNOTAVAIL')
  assert.match(t.detail, /不属于本机|网卡/)
})

/* ═══════════════ 2. 协议错误码（17 个全覆盖）═══════════════ */

test('协议码：所有 ERROR_CODE 都有翻译（不漏）', () => {
  const missing = []
  for (const [name, code] of Object.entries(ERROR_CODE)) {
    const t = explainError({ code, message: code })
    // 兜底也算"有翻译"，但标题不该是泛泛的"出错了"
    if (t.title === '出错了') missing.push(`${name}=${code}`)
  }
  assert.deepEqual(missing, [], `这些错误码没有专门翻译：${missing.join(', ')}`)
})

test('协议码：unauthorized → 教用户重新生成配对码', () => {
  const t = explainError({ code: ERROR_CODE.UNAUTHORIZED, message: 'unauthorized' })
  assertGood(t, 'unauthorized')
  assert.match(t.title, /鉴权失败/)
  assert.match(t.hint, /配对码|dshra1/)
})

test('协议码：protocol-mismatch → 提示两端版本不一致', () => {
  const t = explainError({ code: ERROR_CODE.PROTOCOL_MISMATCH, message: 'protocol mismatch' })
  assert.match(t.title, /版本不兼容/)
  assert.match(t.hint, /同一版本|升级/)
})

test('协议码：duplicate-node → 提示改节点 ID', () => {
  const t = explainError({ code: ERROR_CODE.DUPLICATE_NODE, message: 'duplicate' })
  assert.match(t.title, /节点 ID 重复/)
  assert.match(t.hint, /节点 ID/)
})

test('协议码：workspace-denied → 提示加进 roots', () => {
  const t = explainError({ code: ERROR_CODE.WORKSPACE_DENIED, message: 'denied' })
  assert.match(t.title, /工作区被拒绝/)
  assert.match(t.hint, /roots/)
})

test('协议码：从 message 里也能捞到错误码（不只靠 code 字段）', () => {
  // 很多地方只把 code 拼进文案，没有结构化字段
  const t = explainError({ message: 'task failed: workspace-denied (path outside roots)' })
  assert.match(t.title, /工作区被拒绝/, '应从文案里识别出 workspace-denied')
})

/* ═══════════════ 3. HTTP 状态码 ═══════════════ */

test('HTTP：401 → 提示刷新/检查来源', () => {
  const t = explainError({ message: 'HTTP 401' })
  assertGood(t, '401')
  assert.match(t.title, /鉴权失败/)
  assert.match(t.hint, /刷新/)
})

test('HTTP：404 → 提示"插件可能没加载"', () => {
  const t = explainError({ message: 'HTTP 404' })
  assert.match(t.title, /接口不存在/)
  assert.match(t.hint, /插件是否已安装|版本/)
})

test('HTTP：502/503/504 → 提示副机不可用', () => {
  for (const s of ['502', '503', '504']) {
    const t = explainError({ message: `HTTP ${s}` })
    assert.match(t.title, /副机暂时不可用/, `${s} 应识别为副机不可用`)
  }
})

/* ═══════════════ 4. 文案特征（无结构化的错误）═══════════════ */

test('文案：timeout after Nms → 换算成秒', () => {
  const t = explainError({ message: 'task t-abc terminal: timeout after 40000ms' })
  assert.match(t.title, /操作超时/)
  assert.match(t.detail, /40 秒/, '应把 40000ms 换算成 40 秒')
})

test('文案：handshake timeout → 提示版本差异', () => {
  const t = explainError({ message: 'handshake timeout: no welcome/accepted within 15000ms' })
  assert.match(t.title, /握手超时/)
  assert.match(t.hint, /版本|端口/)
})

/* ═══════════════ 5. 兜底与健壮性 ═══════════════ */

test('兜底：完全未知的错误也不编造原因', () => {
  const t = explainError(new Error('某个从没见过的错误'))
  assertGood(t, 'unknown')
  assert.match(t.detail, /某个从没见过的错误/, '应如实转述原始 message')
  assert.match(t.hint, /issue|原始错误/, '应引导用户附上原始错误')
})

test('健壮性：任何输入都不抛', () => {
  // ⚠ 注意最后一个用例：toString 会抛错。
  // 断言消息里**不能写 `String(v)`** —— 那会在构造消息时自己先抛
  // （本测试第一版就踩了这个，误报成"实现抛错"）。
  const inputs = [
    null, undefined, '', 0, false, [], {}, new Error('x'),
    { code: null }, { message: null }, { code: 42, message: 42 },
    'plain string', { toString() { throw new Error('boom') } },
  ]
  for (let i = 0; i < inputs.length; i += 1) {
    const v = inputs[i]
    // 用下标标识用例，避免 String(v) 触发恶意 toString
    assert.doesNotThrow(() => explainError(v), `第 ${i} 个输入不该抛`)
    const t = explainError(v)
    assert.ok(typeof t.title === 'string' && t.title !== '', `第 ${i} 个输入要有 title`)
    assert.ok(typeof t.hint === 'string' && t.hint !== '', `第 ${i} 个输入要有 hint`)
  }
})

test('健壮性：context 参数会出现在兜底标题里', () => {
  const t = explainError(new Error('weird'), { context: '拉取产物' })
  assert.match(t.title, /拉取产物失败/)
})

/* ═══════════════ 6. 渲染 ═══════════════ */

test('formatExplained：输出 title + detail + hint 三行', () => {
  const t = explainError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED x:1' }, { where: 'x:1' })
  const text = formatExplained(t)
  assert.ok(text.includes(t.title), '应含 title')
  assert.ok(text.includes(t.detail), '应含 detail')
  assert.ok(text.includes('→'), '应含指向修法的箭头')
})
