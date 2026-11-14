// 配置变更触发的重启不得打断正在跑的任务。三面各切一处：
//   有任务时不重启（drainRestart 被切成「不管有没有任务都立刻重启」就红）、
//   排空后重启（被切成「排空了也不重启」就红）、
//   对账不误杀（reconcileOnStartup 被切成「一律标 interrupted」就红）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drainRestart } from '../lib/node/config-sync.js'
import { reconcileOnStartup } from '../lib/node/startup-reconcile.js'
import { TaskStore } from '../lib/node/task-store.js'
import { TaskEngine } from '../lib/node/task-engine.js'
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

const self = { pid: 4242, startedAt: 1_700_000_000_000 }

test('启动对账：同一进程留下的 RUNNING 任务原样保留', () => {
  const updates = []
  const store = {
    list: () => [
      { taskId: 'still-running', status: TASK_STATUS.RUNNING, ownerPid: self.pid, ownerStartedAt: self.startedAt },
      { taskId: 'done', status: TASK_STATUS.SUCCEEDED, ownerPid: self.pid, ownerStartedAt: self.startedAt },
    ],
    update: (taskId, patch) => updates.push([taskId, patch]),
  }
  const tally = reconcileOnStartup(store, { self })
  assert.deepEqual(updates, [], 'a task owned by this same process is not marked interrupted')
  assert.equal(tally.kept, 1)
  assert.equal(tally.interrupted, 0)
})

test('启动对账：进程换了才把 RUNNING 任务标 interrupted', () => {
  const updates = []
  const store = {
    list: () => [
      // 新引擎的 running 表是空的也一样：属主进程不同，就该标 interrupted。
      { taskId: 'old-proc', status: TASK_STATUS.RUNNING, ownerPid: self.pid + 1, ownerStartedAt: self.startedAt },
      // pid 被复用，但进程启动时刻对不上，仍是另一个进程。
      { taskId: 'reused-pid', status: TASK_STATUS.RUNNING, ownerPid: self.pid, ownerStartedAt: self.startedAt - 60_000 },
      // 升级前留下的记录没有属主，无法证明还是这个进程，按换了进程处理。
      { taskId: 'no-owner', status: TASK_STATUS.RUNNING },
    ],
    update: (taskId, patch) => updates.push([taskId, patch]),
  }
  const tally = reconcileOnStartup(store, { self })
  assert.deepEqual(updates.map(([id]) => id), ['old-proc', 'reused-pid', 'no-owner'])
  assert.equal(updates[0][1].status, TASK_STATUS.INTERRUPTED)
  assert.equal(updates[0][1].error.code, 'node-restart')
  assert.equal(tally.interrupted, 3)
  assert.equal(tally.kept, 0)
})

// 两个真 TaskStore 共用一个目录：上一代写完只进它自己的缓存和磁盘，新一代的
// 缓存是构造时读的。删掉 syncAll 里的 reload，这条报上来的就是 running。
test('重载后重连，新实例上报上一代已经写进磁盘的完成', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-reload-sync-'))
  try {
    const oldStore = new TaskStore(dir)
    oldStore.create({ taskId: 't-reload', mode: 'exec', goal: 'g' }, { nodeId: 'n1', workspace: dir })
    oldStore.update('t-reload', { status: TASK_STATUS.RUNNING })

    const newStore = new TaskStore(dir)
    assert.equal(newStore.get('t-reload').status, TASK_STATUS.RUNNING, 'the new cache was read while the task was still running')

    oldStore.update('t-reload', { status: TASK_STATUS.COMPLETED, endedAt: Date.now() })
    assert.equal(newStore.get('t-reload').status, TASK_STATUS.RUNNING, 'the completion never reaches the new cache on its own')

    const frames = []
    const engine = new TaskEngine({
      store: newStore,
      artifacts: {},
      runner: {},
      nodeId: 'n1',
      roots: [dir],
      defaultWorkspace: dir,
      send: (type, data) => frames.push({ type, data }),
    })
    engine.syncAll()

    const sync = frames.find((f) => f.type === 'task/sync')
    assert.ok(sync, 'a reconnect reports the task')
    assert.equal(sync.data.tasks.length, 1)
    assert.equal(sync.data.tasks[0].status, TASK_STATUS.COMPLETED, 'the completion written to disk is what gets reported, not the stale running')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 真实顺序和上面那条相反：重载后秒级重连时任务还在跑，syncAll 报的是 running；
// 上一代要到很久之后才写完，而它的 task/end 走的是已经停掉的连接，帧丢了，
// 之后不再有 sync。活着的这一代必须在完成落盘那一拍把 task/end 补出去。
// 切掉 replaySettled 里的 this.send('task/end') 这条就红。
test('完成落在重连之后，新实例把磁盘上的终态补发给 hub', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-reload-replay-'))
  try {
    const oldStore = new TaskStore(dir)
    oldStore.create({ taskId: 't-late', mode: 'exec', goal: 'g' }, { nodeId: 'n1', workspace: dir })
    oldStore.update('t-late', { status: TASK_STATUS.RUNNING, startedAt: 1_000 })

    const newStore = new TaskStore(dir)
    const frames = []
    const engine = new TaskEngine({
      store: newStore,
      artifacts: {},
      runner: {},
      nodeId: 'n1',
      roots: [dir],
      defaultWorkspace: dir,
      send: (type, data) => { frames.push({ type, data }); return true },
    })

    engine.syncAll()
    const firstSync = frames.find((f) => f.type === 'task/sync')
    assert.equal(firstSync.data.tasks[0].status, TASK_STATUS.RUNNING, 'the reconnect reports the task still running')

    // 上一代这才写完。它的 send 绑的是已停的连接，task/end 到不了 hub，只落了盘。
    oldStore.update('t-late', { status: TASK_STATUS.COMPLETED, endedAt: 5_000 })
    assert.equal(frames.filter((f) => f.type === 'task/end').length, 0, 'nothing has reported the completion yet')

    const replayed = engine.replaySettled()

    assert.equal(replayed, 1, 'the completion is replayed exactly once')
    const end = frames.find((f) => f.type === 'task/end')
    assert.ok(end, 'a task/end reaches the live transport when the completion lands')
    assert.equal(end.data.taskId, 't-late')
    assert.equal(end.data.status, TASK_STATUS.COMPLETED, 'the hub is told the task completed, not left at running')
    assert.equal(engine.replaySettled(), 0, 'the same completion is not sent again on the next pass')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
