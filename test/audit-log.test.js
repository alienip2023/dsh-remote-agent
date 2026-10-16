/**
 * 审计日志测试（提案 #19）。
 *
 * 覆盖四层：
 *   1. JSONL 写入契约（一行一条、ts/event 字段、脱敏、截断）
 *   2. 轮转（maxBytes 触发、maxFiles 封顶、maxFiles=1 清空语义）
 *   3. 失败隔离（目录被删 / 目录不可建 → record 不抛、hub 不受影响、限频告警）
 *   4. 集成（NodeRegistry.createTask/cancelTask、PullManager 的 start/end 钩子）
 *
 * 写入是异步 fire-and-forget，所有文件断言都要等队列排空：统一用
 * `audit.dispose()`（它返回排空后的 promise）——这也是生产 teardown 的同款语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAuditLog, AUDIT_FILE_NAME } from '../lib/hub/audit-log.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'
import { PullManager } from '../lib/hub/pull-manager.js'

function tmpDir(t) {
  const dir = fs.realpathSync.native
    ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-')))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return dir
}

function readLines(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, AUDIT_FILE_NAME), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

test('record 写 JSONL：一行一条、ts/event/fields 齐、文件落 stateDir', async (t) => {
  const dir = tmpDir(t)
  const audit = createAuditLog({ dir, log: () => {} })
  audit.record('task.dispatch', { taskId: 't-1', nodeId: 'n1', mode: 'exec' })
  await audit.dispose()

  const lines = readLines(dir)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].event, 'task.dispatch')
  assert.equal(lines[0].taskId, 't-1')
  assert.equal(lines[0].nodeId, 'n1')
  assert.equal(lines[0].mode, 'exec')
  // ts 是 ISO 字符串且可解析
  assert.equal(typeof lines[0].ts, 'string')
  assert.equal(Number.isNaN(Date.parse(lines[0].ts)), false)
})

test('敏感键打码 + 超长值截断（凭证与整段任务书绝不整段落盘）', async (t) => {
  const dir = tmpDir(t)
  const audit = createAuditLog({ dir, log: () => {} })
  audit.record('task.dispatch', {
    nodeToken: 'nt_super_secret',
    password: 'hunter2',
    goal: 'g'.repeat(1000),
    taskId: 't-2',
  })
  await audit.dispose()

  const lines = readLines(dir)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].nodeToken, '***')
  assert.equal(lines[0].password, '***')
  // 400 字符截断（与 hub-util 的日志截断同口径）+ 省略号
  assert.equal(lines[0].goal.length, 401)
  assert.ok(lines[0].goal.endsWith('…'))
  assert.equal(lines[0].taskId, 't-2')
})

test('值级打码：正文里的 token 形态字符串也打 ***（真机验证 §4③ 揪出的缺口）', async (t) => {
  const dir = tmpDir(t)
  const audit = createAuditLog({ dir, log: () => {} })
  audit.record('task.dispatch', {
    taskId: 't-3',
    // 键名不含敏感词，但值里内嵌凭证 —— 修复前原样落盘
    goal: 'curl -H "Authorization: Bearer sk-live-abcdef123456" https://x',
    command: 'mysql --password=p4ssw0rd db',
    url: 'https://user:tok123@corp.example/x.git',
    benign: '部署 token 轮换文档已更新', // "token" 后面没有 = 值，不应误伤
  })
  await audit.dispose()

  const lines = readLines(dir)
  assert.equal(lines.length, 1)
  const row = lines[0]
  assert.ok(!row.goal.includes('sk-live-abcdef123456'), 'sk- 前缀 token 必须打码')
  assert.ok(row.goal.includes('***'))
  assert.ok(!row.command.includes('p4ssw0rd'), 'password= 形态必须打码')
  assert.ok(!row.url.includes('tok123'), 'URL userinfo 必须打码')
  // 高精度口径：普通中文正文不受影响
  assert.equal(row.benign, '部署 token 轮换文档已更新')
  // 键名打码仍然生效（双层）
  audit.record('task.dispatch', { token: 'plain' })
  await audit.dispose()
  assert.equal(readLines(dir)[1].token, '***')
})

test('轮转：超过 maxBytes 换新文件，maxFiles 封顶，旧档依次后移', async (t) => {
  const dir = tmpDir(t)
  // maxBytes=120：约两条记录就超限；maxFiles=2：只留当前 + .1
  const audit = createAuditLog({ dir, maxBytes: 120, maxFiles: 2, log: () => {} })
  for (let i = 0; i < 6; i += 1) {
    audit.record('task.dispatch', { taskId: `t-rotate-${i}`, pad: 'x'.repeat(40) })
  }
  await audit.dispose()

  const cur = path.join(dir, AUDIT_FILE_NAME)
  const rolled = path.join(dir, `${AUDIT_FILE_NAME}.1`)
  assert.ok(fs.existsSync(cur), '当前文件存在')
  assert.ok(fs.existsSync(rolled), '.1 档存在')
  assert.equal(fs.existsSync(path.join(dir, `${AUDIT_FILE_NAME}.2`)), false, 'maxFiles=2 → 不存在 .2')
  // 封顶语义：maxFiles 档之外的最旧内容按 logrotate 惯例丢弃（不承诺全量保留），
  // 这里只钉结构：所有现存行都可解析、当前文件体积受控、且至少留有最新几条。
  for (const l of readLines(dir)) assert.equal(l.event, 'task.dispatch')
  assert.ok(fs.statSync(cur).size <= 120 + 300, '当前文件体积受控')
  const latest = readLines(dir).map((l) => l.taskId)
  assert.ok(latest.includes('t-rotate-5'), '最新一条在当前文件里')
})

test('maxFiles=1：不保留历史，轮转即清空当前文件', async (t) => {
  const dir = tmpDir(t)
  const audit = createAuditLog({ dir, maxBytes: 100, maxFiles: 1, log: () => {} })
  audit.record('task.dispatch', { taskId: 't-a', pad: 'x'.repeat(40) })
  audit.record('task.dispatch', { taskId: 't-b', pad: 'x'.repeat(40) })
  audit.record('task.dispatch', { taskId: 't-c', pad: 'x'.repeat(40) })
  await audit.dispose()

  assert.equal(fs.existsSync(path.join(dir, `${AUDIT_FILE_NAME}.1`)), false)
  const lines = readLines(dir)
  // 清空后至少还有最后一轮的写入；绝没有任何历史档
  assert.ok(lines.length >= 1 && lines.length < 3)
})

test('目录不可建：返回 no-op 形态，record 永不抛', (t) => {
  const parent = tmpDir(t)
  const blocker = path.join(parent, 'not-a-dir')
  fs.writeFileSync(blocker, 'x')
  const warns = []
  const audit = createAuditLog({ dir: blocker, log: (level, msg) => warns.push(`${level}:${msg}`) })
  assert.doesNotThrow(() => audit.record('task.dispatch', { taskId: 't' }))
  assert.equal(fs.statSync(blocker).isFile(), true, '目录创建失败不破坏已有文件')
  assert.ok(warns.some((w) => w.includes('audit dir creation failed')), '目录失败有明确告警')
})

test('写失败隔离：运行中目录被删 → record 不抛、限频告警、磁盘现状重新对齐', async (t) => {
  const dir = tmpDir(t)
  const warns = []
  const audit = createAuditLog({ dir, log: (level, msg) => warns.push(`${level}:${msg}`) })
  audit.record('task.dispatch', { taskId: 't-alive' })
  await audit.dispose()
  assert.ok(fs.existsSync(path.join(dir, AUDIT_FILE_NAME)), '第一条已落盘')

  fs.rmSync(path.join(dir, AUDIT_FILE_NAME), { force: true })
  // 删掉文件后再写：appendFile 会失败（父目录在，文件没了其实会重建——
  // 所以这里模拟"父目录没了"的更狠场景）
  fs.rmSync(dir, { recursive: true, force: true })
  assert.doesNotThrow(() => audit.record('task.dispatch', { taskId: 't-after-rm' }))
  await audit.dispose()
  assert.ok(warns.some((w) => w.includes('audit write failed')), '写失败有限频告警')
})

test('enabled:false → no-op 形态，不产生任何文件', async (t) => {
  const dir = tmpDir(t)
  const audit = createAuditLog({ dir, enabled: false, log: () => {} })
  audit.record('task.dispatch', { taskId: 't-off' })
  await audit.dispose()
  assert.equal(fs.existsSync(path.join(dir, AUDIT_FILE_NAME)), false)
})

test('集成：NodeRegistry.createTask / cancelTask 写入审计', async (t) => {
  const dir = tmpDir(t)
  const audit = createAuditLog({ dir, log: () => {} })
  const registry = new NodeRegistry({ log: () => {}, audit })
  // 直接摆一个在线节点；send stub 成功（createTask 派 TASK_START 帧失败会抛
  // node unreachable——那是真实语义，这里只测审计钩子）
  registry.nodes.set('n1', { nodeId: 'n1', online: true, tasks: new Map(), hello: {}, conn: null })
  registry.send = () => true
  const spec = {
    taskId: 't-audit-1',
    goal: '跑一遍测试',
    workspace: 'D:/work/demo',
    mode: 'exec',
    model: null,
    outputs: ['report.txt'],
    constraints: { timeoutMs: 60000, denyPaths: [] },
    origin: 'hub',
  }
  registry.createTask({ nodeId: 'n1', spec })
  registry.cancelTask('t-audit-1')
  await audit.dispose()

  const lines = readLines(dir)
  const dispatch = lines.find((l) => l.event === 'task.dispatch')
  const cancel = lines.find((l) => l.event === 'task.cancel')
  assert.ok(dispatch, 'task.dispatch 已审计')
  assert.equal(dispatch.taskId, 't-audit-1')
  assert.equal(dispatch.nodeId, 'n1')
  assert.equal(dispatch.mode, 'exec')
  assert.equal(dispatch.goal, '跑一遍测试')
  assert.equal(dispatch.outputsCount, 1)
  assert.ok(cancel, 'task.cancel 已审计')
  assert.equal(cancel.delivered, true)
})

test('集成：PullManager 的 pull.start / pull.end(ok:false) 钩子', async (t) => {
  const dir = tmpDir(t)
  const audit = createAuditLog({ dir, log: () => {} })
  const pulls = new PullManager({
    registry: {
      // send 恒 false → dispatchPull 走 failSession → pull.end ok:false
      send: () => false,
      getNode: () => ({ nodeId: 'n1', online: true, pendingPulls: new Map() }),
    },
    log: () => {},
    audit,
  })
  const dest = path.join(tmpDir(t), 'dest')
  await assert.rejects(
    pulls.pull({ nodeId: 'n1', taskId: 't-pull-1', relPath: 'a.txt', dest }),
    /node unreachable/,
  )
  await audit.dispose()

  const lines = readLines(dir)
  const start = lines.find((l) => l.event === 'pull.start')
  const end = lines.find((l) => l.event === 'pull.end')
  assert.ok(start, 'pull.start 已审计')
  assert.equal(start.taskId, 't-pull-1')
  assert.equal(start.relPath, 'a.txt')
  assert.ok(end, 'pull.end 已审计')
  assert.equal(end.ok, false)
  assert.equal(end.error, 'internal')
})
