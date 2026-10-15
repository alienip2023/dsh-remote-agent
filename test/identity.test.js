/**
 * hub 身份原语测试（P2-11）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 纪律（与 protocol-golden.test.js 同源）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. 黄金向量的期望值**独立计算**：指纹用 node:crypto 现场算 sha256，
 *     签名字节是 RFC 8032 确定性 ed25519 的输出 —— 换实现/换常量立刻红；
 *  2. 变异负向控制占一半篇幅：篡改签名/nonce/时间戳/nodeId/指纹、换一把
 *     钥匙验、坏 key 文件重建 —— 每一个"必须失败"的路径都有断言；
 *  3. 磁盘行为真写临时目录：创建→重读稳定→损坏重建→指纹改变，全链路。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  FINGERPRINT_PREFIX,
  IDENTITY_CONTEXT,
  fingerprintOf,
  generateIdentity,
  importIdentity,
  identitySignPayload,
  loadOrCreateHubIdentity,
  newNonce,
  normalizeFingerprint,
  readHubIdentity,
  signIdentity,
  verifyIdentity,
} from '../lib/identity.js'

/* ───────────────────────── 黄金向量（固定密钥，跨实现锚点） ───────────────────────── */

// 一次性生成后钉死在这里。ed25519 签名确定性（RFC 8032）→ 任何合规实现的
// 输出必须逐字节一致；改签名算法/载荷序列化/上下文前缀，这个值立刻漂移。
const VECTOR = {
  privateKeyB64: 'MC4CAQAwBQYDK2VwBCIEIEZMHmm_EJCE9QBhcQncsyiGMW23J51NiwXmjtd2Kd72',
  publicKeyB64: 'MCowBQYDK2VwAyEAex1jhl3ue5c-Lcd8eBnqC3SZUOBQXt-WpRnnVLxnx0w',
  fingerprint: 'hubfp1-ZKBSPB6tLRXi8EqTDeSRlA',
  nodeId: 'node-01',
  nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  at: 1700000000000,
  sig: 'C3rON7bxq3A_TVMVbIU9KUoqhAdLNgShDeHJ0RFVyANkg2EIcA7cEc2P2pdTwv98D-7fe-1tYtll5pgDyvcPDA',
}

test('黄金向量：指纹 = base64url(sha256(SPKI DER)[0:16])，独立复算', () => {
  // 期望值不经过被测代码：直接用 node:crypto 从公钥 DER 重算
  const der = Buffer.from(VECTOR.publicKeyB64, 'base64url')
  const expected =
    FINGERPRINT_PREFIX +
    createHash('sha256').update(der).digest().subarray(0, 16).toString('base64url')
  assert.equal(expected, VECTOR.fingerprint, '指纹派生规则锁定：sha256 前 16 字节 base64url')
  assert.equal(fingerprintOf(der), VECTOR.fingerprint, 'fingerprintOf 必须与独立复算一致')
  assert.equal(VECTOR.fingerprint.length, FINGERPRINT_PREFIX.length + 22, '指纹总长 29 字符')
})

test('黄金向量：签名字节逐字节锁定（确定性 ed25519）', () => {
  const sig = signIdentity(VECTOR.privateKeyB64, {
    fingerprint: VECTOR.fingerprint,
    nodeId: VECTOR.nodeId,
    nonce: VECTOR.nonce,
    at: VECTOR.at,
  })
  assert.equal(sig, VECTOR.sig, '签名字节必须与黄金向量一致（算法或序列化漂移即红）')
  assert.equal(
    verifyIdentity(VECTOR.publicKeyB64, {
      fingerprint: VECTOR.fingerprint,
      nodeId: VECTOR.nodeId,
      nonce: VECTOR.nonce,
      at: VECTOR.at,
    }, VECTOR.sig),
    true,
    '黄金签名必须能验过',
  )
})

test('黄金向量：签名载荷的规范化序列化锁定', () => {
  // 字段序/分隔符是契约：改一个字符，所有历史身份帧全部验不过
  const payload = identitySignPayload({
    fingerprint: VECTOR.fingerprint,
    nodeId: VECTOR.nodeId,
    nonce: VECTOR.nonce,
    at: VECTOR.at,
  })
  assert.equal(
    payload,
    [IDENTITY_CONTEXT, VECTOR.fingerprint, VECTOR.nodeId, VECTOR.nonce, String(VECTOR.at)].join('\n'),
    '载荷必须是指定顺序的换行分隔串',
  )
  // 缺字段不许抛：一律序列化成空段（验签自然失败，fail-closed）
  assert.equal(identitySignPayload({}), `${IDENTITY_CONTEXT}\n\n\n\n`)
})

/* ───────────────────────── 变异负向控制 ───────────────────────── */

test('负向：签名被篡改一个 base64url 字符 → 验不过', () => {
  const fields = { fingerprint: VECTOR.fingerprint, nodeId: VECTOR.nodeId, nonce: VECTOR.nonce, at: VECTOR.at }
  const flipped = VECTOR.sig.startsWith('A') ? `B${VECTOR.sig.slice(1)}` : `A${VECTOR.sig.slice(1)}`
  assert.equal(verifyIdentity(VECTOR.publicKeyB64, fields, flipped), false, '篡改签名必须拒绝')
})

test('负向：字段级篡改全部验不过（nonce/at/nodeId/fingerprint）', () => {
  const good = { fingerprint: VECTOR.fingerprint, nodeId: VECTOR.nodeId, nonce: VECTOR.nonce, at: VECTOR.at }
  const cases = [
    ['nonce 被换', { ...good, nonce: 'f'.repeat(32) }],
    ['at 被改', { ...good, at: VECTOR.at + 1 }],
    ['nodeId 被换', { ...good, nodeId: 'node-02' }],
    ['fingerprint 被换', { ...good, fingerprint: 'hubfp1-' + 'A'.repeat(22) }],
  ]
  for (const [name, tampered] of cases) {
    assert.equal(verifyIdentity(VECTOR.publicKeyB64, tampered, VECTOR.sig), false, `${name} 必须验不过`)
  }
})

test('负向：换一把钥匙验同一签名 → 验不过', () => {
  const other = generateIdentity()
  const fields = { fingerprint: VECTOR.fingerprint, nodeId: VECTOR.nodeId, nonce: VECTOR.nonce, at: VECTOR.at }
  assert.equal(verifyIdentity(other.publicKeyB64, fields, VECTOR.sig), false, '非对应公钥必须验不过')
})

test('负向：畸形输入一律 false，绝不抛', () => {
  const fields = { fingerprint: VECTOR.fingerprint, nodeId: VECTOR.nodeId, nonce: VECTOR.nonce, at: VECTOR.at }
  for (const [pub, sig] of [
    ['', VECTOR.sig],
    ['not-base64url!!', VECTOR.sig],
    [VECTOR.publicKeyB64, ''],
    [VECTOR.publicKeyB64, '!!!not-base64url!!!'],
    [null, VECTOR.sig],
    [VECTOR.publicKeyB64, null],
  ]) {
    assert.equal(verifyIdentity(pub, fields, sig), false, `pub=${String(pub).slice(0, 12)} sig=${String(sig).slice(0, 12)}`)
  }
})

/* ───────────────────────── 指纹归一化 ───────────────────────── */

test('normalizeFingerprint：只认 hubfp1- + 22 位 base64url，其余为空', () => {
  assert.equal(normalizeFingerprint(VECTOR.fingerprint), VECTOR.fingerprint, '合法指纹原样归一')
  assert.equal(normalizeFingerprint(`  ${VECTOR.fingerprint}\n`), VECTOR.fingerprint, '首尾空白可容忍')
  const bad = [
    '', '   ', 'hubfp1-', 'hubfp1-tooshort', 'hubfp2-ZKBSPB6tLRXi8EqTDeSRlA',
    'ZKBSPB6tLRXi8EqTDeSRlA', `hubfp1-${'A'.repeat(21)}`, `hubfp1-${'A'.repeat(23)}`,
    `hubfp1-${'A'.repeat(21)}!`, null, undefined, 42, {},
  ]
  for (const v of bad) {
    assert.equal(normalizeFingerprint(v), '', `必须拒绝：${JSON.stringify(v)?.slice(0, 40)}`)
  }
  // 大小写不折叠：两个不同大小写指纹是两个不同指纹
  const upper = `hubfp1-${'a'.repeat(22)}`
  const lower = `hubfp1-${'A'.repeat(22)}`
  assert.notEqual(normalizeFingerprint(upper), normalizeFingerprint(lower))
})

/* ───────────────────────── importIdentity ───────────────────────── */

test('importIdentity：残缺/伪造存储一律 null', () => {
  const cases = [
    undefined, null, 42, 'x', [],
    {},
    { privateKeyB64: VECTOR.privateKeyB64 },                                   // 缺公钥
    { publicKeyB64: VECTOR.publicKeyB64 },                                     // 缺私钥
    { privateKeyB64: 'garbage', publicKeyB64: VECTOR.publicKeyB64, fingerprint: VECTOR.fingerprint },
    { ...VECTOR, fingerprint: 'hubfp1-' + 'A'.repeat(22) },                    // 指纹与公钥不符
  ]
  for (const stored of cases) {
    assert.equal(importIdentity(stored), null, `必须拒绝：${JSON.stringify(stored)?.slice(0, 50)}`)
  }
  const ok = importIdentity(VECTOR)
  assert.equal(ok.fingerprint, VECTOR.fingerprint)
  assert.equal(ok.publicKeyB64, VECTOR.publicKeyB64)
})

/* ───────────────────────── 磁盘行为（真临时目录） ───────────────────────── */

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-identity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('loadOrCreateHubIdentity：创建 → 重读稳定 → 损坏重建 → 指纹改变', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'hub-identity.json')

  const first = loadOrCreateHubIdentity(file)
  assert.equal(first.created, true, '首次必须创建')
  assert.ok(fs.existsSync(file), '身份必须落盘')
  assert.equal(first.fingerprint, readHubIdentity(file).fingerprint, '落盘内容与返回一致')

  const second = loadOrCreateHubIdentity(file)
  assert.equal(second.created, false, '第二次必须复用')
  assert.equal(second.privateKeyB64, first.privateKeyB64, '私钥跨重启稳定')
  assert.equal(second.fingerprint, first.fingerprint, '指纹跨重启稳定')

  // 损坏 → 重建（hub 不能因为一个坏字节起不来；副机会因指纹变化大声失败，fail-closed）
  fs.writeFileSync(file, '{ not json')
  const third = loadOrCreateHubIdentity(file)
  assert.equal(third.created, true, '损坏文件必须重建')
  assert.notEqual(third.fingerprint, first.fingerprint, '重建后指纹必须变化（旧 pin 才会失效）')

  // 形态合法但内容对不上（fingerprint 与公钥不符）同样重建
  fs.writeFileSync(file, JSON.stringify({ ...first, fingerprint: 'hubfp1-' + 'A'.repeat(22) }))
  const fourth = loadOrCreateHubIdentity(file)
  assert.notEqual(fourth.fingerprint, 'hubfp1-' + 'A'.repeat(22), '伪造指纹必须被丢弃并重建')
})

test('loadOrCreateHubIdentity：空路径抛可读错误', () => {
  assert.throws(() => loadOrCreateHubIdentity(''), /file 必须是非空路径/)
  assert.throws(() => loadOrCreateHubIdentity(null), /file 必须是非空路径/)
})

test('readHubIdentity：缺失/损坏/空路径一律 null，不创建文件', (t) => {
  const dir = tmpDir(t)
  const missing = path.join(dir, 'nope.json')
  assert.equal(readHubIdentity(missing), null)
  assert.equal(fs.existsSync(missing), false, '只读函数绝不能创建文件')
  fs.writeFileSync(missing, 'broken')
  assert.equal(readHubIdentity(missing), null)
  assert.equal(readHubIdentity(''), null)
  assert.equal(readHubIdentity(null), null)
})

test('newNonce：32 位 hex，两次不同', () => {
  const a = newNonce()
  const b = newNonce()
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.notEqual(a, b)
})

test('generateIdentity：指纹与公钥自洽，可验签', () => {
  const id = generateIdentity()
  const fields = { fingerprint: id.fingerprint, nodeId: 'n1', nonce: newNonce(), at: Date.now() }
  const sig = signIdentity(id.privateKeyB64, fields)
  assert.equal(verifyIdentity(id.publicKeyB64, fields, sig), true)
  assert.equal(importIdentity(id).fingerprint, id.fingerprint, '生成的身份必须能原样导回')
})
