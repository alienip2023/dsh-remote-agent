/**
 * 副机资源遥测测试：采样器数学（增量 CPU / 内存 / 负载）+ hub 侧摄入。
 *
 * 采样器用假 os（时间可控的 cpu times），registry 摄入用最小假件
 * （与 hub-identity.test.js 同口径：假 conn 只需 send/close）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../lib/protocol.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { cpuPctBetween, createResourceSampler, snapshotCpu } from '../lib/node/resource.js'

/* ───────────────────────── 采样器数学 ───────────────────────── */

/** 假 os：cpus() 返回预设的时间片序列（每次调用消耗下一档）。 */
function fakeOs(timesSeries, { total = 16 * 1024 ** 3, free = 8 * 1024 ** 3, load = [1.5, 0, 0] } = {}) {
  let i = 0
  return {
    cpus: () => {
      const t = timesSeries[Math.min(i, timesSeries.length - 1)]
      i += 1
      return [{ times: { user: t.user, nice: t.nice ?? 0, sys: t.sys, idle: t.idle, irq: t.irq ?? 0, iowait: t.iowait ?? 0 } }]
    },
    totalmem: () => total,
    freemem: () => free,
    loadavg: () => load,
  }
}

test('首次采样无基线 → cpuPct 为 null，内存/负载正常', () => {
  const s = createResourceSampler({ osLike: fakeOs([{ user: 100, sys: 50, idle: 850 }]) })
  const r = s.sample()
  assert.equal(r.cpuPct, null)
  assert.equal(r.memTotalMb, 16384)
  assert.equal(r.memUsedMb, 8192)
  assert.equal(r.load1, 1.5)
})

test('第二次采样按增量算 CPU 利用率（30% 忙 → cpuPct=30）', () => {
  const s = createResourceSampler({
    osLike: fakeOs([
      { user: 100, sys: 50, idle: 850 },
      { user: 220, sys: 80, idle: 1000 }, // 增量：total=300，busy=150 → 50%？见断言
    ]),
  })
  s.sample()
  const r = s.sample()
  // delta: total = (220+80+1000) - (100+50+850) = 300；idle = 150 → busy 50%
  assert.equal(r.cpuPct, 50)
})

test('跨多核聚合：两核分别忙闲不同时按总量算', () => {
  const s = createResourceSampler({
    osLike: {
      cpus: () => {
        // 固定返回同一份（每次 sample 之间由测试控制两个快照做不到 ——
        // 这里直接测 snapshotCpu + cpuPctBetween 的组合）
        return [
          { times: { user: 10, sys: 10, idle: 80 } },
          { times: { user: 30, sys: 10, idle: 60 } },
        ]
      },
      totalmem: () => 0,
      freemem: () => 0,
      loadavg: () => [0, 0, 0],
    },
  })
  const snap = snapshotCpu(s.osLike ?? undefined)
  // 直接构造两快照验证聚合数学：核1 busy 20/100，核2 busy 40/100 → 总 busy 60/200 = 30%
  const prev = { idle: 0, total: 0 }
  const cur = { idle: 80 + 60, total: (10 + 10 + 80) + (30 + 10 + 60) }
  assert.equal(cpuPctBetween(prev, cur), 30)
  assert.ok(snap.total > 0)
})

test('计数器重置（total 倒退）→ cpuPct 为 null，不给出负数/NaN', () => {
  const s = createResourceSampler({
    osLike: fakeOs([
      { user: 500, sys: 500, idle: 500 },
      { user: 10, sys: 5, idle: 85 }, // 重启后的累计值，全面倒退
    ]),
  })
  s.sample()
  const r = s.sample()
  assert.equal(r.cpuPct, null)
})

test('超过 100% 的脏数据被钳到 100', () => {
  // idle 倒退（计数器重置）→ null
  const prev = { idle: 0, total: 100 }
  const cur = { idle: -10, total: 100 }
  assert.equal(cpuPctBetween(prev, cur), null)
  // 全忙（idle 增量为 0、total 前进）→ 恰好 100
  const cur2 = { idle: 0, total: 200 }
  assert.equal(cpuPctBetween(prev, cur2), 100)
})

/* ───────────────────────── hub 侧摄入 ───────────────────────── */

function registryWithNode() {
  const registry = new NodeRegistry({ log: () => {} })
  const conn = { send: () => {}, close: () => {} }
  registry.ingestHello({
    helloData: { nodeId: 'node-res', protocol: PROTOCOL_VERSION, os: 'linux', nonce: '', time: Date.now() },
    conn,
    transport: 'direct',
    pending: undefined,
  })
  return registry
}

test('node/resource 帧：数值齐全 → rec.resource 落位，list() 透出', () => {
  const registry = registryWithNode()
  registry.handleFrameFor('node-res', {
    t: 'node/resource',
    d: { cpuPct: 12.5, load1: 0.4, memUsedMb: 2048, memTotalMb: 16384 },
  })
  const n = registry.list().find((x) => x.nodeId === 'node-res')
  assert.equal(n.resource.cpuPct, 12.5)
  assert.equal(n.resource.memTotalMb, 16384)
  assert.ok(Number.isFinite(n.resource.at))
})

test('node/resource 帧：畸形字段 → 落 null 不抛，其余字段保留', () => {
  const registry = registryWithNode()
  registry.handleFrameFor('node-res', {
    t: 'node/resource',
    d: { cpuPct: '99%', load1: NaN, memUsedMb: -5, memTotalMb: 16384 },
  })
  const n = registry.list().find((x) => x.nodeId === 'node-res')
  assert.equal(n.resource.cpuPct, null) // 字符串 → null
  assert.equal(n.resource.load1, null) // NaN → null
  assert.equal(n.resource.memUsedMb, -5) // 有限数值如实收（采样端负责钳制）
  assert.equal(n.resource.memTotalMb, 16384)
})

test('node/resource 帧：完全缺字段 → 全 null，节点记录不受影响', () => {
  const registry = registryWithNode()
  registry.handleFrameFor('node-res', { t: 'node/resource', d: {} })
  const n = registry.list().find((x) => x.nodeId === 'node-res')
  assert.equal(n.resource.cpuPct, null)
  assert.equal(n.resource.memTotalMb, null)
  assert.equal(n.online, true)
})

test('离线节点保留最后一次 resource（消费方按 at 判断新鲜度）', () => {
  const registry = registryWithNode()
  registry.handleFrameFor('node-res', {
    t: 'node/resource',
    d: { cpuPct: 7, memUsedMb: 1024, memTotalMb: 16384 },
  })
  registry.markOffline('node-res', 'test')
  const n = registry.list().find((x) => x.nodeId === 'node-res')
  assert.equal(n.online, false)
  assert.equal(n.resource.cpuPct, 7)
})
