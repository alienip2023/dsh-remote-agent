import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TASKS_SERVICE, createHubTasksService } from '../lib/hub/tasks-service.js'

function makeRegistry() {
  const records = [
    { taskId: 'older', startedAt: 10, status: 'running', nodeId: 'node-a', exit: null,
      summary: { text: 'working', privateDetail: 'hidden' }, spec: { secret: 'hidden' }, waiters: new Set() },
    { taskId: 'newer', startedAt: 30, status: 'completed', nodeId: 'node-b',
      exit: { code: 0, privateDetail: 'hidden' }, summary: { text: 'done', privateDetail: 'hidden' },
      spec: { secret: 'hidden' }, waiters: new Set() },
    { taskId: 'pending', startedAt: 0, status: 'pending', nodeId: 'node-a', exit: null,
      summary: { text: '' }, spec: { secret: 'hidden' }, waiters: new Set() },
  ]
  const calls = []
  const registry = {
    listTasks() { return records },
    getTask(id) { return records.find(task => task.taskId === id) },
    taskView(task) {
      assert.equal(this, registry)
      calls.push(task)
      return {
        taskId: task.taskId, startedAt: task.startedAt, status: task.status, nodeId: task.nodeId,
        exit: task.exit ? { code: task.exit.code } : null,
        summary: { text: task.summary.text },
      }
    },
  }
  return { registry, records, calls }
}

test('listTasks projects each task once, drops raw fields and sorts by startedAt descending', () => {
  const { registry, records, calls } = makeRegistry()
  const service = createHubTasksService({ registry })
  assert.deepEqual(service.listTasks(), [
    { taskId: 'newer', startedAt: 30, status: 'completed', nodeId: 'node-b', exit: { code: 0 }, summary: { text: 'done' } },
    { taskId: 'older', startedAt: 10, status: 'running', nodeId: 'node-a', exit: null, summary: { text: 'working' } },
    { taskId: 'pending', startedAt: 0, status: 'pending', nodeId: 'node-a', exit: null, summary: { text: '' } },
  ])
  assert.deepEqual(calls, records)
  for (let i = 0; i < records.length; i++) assert.equal(calls[i], records[i])
  assert.deepEqual(records.map(task => task.taskId), ['older', 'newer', 'pending'])
})

test('getTask projects a known task and leaves an unknown task undefined', () => {
  const { registry, records, calls } = makeRegistry()
  const service = createHubTasksService({ registry })
  assert.deepEqual(service.getTask('newer'), {
    taskId: 'newer', startedAt: 30, status: 'completed', nodeId: 'node-b', exit: { code: 0 }, summary: { text: 'done' },
  })
  assert.equal(service.getTask('unknown'), undefined)
  assert.deepEqual(calls, [records[1]])
})

test('taskView delegates without changing the projection or registry receiver', () => {
  const task = { taskId: 'held-record' }
  const projection = { taskId: 'held-record', summaryText: 'existing projection' }
  let calls = 0
  const registry = {
    taskView(input) {
      assert.equal(this, registry)
      assert.equal(input, task)
      calls++
      return projection
    },
  }
  const service = createHubTasksService({ registry })
  assert.equal(service.taskView(task), projection)
  assert.equal(service.taskView(undefined), undefined)
  assert.equal(calls, 1)
})

test('missing registry returns empty results and warns exactly once across repeated reads', () => {
  for (const registry of [undefined, null]) {
    const logs = []
    const service = createHubTasksService({ registry, log: (...args) => logs.push(args) })
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(service.listTasks(), [])
      assert.equal(service.getTask('unknown'), undefined)
      assert.equal(service.taskView({ taskId: 'held-record' }), undefined)
    }
    assert.equal(logs.length, 1)
    assert.equal(logs[0][0], 'warn')
    assert.ok(logs[0][1].includes(TASKS_SERVICE))
  }
})

for (const missing of ['listTasks', 'getTask', 'taskView']) {
  test(`registry lacking ${missing} degrades safely and warns once`, () => {
    const { registry, records } = makeRegistry()
    delete registry[missing]
    const logs = []
    const service = createHubTasksService({ registry, log: (...args) => logs.push(args) })
    for (let i = 0; i < 2; i++) {
      if (missing === 'listTasks' || missing === 'taskView') assert.deepEqual(service.listTasks(), [])
      if (missing === 'getTask' || missing === 'taskView') assert.equal(service.getTask('newer'), undefined)
      if (missing === 'taskView') assert.equal(service.taskView(records[0]), undefined)
    }
    assert.equal(logs.length, 1)
    assert.equal(logs[0][0], 'warn')
  })
}

test('empty registry returns no rows without warning', () => {
  const logs = []
  const service = createHubTasksService({ registry: { listTasks: () => [], taskView() { assert.fail('no task to project') } },
    log: (...args) => logs.push(args) })
  assert.deepEqual(service.listTasks(), [])
  assert.deepEqual(logs, [])
})

test('missing registry remains safe without a logger or with a throwing logger', () => {
  for (const options of [undefined, { log() { throw new Error('logger unavailable') } }]) {
    const service = createHubTasksService(options)
    assert.deepEqual(service.listTasks(), [])
    assert.equal(service.getTask('unknown'), undefined)
    assert.equal(service.taskView({}), undefined)
  }
})

test('dispose releases the registry and tolerates repeated disposal', () => {
  const { registry, calls } = makeRegistry()
  const service = createHubTasksService({ registry })
  service.dispose()
  service.dispose()
  assert.deepEqual(service.listTasks(), [])
  assert.equal(service.getTask('newer'), undefined)
  assert.equal(service.taskView({}), undefined)
  assert.deepEqual(calls, [])
})

function makeCtx() {
  const services = new Map()
  const calls = []
  return {
    calls,
    provide(key, value) {
      if (services.has(key)) throw new Error(`service "${key}" has been registered`)
      calls.push(['provide', key])
      services.set(key, value)
    },
    get(key) { return services.get(key) },
    set(key, value) {
      if (!services.has(key)) throw new Error(`cannot set property "${key}" without provide`)
      calls.push(['set', key])
      services.set(key, value)
    },
  }
}

// Execute the actual applyHub registration block in isolation: no hub runtime or sockets.
const hubSource = readFileSync(new URL('../lib/hub/index.js', import.meta.url), 'utf8')
const wiringStart = hubSource.indexOf('  const tasks = createHubTasksService(')
const wiringEnd = hubSource.indexOf('\n  // M2：config-sync', wiringStart)
assert.ok(wiringStart >= 0 && wiringEnd > wiringStart, 'hub tasks registration block must exist')
const wireTasks = new Function('ctx', 'registry', 'log', 'TASKS_SERVICE', 'createHubTasksService',
  `${hubSource.slice(wiringStart, wiringEnd)}\nreturn tasks`)

test('hub wiring provides remote-agent:tasks so cordis get can read it', () => {
  const ctx = makeCtx()
  const { registry } = makeRegistry()
  const logs = []
  assert.equal(TASKS_SERVICE, 'remote-agent:tasks')
  const service = wireTasks(ctx, registry, (...args) => logs.push(args), TASKS_SERVICE, createHubTasksService)
  assert.equal(ctx.get('remote-agent:tasks'), service)
  assert.equal(service.getTask('newer').status, 'completed')
  assert.deepEqual(ctx.calls, [['provide', TASKS_SERVICE]])
  assert.deepEqual(logs, [])
})

test('hub wiring overwrites an already provided tasks service with set', () => {
  const ctx = makeCtx()
  const previous = { stale: true }
  ctx.provide(TASKS_SERVICE, previous)
  const logs = []
  const { registry } = makeRegistry()
  const service = wireTasks(ctx, registry, (...args) => logs.push(args), TASKS_SERVICE, createHubTasksService)
  assert.equal(ctx.get(TASKS_SERVICE), service)
  assert.notEqual(service, previous)
  assert.deepEqual(ctx.calls, [['provide', TASKS_SERVICE], ['set', TASKS_SERVICE]])
  assert.deepEqual(logs, [])
})

test('hub wiring catches registration failure and logs the service name', () => {
  const ctx = makeCtx()
  ctx.provide = () => { throw new Error('provide failed') }
  const { registry } = makeRegistry()
  const logs = []
  assert.doesNotThrow(() => wireTasks(ctx, registry, (...args) => logs.push(args), TASKS_SERVICE, createHubTasksService))
  assert.deepEqual(logs, [['warn', 'remote-agent:tasks provide failed', { error: 'provide failed' }]])
})
