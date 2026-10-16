/**
 * 负载感知自动路由测试（提案 #14）。
 *
 * 覆盖 pickAutoNode 的逐级比较语义（在跑任务数 → CPU → 内存 → nodeId 字典序）
 * 与 resolveNodeId 的三种形态（显式指定 / 唯一在线 / 多节点自动选），
 * 以及 agent 模式的 agentMode 能力过滤。
 *
 * 节点记录直接摆进 registry.nodes（与 resilience.test.js 同款手法），
 * 不需要真连接 —— 选节点只读 online/hello/resource/tasks 投影。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { NodeRegistry } from '../lib/hub/node-registry.js'
import { resolveNodeId } from '../lib/hub/tools.js'
import { RemoteAgentError, TASK_STATUS } from '../lib/protocol.js'

/** 造一个 registry + 若干在线节点（hello/resource 可按用例覆写）。 */
function setup(t, nodes) {
  const registry = new NodeRegistry({ log: () => {} })
  for (const n of nodes) {
    registry.nodes.set(n.nodeId, {
      nodeId: n.nodeId,
      online: true,
      hello: { agentMode: n.agentMode !== false },
      resource: n.resource ?? null,
      tasks: new Map(),
      conn: null,
    })
    if (n.activeTasks) {
      for (let i = 0; i < n.activeTasks; i += 1) {
        registry.nodes.get(n.nodeId).tasks.set(`${n.nodeId}-t${i}`, { status: TASK_STATUS.RUNNING })
      }
    }
  }
  t.after(() => registry.dispose())
  return registry
}

function onlineRecord(registry, nodeId) {
  return registry.nodes.get(nodeId)
}

test('pickAutoNode：在跑任务数最少优先（第一级）', (t) => {
  const registry = setup(t, [
    { nodeId: 'busy', activeTasks: 2, resource: { cpuPct: 1 } },
    { nodeId: 'idle', activeTasks: 0, resource: { cpuPct: 99 } },
  ])
  assert.equal(registry.pickAutoNode(), 'idle')
})

test('pickAutoNode：任务数打平时 CPU 低者胜（第二级）', (t) => {
  const registry = setup(t, [
    { nodeId: 'hot', activeTasks: 1, resource: { cpuPct: 90 } },
    { nodeId: 'cool', activeTasks: 1, resource: { cpuPct: 10 } },
  ])
  assert.equal(registry.pickAutoNode(), 'cool')
})

test('pickAutoNode：CPU 打平（无遥测）时内存占比低者胜（第三级）', (t) => {
  const registry = setup(t, [
    { nodeId: 'memfull', activeTasks: 1, resource: { memUsedMb: 14000, memTotalMb: 16000 } },
    { nodeId: 'memfree', activeTasks: 1, resource: { memUsedMb: 2000, memTotalMb: 16000 } },
  ])
  // 两边都没有 cpuPct → CPU 级同为 +Inf 打平 → 进内存级
  assert.equal(registry.pickAutoNode(), 'memfree')
})

test('pickAutoNode：全打平时按 nodeId 字典序稳定收敛', (t) => {
  const registry = setup(t, [{ nodeId: 'bbb' }, { nodeId: 'aaa' }, { nodeId: 'ccc' }])
  assert.equal(registry.pickAutoNode(), 'aaa')
})

test('pickAutoNode：agent 模式过滤掉 agentMode=false 的节点', (t) => {
  const registry = setup(t, [
    { nodeId: 'exec-only', agentMode: false, activeTasks: 0 },
    { nodeId: 'agent-ok', agentMode: true, activeTasks: 3 },
  ])
  // exec：无能力要求，'exec-only' 因任务少胜出
  assert.equal(registry.pickAutoNode({ mode: 'exec' }), 'exec-only')
  // agent：只有 'agent-ok' 有能力
  assert.equal(registry.pickAutoNode({ mode: 'agent' }), 'agent-ok')
  // 全部不支持 agent → null
  registry.nodes.get('agent-ok').hello.agentMode = false
  assert.equal(registry.pickAutoNode({ mode: 'agent' }), null)
})

test('pickAutoNode：无在线节点 → null', (t) => {
  const registry = setup(t, [])
  assert.equal(registry.pickAutoNode(), null)
})

test('resolveNodeId：显式指定优先，且不受自动路由影响', (t) => {
  const registry = setup(t, [
    { nodeId: 'busy', activeTasks: 5 },
    { nodeId: 'idle', activeTasks: 0 },
  ])
  assert.equal(resolveNodeId(registry, 'busy'), 'busy')
  assert.throws(() => resolveNodeId(registry, 'ghost'), RemoteAgentError)
})

test('resolveNodeId：零在线节点 → 明确报错（旧语义保持）', (t) => {
  const registry = setup(t, [])
  assert.throws(() => resolveNodeId(registry), /no online node/)
})

test('resolveNodeId：多节点不再报错，改自动选（提案 #14 的行为变更点）', (t) => {
  const registry = setup(t, [
    { nodeId: 'busy', activeTasks: 2 },
    { nodeId: 'idle', activeTasks: 0 },
  ])
  assert.equal(resolveNodeId(registry), 'idle')
})

test('resolveNodeId：agent 模式无可用节点时报错并点名原因', (t) => {
  const registry = setup(t, [{ nodeId: 'exec-only', agentMode: false }])
  assert.throws(() => resolveNodeId(registry, undefined, { mode: 'agent' }), /agent mode/)
})
