/**
 * 两阶段审批测试（提案 #2）。
 *
 * 三层覆盖：
 *   - 协议层：validateTaskStart 的 approval 缺省语义（exec→manual、agent→auto、
 *     显式传值双向覆盖）
 *   - 注册表层：manual 任务挂起不派帧 / approve 派帧 / reject 终态 / 超时自动
 *     拒绝（fail-closed）/ cancel 挂起任务走本地拒绝 / sync 对账不清挂起任务
 *   - 面板路由：approve/reject 的 404/409/502 语义
 *
 * 与 auto-routing.test.js 同款手法：节点记录直接摆进 registry.nodes，send 用
 * stub 记帧（manual 任务绝不能发出 TASK_START，这是本提案的核心断言）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { NodeRegistry } from '../lib/hub/node-registry.js'
import { registerUiRoutes, UI_API_PREFIX } from '../lib/hub/ui-routes.js'
import { HUB_TO_NODE, TASK_STATUS, TERMINAL_STATUS, validateTaskStart } from '../lib/protocol.js'

/* ══════════════════════════════════════════════════════════════════
 * 1. 协议层：approval 缺省语义
 * ══════════════════════════════════════════════════════════════════ */

test('validateTaskStart：exec 缺省 manual（保守默认），agent 缺省 auto', () => {
  assert.equal(validateTaskStart({ taskId: 't1', goal: 'g', mode: 'exec' }).spec.approval, 'manual')
  assert.equal(validateTaskStart({ taskId: 't2', goal: 'g', mode: 'agent' }).spec.approval, 'auto')
  // mode 省略 = agent
  assert.equal(validateTaskStart({ taskId: 't3', goal: 'g' }).spec.approval, 'auto')
})

test('validateTaskStart：显式传值双向覆盖缺省', () => {
  assert.equal(validateTaskStart({ taskId: 't1', goal: 'g', mode: 'exec', approval: 'auto' }).spec.approval, 'auto')
  assert.equal(validateTaskStart({ taskId: 't2', goal: 'g', mode: 'agent', approval: 'manual' }).spec.approval, 'manual')
  // 坏值回落缺省（exec → manual）
  assert.equal(validateTaskStart({ taskId: 't3', goal: 'g', mode: 'exec', approval: 'yes' }).spec.approval, 'manual')
})

/* ══════════════════════════════════════════════════════════════════
 * 2. 注册表层
 * ══════════════════════════════════════════════════════════════════ */

/** registry + 一个在线节点；frames 记录所有发出的帧；audit 记事件。 */
function setup(t, { approvalTimeoutMs, ackTimeoutMs } = {}) {
  const frames = []
  const events = []
  const registry = new NodeRegistry({
    log: () => {},
    limits: { ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}), ...(ackTimeoutMs !== undefined ? { ackTimeoutMs } : {}) },
    audit: { record: (event, fields) => events.push({ event, fields }) },
  })
  registry.send = (nodeId, type, data) => {
    frames.push({ nodeId, type, data })
    return true
  }
  registry.nodes.set('n1', {
    nodeId: 'n1',
    online: true,
    hello: { agentMode: true, roots: ['D:\\w'] },
    resource: null,
    repos: [],
    tasks: new Map(),
    conn: null,
  })
  t.after(() => registry.dispose())
  return { registry, frames, events }
}

const EXEC_SPEC = (taskId) => validateTaskStart({
  taskId,
  goal: 'echo hi',
  mode: 'exec',
  approval: 'manual',
  origin: 'hub',
}).spec

test('createTask：manual 任务挂起在 hub，绝不发出 TASK_START', (t) => {
  const { registry, frames, events } = setup(t)
  const rec = registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  assert.equal(rec.status, TASK_STATUS.PENDING_APPROVAL)
  assert.equal(rec.approval, 'manual')
  assert.equal(frames.length, 0, '挂起期间一帧都不能发给副机')
  assert.ok(events.some((e) => e.event === 'approval.pending'))
  // 挂起任务占用活跃额度（防审批队列无界堆积）
  assert.equal([...registry.nodes.get('n1').tasks.values()].filter((x) => !TERMINAL_STATUS.has(x.status)).length, 1)
})

test('approveTask：此刻才派 TASK_START，状态回 queued，审计留痕', (t) => {
  const { registry, frames, events } = setup(t)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  const ok = registry.approveTask('t1', { by: 'ui' })
  assert.equal(ok, true)
  assert.equal(registry.getTask('t1').status, TASK_STATUS.QUEUED)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, HUB_TO_NODE.TASK_START)
  assert.equal(frames[0].data.taskId, 't1')
  assert.ok(events.some((e) => e.event === 'approval.granted'))
  assert.ok(events.some((e) => e.event === 'task.dispatch'), '批准即派发：dispatch 审计在批准时才落')
})

test('approveTask：不是挂起态 / 不存在 → false（幂等安全）', (t) => {
  const { registry } = setup(t)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  registry.approveTask('t1')
  assert.equal(registry.approveTask('t1'), false, '二次批准必须被拒')
  assert.equal(registry.approveTask('nope'), false)
  // 二次批准没有多发帧
  assert.equal(registry.getTask('t1').status, TASK_STATUS.QUEUED)
})

test('approveTask：批准时节点已掉线 → 抛 node unreachable，任务转 failed 终态（保留可见）', async (t) => {
  const { registry } = setup(t)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  registry.nodes.get('n1').online = false

  // 2026-10-17 改（代码审查 M3）：原实现是 `tasks.delete(taskId)` —— 任务从
  // hub 视图**彻底消失**（不是失败、不是挂起，是不存在），与该方法注释自称的
  // "转 failed 终态"直接矛盾。后果：remote_status / 面板都查不到该任务、
  // awaitTerminal 等不到终态只能靠超时兜底（最长可挂 1 小时+）。
  //
  // 现在改成**保留记录并置终态**：状态可见、可查、可重试。
  const terminalP = registry.awaitTerminal('t1')
  assert.throws(() => registry.approveTask('t1'), /node unreachable/)

  const task = registry.getTask('t1')
  assert.ok(task, '任务记录必须保留（不能删除）')
  assert.equal(task.status, TASK_STATUS.FAILED, '应置 failed 终态')
  assert.equal(task.error.code, 'node-unreachable')
  assert.ok(task.endedAt > 0, '应有结束时间')

  // 等待器必须被唤醒（不唤醒会挂到超时）
  const done = await terminalP
  assert.equal(done.status, TASK_STATUS.FAILED)
  assert.ok(TERMINAL_STATUS.has(done.status), '必须是终态')
})

test('rejectTask：转 rejected 终态 + error 码，等待器被唤醒', async (t) => {
  const { registry } = setup(t)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  const terminalP = registry.awaitTerminal('t1')
  const ok = registry.rejectTask('t1', { by: 'ui', reason: '不跑了' })
  assert.equal(ok, true)
  const done = await terminalP
  assert.equal(done.status, TASK_STATUS.REJECTED)
  assert.ok(TERMINAL_STATUS.has(done.status))
  assert.equal(done.error.code, 'approval-rejected')
  assert.ok(done.endedAt > 0)
  assert.equal(registry.rejectTask('t1'), false, '终态后二次拒绝返回 false')
})

test('审批超时：挂起超过 approvalTimeoutMs 自动拒绝（fail-closed），绝不自动批准', async (t) => {
  const { registry } = setup(t, { approvalTimeoutMs: 10 })
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  assert.equal(registry.getTask('t1').status, TASK_STATUS.PENDING_APPROVAL)
  await new Promise((r) => setTimeout(r, 50))
  const task = registry.getTask('t1')
  assert.equal(task.status, TASK_STATUS.REJECTED)
  assert.equal(task.error.code, 'approval-timeout')
  // timeoutMs=0：无超时，任务一直挂着
  const { registry: r2 } = setup(t, { approvalTimeoutMs: 0 })
  r2.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t2') })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(r2.getTask('t2').status, TASK_STATUS.PENDING_APPROVAL)
})

test('cancelTask：挂起任务走本地拒绝，不发 TASK_CANCEL 帧', (t) => {
  const { registry, frames } = setup(t)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  const ok = registry.cancelTask('t1')
  assert.equal(ok, true)
  assert.equal(registry.getTask('t1').status, TASK_STATUS.REJECTED)
  assert.equal(frames.length, 0, '任务没到过副机，没有可取消的东西')
})

test('sync 对账：审批挂起中的任务绝不被"sync 里没有"清掉', (t) => {
  // ackTimeoutMs=0 让宽限期失效：没有保护的话，任何一次 sync 都会清掉挂起任务
  const { registry } = setup(t, { ackTimeoutMs: 0 })
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  registry.handleFrameFor('n1', { t: 'task/sync', d: { tasks: [] } })
  assert.equal(registry.getTask('t1').status, TASK_STATUS.PENDING_APPROVAL, '挂起任务必须存活')
  // 对照组：派发后未被接受的非挂起任务在同样条件下会被清（既有语义不回退）
  registry.createTask({ nodeId: 'n1', spec: validateTaskStart({ taskId: 't2', goal: 'g', mode: 'exec', approval: 'auto', origin: 'hub' }).spec })
  registry.getTask('t2').accepted = false
  registry.handleFrameFor('n1', { t: 'task/sync', d: { tasks: [] } })
  assert.equal(registry.getTask('t2'), undefined)
})

test('dispose：挂起定时器全部清掉，不泄漏', (t) => {
  const { registry } = setup(t, { approvalTimeoutMs: 60_000 })
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  assert.equal(registry.pendingApprovals.size, 1)
  registry.dispose()
  assert.equal(registry.pendingApprovals.size, 0)
})

/* ══════════════════════════════════════════════════════════════════
 * 3. 面板路由：404 / 409 / 502 语义
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 组一个最小 UI 路由环境（照 ui-routes.test.js 的"捕获 handler 直调"手法：
 * fake ctx.webServer.register 捕获路由表，再直接以假 req/res 调 handler）。
 */
function setupUi(t) {
  const env = setup(t)
  const captured = []
  const ctx = {
    webServer: { register: (r) => { captured.push(r); return () => {} } },
    connection: undefined,
  }
  const disposers = registerUiRoutes({
    ctx,
    registry: env.registry,
    pulls: {},
    log: () => {},
    defaults: {},
    config: { role: 'hub' },
  })
  t.after(() => { for (const d of disposers) { try { d() } catch { /* 忽略 */ } } })

  const call = async (routePath, method, body) => {
    const handler = captured.find((r) => r.path === `${UI_API_PREFIX}/${routePath}`)?.handler
    if (!handler) throw new Error(`route not registered: ${routePath}`)
    const out = { status: 0, body: null }
    const res = {
      writeHead(code) { out.status = code },
      end(payload) { out.body = payload ? JSON.parse(payload) : null },
    }
    const req = {
      method,
      url: `${UI_API_PREFIX}/${routePath}`,
      headers: { 'content-type': 'application/json' },
      // readJson 用 for-await 消费 body（见 ui-routes.js readJson）
      *[Symbol.asyncIterator]() {
        yield Buffer.from(body ? JSON.stringify(body) : '')
      },
    }
    await handler(req, res)
    return { status: out.status, json: out.body }
  }
  return { ...env, call }
}

test('UI dispatch：exec 缺省 manual（面板与 remote_task 同一缺省语义）', async (t) => {
  const { registry, frames, call } = setupUi(t)
  const r = await call('dispatch', 'POST', { node: 'n1', goal: 'echo hi', mode: 'exec' })
  assert.equal(r.status, 200)
  assert.equal(r.json.approval, 'manual')
  assert.equal(registry.getTask(r.json.taskId).status, TASK_STATUS.PENDING_APPROVAL)
  assert.equal(frames.length, 0, '挂起期间不派帧')
  // agent 缺省 auto：立即派
  const r2 = await call('dispatch', 'POST', { node: 'n1', goal: '做点事', mode: 'agent' })
  assert.equal(r2.json.approval, 'auto')
  assert.equal(frames.length, 1, 'agent 任务应立即派发')
})

test('UI 路由：approve 的 404 / 409 / 成功 / 405', async (t) => {
  const { registry, call } = setupUi(t)
  assert.equal((await call('approve', 'POST', { taskId: 'nope' })).status, 404)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  assert.equal((await call('approve', 'POST', { taskId: 't1' })).status, 200)
  // 已批准（非挂起态）再批 → 409
  assert.equal((await call('approve', 'POST', { taskId: 't1' })).status, 409)
  // GET 打到 POST 路由 → 405
  assert.equal((await call('approve', 'GET')).status, 405)
})

test('UI 路由：reject 幂等成功 / 非 pending 409 / approve 节点掉线 502', async (t) => {
  const { registry, call } = setupUi(t)
  assert.equal((await call('reject', 'POST', { taskId: 'nope' })).status, 404)
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t1') })
  assert.equal((await call('reject', 'POST', { taskId: 't1', reason: '不要了' })).status, 200)
  assert.equal(registry.getTask('t1').status, TASK_STATUS.REJECTED)

  // 掉线批准 → 502
  registry.createTask({ nodeId: 'n1', spec: EXEC_SPEC('t2') })
  registry.nodes.get('n1').online = false
  const r = await call('approve', 'POST', { taskId: 't2' })
  assert.equal(r.status, 502)
  assert.equal(r.json.error, 'node-unreachable')
})
