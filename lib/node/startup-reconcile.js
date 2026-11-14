/**
 * 启动对账，单独成模块：它不依赖 worker 装配，测试才能在不拉起整个
 * lib/node/index.js 的情况下喂一个假 store。
 */
import { TASK_STATUS, TERMINAL_STATUS } from '../protocol.js'

// 进程启动时刻由 Date.now() 与 process.uptime() 两次采样相减得到，两次计算会差
// 零点几毫秒；in-process 重载会重新 import 本模块、再算一次。5 秒盖住这个抖动和
// 一次小的对时跳变，又远小于进程真的退出再起来的间隔。只有 pid 被复用、且新进程
// 的启动时刻正好落在这 5 秒里，才可能把一个已死的任务误留成 RUNNING。
const SAME_PROCESS_TOLERANCE_MS = 5000

/** 当前进程的属主标识：pid 加进程启动时刻。同一次进程内反复算，落在容忍窗口内。 */
export function currentProcessOwner(now = Date.now()) {
  return { pid: process.pid, startedAt: now - process.uptime() * 1000 }
}

function sameProcess(rec, self) {
  if (rec.ownerPid == null || rec.ownerStartedAt == null) return false
  if (rec.ownerPid !== self.pid) return false
  return Math.abs(rec.ownerStartedAt - self.startedAt) <= SAME_PROCESS_TOLERANCE_MS
}

/**
 * RUNNING 且属主进程还是当前进程的原样留下（in-process 重载换的是连接，不是进程，
 * 新引擎的 running 表是空的，不能拿它判断任务是否还活着）；进程真换了、或记录上
 * 没有属主的，才标 interrupted。QUEUED 在 resumeQueued 时重排。
 * @returns {{ interrupted: number, requeued: number, kept: number }}
 */
export function reconcileOnStartup(store, { self = currentProcessOwner(), resumeQueued = true, enqueue = () => {}, now = Date.now } = {}) {
  const tally = { interrupted: 0, requeued: 0, kept: 0 }
  for (const rec of store.list()) {
    if (TERMINAL_STATUS.has(rec.status)) continue
    if (rec.status === TASK_STATUS.RUNNING) {
      if (sameProcess(rec, self)) { tally.kept += 1; continue }
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
