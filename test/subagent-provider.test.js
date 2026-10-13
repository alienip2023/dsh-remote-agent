/**
 * hub 侧 subagent provider 单元测试（lib/hub/subagent-provider.js）。
 *
 * 定位：这个文件把"远程副机"接成 DSH 的一个委派目标 —— 主 agent 用普通的
 * subagent 工具派活，任务实际跑在另一台电脑上。它此前**零直接测试**，而它是
 * 主电脑与副机之间**唯一的委派入口**，出错形态又都很隐蔽：
 *
 *   - 派错机器：任务跑完、交接卡正常，只是跑在了别的电脑上。
 *   - 泄漏：provider 的返回值会进主机会话日志，副机上报的任何字段都可能被带进去。
 *   - 静默降级：异常被兜底 catch 吞掉，一个**已完成**的任务被报成"未完成"。
 *
 * ── 覆盖到的真实缺陷（已在本文件建立时修复） ──────────────────────
 *
 * [D-1] `nodeHintFromLabel` 短 id 劫持长 id：按插入顺序做 `includes`，命中即返回。
 *       同时在线 `pc` 与 `pc-2` 时，label `"run on pc-2"` 命中 `pc`（子串）→
 *       **任务派到错误的机器**。修法：最长匹配优先 + 词边界 + 等长冲突返回 ''。
 *
 * [D-2] `promptToGoal` 只认 `ContentBlock[]`：裸 string prompt 变成 ''，
 *       `start()` 于是回落到**用 label 当 goal** —— 派出去的活变成派单标题，
 *       调用方看不到任何异常。修法：字符串输入直接收下。
 *
 * [D-3] `promptToGoal` 无上界：3 MB 的 prompt 原样进 task/start 帧，
 *       而控制帧上限是 4 MiB（MAX_CONTROL_FRAME_BYTES）。修法：截断到 64 KiB
 *       并附截断标记（截断而不是抛 —— 一条超长 prompt 不该让派单失败）。
 *
 * [D-4] `stopReasonOf` 用 switch default 兜底：protocol.js 新增状态会**静默**
 *       落进 error。修法：显式全表 `STOP_REASON_BY_STATUS`，测试遍历 TASK_STATUS
 *       断言每个状态都在表里 —— 将来加状态就红。
 *
 * [D-5] `structured: handoff` **裸直出**副机上报的 handoff：workspace（绝对路径，
 *       回显主机目录结构）、logs（可能含环境变量/凭证）、以及副机版本的任何新字段
 *       全部进入主机会话日志。工具路径（remote_handoff）早已改成走 handoffView，
 *       这里漏了。修法：`structured: handoffView(handoff)`。
 *
 * [D-6] `fallbackText` 直接解引用副机上报的 `progressTail` 元素：副机上报一个
 *       `null` 就让 `p.phase` 抛 TypeError，异常被兜底 catch 吞掉 → 一个
 *       **已完成**的任务被上报成"未完成：Cannot read properties of null"。
 *       修法：改用 views.js 的 progressTailView 做元素级投影（同一份白名单）。
 *
 * [D-7] `dispose()` 在 result 已落定后仍发 `task/cancel`：任务都跑完了还取消，
 *       副机日志里多一条莫名其妙的 cancel。修法：`settled` 标记后 dispose 变 no-op。
 *
 * [D-8] `pulls` / `log` 是可选依赖但被无条件调用：少传一个就让派单在
 *       `log(...)` 处抛 TypeError（装配期少依赖 → 运行期炸在第一个任务上）。
 *       修法：两个都做兜底。
 *
 * [D-9] `defaults.timeoutMs` 只查 `Number.isFinite`：`0` / 负数被
 *       validateTaskStart 夹到下限 1000ms，于是一个配错成 `timeoutMs: -1` 的
 *       部署会让**每条任务在 1 秒后判超时** —— 比回落到 1 小时更糟（错得静默，
 *       而且看起来像"任务真的失败了"）。修法：只接受正数。
 *
 * 全部用例使用**假 registry**，不建立真实连接、不 spawn 进程、不碰真实 `~/.dsh`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STOP_REASON_BY_STATUS,
  createRemoteAgentProvider,
  nodeHintFromLabel,
  promptToGoal,
  stopReasonOf,
} from '../lib/hub/subagent-provider.js'
import { TASK_STATUS, TERMINAL_STATUS } from '../lib/protocol.js'

/** 控制字符（源码里不放裸字节，避免文件被当成二进制）。 */
const NUL = String.fromCharCode(0x00)
const SOH = String.fromCharCode(0x01)

/* ─────────────────────────── 假 registry ─────────────────────────── */

/**
 * 造一个假 registry。只实现 provider 真正用到的那几个方法，
 * 并记录调用以便断言"派给谁了 / 取消了几次"。
 */
function fakeRegistry({ online = [], terminal = null, terminalError = null, createError = null, limits } = {}) {
  const tasks = new Map()
  const calls = { createTask: [], cancelTask: [], awaitAccepted: [], awaitTerminal: [] }
  const registry = {
    calls,
    limits: limits ?? { ackTimeoutMs: 1000 },
    nodes: new Map(online.map((n) => [n.nodeId, { nodeId: n.nodeId, online: true, hello: { hostname: n.hostname ?? n.nodeId } }])),
    onlineNodes() {
      return [...this.nodes.values()].filter((r) => r.online)
    },
    createTask({ nodeId, spec }) {
      if (createError) throw createError
      calls.createTask.push({ nodeId, spec })
      const t = { taskId: spec.taskId, nodeId, status: TASK_STATUS.RUNNING, progressTail: [], logTail: [] }
      tasks.set(spec.taskId, t)
      return t
    },
    cancelTask(taskId) {
      calls.cancelTask.push(taskId)
      return true
    },
    getTask(taskId) {
      return tasks.get(taskId)
    },
    awaitAccepted(taskId, opts) {
      calls.awaitAccepted.push(opts)
      return Promise.resolve(tasks.get(taskId))
    },
    awaitTerminal(taskId, opts) {
      calls.awaitTerminal.push(opts)
      return terminalError ? Promise.reject(terminalError) : Promise.resolve(terminal)
    },
  }
  return registry
}

/** 造一个 provider + 假 pulls，返回 { provider, seen } 便于断言取消次数。 */
function makeProvider(registry, { defaults, log, pulls } = {}) {
  const seen = { cancelled: [], logs: [] }
  const fakePulls = pulls ?? { cancelTask: (id) => seen.cancelled.push(id) }
  const provider = createRemoteAgentProvider({
    registry,
    pulls: fakePulls,
    log: log ?? ((level, msg, extra) => seen.logs.push({ level, msg, extra })),
    defaults,
  })
  return { provider, pulls: fakePulls, seen }
}

/** 一个完整的终态任务记录（handoff 里的字段全部来自"副机"，视为不可信）。 */
function terminalTask(over = {}) {
  return {
    taskId: 't-1',
    nodeId: 'n1',
    status: TASK_STATUS.COMPLETED,
    progressTail: [],
    logTail: [],
    handoff: null,
    ...over,
  }
}

/* ═════════════════════════ 1. nodeHintFromLabel ═════════════════════════ */

test('nodeHintFromLabel：能从 label 里解析出节点名', () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'desktop-01' }] })
  for (const label of ['build on desktop-01', 'node:desktop-01', 'desktop-01', '请用 DESKTOP-01 跑', 'run on desktop-01.']) {
    assert.equal(nodeHintFromLabel(label, reg), 'desktop-01', `label=${label}`)
  }
})

test('nodeHintFromLabel：也能按 hostname 命中（label 里写主机名而非 id）', () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'node-a', hostname: 'DESKTOP-XYZ' }] })
  assert.equal(nodeHintFromLabel('run on desktop-xyz', reg), 'node-a')
  assert.equal(nodeHintFromLabel('DESKTOP-XYZ', reg), 'node-a')
})

test('nodeHintFromLabel：无节点名 → 返回空串（交给"唯一在线节点"规则）', () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'desktop-01' }] })
  for (const label of ['', '   ', 'do something', 'run it', null, undefined, 42]) {
    assert.equal(nodeHintFromLabel(label, reg), '', `label=${JSON.stringify(label)}`)
  }
})

test('[D-1] nodeHintFromLabel：短 id 不劫持长 id（最长匹配优先）', () => {
  // 这是本文件最关键的一条断言。修复前按插入顺序 includes 命中即返回，
  // `pc` 会先于 `pc-2` 命中 "run on pc-2" → **任务派到错误的机器**。
  const orders = [
    [{ nodeId: 'pc' }, { nodeId: 'pc-2' }],
    [{ nodeId: 'pc-2' }, { nodeId: 'pc' }],
  ]
  for (const online of orders) {
    const reg = fakeRegistry({ online })
    assert.equal(
      nodeHintFromLabel('run on pc-2', reg),
      'pc-2',
      `顺序 ${online.map((n) => n.nodeId).join(',')} 下短 id 劫持了长 id`,
    )
    // 反过来：写 pc 就该是 pc（不能因为最长匹配就把 pc 也判成 pc-2）
    assert.equal(nodeHintFromLabel('run on pc', reg), 'pc')
  }

  const reg2 = fakeRegistry({ online: [{ nodeId: 'desk' }, { nodeId: 'desktop-01' }] })
  assert.equal(nodeHintFromLabel('build on desktop-01', reg2), 'desktop-01')
  assert.equal(nodeHintFromLabel('build on desk', reg2), 'desk')
})

test('[D-1] nodeHintFromLabel：词边界 —— 不因包含关系误命中', () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'pc' }] })
  // 'apc' / 'pcx' 里含 'pc' 但不是节点名，不该命中
  assert.equal(nodeHintFromLabel('run on apc', reg), '')
  assert.equal(nodeHintFromLabel('run on pcx', reg), '')
  assert.equal(nodeHintFromLabel('xpcx', reg), '')
  // 真正的独立出现要命中
  assert.equal(nodeHintFromLabel('run on pc', reg), 'pc')
  assert.equal(nodeHintFromLabel('pc.', reg), 'pc')
  assert.equal(nodeHintFromLabel('pc:', reg), 'pc')
})

test('[D-1] nodeHintFromLabel：等长冲突 → 返回空串（不猜机器）', () => {
  // 两个不同节点以同样长度命中 label：label 不足以定位。
  // 返回 '' 让上层走"唯一在线节点"或报"请在 label 里写明节点名"——
  // 宁可让调用方补一句，不可猜错机器。
  const reg = fakeRegistry({ online: [{ nodeId: 'abc' }, { nodeId: 'abd' }] })
  assert.equal(nodeHintFromLabel('run on abc abd', reg), '')
})

test('[D-1] nodeHintFromLabel：两个节点都以完整 token 命中时，长的赢且与插入顺序无关', () => {
  // 为什么需要"最长匹配"而不是"首个命中即返回"：label 里同时出现多个节点名时，
  // "首个命中"的结果取决于 `registry.nodes` 的**插入顺序**，也就是取决于谁先连上来 ——
  // 同一个 label 在不同时刻会派到不同机器上。最长匹配给出与顺序无关的确定结果。
  const label = 'deploy on pc then verify on pc-2'
  const orders = [
    [{ nodeId: 'pc' }, { nodeId: 'pc-2' }],
    [{ nodeId: 'pc-2' }, { nodeId: 'pc' }],
  ]
  for (const online of orders) {
    const reg = fakeRegistry({ online })
    assert.equal(
      nodeHintFromLabel(label, reg),
      'pc-2',
      `顺序 ${online.map((n) => n.nodeId).join(',')} 下结果与最长匹配不符`,
    )
  }
  // 等长的两个都命中 → 无法定位，返回空串（同样与顺序无关）
  const tie = fakeRegistry({ online: [{ nodeId: 'aa' }, { nodeId: 'bb' }] })
  assert.equal(nodeHintFromLabel('aa bb', tie), '')
})

test('nodeHintFromLabel：恶意 / 畸形 label 不抛', () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1', hostname: 'h1' }] })
  const nasty = [
    'a'.repeat(1_000_000),
    ' ',
    `${NUL}${SOH}`,
    '{}[]()\\/|*?<>',
    `n1${NUL.repeat(100)}`,
    '${jquery}',
    '`whoami`',
    'n1'.repeat(10_000),
    '中文标签：n1 请跑',
    '../../etc/passwd',
  ]
  for (const label of nasty) {
    let got
    assert.doesNotThrow(() => {
      got = nodeHintFromLabel(label, reg)
    }, `label=${JSON.stringify(label).slice(0, 60)}`)
    assert.equal(typeof got, 'string')
    // 命中只能是真实存在的节点 id，不能凭空造出一个
    assert.ok(got === '' || got === 'n1', `got=${got}`)
  }
})

test('nodeHintFromLabel：registry 畸形（缺 nodes / 空 Map）不抛', () => {
  for (const reg of [{}, { nodes: null }, { nodes: new Map() }, undefined, null]) {
    let got
    assert.doesNotThrow(() => {
      got = nodeHintFromLabel('run on n1', reg)
    }, `reg=${JSON.stringify(reg)}`)
    assert.equal(got, '', `reg=${JSON.stringify(reg)}`)
  }
  // 节点记录本身畸形（nodeId 非字符串 / hello 缺失）
  const reg = fakeRegistry({ online: [] })
  reg.nodes.set('bad', { nodeId: 42, hello: null })
  reg.nodes.set('good', { nodeId: 'good', hello: undefined })
  assert.doesNotThrow(() => nodeHintFromLabel('run on good', reg))
  assert.equal(nodeHintFromLabel('run on good', reg), 'good')
})

/* ═════════════════════════ 2. promptToGoal ═════════════════════════ */

test('promptToGoal：ContentBlock[] 里的文本被拼起来', () => {
  assert.equal(promptToGoal([{ type: 'text', text: 'do A' }]), 'do A')
  assert.equal(promptToGoal([{ type: 'text', text: 'do A' }, { type: 'text', text: 'then B' }]), 'do A\n\nthen B')
  // 两端空白被 trim
  assert.equal(promptToGoal([{ type: 'text', text: '  spaced  ' }]), 'spaced')
})

test('promptToGoal：非文本块如实标注，不静默丢弃', () => {
  const goal = promptToGoal([
    { type: 'text', text: 'look at this' },
    { type: 'image', source: { data: 'xxx' } },
    { type: 'tool_use', id: 'x' },
  ])
  assert.match(goal, /look at this/)
  assert.match(goal, /\[image block omitted\]/)
  assert.match(goal, /\[tool_use block omitted\]/)
})

test('[D-2] promptToGoal：裸 string prompt 被接受（不静默变成空 goal）', () => {
  // 修复前：非数组 → blocks=[] → parts=[] → 返回 ''，于是 start() 回落到
  // **用 label 当 goal**。派出去的活变成了派单标题，调用方看不到任何异常。
  assert.equal(promptToGoal('do the thing'), 'do the thing')
  assert.equal(promptToGoal('  trimmed  '), 'trimmed')
})

test('promptToGoal：空 / 畸形 prompt 返回空串，不抛', () => {
  for (const p of [undefined, null, [], '', '   ', 42, {}, [null, undefined, 7, 'str'], [{ type: 42 }], [{}]]) {
    let got
    assert.doesNotThrow(() => {
      got = promptToGoal(p)
    }, `prompt=${JSON.stringify(p)}`)
    assert.equal(typeof got, 'string', `prompt=${JSON.stringify(p)}`)
  }
  assert.equal(promptToGoal([]), '')
  assert.equal(promptToGoal(undefined), '')
  assert.equal(promptToGoal([{ type: 'text', text: '' }]), '')
})

test('[D-3] promptToGoal：超长 prompt 被截断（有上界，不抛）', () => {
  const huge = 'x'.repeat(3_000_000)
  let goal
  assert.doesNotThrow(() => {
    goal = promptToGoal([{ type: 'text', text: huge }])
  })
  // 必须有明确上界：控制帧上限是 4 MiB，3 MB 的 goal 塞进 task/start 会撞上限。
  assert.ok(goal.length <= 70_000, `goal 未被截断：len=${goal.length}`)
  // 截断而不是拒绝：一条超长 prompt 不该让整个派单失败
  assert.match(goal, /truncated/i)
  // 内容仍然是 prompt 的开头（不是空串）
  assert.ok(goal.startsWith('x'.repeat(100)))
})

test('promptToGoal：超长非文本块的 type 名也被截断', () => {
  const goal = promptToGoal([{ type: 'z'.repeat(1_000_000) }])
  assert.ok(goal.length < 1000, `len=${goal.length}`)
})

/* ═════════════════════════ 3. stopReasonOf ═════════════════════════ */

test('[D-4] stopReasonOf：TASK_STATUS 全集都有映射（用协议常量遍历）', () => {
  // 关键断言：遍历 protocol.js 的 TASK_STATUS 全集，保证**没有遗漏的状态**。
  // 将来 protocol.js 新增一个状态而这里忘了加，本用例就会红。
  const statuses = Object.values(TASK_STATUS)
  assert.ok(statuses.length >= 6, `TASK_STATUS 只有 ${statuses.length} 个状态？`)

  for (const status of statuses) {
    const reason = stopReasonOf(status)
    assert.ok(
      reason !== undefined && reason !== null,
      `状态 ${status} 没有 stopReason 映射（落到 undefined 了）`,
    )
    assert.equal(typeof reason, 'string', `状态 ${status} 的 stopReason 不是字符串：${String(reason)}`)
    assert.ok(['completed', 'aborted', 'error'].includes(reason), `状态 ${status} → 未知 stopReason ${reason}`)
  }
})

test('[D-4] stopReasonOf：映射表显式覆盖每个 TASK_STATUS 键', () => {
  // 不止"函数返回值非 undefined"，还要钉住**显式表**本身 ——
  // 这样新增状态时能同时看到"表里缺哪个键"。
  for (const status of Object.values(TASK_STATUS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(STOP_REASON_BY_STATUS, status),
      `STOP_REASON_BY_STATUS 缺少状态键 ${status}`,
    )
    assert.equal(STOP_REASON_BY_STATUS[status], stopReasonOf(status), `状态 ${status} 表与函数不一致`)
  }
  assert.ok(Object.isFrozen(STOP_REASON_BY_STATUS), '映射表应冻结，防止运行时被改')
})

test('stopReasonOf：语义正确（completed→completed，aborted→aborted，其余→error）', () => {
  assert.equal(stopReasonOf(TASK_STATUS.COMPLETED), 'completed')
  assert.equal(stopReasonOf(TASK_STATUS.ABORTED), 'aborted')
  assert.equal(stopReasonOf(TASK_STATUS.FAILED), 'error')
  assert.equal(stopReasonOf(TASK_STATUS.INTERRUPTED), 'error')
})

test('stopReasonOf：终态集合与"completed/aborted"的映射一致', () => {
  // 不变式：TERMINAL_STATUS 里除了 completed/aborted，其余都是 error。
  // 这条把"状态机新增终态"与"stopReason 语义"绑在一起。
  for (const status of TERMINAL_STATUS) {
    const reason = stopReasonOf(status)
    if (status === TASK_STATUS.COMPLETED) assert.equal(reason, 'completed')
    else if (status === TASK_STATUS.ABORTED) assert.equal(reason, 'aborted')
    else assert.equal(reason, 'error', `终态 ${status} 应为 error`)
  }
})

test('stopReasonOf：未知 / 畸形状态一律回 error，不返回 undefined', () => {
  for (const s of ['brand-new-status', '', 'COMPLETED', null, undefined, 42, {}, [], NaN]) {
    const reason = stopReasonOf(s)
    assert.equal(reason, 'error', `status=${String(s)}`)
    assert.notEqual(reason, undefined)
  }
})

/* ═════════════════════════ 4. createRemoteAgentProvider ═════════════════════════ */

test('createRemoteAgentProvider：返回对象形状符合 provider 契约', () => {
  const { provider } = makeProvider(fakeRegistry({ online: [{ nodeId: 'n1' }] }))
  assert.equal(provider.name, 'remote-agent')
  assert.equal(typeof provider.start, 'function')
  assert.equal(provider.inheritsParentContext, false)
  // 三条刻意声明为"不支持"的能力：声称支持却忽略参数比明确不支持更糟
  assert.deepEqual(provider.capabilities, {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  })
  for (const [k, v] of Object.entries(provider.capabilities)) {
    assert.equal(v, false, `capabilities.${k} 应为 false`)
  }
})

test('createRemoteAgentProvider：无在线节点 → start 同步拒绝（不返回 run）', async () => {
  const { provider } = makeProvider(fakeRegistry({ online: [] }))
  await assert.rejects(
    () => provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] }),
    /没有在线节点/,
  )
})

test('createRemoteAgentProvider：多个在线节点且 label 未指定 → 拒绝并列出节点名', async () => {
  const { provider } = makeProvider(fakeRegistry({ online: [{ nodeId: 'a' }, { nodeId: 'b' }] }))
  await assert.rejects(
    () => provider.start({ label: 'do something', prompt: [{ type: 'text', text: 'g' }] }),
    (err) => {
      assert.match(err.message, /多个在线节点/)
      assert.match(err.message, /a/)
      assert.match(err.message, /b/)
      return true
    },
  )
})

test('createRemoteAgentProvider：唯一在线节点时自动选中', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'only' }], terminal: terminalTask() })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  assert.equal(typeof run.id, 'string')
  assert.equal(reg.calls.createTask.length, 1)
  assert.equal(reg.calls.createTask[0].nodeId, 'only')
  await run.result
})

test('[D-1] createRemoteAgentProvider：label 指定节点时派给正确的那台', async () => {
  // 回归：短 id 劫持会让这里派给 'pc' 而不是 'pc-2'
  const reg = fakeRegistry({ online: [{ nodeId: 'pc' }, { nodeId: 'pc-2' }], terminal: terminalTask() })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'run on pc-2', prompt: [{ type: 'text', text: 'g' }] })
  assert.equal(reg.calls.createTask[0].nodeId, 'pc-2', '任务被派到了错误的节点')
  await run.result
})

test('createRemoteAgentProvider：start 返回的 run 有 id/result/dispose', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask() })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  assert.equal(typeof run.id, 'string')
  assert.ok(run.id.length > 0)
  assert.equal(run.id, reg.calls.createTask[0].spec.taskId, 'run.id 应是派出去的 taskId')
  assert.ok(run.result instanceof Promise, 'result 必须是 Promise')
  assert.equal(typeof run.dispose, 'function')
  assert.equal(run.localAgent, undefined)
  const res = await run.result
  assert.ok(res && typeof res === 'object')
  assert.equal(typeof res.stopReason, 'string')
  assert.ok(Array.isArray(res.output))
  assert.equal(typeof res.output[0].text, 'string')
  await run.dispose()
})

test('createRemoteAgentProvider：派活失败（createTask 抛）→ start 抛出，不返回 run', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], createError: new Error('node unreachable: n1') })
  const { provider } = makeProvider(reg)
  await assert.rejects(
    () => provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] }),
    /node unreachable/,
  )
})

test('createRemoteAgentProvider：任务完成 → completed + 交接卡文本', async () => {
  const handoff = {
    taskId: 't-1',
    nodeId: 'n1',
    status: TASK_STATUS.COMPLETED,
    mode: 'agent',
    runner: 'in-process',
    summary: { text: '全部完成' },
    changed: [{ op: 'add', path: 'out.txt', bytes: 5 }],
    artifacts: { counts: { final: 1 }, final: [{ path: 'out.txt', kind: 'file', bytes: 5, sha256: 'a'.repeat(64) }] },
  }
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask({ handoff }) })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  const res = await run.result

  assert.equal(res.stopReason, 'completed')
  assert.equal(res.diagnostic, undefined, '完成的任务不该带 diagnostic')
  assert.match(res.output[0].text, /全部完成/)
  assert.match(res.output[0].text, /out\.txt/)
  assert.equal(res.structured.taskId, 't-1')
  assert.equal(res.structured.status, TASK_STATUS.COMPLETED)
})

test('createRemoteAgentProvider：任务失败 → error + diagnostic', async () => {
  const reg = fakeRegistry({
    online: [{ nodeId: 'n1' }],
    terminal: terminalTask({
      status: TASK_STATUS.FAILED,
      error: { code: 'exec-failed', message: 'boom' },
      handoff: null,
    }),
  })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  const res = await run.result
  assert.equal(res.stopReason, 'error')
  assert.ok(typeof res.diagnostic === 'string' && res.diagnostic.length > 0)
  assert.match(res.diagnostic, /exec-failed/)
})

test('createRemoteAgentProvider：awaitTerminal reject → error 结果，不抛', async () => {
  const reg = fakeRegistry({
    online: [{ nodeId: 'n1' }],
    terminalError: Object.assign(new Error('task t-1 terminal: timeout after 100ms'), { code: 'internal' }),
  })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  let res
  await assert.doesNotReject(async () => {
    res = await run.result
  })
  assert.equal(res.stopReason, 'error')
  assert.match(res.diagnostic, /timeout/)
  assert.equal(typeof res.structured.taskId, 'string')
})

test('createRemoteAgentProvider：dispose() 取消派单 → aborted 结果及时落定', async () => {
  // 一条"永远不落定"的 awaitTerminal：模拟副机还没回话。
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }] })
  reg.awaitTerminal = (taskId) => {
    reg.calls.awaitTerminal.push({ taskId })
    return new Promise(() => {}) // 永不 settle
  }
  const { provider, seen } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })

  const pending = run.result
  await run.dispose()

  const res = await pending
  assert.equal(res.stopReason, 'aborted')
  assert.equal(res.structured.cancelled, true)
  assert.match(res.output[0].text, /已请求取消/)
  // 取消请求照发不误 —— 副机侧的任务该停还是要停
  assert.equal(seen.cancelled.length, 1, 'pulls.cancelTask 应被调用一次')
  assert.equal(reg.calls.cancelTask.length, 1, 'registry.cancelTask 应被调用一次')
})

test('createRemoteAgentProvider：signal abort → aborted 结果，不抛', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }] })
  reg.awaitTerminal = () => new Promise(() => {})
  const { provider } = makeProvider(reg)
  const ac = new AbortController()
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }], signal: ac.signal })
  const pending = run.result
  ac.abort()
  const res = await pending
  assert.equal(res.stopReason, 'aborted')
  assert.equal(res.structured.cancelled, true)
})

test('createRemoteAgentProvider：已 aborted 的 signal 立即取消', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }] })
  reg.awaitTerminal = () => new Promise(() => {})
  const { provider } = makeProvider(reg)
  const ac = new AbortController()
  ac.abort()
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }], signal: ac.signal })
  const res = await run.result
  assert.equal(res.stopReason, 'aborted')
})

test('[D-7] createRemoteAgentProvider：任务已落定后 dispose() 不再发 cancel', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask() })
  const { provider, seen } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  await run.result
  await run.dispose()
  assert.deepEqual(reg.calls.cancelTask, [], '任务已完成后 dispose 不该再发 task/cancel')
  assert.deepEqual(seen.cancelled, [], '任务已完成后 dispose 不该再取消 pull')
})

test('createRemoteAgentProvider：dispose 幂等，重复调用安全', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }] })
  reg.awaitTerminal = () => new Promise(() => {})
  const { provider, seen } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  await run.dispose()
  await run.dispose()
  await run.dispose()
  assert.equal(seen.cancelled.length, 1, 'dispose 应幂等，只取消一次')
})

test('[D-5] createRemoteAgentProvider：structured 不裸直出副机 handoff（无凭证/绝对路径泄漏）', async () => {
  // provider 的返回值会进主机会话日志 —— 比 UI 那条路径更该加固。
  const SECRET_TOKEN = 'en_SUPERSECRET_ENROLL_TOKEN'
  const handoff = {
    taskId: 't-1',
    nodeId: 'n1',
    status: TASK_STATUS.COMPLETED,
    mode: 'agent',
    runner: 'in-process',
    summary: { text: 'ok' },
    changed: [{ op: 'add', path: 'out.txt', bytes: 5 }],
    artifacts: { counts: { final: 1 }, final: [{ path: 'out.txt', kind: 'file', bytes: 5, sha256: 'a'.repeat(64) }] },
    // 副机上报的、不该过河的字段：
    workspace: 'C:\\Users\\SECRETUSER\\private\\proj',
    logs: { tail: [`TOKEN=${SECRET_TOKEN}`, 'PATH=C:\\secret'] },
    sessionId: 'sess-internal-123',
    goal: 'raw goal text',
    evilNodeControlledField: 'pwn',
  }
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask({ handoff }) })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  const res = await run.result

  const serialized = JSON.stringify(res)
  assert.equal(serialized.includes(SECRET_TOKEN), false, 'structured/output 里出现了副机 token')
  assert.equal(serialized.includes('SECRETUSER'), false, 'structured/output 里出现了绝对路径（回显主机目录）')
  assert.equal(serialized.includes('pwn'), false, 'structured 里出现了副机自造字段')
  assert.equal(res.structured.workspace, undefined, 'structured 不该带 workspace')
  assert.equal(res.structured.logs, undefined, 'structured 不该带 logs')
  assert.equal(res.structured.sessionId, undefined, 'structured 不该带 sessionId')
  assert.equal(res.structured.evilNodeControlledField, undefined)

  // 该留的仍然留着（投影不能把有用信息也砍掉）
  assert.equal(res.structured.taskId, 't-1')
  assert.equal(res.structured.status, TASK_STATUS.COMPLETED)
  assert.equal(res.structured.summaryText, 'ok')
  assert.ok(Array.isArray(res.structured.changed))
  assert.ok(Array.isArray(res.structured.artifacts.final))
  // 渲染文本里不该出现裸的 undefined（workspace 被投影刻意丢弃，给明确占位）
  assert.equal(res.output[0].text.includes('undefined'), false, '交接文本里出现了 undefined')
})

test('[D-6] createRemoteAgentProvider：副机上报畸形 progressTail/logTail 不崩（已完成不被误报未完成）', async () => {
  // 副机上报一个 null 元素 → 旧实现 `p.phase` 抛 TypeError → 被兜底 catch 吞掉 →
  // 一个**已完成**的任务被上报成"未完成：Cannot read properties of null"。
  const reg = fakeRegistry({
    online: [{ nodeId: 'n1' }],
    terminal: terminalTask({
      status: TASK_STATUS.COMPLETED,
      handoff: null, // 走 fallbackText 那条路
      progressTail: [null, undefined, 'str', 7, { phase: 'build', detail: 'ok' }, []],
      logTail: [null, undefined, { obj: 1 }, 'real log line'],
    }),
  })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  let res
  await assert.doesNotReject(async () => {
    res = await run.result
  })
  assert.equal(res.stopReason, 'completed', '已完成的任务被误报成未完成')
  assert.equal(res.diagnostic, undefined)
  assert.match(res.output[0].text, /状态：completed/)
  // 合法元素仍然被渲染
  assert.match(res.output[0].text, /build/)
  assert.match(res.output[0].text, /real log line/)
  assert.equal(res.output[0].text.includes('Cannot read properties of null'), false)
})

test('createRemoteAgentProvider：handoff 本身畸形（null/字符串/数组）不抛', async () => {
  for (const bad of [null, undefined, 'str', 42, [], { summary: null }]) {
    const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask({ handoff: bad }) })
    const { provider } = makeProvider(reg)
    const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
    let res
    await assert.doesNotReject(async () => {
      res = await run.result
    }, `handoff=${JSON.stringify(bad)}`)
    assert.ok(res && typeof res === 'object', `handoff=${JSON.stringify(bad)}`)
    assert.ok(['completed', 'aborted', 'error'].includes(res.stopReason))
    assert.equal(typeof res.output[0].text, 'string')
  }
})

test('createRemoteAgentProvider：终态记录本身缺失字段也不抛', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: { status: TASK_STATUS.COMPLETED } })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  let res
  await assert.doesNotReject(async () => {
    res = await run.result
  })
  assert.equal(res.stopReason, 'completed')
  assert.equal(typeof res.output[0].text, 'string')
})

test('createRemoteAgentProvider：非终态结果 → error（不假装完成）', async () => {
  // 正常路径不会走到这里（result 等的是 awaitTerminal），真到了说明
  // "run 结束了但任务没有终态"，那本身就是错误。
  for (const status of [TASK_STATUS.QUEUED, TASK_STATUS.RUNNING]) {
    const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask({ status }) })
    const { provider } = makeProvider(reg)
    const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
    const res = await run.result
    assert.equal(res.stopReason, 'error', `status=${status}`)
    assert.match(res.output[0].text, /尚未结束/)
  }
})

test('createRemoteAgentProvider：空 prompt → 用 label 兜底当 goal（不派空活）', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask() })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'cleanup temp files', prompt: [] })
  const spec = reg.calls.createTask[0].spec
  assert.equal(spec.goal, 'cleanup temp files')
  assert.equal(spec.mode, 'agent')
  assert.equal(spec.origin, 'subagent')
  await run.result
})

test('createRemoteAgentProvider：完全没有 prompt 也没有 label → 占位 goal（不抛）', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask() })
  const { provider } = makeProvider(reg)
  const run = await provider.start({})
  const spec = reg.calls.createTask[0].spec
  assert.ok(spec.goal.trim().length > 0, 'goal 不能为空（validateTaskStart 会拒）')
  await run.result
})

test('createRemoteAgentProvider：defaults.timeoutMs 透传到任务约束', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask() })
  const { provider } = makeProvider(reg, { defaults: { timeoutMs: 12_345 } })
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  assert.equal(reg.calls.createTask[0].spec.constraints.timeoutMs, 12_345)
  await run.result
})

test('[D-9] createRemoteAgentProvider：非法 / 非正 timeoutMs 回落到 1 小时', async () => {
  // 0 与负数曾被 validateTaskStart 夹到下限 1000ms：配错一个 `timeoutMs: -1`
  // 会让每条任务在 1 秒后判超时 —— 静默且看起来像"任务真的失败了"。
  for (const bad of [undefined, null, 'x', NaN, Infinity, -1, 0, -60_000]) {
    const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask() })
    const { provider } = makeProvider(reg, { defaults: { timeoutMs: bad } })
    const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
    const got = reg.calls.createTask[0].spec.constraints.timeoutMs
    assert.equal(got, 60 * 60 * 1000, `timeoutMs=${String(bad)} → ${got}`)
    await run.result
  }
})

test('[D-8] createRemoteAgentProvider：pulls / log 缺失也不抛（可选依赖）', async () => {
  // provider 是可选服务（hub 可能跑在没有 subagents 的组合里），少传一个依赖
  // 不该让派单在 `log(...)` 处抛 TypeError。
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }] })
  reg.awaitTerminal = () => new Promise(() => {})
  const provider = createRemoteAgentProvider({ registry: reg, pulls: undefined, log: undefined })
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  await run.dispose()
  const res = await run.result
  assert.equal(res.stopReason, 'aborted')
})

test('createRemoteAgentProvider：pulls.cancelTask 抛错不影响 result 落定', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }] })
  reg.awaitTerminal = () => new Promise(() => {})
  const provider = createRemoteAgentProvider({
    registry: reg,
    pulls: {
      cancelTask: () => {
        throw new Error('pull manager exploded')
      },
    },
    log: () => {},
  })
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  const pending = run.result
  await assert.doesNotReject(() => run.dispose())
  const res = await pending
  assert.equal(res.stopReason, 'aborted')
})

test('createRemoteAgentProvider：registry.limits.ackTimeoutMs 被用于 awaitAccepted', async () => {
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask(), limits: { ackTimeoutMs: 4_242 } })
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  await run.result
  assert.equal(reg.calls.awaitAccepted[0].timeoutMs, 4_242)
})

test('createRemoteAgentProvider：dispatch 后 result 一定落定（不会悬挂）', async () => {
  // 兜底契约：任何意外都要落成一个 SubagentResult，绝不让 result 悬挂。
  const reg = fakeRegistry({ online: [{ nodeId: 'n1' }], terminal: terminalTask() })
  // getTask 抛错 → 走兜底 catch 分支
  reg.getTask = () => {
    throw new Error('registry state corrupted')
  }
  const { provider } = makeProvider(reg)
  const run = await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'g' }] })
  const res = await run.result
  assert.ok(res && typeof res === 'object')
  assert.equal(typeof res.stopReason, 'string')
  assert.ok(['completed', 'aborted', 'error'].includes(res.stopReason))
})
