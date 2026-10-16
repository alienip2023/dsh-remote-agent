/**
 * E2E 会话加密单测（提案 #1，lib/e2e.js）。
 *
 * 覆盖：密钥协商双方一致、黄金向量（固定 X25519/ed25519 密钥锁定字节）、
 * 交换帧签名与篡改检出、seal/open 往返、AAD 绑定（帧类型/id 漂移即拒）、
 * 序号语义（重放/跳跃即拒）、二进制帧整体封密、会话销毁。
 *
 * 黄金向量说明：X25519 / HKDF-SHA256 / AES-256-GCM / ed25519 全是标准化
 * 确定性算法，固定输入必得固定输出 —— 换 Node 版本向量不应漂移；
 * 漂移即实现变更，测试必须红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  E2E_CONTEXT,
  E2E_MARKER,
  createSession,
  deriveSessionKey,
  generateEphemeral,
  normalizeE2EPub,
  signExchange,
  verifyExchange,
} from '../lib/e2e.js'
import { fingerprintOf } from '../lib/identity.js'

/* ── 黄金向量（生成方式见 lib/e2e.js 注释；换实现必须显式重锚） ── */
const GOLDEN = {
  nodePriv: '0JgDMuJaCT0YqN6CEM5pBGtkO8vBe3AHuOoI7XioSE8',
  nodePub: 'BxjvY98VlAYNd0vKFBFJ_eEMPvfd7OfLnL0Yq5xdQVo',
  hubPriv: 'ALM9mWt-x34zZoyCJ3vFW5SmafbBI3IN1n4ASVgH_Ho',
  hubPub: 'EZYVwLi8F6DEict7m1r-FhT44EhDwdndw8m7AU-e-R4',
  keyHex: 'f233de5a7e8525d85973683b8fc95af17f760038099125ec5fd020473ae6f202',
  idPriv: 'MC4CAQAwBQYDK2VwBCIEIHbkc4MgYaPibpsXQDi3XQyDo7EfSUkuzebYKlhLJyvF',
  idPub: 'MCowBQYDK2VwAyEAeMfcJ88f71u5jHuWM0GvguJq1ZuwuQpEjDJ1FMSacOw',
  sig: 'mA9GaflHhevzNPdwU9IYHY3F9ssG-hKNDbTRvfOt-xCSVEY9huUkViDhFmrFR_CPgDR6F89WhEI7BpZh69moAg',
}
const GOLDEN_EXCHANGE_FIELDS = {
  fingerprint: fingerprintOf(Buffer.from(GOLDEN.idPub, 'base64url')),
  nodeId: 'test-worker',
  nonce: 'aabbccdd00112233',
  pub: GOLDEN.hubPub,
  peerPub: GOLDEN.nodePub,
  at: 1700000000000,
}

/** 造一对角色就绪的会话（随机密钥）。 */
function makeSessions() {
  const n = generateEphemeral()
  const h = generateEphemeral()
  const sN = createSession({ role: 'node', ownPrivB64: n.privateKeyB64, peerPubB64: h.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 })
  const sH = createSession({ role: 'hub', ownPrivB64: h.privateKeyB64, peerPubB64: n.publicKeyB64, nodePubB64: n.publicKeyB64, hubPubB64: h.publicKeyB64 })
  return { n, h, sN, sH }
}

/* ─────────────────────────── 密钥协商 ─────────────────────────── */

test('generateEphemeral：43 字符 base64url 公钥，两次生成互不相同', () => {
  const a = generateEphemeral()
  const b = generateEphemeral()
  assert.match(a.publicKeyB64, /^[A-Za-z0-9_-]{43}$/)
  assert.match(a.privateKeyB64, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a.publicKeyB64, b.publicKeyB64)
  assert.notEqual(a.privateKeyB64, b.privateKeyB64)
  assert.equal(Buffer.from(a.publicKeyB64, 'base64url').length, 32)
})

test('normalizeE2EPub：合法放行，长度/字符集/字节数不对一律空串', () => {
  assert.equal(normalizeE2EPub(GOLDEN.nodePub), GOLDEN.nodePub)
  assert.equal(normalizeE2EPub('short'), '')
  // 形态校验只管结构：43 个合法字符 = 32 字节，内容是不是弱密钥不归它管
  assert.equal(normalizeE2EPub('x'.repeat(43)), 'x'.repeat(43))
  assert.equal(normalizeE2EPub('!!!invalid!!!'), '')
  assert.equal(normalizeE2EPub(42), '')
  assert.equal(normalizeE2EPub(undefined), '')
  // 44 字符（带填充）不收 —— 线上形态固定为无填充
  assert.equal(normalizeE2EPub(GOLDEN.nodePub + '='), '')
})

test('黄金向量：固定 X25519 密钥对的 ECDH+HKDF 会话密钥逐字节锁定', () => {
  const { key } = deriveSessionKey({
    role: 'node',
    ownPrivB64: GOLDEN.nodePriv,
    peerPubB64: GOLDEN.hubPub,
    nodePubB64: GOLDEN.nodePub,
    hubPubB64: GOLDEN.hubPub,
  })
  assert.equal(key.toString('hex'), GOLDEN.keyHex)
  // hub 侧从对侧推导，得到同一把
  const { key: hubKey } = deriveSessionKey({
    role: 'hub',
    ownPrivB64: GOLDEN.hubPriv,
    peerPubB64: GOLDEN.nodePub,
    nodePubB64: GOLDEN.nodePub,
    hubPubB64: GOLDEN.hubPub,
  })
  assert.equal(hubKey.toString('hex'), GOLDEN.keyHex)
})

test('密钥协商：双方派生同一把密钥，文本帧 seal/open 往返一致', () => {
  const { sN, sH } = makeSessions()
  const data = { nodeId: 'n1', goal: '任务目标·机密内容', tasks: [{ a: 1 }] }
  const env = sN.sealFrame('task/sync', 'm-abc', data)
  assert.equal(env.e2e, E2E_MARKER)
  assert.equal(typeof env.seq, 'number')
  assert.match(env.iv, /^[A-Za-z0-9_-]+$/)
  assert.ok(!JSON.stringify(env).includes('机密内容'), '密文里不得出现明文片段')
  const back = sH.openFrame('task/sync', 'm-abc', env)
  assert.deepEqual(back, data)
  // 反方向同样成立
  const env2 = sH.sealFrame('task/start', 'm-2', { taskId: 't-1' })
  assert.deepEqual(sN.openFrame('task/start', 'm-2', env2), { taskId: 't-1' })
})

test('黄金向量：交换帧签名（固定 ed25519 身份）逐字节锁定且验签通过', () => {
  assert.equal(verifyExchange(GOLDEN.idPub, GOLDEN_EXCHANGE_FIELDS, GOLDEN.sig), true)
  const fp = fingerprintOf(Buffer.from(GOLDEN.idPub, 'base64url'))
  assert.equal(GOLDEN_EXCHANGE_FIELDS.fingerprint, fp)
  // 用身份私钥重签 —— ed25519 确定性签名，必须得到同一个 sig
  const again = signExchange(GOLDEN.idPriv, GOLDEN_EXCHANGE_FIELDS)
  assert.equal(again, GOLDEN.sig)
})

test('交换帧签名：任一字段被篡改都验不过', () => {
  const base = { ...GOLDEN_EXCHANGE_FIELDS }
  assert.equal(verifyExchange(GOLDEN.idPub, base, GOLDEN.sig), true)
  // peerPub 换成另一把（中继偷换副机公钥的攻击形态）
  assert.equal(verifyExchange(GOLDEN.idPub, { ...base, peerPub: GOLDEN.hubPub }, GOLDEN.sig), false)
  // pub 换掉（中继偷换 hub 公钥）
  assert.equal(verifyExchange(GOLDEN.idPub, { ...base, pub: GOLDEN.nodePub }, GOLDEN.sig), false)
  // nonce 换掉（重放旧连接的 ack）
  assert.equal(verifyExchange(GOLDEN.idPub, { ...base, nonce: 'deadbeefdeadbeef' }, GOLDEN.sig), false)
  // nodeId / at / fingerprint 任意漂移同样失败
  assert.equal(verifyExchange(GOLDEN.idPub, { ...base, nodeId: 'other' }, GOLDEN.sig), false)
  assert.equal(verifyExchange(GOLDEN.idPub, { ...base, at: base.at + 1 }, GOLDEN.sig), false)
  // 验签锚（hub 身份公钥）不是签名的那个
  const other = generateEphemeral()
  assert.equal(verifyExchange(other.publicKeyB64, base, GOLDEN.sig), false)
  // 签名本体损坏
  assert.equal(verifyExchange(GOLDEN.idPub, base, GOLDEN.sig.slice(0, -2) + 'AA'), false)
  assert.equal(verifyExchange(GOLDEN.idPub, base, ''), false)
  assert.equal(verifyExchange('', base, GOLDEN.sig), false)
})

/* ─────────────────────────── 文本帧 seal/open ─────────────────────────── */

test('sealFrame/openFrame：篡改 iv / ct 任一即认证失败', () => {
  const { sN, sH } = makeSessions()
  const env = sN.sealFrame('task/sync', 'm-1', { secret: 'x'.repeat(100) })
  assert.throws(() => sH.openFrame('task/sync', 'm-1', { ...env, iv: env.iv.slice(0, -2) + 'AA' }))
  assert.throws(() => sH.openFrame('task/sync', 'm-1', { ...env, ct: env.ct.slice(0, -4) + 'AAAA' }))
  // 标记值不对不算 e2e 帧
  assert.throws(() => sH.openFrame('task/sync', 'm-1', { ...env, e2e: 99 }))
  // 好帧仍然能开（前面失败没有吃掉序号）
  const env2 = sN.sealFrame('task/sync', 'm-2', { ok: true })
  assert.deepEqual(sH.openFrame('task/sync', 'm-2', env2), { ok: true })
})

test('AAD 绑定：帧类型 / 帧 id 漂移即拒（防密文挪用到别的帧上）', () => {
  const { sN, sH } = makeSessions()
  const env = sN.sealFrame('task/sync', 'm-1', { secret: 1 })
  // 用别的 type 解
  assert.throws(() => sH.openFrame('task/end', 'm-1', env))
  // 用别的 id 解
  assert.throws(() => sH.openFrame('task/sync', 'm-other', env))
})

test('序号语义：重放与跳跃都拒绝，严格递增才收', () => {
  const { sN, sH } = makeSessions()
  const e1 = sN.sealFrame('task/sync', 'm-1', { n: 1 })
  assert.deepEqual(sH.openFrame('task/sync', 'm-1', e1), { n: 1 })
  // 重放同一帧
  assert.throws(() => sH.openFrame('task/sync', 'm-1', e1))
  // 跳号（伪造 seq=99 的帧：签名没有，但 GCM 也不用密钥就能造序号 —— 序号在 AAD 里，
  // 造不出合法密文，这里直接测 open 的防御分支）
  assert.throws(() => sH.openFrame('task/sync', 'm-9', { e2e: E2E_MARKER, seq: 99, iv: e1.iv, ct: e1.ct }))
  // 顺序发后续帧都正常
  for (let i = 2; i <= 5; i += 1) {
    const e = sN.sealFrame('task/sync', `m-${i}`, { n: i })
    assert.deepEqual(sH.openFrame('task/sync', `m-${i}`, e), { n: i })
  }
})

test('二进制帧：内层 header/payload 完整往返，篡改即拒', () => {
  const { sN, sH } = makeSessions()
  const innerHeader = { t: 'artifact/chunk', pullId: 'p-1', offset: 0, sha256: 'ab'.repeat(32) }
  const innerPayload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x89, 0x50])
  const sealed = sN.sealBinary('artifact/chunk', innerHeader, innerPayload)
  assert.equal(sealed.header.t, 'artifact/chunk')
  assert.equal(sealed.header.e2e, E2E_MARKER)
  assert.ok(!JSON.stringify(sealed.header).includes('pullId'), '外层 header 不得带 pullId（中继可见）')
  const opened = sH.openBinary(sealed.header.t, sealed.header, sealed.payload)
  assert.deepEqual(opened.header, innerHeader)
  assert.equal(Buffer.compare(opened.payload, innerPayload), 0)
  // 篡改一个字节
  const bad = Buffer.from(sealed.payload)
  bad[0] ^= 0xff
  assert.throws(() => sH.openBinary(sealed.header.t, sealed.header, bad))
})

test('会话销毁：destroy 后 seal/open 一律抛错', () => {
  const { sN, sH } = makeSessions()
  sN.destroy()
  assert.throws(() => sN.sealFrame('task/sync', 'm-1', {}))
  const env = { e2e: E2E_MARKER, seq: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
  assert.throws(() => sH.openFrame('task/sync', 'm-1', env))
  sH.destroy()
  assert.throws(() => sH.openFrame('task/sync', 'm-1', env))
})

test('上下文前缀稳定：改 E2E_CONTEXT = 协议变更（锁定值）', () => {
  assert.equal(E2E_CONTEXT, 'dsh-remote-agent/relay-e2e/v1')
})
