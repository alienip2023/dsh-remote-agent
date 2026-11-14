// 配置变更触发的重启不得打断正在跑的任务。三面各切一处：
//   有任务时不重启（drainRestart 被切成「不管有没有任务都立刻重启」就红）、
//   排空后重启（被切成「排空了也不重启」就红）、
//   对账不误杀（reconcileOnStartup 被切成「一律标 interrupted」就红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drainRestart } from '../lib/node/config-sync.js'
import { reconcileOnStartup } from '../lib/node/index.js'
import { TASK_STATUS } from '../lib/protocol.js'

test('有任务在跑时，配置重启被推迟，不立刻重启', () => {
  const calls = []
  const logs = []
  const pending = drainRestart({
    delayMs: 300,
    restart: (delay) => calls.push(delay),
    running: () => 2,
    log: (level, msg) => logs.push([level, msg]),
  })
  assert.equal(calls.length, 0, 'a task still running must hold the restart')
  assert.ok(logs.some(([, msg]) => /drain/i.test(msg)), 'the wait is logged, not silent')
  assert.equal(typeof pending, 'function', 'the caller can still force it once the bound is reached')
})

test('任务排空后，推迟的重启才发出', () => {
  const calls = []
  let running = 1
  const pending = drainRestart({
    delayMs: 300,
    restart: (delay) => calls.push(delay),
    running: () => running,
    log: () => {},
    waitMs: 5,
    boundMs: 1000,
  })
  return new Promise((resolve) => {
    setTimeout(() => { running = 0 }, 20)
    const started = Date.now()
    const tick = () => {
      if (calls.length > 0) {
        assert.ok(Date.now() - started >= 15, 'the restart waited for the task to finish')
        assert.equal(typeof pending, 'function')
        resolve()
        return
      }
      if (Date.now() - started > 800) {
        assert.fail('the drained restart was never issued')
      }
      setTimeout(tick, 10)
    }
    setTimeout(tick, 30)
  })
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
