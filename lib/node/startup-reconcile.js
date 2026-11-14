/**
 * 启动对账，单独成模块：它不依赖 worker 装配，测试才能在不拉起整个
 * lib/node/index.js 的情况下喂一个假 store。
 */
import { TASK_STATUS, TERMINAL_STATUS } from '../protocol.js'

/**
 * RUNNING 且没有活 runner 的标 interrupted；有活 runner 的原样留下，由它自己
 * 跑完。QUEUED 在 resumeQueued 时重排。
 * @returns {{ interrupted: number, requeued: number, kept: number }}
 */
export function reconcileOnStartup(store, { alive = () => false, resumeQueued = true, enqueue = () => {}, now = Date.now } = {}) {
  const tally = { interrupted: 0, requeued: 0, kept: 0 }
  for (const rec of store.list()) {
    if (TERMINAL_STATUS.has(rec.status)) continue
    if (rec.status === TASK_STATUS.RUNNING) {
      if (alive(rec.taskId)) { tally.kept += 1; continue }
      store.update(rec.taskId, {
        status: TASK_STATUS.INTERRUPTED,
        endedAt: now(),
        error: { code: 'node-restart', message: 'node process restarted while task was running' },
      })
      tally.interrupted += 1
    } else if (rec.status === TASK_STATUS.QUEUED && resumeQueued) {
      enqueue(rec.taskId)
      tally.requeued += 1
    }
  }
  return tally
}
