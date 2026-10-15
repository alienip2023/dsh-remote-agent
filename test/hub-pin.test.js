/**
 * P2-11 副机侧测试：TOFU 钉住落盘 + transport 身份验证链 + relay 宽限窗口。
 *
 * transport 的验证逻辑不碰网络 —— NodeTransport 构造函数不连接，
 * verifyHubIdentity 只依赖 this.hello / this.resolveUrl() / pinStore，
 * 可以脱离 socket 直接驱动。pinStore 用内存实现注入（worker 用 fs 实现，
 * 两条路径分开测）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { generateIdentity, signIdentity } from '../lib/identity.js'
import { clearHubPin, loadHubPin, saveHubPin } from '../lib/node/hub-pin.js'
import { NodeTransport, IDENTITY_MAX_SKEW_MS } from '../lib/node/transport.js'

const NONCE = 'ab'.repeat(16)
const HELLO = { nodeId: 'n1', nonce: NONCE }
const URL_A = 'ws://127.0.0.1:19387/api/remote-agent/node'
const URL_B = 'ws://127.0.0.2:19387/api/remote-agent/node'

/** 造一把 hub 身份 + 按参数出身份帧。 */
function makeHub() {
  const id = generateIdentity()
  return {
    id,
    frame: ({ nodeId = 'n1', nonce = NONCE, at = Date.now(), fpOverride, pubOverride } = {}) => {
      const sig = signIdentity(id.privateKeyB64, { fingerprint: fpOverride ?? id.fingerprint, nodeId, nonce, at })
      return { fp: fpOverride ?? id.fingerprint, pub: pubOverride ?? id.publicKeyB64, sig, at, nonce }
    },
  }
}

/** 内存 pinStore（记录 set 调用，供断言）。 */
function memPinStore(initial = null) {
  const calls = { set: 0, cleared: 0 }
  let pin = initial
  return {
    calls,
    get: () => pin,
    set: (p) => {
      calls.set += 1
      pin = { ...p }
      return true
    },
    clear: () => {
      calls.cleared += 1
      pin = null
    },
  }
}

function makeTransport(o = {}) {
  const events = { error: [], rePin: [], hubIdentity: [] }
  const t = new NodeTransport({
    mode: o.mode ?? 'direct',
    url: o.url ?? URL_A,
    hello: { ...(o.hello ?? HELLO) },
    pinnedFingerprint: o.pinnedFingerprint,
    pinStore: o.pinStore ?? memPinStore(),
    identityGraceMs: o.identityGraceMs ?? 30,
  })
  t.on('error', (e) => events.error.push(String(e.message)))
  t.on('re-pin', (info) => events.rePin.push(info))
  t.on('hubIdentity', (s) => events.hubIdentity.push(s))
  return { t, events }
}

/* ───────────────────────── hub-pin 落盘 ───────────────────────── */

test('hub-pin：save → load 原样取回；clear 后读不到；坏指纹拒绝写入', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hubpin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  assert.equal(loadHubPin(dir), null, '初始无 pin')
  assert.equal(saveHubPin(dir, { fingerprint: 'not-a-fp' }), false, '坏指纹必须拒绝')
  assert.equal(saveHubPin(dir, { fingerprint: 'hubfp1-ZKBSPB6tLRXi8EqTDeSRlA', endpoint: URL_A }), true)
  const pin = loadHubPin(dir)
  assert.equal(pin.fingerprint, 'hubfp1-ZKBSPB6tLRXi8EqTDeSRlA')
  assert.equal(pin.endpoint, URL_A)
  assert.ok(pin.pinnedAt > 0)

  clearHubPin(dir)
  assert.equal(loadHubPin(dir), null, '清除后读不到')
  assert.equal(saveHubPin('', { fingerprint: 'hubfp1-ZKBSPB6tLRXi8EqTDeSRlA' }), false, '空 stateDir 拒绝')
  assert.equal(loadHubPin(''), null)
})

test('hub-pin：损坏文件按无 pin 处理（下次连接重新 TOFU），绝不抛', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hubpin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'hub-pin.json'), '{ broken')
  assert.equal(loadHubPin(dir), null)
  fs.writeFileSync(path.join(dir, 'hub-pin.json'), JSON.stringify({ fingerprint: 'garbage-fp' }))
  assert.equal(loadHubPin(dir), null, '指纹形态不对同样按无 pin')
})

/* ───────────────────────── transport 验证链 ───────────────────────── */

test('TOFU：无任何 pin + 合法身份帧 → ok，指纹落盘（含 endpoint）', () => {
  const hub = makeHub()
  const store = memPinStore()
  const { t } = makeTransport({ pinStore: store })
  const v = t.verifyHubIdentity(hub.frame())
  assert.equal(v.ok, true)
  assert.equal(v.status, 'ok')
  assert.equal(v.fingerprint, hub.id.fingerprint)
  assert.equal(store.calls.set, 1, 'TOFU 必须落盘一次')
  assert.equal(store.get().endpoint, t.resolveUrl(), 'endpoint 必须一并记录')
  assert.equal(t.hubIdentity, 'pending', 'verifyHubIdentity 不改状态（由 handleFrame 的 setHubIdentity 负责）')
})

test('TOFU：pin 文件匹配 → ok；显式配置的指纹与 hub 不符 → 拒绝', () => {
  const hub = makeHub()
  const other = makeHub()
  const withFile = makeTransport({ pinStore: memPinStore({ fingerprint: hub.id.fingerprint, endpoint: '' }) })
  assert.equal(withFile.t.verifyHubIdentity(hub.frame()).ok, true)

  const withConfig = makeTransport({ pinnedFingerprint: other.id.fingerprint, pinStore: memPinStore() })
  const v = withConfig.t.verifyHubIdentity(hub.frame())
  assert.equal(v.ok, false)
  assert.match(v.reason, /mismatch/)
})

test('负向：假公钥（指纹与公钥不符）/ 坏签名 / 重放 nonce / 超时时间戳 全部拒绝', () => {
  const hub = makeHub()
  const stranger = makeHub()

  const cases = [
    ['指纹与公钥不符', hub.frame({ pubOverride: stranger.id.publicKeyB64 })],
    ['报真指纹递假钥匙', hub.frame({ fpOverride: stranger.id.fingerprint })],
    ['签名坏', { ...hub.frame(), sig: hub.frame().sig.replace(/^./, 'B') }],
  ]
  for (const [name, frame] of cases) {
    const { t } = makeTransport({})
    const v = t.verifyHubIdentity(frame)
    assert.equal(v.ok, false, `${name} 必须拒绝`)
  }

  // 重放：签名是给 nonce=ff… 的连接做的，本连接发的是 ab…
  const replayed = makeTransport({ hello: { nodeId: 'n1', nonce: 'ff'.repeat(16) } })
  const vReplay = replayed.t.verifyHubIdentity(hub.frame())
  assert.equal(vReplay.ok, false, 'nonce 对不上必须拒绝（重放特征）')
  assert.match(vReplay.reason, /nonce|replay/i)

  // 时间窗：把 at 拉出 ±5min
  const stale = makeTransport({})
  const vStale = stale.t.verifyHubIdentity(hub.frame({ at: Date.now() - IDENTITY_MAX_SKEW_MS - 1000 }))
  assert.equal(vStale.ok, false)
  assert.match(vStale.reason, /window/)
})

test('absent：hub 不报身份 —— 无 pin 放行（旧版兼容），有 pin 拒绝（疑遭剥帧）', () => {
  const hub = makeHub()
  const noPin = makeTransport({ pinStore: memPinStore() })
  const vAbsent = noPin.t.verifyHubIdentity(undefined)
  assert.equal(vAbsent.ok, true)
  assert.equal(vAbsent.status, 'absent', '旧版 hub 兼容路径')

  const pinned = makeTransport({ pinnedFingerprint: hub.id.fingerprint })
  const vFail = pinned.t.verifyHubIdentity(undefined)
  assert.equal(vFail.ok, false)
  assert.match(vFail.reason, /no identity frame/)
})

test('endpoint 变化：换 hubUrl 属本地配置行为 → re-pin 提示 + 重新 TOFU', () => {
  const hub = makeHub()
  const oldEndpoint = 'ws://10.0.0.1:1/x'
  const store = memPinStore({ fingerprint: hub.id.fingerprint, endpoint: oldEndpoint })
  const { t, events } = makeTransport({ url: URL_B, pinStore: store })

  const v = t.verifyHubIdentity(hub.frame({}))
  assert.equal(v.ok, true, '换端点后重新 TOFU 必须成功')
  assert.equal(events.rePin.length, 1, '必须发 re-pin 提示')
  assert.equal(events.rePin[0].from, oldEndpoint)
  assert.equal(store.get().endpoint, t.resolveUrl(), '新 endpoint 已重新钉住')
})

test('failHubIdentity：大声报错 + 停止重连 + 保留 pin（不清除）', () => {
  const store = memPinStore({ fingerprint: 'hubfp1-ZKBSPB6tLRXi8EqTDeSRlA', endpoint: '' })
  const { t, events } = makeTransport({ pinStore: store })
  t.failHubIdentity('test reason')
  assert.equal(t.stopped, true, '必须停止重连')
  assert.equal(events.error.length, 1)
  assert.match(events.error[0], /hub 身份验证失败/)
  assert.ok(store.get(), 'pin 必须保留 —— 修法是人工确认，不是静默重钉')
})

/* ───────────────────────── relay 宽限窗口 ───────────────────────── */

test('relay 宽限：有 pin 但身份帧始终不来 → 超时拒绝并停止', async () => {
  const hub = makeHub()
  const store = memPinStore({ fingerprint: hub.id.fingerprint, endpoint: '' })
  const { t, events } = makeTransport({ mode: 'relay', url: 'ws://relay.example:8890/relay', pinStore: store })
  t.markOnline({ relay: true })
  t.armIdentityGrace()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(t.stopped, true, '钉住的 hub 没证明自己 → 停止')
  assert.equal(t.hubIdentity, 'pending', '失败不走 absent')
  assert.equal(events.error.length, 1)
})

test('relay 宽限：无 pin 且身份帧不来 → 超时进入 absent（旧版 hub 兼容）', async () => {
  const { t, events } = makeTransport({ mode: 'relay', url: 'ws://relay.example:8890/relay', pinStore: memPinStore() })
  t.markOnline({ relay: true })
  t.armIdentityGrace()
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(t.stopped, false)
  assert.equal(t.hubIdentity, 'absent')
  assert.equal(events.hubIdentity.at(-1), 'absent')
})

test('宽限窗口内身份帧到达 → 取消定时器，状态转 ok', async () => {
  const hub = makeHub()
  const { t } = makeTransport({ mode: 'relay', url: 'ws://relay.example:8890/relay', pinStore: memPinStore() })
  t.markOnline({ relay: true })
  t.armIdentityGrace()
  const v = t.verifyHubIdentity(hub.frame())
  assert.equal(v.ok, true)
  t.stopIdentityGrace()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(t.stopped, false, '验证通过后不会被超时误杀')
})
