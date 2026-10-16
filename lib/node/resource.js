/**
 * 副机资源采样（零外部依赖）。
 *
 * 定位：每 30s 采一次 CPU/内存/负载，经 `node/resource` 帧发给 hub ——
 * 派发前能先看一眼节点负载（remote_nodes + 面板节点行）。尽力而为的遥测：
 * 采不到的字段就给 null，绝不因采样失败影响任务链路。
 *
 * CPU 用两次采样的**增量**算利用率：os.cpus() 的 times 是开机以来的累计值，
 * 直接读出来永远是"开机平均"，没有参考价值。首次采样没有基线 → cpuPct=null，
 * hub 侧显示为"待下次上报"。
 */
import os from 'node:os'

/** 默认上报间隔。与心跳（15s）错开半个量级：资源数据不需要秒级新鲜度。 */
export const RESOURCE_INTERVAL_MS = 30_000

/** CPU 时间片快照：全核 idle 与 total 的累计和。 */
export function snapshotCpu(osLike = os) {
  let idle = 0
  let total = 0
  for (const c of osLike.cpus()) {
    const t = c.times
    const iowait = t.iowait ?? 0
    idle += t.idle + iowait
    total += t.user + t.nice + t.sys + t.irq + t.idle + iowait
  }
  return { idle, total }
}

/** 两次快照之间的 CPU 利用率（0-100）。无基线或增量非法（计数器重置）→ null。 */
export function cpuPctBetween(prev, cur) {
  if (!prev || !cur) return null
  const dTotal = cur.total - prev.total
  const dIdle = cur.idle - prev.idle
  if (!(dTotal > 0) || dIdle < 0) return null
  return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100))
}

/**
 * 有状态采样器：内部保留上一次 CPU 快照，sample() 返回本次上报载荷。
 * osLike 参数专为测试注入（假 os，时间可控）。
 */
export function createResourceSampler({ osLike = os, round = (v) => Math.round(v * 10) / 10 } = {}) {
  let prev = null
  return {
    sample() {
      const cur = snapshotCpu(osLike)
      const pct = cpuPctBetween(prev, cur)
      prev = cur
      const total = typeof osLike.totalmem === 'function' ? osLike.totalmem() : 0
      const free = typeof osLike.freemem === 'function' ? osLike.freemem() : 0
      const load = typeof osLike.loadavg === 'function' ? osLike.loadavg() : [0, 0, 0]
      return {
        // null = 暂无基线（首次采样）或采样无效 —— hub 侧显示"待下次上报"
        cpuPct: pct === null ? null : round(pct),
        // Windows 的 loadavg 恒为 [0,0,0]，无参考价值但也不误导（恒 0 = 不忙）
        load1: round(load[0] ?? 0),
        memUsedMb: Math.max(0, Math.round((total - free) / (1024 * 1024))),
        memTotalMb: Math.max(0, Math.round(total / (1024 * 1024))),
      }
    },
  }
}
