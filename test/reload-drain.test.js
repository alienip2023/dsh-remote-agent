// 配置变更触发的重启不得打断正在跑的任务。三面各切一处：
//   有任务时不重启（drainRestart 被切成「不管有没有任务都立刻重启」就红）、
//   排空后重启（被切成「排空了也不重启」就红）、
//   对账不误杀（reconcileOnStartup 被切成「一律标 interrupted」就红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drainRestart } from '../lib/node/config-sync.js'
import { reconcileOnStartup } from '../lib/node/startup-reconcile.js'
import { TASK_STATUS } from '../lib/protocol.js'

test('有任务在跑时，配置重启被推迟，不立刻重启', () => {
  const calls = []
  const logs = []
  const timers = []
  const pending = drainRestart({
    delayMs: 300,
    restart: (delay) => calls.push(delay),
    running: () => 2,
    log: (level, msg) => logs.push([level, msg]),
    schedule: (fn) => { timers.push(fn) },
  })
  assert.equal(calls.length, 0, 'a task still running must hold the restart')
  assert.ok(logs.some(([, msg]) => /drain/i.test(msg)), 'the wait is logged, not silent')
  assert.equal(timers.length, 1, 'it keeps waiting instead of restarting')
  assert.equal(typeof pending, 'function', 'the caller can still force it once the bound is reached')
})

test('任务排空后，推迟的重启才发出', () => {
  const calls = []
  const timers = []
  let running = 1
  const pending = drainRestart({
    delayMs: 300,
    restart: (delay) => calls.push(delay),
    running: () => running,
    log: () => {},
    waitMs: 5,
    boundMs: 1000,
    schedule: (fn) => { timers.push(fn) },
  })
  assert.equal(calls.length, 0)
  for (let i = 0; i < 4 && calls.length === 0; i++) {
    const due = timers.splice(0)
    for (const fn of due) fn()
  }
  assert.equal(calls.length, 0, 'still running, so the restart stays held')
  running = 0
  for (let i = 0; i < 4 && calls.length === 0; i++) {
    const due = timers.splice(0)
    assert.ok(due.length > 0, 'the drain kept a tick scheduled')
    for (const fn of due) fn()
  }
  assert.deepEqual(calls, [300], 'draining issues the restart on the next tick')
  assert.equal(typeof pending, 'function')
  assert.equal(timers.length, 0, 'nothing keeps ticking after the restart fires')
})

test('上界之后才排空，重启仍要发出', () => {
  const calls = []
  const logs = []
  let running = 1
  let now = 0
  const timers = []
  const pending = drainRestart({
    delayMs: 300,
    restart: (delay, log) => calls.push([delay, typeof log]),
    running: () => running,
    log: (level, msg) => logs.push([level, msg]),
    waitMs: 1000,
    boundMs: 10 * 60 * 1000,
    now: () => now,
    schedule: (fn) => { timers.push(fn) },
  })
  assert.equal(calls.length, 0, 'still running, so no restart yet')
  // 时间在两次 tick 之间跨过上界，不是在 tick 之前就过了——后者会让旧实现
  // 在还没打出上界日志时就停摆，测不到「上界之后仍要重启」。
  for (let i = 0; i < 12 && calls.length === 0 && now < 11 * 60 * 1000; i++) {
    now += 55 * 1000
    const due = timers.splice(0)
    if (due.length === 0) break
    for (const fn of due) fn()
  }
  assert.ok(now >= 10 * 60 * 1000, 'the clock crossed the bound')
  assert.equal(calls.length, 0, 'reaching the bound must not give up the restart')
  assert.ok(logs.some(([level]) => level === 'warn'), 'the bound is logged, once')
  const warns = logs.filter(([level]) => level === 'warn').length
  now += 55 * 1000
  for (let i = 0; i < 4 && timers.length; i++) timers.shift()()
  assert.equal(logs.filter(([level]) => level === 'warn').length, warns, 'the bound warning is throttled, not repeated every tick')
  running = 0
  for (let i = 0; i < 4 && timers.length; i++) timers.shift()()
  assert.deepEqual(calls, [[300, 'function']], 'draining after the bound still issues the restart, and the log reaches it')
  assert.equal(typeof pending, 'function')
})

test('启动对账只把没有活 runner 的任务标 interrupted，能接的接回来', () => {
  const updates = []
  const store = {
    list: () => [
      { taskId: 'live', status: TASK_STATUS.RUNNING },
      { taskId: 'dead', status: TASK_STATUS.RUNNING },
      { taskId: 'done', status: TASK_STATUS.SUCCEEDED },
    ],
    update: (taskId, patch) => updates.push([taskId, patch]),
  }
  const tally = reconcileOnStartup(store, {
    alive: (taskId) => taskId === 'live',
  })
  assert.deepEqual(updates.map(([id]) => id), ['dead'], 'the task a runner still holds is not marked interrupted')
  assert.equal(updates[0][1].status, TASK_STATUS.INTERRUPTED)
  assert.equal(updates[0][1].error.code, 'node-restart')
  assert.equal(tally.interrupted, 1)
  assert.equal(tally.kept, 1)
})
