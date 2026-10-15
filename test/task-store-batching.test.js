/**
 * TaskStore 批量写回语义测试（2026-10-15 热路径改造）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 改造前：每条 appendLog / appendProgress / update 都**同步全量重写**整个
 * 记录文件（含最多 500 行 × 4000 字符的日志尾巴，单文件可达 2MB）—— 一条
 * 命令几十行输出就把副机事件循环阻塞几十次，而副机同时还要跑子进程 I/O
 * 和 ws 帧。
 *
 * 改造后：
 *   - 日志 / 进度 → 200ms 合并窗口批量写回（窗口内 N 次更新只写一次盘）
 *   - 状态转移 / 终态 / 创建 → 仍然同步落盘
 *
 * 为什么状态转移不能批量：终态记录若只躺在批量窗口里，进程崩溃后
 * reconcile 会把未落盘的 completed 判成 interrupted **重跑** —— 任务被
 * 执行两次。这是"断连不终止任务"不变式的磁盘侧对应物。
 *
 * 这个文件锁住三条契约：
 *   ① 高频写（日志/进度）进批量窗口，不立即写盘，flush/close 强制落盘
 *   ② 状态转移（含终态时间戳）立即落盘，与批量无关
 *   ③ 崩溃（不 flush）最多丢最后一个窗口的日志，不丢状态
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { TaskStore } from '../lib/node/task-store.js'
import { TASK_STATUS } from '../lib/protocol.js'

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-store-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return { dir, store: new TaskStore(dir), file: (id) => path.join(dir, 'tasks', `${id}.json`) }
}

const SPEC = { taskId: 't-batch-1', mode: 'exec', goal: 'echo hi', workspace: '/tmp/ws' }

test('批量契约①：appendLog / appendProgress 不立即写盘，flush 后落盘', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })
  // create 是同步的：文件必须已经在盘上（幂等与耐久的基础）
  assert.equal(fs.existsSync(file('t-batch-1')), true, 'create 必须同步落盘')

  store.appendLog('t-batch-1', 'line-1')
  store.appendLog('t-batch-1', 'line-2')
  store.appendProgress('t-batch-1', { phase: 'mid' })

  const before = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.equal(before.logs.length, 0, '批量窗口内不得写盘（盘上还是 create 时的快照）')
  assert.equal(before.progress.length, 0)

  const written = store.flush()
  assert.equal(written, 1, '一次 flush 把该任务的全部脏更新写成一份')

  const after = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.deepEqual(after.logs.map((l) => l.line), ['line-1', 'line-2'], '窗口内的多行必须都在')
  assert.equal(after.progress.length, 1)
  assert.equal(store.dirty.size, 0, 'flush 后脏集合必须清空')
})

test('批量契约①：窗口内 50 次 appendLog 只写一次盘', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })
  for (let i = 0; i < 50; i += 1) store.appendLog('t-batch-1', `line-${i}`)
  assert.equal(store.dirty.size, 1, '50 次更新只产生一个脏标记')
  assert.equal(store.flush(), 1, '只写一次盘')
  const after = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.equal(after.logs.length, 50, '50 行必须全部落盘')
})

test('批量契约②：状态转移立即落盘（不等批量窗口）', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })

  store.update('t-batch-1', { status: TASK_STATUS.RUNNING, startedAt: 111 })
  // 不调 flush —— 状态转移必须自己落盘
  const onDisk = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.equal(onDisk.status, TASK_STATUS.RUNNING, 'RUNNING 转移必须同步落盘')
  assert.equal(onDisk.startedAt, 111)
})

test('批量契约②：终态 update 带 manifest 整体落盘（reconcile 不重跑）', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })

  const manifest = { counts: { final: 2, partial: 1 }, files: [] }
  store.update('t-batch-1', {
    status: TASK_STATUS.COMPLETED,
    endedAt: 999,
    manifest,
    exit: { code: 0 },
  })

  const onDisk = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.equal(onDisk.status, TASK_STATUS.COMPLETED)
  assert.equal(onDisk.manifest.counts.final, 2, '终态 patch 里的 manifest 必须同一次写进去')
  assert.equal(onDisk.endedAt, 999)
})

test('批量契约③：模拟崩溃（不 flush）最多丢最后一个窗口的日志，不丢状态', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })
  store.update('t-batch-1', { status: TASK_STATUS.RUNNING, startedAt: 1 })
  store.appendLog('t-batch-1', 'crash-window-log')

  // 模拟崩溃：直接读盘，不 flush、不 close
  const onDisk = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.equal(onDisk.status, TASK_STATUS.RUNNING, '状态已在盘上 —— reconcile 不会误判')
  assert.equal(onDisk.logs.length, 0, '最后一个窗口的日志允许丢失（设计语义）')

  // 恢复"进程"：新 store 读到的状态是正确的 RUNNING，不是 completed 也不是queued
  const revived = new TaskStore(path.dirname(path.dirname(file('t-batch-1'))))
  assert.equal(revived.get('t-batch-1').status, TASK_STATUS.RUNNING)
})

test('批量契约①：close() 强制落盘并停掉批量窗口', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })
  store.appendLog('t-batch-1', 'bye')
  assert.equal(store.flushTimer !== null, true, '窗口定时器应在')

  const written = store.close()
  assert.equal(written, 1)
  assert.equal(store.flushTimer, null, 'close 后定时器必须停')
  const onDisk = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.deepEqual(onDisk.logs.map((l) => l.line), ['bye'])
})

test('批量契约①：close 之后的写退化为同步（closed 分支）', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })
  store.close()
  store.appendLog('t-batch-1', 'after-close')
  const onDisk = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.deepEqual(onDisk.logs.map((l) => l.line), ['after-close'], 'closed 后不得再进批量窗口')
})

test('批量契约①：写盘失败的记录留在脏集合里，下次 flush 重试', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })
  store.appendLog('t-batch-1', 'retry-me')

  const realWrite = fs.writeFileSync
  let calls = 0
  fs.writeFileSync = (...args) => {
    calls += 1
    if (calls === 1) throw new Error('disk full (simulated)')
    return realWrite(...args)
  }
  t.after(() => {
    fs.writeFileSync = realWrite
  })

  assert.equal(store.flush(), 0, '写失败不得计入 written')
  assert.equal(store.dirty.has('t-batch-1'), true, '失败记录必须留在脏集合')

  assert.equal(store.flush(), 1, '重试必须成功')
  const onDisk = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.deepEqual(onDisk.logs.map((l) => l.line), ['retry-me'])
})

test('非状态字段的 update 走批量（不每拍都写盘）', (t) => {
  const { store, file } = tmpStore(t)
  store.create(SPEC, { nodeId: 'n1' })
  store.update('t-batch-1', { sessionId: 's-1' })
  const onDisk = JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8'))
  assert.equal(onDisk.sessionId ?? null, null, '纯字段更新不进同步路径')
  store.flush()
  assert.equal(JSON.parse(fs.readFileSync(file('t-batch-1'), 'utf8')).sessionId, 's-1')
})
