/**
 * 模型选择（remote_task 的 model 参数）端到端分层回归：
 *
 *   1. 协议层   —— normalizeModelSelection 的容错矩阵 + validateTaskStart 落入 spec
 *   2. runner   —— buildAgentOptions 的合成矩阵（默认 × 主机指定）
 *                  + headless 后端对 model 的明确拒绝（不静默忽略）
 *   3. 引擎     —— TaskEngine.runAgent 把 model 传给 runner.run
 *
 * 不变式：只传**选择**，不传凭证 —— 模型 key 始终在副机。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { normalizeModelSelection, validateTaskStart } from '../lib/protocol.js'
import { buildAgentOptions, HeadlessRunner } from '../lib/node/runner.js'
import { TaskEngine } from '../lib/node/task-engine.js'
import { TaskStore } from '../lib/node/task-store.js'
import { ArtifactService } from '../lib/node/artifact-service.js'
import { TASK_STATUS } from '../lib/protocol.js'

/* ══════════════════ 1. 协议层 ══════════════════ */

test('normalizeModelSelection：裸模型名 → { model }', () => {
  assert.deepEqual(normalizeModelSelection('deepseek-chat'), { model: 'deepseek-chat' })
})

test('normalizeModelSelection：provider/model 字符串 → 成对', () => {
  assert.deepEqual(normalizeModelSelection('openai/gpt-4o'), { provider: 'openai', model: 'gpt-4o' })
})

test('normalizeModelSelection：对象逐字段过滤，类型不对的字段丢弃', () => {
  assert.deepEqual(
    normalizeModelSelection({ provider: 'openai', model: 'gpt-4o', reasoningEffort: 'high', junk: 1 }),
    { provider: 'openai', model: 'gpt-4o', reasoningEffort: 'high' },
  )
  // 数字/布尔字段不是 string → 丢弃
  assert.deepEqual(normalizeModelSelection({ provider: 42, model: 'm' }), { model: 'm' })
})

test('normalizeModelSelection：垃圾输入一律 undefined（回到副机默认，不透传垃圾）', () => {
  for (const bad of [undefined, null, '', '   ', 42, true, [], ['a'], {}]) {
    assert.equal(normalizeModelSelection(bad), undefined, String(JSON.stringify(bad)))
  }
  // 只有 provider 没有 model：provider 必须配 model，单独 provider 无效
  assert.equal(normalizeModelSelection({ provider: 'openai' }), undefined)
})

test('normalizeModelSelection：超长截断（防垃圾吃帧）', () => {
  const out = normalizeModelSelection(`${'a'.repeat(200)}/${'b'.repeat(200)}`)
  assert.equal(out.provider.length, 64)
  assert.equal(out.model.length, 128)
})

test('validateTaskStart：model 落入 spec；exec 模式同样保留（引擎侧决定是否使用）', () => {
  const v = validateTaskStart({ taskId: 't', goal: 'g', mode: 'agent', model: 'openai/gpt-4o' })
  assert.equal(v.ok, true)
  assert.deepEqual(v.spec.model, { provider: 'openai', model: 'gpt-4o' })

  const v2 = validateTaskStart({ taskId: 't', goal: 'g', mode: 'exec', model: 'm1' })
  assert.equal(v2.ok, true)
  assert.deepEqual(v2.spec.model, { model: 'm1' })

  const v3 = validateTaskStart({ taskId: 't', goal: 'g', model: 42 })
  assert.equal(v3.spec.model, undefined)
})

/* ══════════════════ 2. buildAgentOptions 合成矩阵 ══════════════════ */

test('buildAgentOptions：无默认 + 无指定 → undefined（DSH 自己的默认行为）', () => {
  assert.equal(buildAgentOptions(undefined, undefined), undefined)
})

test('buildAgentOptions：无默认 + 主机指定成对 → 直接用主机的', () => {
  assert.deepEqual(buildAgentOptions(undefined, { provider: 'openai', model: 'gpt-4o' }), {
    provider: 'openai',
    model: 'gpt-4o',
  })
})

test('buildAgentOptions：只指定模型 → 借副机默认 provider', () => {
  assert.deepEqual(
    buildAgentOptions({ provider: 'deepseek', model: 'deepseek-chat' }, { model: 'deepseek-reasoner' }),
    { provider: 'deepseek', model: 'deepseek-reasoner' },
  )
})

test('buildAgentOptions：成对覆盖 + reasoningEffort 主机优先、缺省继承', () => {
  assert.deepEqual(
    buildAgentOptions(
      { provider: 'p1', model: 'm1', reasoningEffort: 'low' },
      { provider: 'p2', model: 'm2' },
    ),
    { provider: 'p2', model: 'm2', reasoningEffort: 'low' },
  )
  assert.deepEqual(
    buildAgentOptions(
      { provider: 'p1', model: 'm1', reasoningEffort: 'low' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    ).reasoningEffort,
    'high',
  )
})

test('buildAgentOptions：默认缺 provider（不成对）+ 主机只给 model → undefined（无 provider 可借）', () => {
  assert.equal(buildAgentOptions({ model: 'm1' }, { model: 'm2' }), undefined)
})

/* ══════════════════ 3. headless 后端拒绝指定模型 ══════════════════ */

test('HeadlessRunner：指定 model 时明确拒绝（modelUnsupported），不 spawn 进程', async () => {
  const runner = new HeadlessRunner({ dshBin: '/nope/definitely-not-here', platform: 'posix' })
  const res = await runner.run({
    goal: '随便什么任务书',
    cwd: os.tmpdir(),
    timeoutMs: 1000,
    model: { provider: 'openai', model: 'gpt-4o' },
  })
  assert.equal(res.ok, false)
  assert.equal(res.modelUnsupported, true)
  assert.match(res.stderr, /headless/)
  assert.match(res.stderr, /不支持指定模型/)
})

test('HeadlessRunner：不指定 model 时保持原行为（会尝试 spawn 并失败于 ENOENT，而不是 modelUnsupported）', async () => {
  const runner = new HeadlessRunner({ dshBin: '/nope/definitely-not-here', platform: 'posix' })
  const res = await runner.run({ goal: 'x', cwd: os.tmpdir(), timeoutMs: 1000 })
  assert.equal(res.ok, false)
  assert.equal(res.modelUnsupported, undefined)
})

/* ══════════════════ 4. 引擎把 model 传给 runner ══════════════════ */

/** 与 engine-e2e 同款的最小装配，但 runner 捕获 run() 的入参。 */
function makeEngine(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-'))
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch { /* 临时目录，尽力清理 */ }
  })
  const workspace = path.join(root, 'ws')
  fs.mkdirSync(workspace, { recursive: true })

  const runArgs = []
  const runner = {
    kind: 'fake',
    async run(o) {
      runArgs.push(o)
      return { ok: true, exitCode: 0, final: 'done', toolCalls: [], durationMs: 1, sessionId: null }
    },
    async cancel() { return true },
    killAll() {},
    async disposeAll() {},
  }

  const frames = []
  const engine = new TaskEngine({
    store: new TaskStore(path.join(root, 'state')),
    artifacts: new ArtifactService({ nodeId: 'test-node', caseInsensitive: true }),
    runner,
    nodeId: 'test-node',
    roots: [workspace],
    denyPaths: [],
    defaultWorkspace: workspace,
    caseInsensitive: true,
    send: (type, data) => frames.push({ type, data }),
    logger: undefined,
    maxConcurrent: 1,
  })
  return { engine, frames, workspace, runner, runArgs }
}

const waitFrame = async (frames, type, pred) => {
  for (let i = 0; i < 200; i += 1) {
    const hit = frames.find((f) => f.type === type && (!pred || pred(f.data)))
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timeout waiting for ${type}; got: ${frames.map((f) => f.type).join(', ')}`)
}

test('TaskEngine：agent 任务的 model 选择传到 runner.run', async (t) => {
  const { engine, frames, workspace, runArgs } = makeEngine(t)

  const v = validateTaskStart({
    taskId: 't-model-1',
    goal: '写一个文件',
    mode: 'agent',
    workspace,
    model: 'openai/gpt-4o',
  })
  assert.equal(v.ok, true)
  engine.accept(v.spec)

  await waitFrame(frames, 'task/end', (d) => d.taskId === 't-model-1' && d.status === TASK_STATUS.COMPLETED)
  assert.equal(runArgs.length, 1)
  assert.deepEqual(runArgs[0].model, { provider: 'openai', model: 'gpt-4o' })
})

test('TaskEngine：不指定 model 时 runner 收到 undefined（副机默认路径不受影响）', async (t) => {
  const { engine, frames, workspace, runArgs } = makeEngine(t)

  const v = validateTaskStart({ taskId: 't-model-2', goal: '写一个文件', mode: 'agent', workspace })
  engine.accept(v.spec)

  await waitFrame(frames, 'task/end', (d) => d.taskId === 't-model-2' && d.status === TASK_STATUS.COMPLETED)
  assert.equal(runArgs[0].model, undefined)
})
