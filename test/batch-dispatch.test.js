import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { NodeRegistry } from '../lib/hub/node-registry.js'
import { registerRemoteTools } from '../lib/hub/tools.js'
import { HUB_TO_NODE, NODE_TO_HUB, RemoteAgentError, TASK_STATUS } from '../lib/protocol.js'

// 使用真实 registry 的路由、审批、任务存储和回执等待，只替换网络传输。
function setup(t, { roots = ['/srv/work'], caps = [], report = { verdict: 'ok' } } = {}) {
  const frames = []
  const checks = []
  const tools = new Map()
  const registry = new NodeRegistry({ log: () => {}, limits: { approvalTimeoutMs: 0, ackTimeoutMs: 100 } })
  registry.nodes.set('n1', {
    nodeId: 'n1', online: true, hello: { agentMode: true, roots, caps },
    resource: null, repos: [], tasks: new Map(), conn: null,
  })
  registry.send = (nodeId, type, data) => {
    frames.push({ nodeId, type, data })
    if (type === HUB_TO_NODE.TASK_START) {
      registry.handleFrameFor(nodeId, {
        t: NODE_TO_HUB.TASK_ACCEPT,
        d: { taskId: data.taskId, status: TASK_STATUS.QUEUED, workspace: data.workspace ?? roots[0], runner: 'fake' },
      })
    }
    return true
  }
  registry.fsRequest = async (...args) => { checks.push(args); return report }
  const disposers = registerRemoteTools({
    ctx: { tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } } },
    registry, pulls: {}, defaults: {},
  })
  t.after(() => { for (const dispose of disposers) dispose(); registry.dispose() })
  const call = (name, args, exec) => {
    assert.ok(tools.has(name), `tool registered: ${name}`)
    return tools.get(name).execute(args, exec)
  }
  return { registry, frames, checks, tools, call, batch: (args, exec) => call('remote_task_batch', args, exec) }
}

test('batch：3 条任务返回不同 taskId，全部 accepted，规格完整透传', async (t) => {
  const env = setup(t)
  const tasks = [0, 1, 2].map((i) => ({ goal: `task ${i}`, node: 'n1', mode: 'agent', timeoutMs: 1200 + i, outputs: [`out${i}.txt`] }))
  const out = await env.batch({ tasks })
  assert.equal(out.accepted, 3)
  assert.equal(out.rejected, 0)
  assert.equal(out.results.length, 3)
  assert.equal(new Set(out.results.map((r) => r.taskId)).size, 3)
  for (const [index, r] of out.results.entries()) {
    assert.ok(r.taskId)
    assert.deepEqual({ ...r, taskId: '' }, { index, taskId: '', node: 'n1', accepted: true, workspace: '/srv/work', mode: 'agent', status: 'queued' })
    const spec = env.registry.getTask(r.taskId).spec
    assert.equal(spec.goal, tasks[index].goal)
    assert.equal(spec.constraints.timeoutMs, tasks[index].timeoutMs)
    assert.deepEqual(spec.outputs, tasks[index].outputs)
  }
  assert.equal(env.frames.length, 3)
})

test('batch：中间路由失败不影响其余任务', async (t) => {
  const env = setup(t)
  const out = await env.batch({ tasks: [{ goal: 'first' }, { goal: 'bad', node: 'ghost' }, { goal: 'last' }] })
  assert.equal(out.accepted, 2)
  assert.equal(out.rejected, 1)
  assert.deepEqual(out.results.map((r) => r.accepted), [true, false, true])
  assert.equal(out.results[1].index, 1)
  assert.equal(out.results[1].node, 'ghost')
  assert.match(out.results[1].error.message, /ghost/)
  assert.equal(env.registry.tasks.size, 2)
})

for (const name of ['remote_task', 'remote_task_batch']) {
  const dispatch = (env, task, extra = {}) => name === 'remote_task'
    ? env.call(name, { ...task, ...extra })
    : env.batch({ tasks: [task], ...extra }).then((out) => out.results[0])

  test(`${name}：相对 workspace 在 roots[0] 下归一化`, async (t) => {
    const env = setup(t)
    const out = await dispatch(env, { goal: 'work', workspace: 'bots/tmp/../rb1' })
    assert.equal(out.workspace, '/srv/work/bots/rb1')
    assert.equal(env.registry.getTask(out.taskId).spec.workspace, out.workspace)
    assert.equal(env.frames[0].data.workspace, out.workspace)
  })

  test(`${name}：绝对 workspace 保持原值，包括其他允许的 root`, async (t) => {
    const env = setup(t, { roots: ['/srv/work', '/opt/projects'] })
    const out = await dispatch(env, { goal: 'work', workspace: '/opt/projects/rb1' })
    assert.equal(out.workspace, '/opt/projects/rb1')
    assert.equal(env.frames[0].data.workspace, out.workspace)
  })

  test(`${name}：缺少 roots 时相对 workspace 返回 workspace-unresolved`, async (t) => {
    const env = setup(t, { roots: [] })
    delete env.registry.getNode('n1').hello.roots
    if (name === 'remote_task') {
      await assert.rejects(dispatch(env, { goal: 'work', workspace: 'bots/rb1' }), { code: 'workspace-unresolved' })
    } else {
      const out = await dispatch(env, { goal: 'work', workspace: 'bots/rb1' })
      assert.equal(out.error.code, 'workspace-unresolved')
    }
    assert.equal(env.registry.tasks.size, 0)
    assert.equal(env.frames.length, 0)
  })

  test(`${name}：拒绝 ../../etc 和相同前缀的兄弟目录`, async (t) => {
    const env = setup(t)
    for (const workspace of ['../../etc', '../work-other/bot']) {
      if (name === 'remote_task') {
        await assert.rejects(dispatch(env, { goal: 'work', workspace }), { code: 'workspace-escape' })
      } else {
        const out = await dispatch(env, { goal: 'work', workspace })
        assert.equal(out.accepted, false)
        assert.equal(out.error.code, 'workspace-escape')
      }
    }
    assert.equal(env.registry.tasks.size, 0)
    assert.equal(env.frames.length, 0)
  })

  test(`${name}：按 Windows 节点 roots 解析并拦截反斜杠逃逸`, async (t) => {
    const env = setup(t, { roots: ['D:\\work'] })
    const out = await dispatch(env, { goal: 'work', workspace: 'bots/rb1' })
    assert.equal(out.workspace, path.win32.join('D:\\work', 'bots/rb1'))
    if (name === 'remote_task') {
      await assert.rejects(dispatch(env, { goal: 'work', workspace: '..\\..\\etc' }), { code: 'workspace-escape' })
    } else {
      const bad = await dispatch(env, { goal: 'work', workspace: '..\\..\\etc' })
      assert.equal(bad.error.code, 'workspace-escape')
    }
    assert.equal(env.frames.length, 1)
  })
}

test('batch：dryRun 逐条预览并校验，不落库、不派发、不自检', async (t) => {
  const env = setup(t, { caps: ['selfcheck'] })
  const out = await env.batch({ dryRun: true, tasks: [
    { goal: 'agent', workspace: 'bots/rb1' },
    { goal: 'exec', mode: 'exec' },
    { goal: 'escape', workspace: '../../etc' },
  ] })
  assert.equal(out.results.length, 3)
  for (const [i, r] of out.results.slice(0, 2).entries()) {
    assert.equal(r.index, i)
    assert.equal(r.taskId, '')
    assert.equal(r.dryRun, true)
    assert.equal(r.status, 'dry_run')
    assert.equal(r.approval, i === 0 ? 'auto' : 'manual')
  }
  assert.equal(out.results[0].workspace, '/srv/work/bots/rb1')
  assert.equal(out.results[2].error.code, 'workspace-escape')
  assert.equal(out.accepted, 0)
  assert.equal(out.rejected, 1)
  assert.equal(env.registry.tasks.size, 0)
  assert.equal(env.frames.length, 0)
  assert.equal(env.checks.length, 0)
})

test('batch：approval 省略时逐条按 mode 默认，待审批不算拒绝', async (t) => {
  const env = setup(t)
  const out = await env.batch({ tasks: [{ goal: 'exec', mode: 'exec' }, { goal: 'agent' }] })
  assert.equal(out.results[0].status, TASK_STATUS.PENDING_APPROVAL)
  assert.equal(out.results[0].accepted, false)
  assert.equal(env.registry.getTask(out.results[0].taskId).approval, 'manual')
  assert.equal(out.results[1].accepted, true)
  assert.equal(out.accepted, 1)
  assert.equal(out.rejected, 0)
  assert.equal(env.frames.length, 1)
})

test('batch：显式 approval 覆盖各任务默认值', async (t) => {
  const env = setup(t)
  const auto = await env.batch({ approval: 'auto', tasks: [{ goal: 'exec', mode: 'exec' }] })
  assert.equal(auto.results[0].accepted, true)
  const manual = await env.batch({ approval: 'manual', tasks: [{ goal: 'agent' }] })
  assert.equal(manual.results[0].status, TASK_STATUS.PENDING_APPROVAL)
  assert.equal(env.frames.length, 1)
})

test('batch：precheck 共用单条的 fresh gate，false 跳过', async (t) => {
  const env = setup(t, { caps: ['selfcheck'], report: { verdict: 'blocked', blockingFailures: [{ id: 'root-writable' }] } })
  const blocked = await env.batch({ tasks: [{ goal: 'one' }, { goal: 'two' }] })
  assert.equal(blocked.rejected, 2)
  assert.equal(env.checks.length, 2)
  assert.equal(env.registry.tasks.size, 0)
  const allowed = await env.batch({ precheck: false, tasks: [{ goal: 'one' }, { goal: 'two' }] })
  assert.equal(allowed.accepted, 2)
  assert.equal(env.checks.length, 2)
})

test('batch：缺失 goal 仅拒绝该条，后续继续', async (t) => {
  const env = setup(t)
  const out = await env.batch({ tasks: [{}, { goal: 'valid' }] })
  assert.equal(out.rejected, 1)
  assert.match(out.results[0].error.message, /task-goal-missing/)
  assert.equal(out.results[1].accepted, true)
})

test('batch：副机回绝一条任务后继续派发', async (t) => {
  const env = setup(t)
  const send = env.registry.send
  env.registry.send = (nodeId, type, data) => {
    if (type === HUB_TO_NODE.TASK_START && data.goal === 'deny') {
      env.registry.handleFrameFor(nodeId, { t: NODE_TO_HUB.TASK_END, d: {
        taskId: data.taskId, status: TASK_STATUS.FAILED,
        error: { code: 'workspace-denied', message: 'outside allowed roots' },
      } })
      return true
    }
    return send(nodeId, type, data)
  }
  const out = await env.batch({ tasks: [{ goal: 'deny', workspace: '/etc' }, { goal: 'work' }] })
  assert.equal(out.rejected, 1)
  assert.equal(out.accepted, 1)
  assert.ok(out.results[0].taskId)
  assert.equal(out.results[0].error.code, 'workspace-denied')
  assert.equal(out.results[1].accepted, true)
})

test('batch：回执等待异常保留已创建的 taskId，并传递执行 signal', async (t) => {
  const env = setup(t)
  const wait = env.registry.awaitAccepted.bind(env.registry)
  const signal = new AbortController().signal
  env.registry.awaitAccepted = (taskId, options) => {
    assert.equal(options.signal, signal)
    if (env.registry.getTask(taskId).goal === 'no ack') throw new RemoteAgentError('ack timeout', 'timeout')
    return wait(taskId, options)
  }
  const out = await env.batch({ tasks: [{ goal: 'no ack', workspace: 'bots/rb1' }, { goal: 'work' }] }, { signal })
  assert.equal(out.rejected, 1)
  assert.equal(out.accepted, 1)
  assert.ok(env.registry.getTask(out.results[0].taskId))
  assert.equal(out.results[0].node, 'n1')
  assert.equal(out.results[0].workspace, '/srv/work/bots/rb1')
  assert.equal(out.results[0].error.code, 'timeout')
})

test('batch：tasks 必须是 1–50 项数组，非法批次无副作用', async (t) => {
  const env = setup(t)
  for (const tasks of [undefined, null, {}, [], Array.from({ length: 51 }, () => ({ goal: 'work' }))]) {
    await assert.rejects(env.batch({ tasks }), /tasks.*1.*50/)
  }
  const out = await env.batch({ tasks: Array.from({ length: 50 }, () => ({ goal: 'work' })) })
  assert.equal(out.accepted, 50)
  assert.equal(env.frames.length, 50)
})
