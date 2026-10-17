/**
 * 任务引擎端到端测试（lib/node/{task-engine,task-store,artifact-service}.js）。
 *
 * 不经过网络：直接构造 TaskStore + ArtifactService + TaskEngine，用一个假的 send
 * 收集引擎发出的帧，在**真实临时工作区**上跑真实的 PowerShell/sh 命令。
 *
 * 覆盖：
 *   - exec 任务：task/accept 发出、task/end status=completed、
 *     task/summary 的 handoff 有 summary.text 与 changed
 *   - 中间产物（build.log）在 manifest 里 role=intermediate 且不可 pull
 *   - 同 taskId 二次 accept 返回 duplicate 且不重跑
 *   - 失败命令 → status=failed（exec.js 退出码折叠修复的端到端回归防线）
 *   - 超时 → status=interrupted；cancel → aborted
 *
 * ─────────────────────── 一条重要的帧语义约定 ───────────────────────
 * 任务完成**不会**自动推 task/sync。副机完成时只推 task/summary + task/end；
 * task/sync 只在 ① node 上线（重连后）② hub 主动 task/query 两个时机发。
 * 所以"想拿某个任务的完整状态"要么主动 query，要么直接读
 * <stateDir>/tasks/<taskId>.json，要么只断言 task/summary 里的 handoff。
 * 从收到的帧集合里找 logTail 会拿到空数据而误报失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactService } from '../lib/node/artifact-service.js'
import { AGENT_DEFAULT_TIMEOUT_MS, EXEC_DEFAULT_TIMEOUT_MS, TaskEngine, buildDiffs } from '../lib/node/task-engine.js'
import { TaskStore } from '../lib/node/task-store.js'
import { authorizePull } from '../lib/artifacts.js'
import { ARTIFACT_ROLE, TASK_STATUS, validateTaskStart } from '../lib/protocol.js'

const IS_WIN = process.platform === 'win32'

/** 建一个独立临时目录（工作区 + 状态目录同根），注册清理。 */
function tmpRoot(t) {
  // realpath：Windows 上 os.tmpdir() 可能是 8.3 短名，工作区白名单比较需要规范形式
  const dir = fs.realpathSync.native
    ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-')))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用，忽略 */
    }
  })
  return dir
}

/** 平台相关的写文件命令。 */
function writeFileCmd(file, content) {
  if (IS_WIN) {
    const esc = String(content).replace(/'/g, "''")
    return `Set-Content -LiteralPath '${file}' -Value '${esc}' -Encoding UTF8`
  }
  const esc = String(content).replace(/'/g, `'\\''`)
  return `printf '%s\\n' '${esc}' > '${file}'`
}

/** 平台相关的"失败"命令：引用一个不存在的路径。 */
function failCmd() {
  if (IS_WIN) return "Get-Item -LiteralPath 'C:\\__dsh_no_such_path__' -ErrorAction Stop"
  return 'ls /__dsh_no_such_path__'
}

/** 平台相关的"长时间占用"命令（用于超时 / 取消）。 */
function sleepCmd(seconds) {
  if (IS_WIN) return `Start-Sleep -Seconds ${seconds}`
  return `sleep ${seconds}`
}

/** 一个假 runner：exec 模式下只用到 kind / cancel / killAll。 */
function fakeRunner() {
  const cancelled = []
  return {
    kind: 'fake',
    cancelled,
    async cancel(taskId) {
      cancelled.push(taskId)
      return true
    },
    killAll() {},
    async disposeAll() {},
  }
}

/**
 * 装配一套引擎，返回 { engine, store, artifacts, frames, stateDir, workspace, send }。
 * @param {object} o
 * @param {string} o.root 临时根
 * @param {object} [o.limits] 覆盖 maxConcurrent 等
 */
function makeEngine(t, { root, maxConcurrent = 2 } = {}) {
  const stateDir = path.join(root, 'state')
  const workspace = path.join(root, 'ws')
  fs.mkdirSync(workspace, { recursive: true })

  const store = new TaskStore(stateDir)
  const artifacts = new ArtifactService({ nodeId: 'test-node', caseInsensitive: true })
  const runner = fakeRunner()
  const frames = []
  const send = (type, data) => {
    frames.push({ type, data, at: Date.now() })
  }

  const engine = new TaskEngine({
    store,
    artifacts,
    runner,
    nodeId: 'test-node',
    roots: [workspace],
    denyPaths: [],
    defaultWorkspace: workspace,
    caseInsensitive: true,
    send,
    maxConcurrent,
  })

  return { engine, store, artifacts, runner, frames, stateDir, workspace, send }
}

/** 从收集到的帧里等某类帧。 */
async function waitFrame(frames, type, predicate, { timeoutMs = 30000, label } = {}) {
  const started = Date.now()
  for (;;) {
    const hit = frames.find((f) => f.type === type && (!predicate || predicate(f.data)))
    if (hit) return hit
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timeout waiting for ${label ?? type}; got: ${frames.map((f) => f.type).join(', ')}`,
      )
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 把一条 exec 任务派给引擎。 */
function dispatchExec(engine, { goal, taskId, workspace, timeoutMs, outputs, artifactRules } = {}) {
  const v = validateTaskStart({
    taskId: taskId ?? `t-${Math.random().toString(36).slice(2, 10)}`,
    goal,
    mode: 'exec',
    workspace,
    outputs,
    artifactRules,
    constraints: timeoutMs ? { timeoutMs } : {},
  })
  assert.equal(v.ok, true, JSON.stringify(v))
  return engine.accept(v.spec)
}

/* ─────────────────────── exec 任务全链路 ─────────────────────── */

test('engine e2e：exec 任务 → accept / summary(handoff) / end=completed', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace, store } = makeEngine(t, { root })

  const goal = writeFileCmd('out.txt', 'hello from engine')
  const { accepted } = dispatchExec(engine, { goal, taskId: 't-exec-1', workspace })
  assert.equal(accepted, true)

  // task/accept 必须发出，且带 workspace / runner
  const accept = await waitFrame(frames, 'task/accept', (d) => d.taskId === 't-exec-1')
  assert.equal(accept.data.duplicate, false)
  assert.equal(accept.data.status, TASK_STATUS.QUEUED)
  assert.equal(accept.data.nodeId, 'test-node')
  assert.equal(accept.data.runner, 'fake')
  assert.ok(accept.data.workspace)

  // 进度帧
  await waitFrame(frames, 'task/progress', (d) => d.taskId === 't-exec-1' && d.phase === 'started')

  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-exec-1')
  assert.equal(end.data.status, TASK_STATUS.COMPLETED, `stderr 见 logs；frames=${frames.map((f) => f.type).join(',')}`)
  assert.equal(end.data.nodeId, 'test-node')
  assert.equal(typeof end.data.durationMs, 'number')
  assert.ok(end.data.manifestCounts)

  // task/summary 里的 handoff
  const summary = await waitFrame(frames, 'task/summary', (d) => d.taskId === 't-exec-1')
  const handoff = summary.data.handoff
  assert.ok(handoff, 'handoff 必须存在')
  assert.equal(handoff.taskId, 't-exec-1')
  assert.equal(handoff.nodeId, 'test-node')
  assert.equal(handoff.mode, 'exec')
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)

  // summary.text 与 changed 是契约要求的两个字段
  assert.equal(typeof handoff.summary.text, 'string')
  assert.ok(handoff.summary.text.length > 0, 'summary.text 不能为空')
  assert.match(handoff.summary.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Array.isArray(handoff.changed), 'changed 必须是数组')

  // changed 里应能看到新建的 out.txt
  const add = handoff.changed.find((c) => c.path === 'out.txt')
  assert.ok(add, `changed 应包含 out.txt，实际：${JSON.stringify(handoff.changed)}`)
  assert.equal(add.op, 'add')
  assert.ok(add.bytes > 0)

  // 产物清单：out.txt 判 final（.txt 是 report）
  assert.ok(handoff.artifacts.final.some((f) => f.path === 'out.txt'))
  assert.match(handoff.pullHint, /out\.txt/)

  // 磁盘上确实有文件，且 store 落盘
  assert.equal(fs.existsSync(path.join(workspace, 'out.txt')), true)
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'state', 'tasks', 't-exec-1.json'), 'utf8'))
  assert.equal(persisted.status, TASK_STATUS.COMPLETED)
  assert.equal(persisted.manifest.counts.final >= 1, true)
  assert.equal(store.get('t-exec-1').status, TASK_STATUS.COMPLETED)

  engine.running.clear()
  engine.queue.length = 0
})

test('engine e2e：中间产物 build.log 在 manifest 里 role=intermediate 且不可 pull', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  // 同时产出一个 final（report.md）与一个 intermediate（build.log）
  const goal = [
    writeFileCmd('report.md', '# done'),
    writeFileCmd('build.log', 'noise noise'),
  ].join(IS_WIN ? '; ' : '\n')

  dispatchExec(engine, { goal, taskId: 't-art-1', workspace })
  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-art-1')
  assert.equal(end.data.status, TASK_STATUS.COMPLETED)

  const summary = await waitFrame(frames, 'task/summary', (d) => d.taskId === 't-art-1')
  const handoff = summary.data.handoff

  assert.ok(handoff.artifacts.final.some((f) => f.path === 'report.md'), 'report.md 应为 final')
  assert.equal(
    handoff.artifacts.final.some((f) => f.path === 'build.log'),
    false,
    'build.log 不应出现在 final 列表里',
  )
  assert.equal(handoff.artifacts.intermediateCount >= 1, true, 'build.log 应计入 intermediate')
  assert.equal(handoff.artifacts.counts.intermediate >= 1, true)

  // 直接查引擎侧 manifest
  const rec = store_record(root, 't-art-1')
  const logItem = rec.manifest.items.find((i) => i.path === 'build.log')
  assert.ok(logItem, 'build.log 应出现在 manifest.items 里（只上报元数据）')
  assert.equal(logItem.role, ARTIFACT_ROLE.INTERMEDIATE)
  assert.equal(logItem.role, 'intermediate')
  assert.equal(logItem.sha256, undefined, 'intermediate 不算 sha256')

  // authorizePull 必须拒绝 intermediate
  const denied = authorizePull(rec.manifest, 'build.log')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'artifact-denied')
  assert.match(denied.message, /role:final/)

  // final 的可以 pull
  assert.equal(authorizePull(rec.manifest, 'report.md').ok, true)

  engine.running.clear()
  engine.queue.length = 0
})

/** 从磁盘读一条任务记录（stateDir/tasks/<taskId>.json）。 */
function store_record(root, taskId) {
  return JSON.parse(fs.readFileSync(path.join(root, 'state', 'tasks', `${taskId}.json`), 'utf8'))
}

test('engine e2e：同 taskId 二次 accept 返回 duplicate 且不重跑', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace, store } = makeEngine(t, { root })

  // 用一个"写文件 + 追加一行"的命令，重跑会让文件多一行，从而可检测
  const goal = writeFileCmd('once.txt', 'first')
  const first = dispatchExec(engine, { goal, taskId: 't-dup-1', workspace })
  assert.equal(first.accepted, true)

  await waitFrame(frames, 'task/end', (d) => d.taskId === 't-dup-1')
  const rec1 = store.get('t-dup-1')
  const attempts1 = rec1.attempts
  const mtime1 = fs.statSync(path.join(workspace, 'once.txt')).mtimeMs
  const endCount1 = frames.filter((f) => f.type === 'task/end' && f.data.taskId === 't-dup-1').length

  // 二次 accept 同一个 taskId
  const second = engine.accept(
    validateTaskStart({ taskId: 't-dup-1', goal, mode: 'exec', workspace }).spec,
  )
  assert.equal(second.duplicate, true)
  assert.ok(second.record)

  // 回的是 duplicate:true 的 accept
  const dupAccept = await waitFrame(
    frames,
    'task/accept',
    (d) => d.taskId === 't-dup-1' && d.duplicate === true,
  )
  assert.equal(dupAccept.data.duplicate, true)
  assert.equal(dupAccept.data.status, TASK_STATUS.COMPLETED, 'duplicate accept 带当前状态')

  // 不重跑：attempts 不变、没有第二条 task/end、文件 mtime 不变
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(store.get('t-dup-1').attempts, attempts1, 'attempts 不应增加')
  assert.equal(
    frames.filter((f) => f.type === 'task/end' && f.data.taskId === 't-dup-1').length,
    endCount1,
    '不应产生新的 task/end',
  )
  assert.equal(fs.statSync(path.join(workspace, 'once.txt')).mtimeMs, mtime1, '文件不应被重写')
  assert.equal(engine.running.size, 0)
  assert.equal(engine.queue.length, 0)
})

/**
 * [D5] 正常失败路径的 task/end **不带 error 字段**。
 *
 * 位置：lib/node/task-engine.js:201-207 —— 成功/失败共用的 task/end 只发
 *   { taskId, nodeId, status, durationMs, manifestCounts }
 *   而 catch 路径（:215-220）与未知 taskId 路径（:312-317）都会带 error。
 *
/**
 * 【D5 已修复】正常失败路径的 task/end 曾不带 error。
 *
 * 原缺陷：成功/失败共用的 task/end 只发 {taskId,nodeId,status,durationMs,manifestCounts}，
 * 而 catch 路径与未知 taskId 路径都带 error。hub 侧 NodeRegistry 只有
 * `if (d.error) t.error = d.error`，于是普通失败任务在 hub 投影里 error 恒为 null，
 * remote_status 显示不出错误原因（只能靠 remote_handoff 从 handoff 里看）。
 * 修复：失败路径的 task/end 也带 error（含 code / message / exitCode），两条路径一致。
 * 本用例现断言**修复后的正确行为**。
 */
test('[D5 回归] 失败任务的 task/end 带 error，与 catch 路径一致', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  dispatchExec(engine, { goal: failCmd(), taskId: 't-d5-1', workspace })

  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-d5-1')
  assert.equal(end.data.status, TASK_STATUS.FAILED)
  assert.ok(end.data.error, 'D5 修复：正常失败路径的 task/end 必须带 error')
  assert.equal(end.data.error.code, 'task-failed')
  assert.ok(end.data.error.message, 'D5 修复：error.message 非空')
  assert.notEqual(end.data.error.exitCode, 0, 'D5 修复：error.exitCode 反映真实退出码')

  // 磁盘记录与 handoff 里同样有错误信息
  const rec = store_record(root, 't-d5-1')
  assert.ok(rec.error, 'store 记录里有 error')
  assert.equal(rec.error.code, 'task-failed')

  const summary = await waitFrame(frames, 'task/summary', (d) => d.taskId === 't-d5-1')
  assert.ok(summary.data.handoff, 'handoff 仍在')
  assert.equal(summary.data.handoff.exit.code !== 0, true)

  // 成功路径不应带 error（不误伤）
  frames.length = 0
  dispatchExec(engine, { goal: writeFileCmd('ok-d5.txt', 'x'), taskId: 't-d5-ok', workspace })
  const okEnd = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-d5-ok')
  assert.equal(okEnd.data.status, TASK_STATUS.COMPLETED)
  assert.equal(okEnd.data.error, undefined, 'D5 修复：成功路径不带 error')

  // 对照：未知 taskId 的 task/end 同样带 error（两条路径现在一致）
  frames.length = 0
  await engine.cancel('t-d5-unknown')
  const end2 = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-d5-unknown')
  assert.ok(end2.data.error, '对照：cancel 未知任务的 task/end 带 error')
  engine.running.clear()
  engine.queue.length = 0
})

test('engine e2e：成功命令退出码为 0（对照）', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  dispatchExec(engine, { goal: writeFileCmd('ok.txt', 'ok'), taskId: 't-ok-1', workspace })
  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-ok-1')
  assert.equal(end.data.status, TASK_STATUS.COMPLETED)
  const rec = store_record(root, 't-ok-1')
  assert.equal(rec.exit.code, 0)
  assert.equal(rec.exit.timedOut, false)
  engine.running.clear()
  engine.queue.length = 0
})

/* ─────────────────────── 超时 / 取消 ─────────────────────── */

test('engine e2e：超时 → status=interrupted', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  dispatchExec(engine, { goal: sleepCmd(30), taskId: 't-timeout-1', workspace, timeoutMs: 1200 })

  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-timeout-1', { timeoutMs: 30000 })
  assert.equal(end.data.status, TASK_STATUS.INTERRUPTED)
  const rec = store_record(root, 't-timeout-1')
  assert.equal(rec.exit.timedOut, true)
  engine.running.clear()
  engine.queue.length = 0
})

test('engine e2e：失败命令 → status=failed，summary.text 带错误文本（修复 2 回归防线）', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  dispatchExec(engine, { goal: failCmd(), taskId: 't-fail-1', workspace })

  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-fail-1')
  assert.equal(
    end.data.status,
    TASK_STATUS.FAILED,
    '失败的 cmdlet 必须上报 failed（修复前会被折成 completed）',
  )

  const summary = await waitFrame(frames, 'task/summary', (d) => d.taskId === 't-fail-1')
  const handoff = summary.data.handoff
  assert.equal(handoff.status, TASK_STATUS.FAILED)
  assert.equal(handoff.exit.code !== 0, true, `exit.code 应为非 0，实际 ${handoff.exit.code}`)
  assert.equal(typeof handoff.summary.text, 'string')
  assert.ok(handoff.summary.text.length > 0)
  // 摘要应如实带上错误文本（不是空泛的"任务完成"）
  assert.notEqual(handoff.summary.text, '任务完成，产出 0 个成品。')

  const rec = store_record(root, 't-fail-1')
  assert.equal(rec.status, TASK_STATUS.FAILED)
  assert.ok(rec.exit.code !== 0)
  assert.ok(rec.error, 'store 记录带 error')
  engine.running.clear()
  engine.queue.length = 0
})

/**
 * [D6] 被取消的任务落成 failed，而不是文档/协议里的 aborted。
 *
 * 位置：lib/node/task-engine.js:167-171 的状态映射只看 timedOut / ok：
 *     result.timedOut ? INTERRUPTED : result.ok ? COMPLETED : FAILED
 *   而 exec.js:350-357 在 abort 时设置 `aborted=true`，`ok=false`、`timedOut=false`
 *   （实测：ok=false, timedOut=false, aborted=true, exitCode=1）
 *   → 落进 FAILED 分支。`result.aborted` 被传进 runExec 的返回值但**从未参与映射**。
 *
 * 原缺陷：状态映射只看 timedOut/ok —— `timedOut ? INTERRUPTED : ok ? COMPLETED : FAILED`，
 * 而 abort 时 exec.js 给的是 ok=false / timedOut=false / aborted=true → 落进 FAILED。
 * `result.aborted` 被计算了但从未参与映射。
 *
 * 与三处文档不一致（修复后已一致）：
 *   - task-engine.js 头注释：「可取消：…并把状态落成 aborted」
 *   - protocol.js 定义了 TASK_STATUS.ABORTED
 *   - hub/tools.js 的 remote_cancel 描述：「把状态落成 aborted」
 *
 * 影响：hub 侧 remote_status 会把"用户主动取消"显示成"任务失败"，
 *      自动化流程可能据此误判为需要重试/排障。
 * 修复：状态映射把 result.aborted 放在最前。
 * 本用例现断言**修复后的正确行为**。
 */
test('[D6 回归] cancel 在跑的任务 → 落成 aborted（不是 failed）', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace, runner } = makeEngine(t, { root })

  dispatchExec(engine, { goal: sleepCmd(30), taskId: 't-cancel-1', workspace })
  await waitFrame(frames, 'task/progress', (d) => d.taskId === 't-cancel-1' && d.phase === 'started')

  const ok = await engine.cancel('t-cancel-1')
  assert.equal(ok, true)
  assert.deepEqual(runner.cancelled, ['t-cancel-1'], 'runner.cancel 应被调用')

  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-cancel-1', { timeoutMs: 30000 })
  assert.equal(
    end.data.status,
    TASK_STATUS.ABORTED,
    'D6 修复：被取消的任务落成 aborted（与文档、remote_cancel 描述一致）',
  )
  // 取消不是失败：不应带 error，避免自动化流程误判需重试
  assert.equal(end.data.error, undefined, 'D6 修复：aborted 不带 error')

  // 磁盘上同样是 aborted，且 exit.timedOut/aborted 语义正确
  const rec = store_record(root, 't-cancel-1')
  assert.equal(rec.status, TASK_STATUS.ABORTED)
  assert.equal(rec.exit.timedOut, false, '取消不是超时')
  assert.equal(rec.exit.aborted, true, 'D6 修复：exit.aborted 被记录')
  assert.equal(rec.error, null, 'D6 修复：aborted 记录的 error 为 null')

  // 对照：只有"超时"才落成 interrupted
  frames.length = 0
  dispatchExec(engine, { goal: sleepCmd(30), taskId: 't-cancel-2', workspace, timeoutMs: 1000 })
  const end2 = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-cancel-2', { timeoutMs: 30000 })
  assert.equal(end2.data.status, TASK_STATUS.INTERRUPTED, '超时 → interrupted（对照）')

  engine.running.clear()
  engine.queue.length = 0
})

test('engine e2e：cancel 未知 taskId → 回 failed/unknown 且返回 false', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames } = makeEngine(t, { root })

  const ok = await engine.cancel('t-nope')
  assert.equal(ok, false)
  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-nope')
  assert.equal(end.data.status, TASK_STATUS.FAILED)
  assert.equal(end.data.error.code, 'task-unknown')
})

/* ─────────────────────── 工作区校验 ─────────────────────── */

test('engine e2e：工作区越界 → task/end failed(workspace-denied)，不执行', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, store } = makeEngine(t, { root })

  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside, { recursive: true })

  const r = engine.accept(
    validateTaskStart({
      taskId: 't-outside',
      goal: writeFileCmd('nope.txt', 'x'),
      mode: 'exec',
      workspace: outside,
    }).spec,
  )
  assert.equal(r.rejected, true)

  const end = await waitFrame(frames, 'task/end', (d) => d.taskId === 't-outside')
  assert.equal(end.data.status, TASK_STATUS.FAILED)
  assert.equal(end.data.error.code, 'workspace-denied')
  assert.equal(fs.existsSync(path.join(outside, 'nope.txt')), false, '越界任务不应被执行')
  assert.equal(store.get('t-outside'), undefined, '被拒的任务不建记录')
  assert.equal(frames.some((f) => f.type === 'task/accept'), false)
})

test('engine e2e：outputs 过滤只保留命中的产物', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  const goal = [
    writeFileCmd('keep.md', 'keep'),
    writeFileCmd('skip.md', 'skip'),
  ].join(IS_WIN ? '; ' : '\n')

  dispatchExec(engine, { goal, taskId: 't-out-1', workspace, outputs: ['keep.md'] })
  await waitFrame(frames, 'task/end', (d) => d.taskId === 't-out-1')

  const rec = store_record(root, 't-out-1')
  const paths = rec.manifest.items.map((i) => i.path)
  assert.deepEqual(paths, ['keep.md'], 'outputs 未命中的文件不应进清单')
  engine.running.clear()
  engine.queue.length = 0
})

/* ─────────────────────── syncAll ─────────────────────── */

test('engine e2e：syncAll 回全量任务视图（重连补齐走这条）', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  dispatchExec(engine, { goal: writeFileCmd('s.txt', 'x'), taskId: 't-sync-1', workspace })
  await waitFrame(frames, 'task/end', (d) => d.taskId === 't-sync-1')

  frames.length = 0
  engine.syncAll()
  const sync = await waitFrame(frames, 'task/sync')
  assert.equal(sync.data.nodeId, 'test-node')
  assert.ok(Array.isArray(sync.data.tasks))
  const view = sync.data.tasks.find((v) => v.taskId === 't-sync-1')
  assert.ok(view, 'sync 应包含已完成的任务')
  assert.equal(view.status, TASK_STATUS.COMPLETED)
  assert.equal(view.mode, 'exec')
  assert.ok(view.manifestCounts)
  engine.running.clear()
  engine.queue.length = 0
})

/* ─────────────────────── 启动对账（TaskStore 持久化） ─────────────────────── */

test('engine e2e：TaskStore 落盘后新实例能读回（任务状态真身在副机）', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  dispatchExec(engine, { goal: writeFileCmd('persist.txt', 'p'), taskId: 't-persist-1', workspace })
  await waitFrame(frames, 'task/end', (d) => d.taskId === 't-persist-1')
  engine.running.clear()
  engine.queue.length = 0

  // 用同一个 stateDir 新建一个 store：模拟副机进程重启
  const store2 = new TaskStore(path.join(root, 'state'))
  const rec = store2.get('t-persist-1')
  assert.ok(rec, '重启后应能读回任务记录')
  assert.equal(rec.status, TASK_STATUS.COMPLETED)
  assert.equal(rec.goal.length > 0, true)
  assert.ok(rec.manifest)

  // 日志尾巴也在盘上（经 task/query 或直接读盘获取，不是靠 task/sync 自动推送）
  assert.ok(Array.isArray(rec.logs))
  assert.ok(rec.logs.length > 0, 'exec 任务应留下日志')
})

/* ══════════════════════════════════════════════════════════════════
 * 输出行心跳（提案 #15）：有新行才发，stop() 干净收尾
 * ══════════════════════════════════════════════════════════════════ */

test('engine：outputHeartbeat 只在行数变化时发帧，stop 后静默', async (t) => {
  const frames = []
  const engine = { send: (type, data) => frames.push(data) }
  let lines = 0
  const stop = TaskEngine.prototype.outputHeartbeat.call(engine, 't-hb', () => lines)

  await new Promise((r) => setTimeout(r, 2300))
  // 0 行也是状态（"活着但还没吐"），首个 tick 发一次"已输出 0 行"
  const first = frames.filter((f) => f.phase === 'output')
  assert.equal(first.length, 1, `首 tick 应恰好 1 帧，实际 ${first.length}`)
  assert.equal(first[0].detail, '已输出 0 行')

  lines = 5
  await new Promise((r) => setTimeout(r, 2300))
  const five = frames.filter((f) => f.phase === 'output')
  assert.equal(five.length, 2, '行数变化后应再发一帧')
  assert.equal(five[1].detail, '已输出 5 行')

  // 行数不变：不再发
  await new Promise((r) => setTimeout(r, 2300))
  assert.equal(frames.filter((f) => f.phase === 'output').length, 2, '行数不变不得重复发帧')

  stop()
  lines = 9
  await new Promise((r) => setTimeout(r, 2300))
  assert.equal(frames.filter((f) => f.phase === 'output').length, 2, 'stop 后必须静默')
})

/* ══════════════════════════════════════════════════════════════════
 * 变更 diff 视图（提案 #21）：handoff 带 diffs，二进制/超大缺席
 * ══════════════════════════════════════════════════════════════════ */

test('engine e2e：modify 文件 → handoff.diffs 带 -旧/+新 unified diff', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  // 前像先落盘（快照在 accept 时捕获），任务把它改成别的内容
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'before line\n', 'utf8')
  const goal = writeFileCmd('note.txt', 'after line')
  dispatchExec(engine, { goal, taskId: 't-diff-1', workspace })

  const summary = await waitFrame(frames, 'task/summary', (d) => d.taskId === 't-diff-1', { label: 'task/summary(t-diff-1)' })
  const handoff = summary.data.handoff
  assert.ok(handoff, 'handoff 必须存在')
  assert.ok(Array.isArray(handoff.diffs), 'handoff.diffs 必须是数组')
  const d = handoff.diffs.find((x) => x && x.path === 'note.txt')
  assert.ok(d, `diffs 应含 note.txt，实际：${JSON.stringify(handoff.diffs)}`)
  assert.equal(d.truncated, false)
  assert.match(d.diff, /^--- a\/note\.txt\n/)
  // Windows PowerShell Set-Content -Encoding UTF8 会写 BOM（U+FEFF），兼容之
  assert.match(d.diff, /-before line/)
  assert.match(d.diff, /\+\uFEFF?after line/)
})

test('engine e2e：add 文件也出 diff（对照第一用例的 changed 路径）', async (t) => {
  const root = tmpRoot(t)
  const { engine, frames, workspace } = makeEngine(t, { root })

  const goal = writeFileCmd('brand-new.txt', 'created by task')
  dispatchExec(engine, { goal, taskId: 't-diff-2', workspace })

  const summary = await waitFrame(frames, 'task/summary', (d) => d.taskId === 't-diff-2', { label: 'task/summary(t-diff-2)' })
  const d = summary.data.handoff.diffs.find((x) => x && x.path === 'brand-new.txt')
  assert.ok(d, '新增文件应有 diff')
  assert.match(d.diff, /\+\uFEFF?created by task/)
})

test('engine：buildDiffs 二进制/前像缺席的文件跳过，12 文件封顶', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bd-'))
  t.after(() => {
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 忽略 */ }
  })

  // modify：前像缺席（模拟二进制/超大 —— 快照没存 content）→ 跳过
  fs.writeFileSync(path.join(workspace, 'bin.dat'), 'x', 'utf8')
  const before = new Map([
    ['bin.dat', { bytes: 1, mtimeMs: 1 }], // 无 content
  ])
  const changed = [{ path: 'bin.dat', op: 'modify' }]
  let diffs = buildDiffs({ workspace, changed, before })
  assert.deepEqual(diffs, [], '前像无 content 的 modify 必须跳过')

  // modify：前像有 content、后像在磁盘 → 正常出 diff
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'v2\n', 'utf8')
  const before2 = new Map([
    ['a.txt', { bytes: 3, mtimeMs: 1, content: 'v1\n' }],
  ])
  diffs = buildDiffs({ workspace, changed: [{ path: 'a.txt', op: 'modify' }], before: before2 })
  assert.equal(diffs.length, 1)
  assert.match(diffs[0].diff, /-v1\n\+v2\n/)

  // delete：前像有 content → 纯删 diff；磁盘上文件已不在
  fs.rmSync(path.join(workspace, 'a.txt'))
  diffs = buildDiffs({ workspace, changed: [{ path: 'a.txt', op: 'delete' }], before: before2 })
  assert.equal(diffs.length, 1)
  assert.match(diffs[0].diff, /-v1\n/)

  // 封顶：changed 超过 12 个只出 12 份
  const many = Array.from({ length: 15 }, (_, i) => `f${i}.txt`)
  const before3 = new Map(many.map((p) => [p, { bytes: 1, mtimeMs: 1, content: 'x\n' }]))
  diffs = buildDiffs({ workspace, changed: many.map((p) => ({ path: p, op: 'delete' })), before: before3 })
  assert.equal(diffs.length, 12, `应封顶 12，实际 ${diffs.length}`)
})

/* ══════════════════════════════════════════════════════════════════
 * 提案 #26：队列堵死防线 —— 分开超时常量、maxConcurrent 默认、queueStats
 * ══════════════════════════════════════════════════════════════════ */

test('#26-1 默认超时常量：exec 10 分钟 / agent 1 小时，引擎兜底与工具层同源', () => {
  assert.equal(EXEC_DEFAULT_TIMEOUT_MS, 10 * 60 * 1000)
  assert.equal(AGENT_DEFAULT_TIMEOUT_MS, 60 * 60 * 1000)
  // 兜底必须引用常量而不是字面量 —— 否则"工具说 10 分钟、副机兜底 1 小时"
  // 的分裂会在有人改其一而不改其二时复发（#26 事故形态之一）。
  const src = fs.readFileSync(new URL('../lib/node/task-engine.js', import.meta.url), 'utf8')
  assert.match(src, /rec\.constraints\?\.timeoutMs \?\? EXEC_DEFAULT_TIMEOUT_MS/, 'runExec 兜底应引用 EXEC_DEFAULT_TIMEOUT_MS')
  assert.match(src, /rec\.constraints\?\.timeoutMs \?\? AGENT_DEFAULT_TIMEOUT_MS/, 'runAgent 兜底应引用 AGENT_DEFAULT_TIMEOUT_MS')
})

test('#26-2 maxConcurrent 默认 4（显式配置仍然生效）', () => {
  const bare = ({ maxConcurrent } = {}) => new TaskEngine({
    store: { get: () => undefined, list: () => [] },
    artifacts: {},
    runner: { kind: 'fake' },
    nodeId: 'n',
    roots: [],
    defaultWorkspace: '',
    send: () => {},
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
  })
  assert.equal(bare().maxConcurrent, 4, '不传 maxConcurrent 时默认应为 4')
  assert.equal(bare({ maxConcurrent: 2 }).maxConcurrent, 2, '显式配置必须原样生效')
})

test('#26-3 queueStats：排队/并发/最久等待与 starved 判定', () => {
  const store = new Map()
  const engine = new TaskEngine({
    store: { get: (id) => store.get(id), list: () => [...store.values()] },
    artifacts: {},
    runner: { kind: 'fake' },
    nodeId: 'n',
    roots: [],
    defaultWorkspace: '',
    send: () => {},
  })
  const now = Date.now()

  // 空队列：全零、不饿
  assert.deepEqual(engine.queueStats(now), {
    queued: 0, running: 0, maxConcurrent: 4, oldestQueuedMs: 0, starved: false,
  })

  // 两条排队（一条 3 分钟前、一条 1 分钟前）+ 并发未占满 → 不饿
  store.set('a', { createdAt: now - 3 * 60 * 1000 })
  store.set('b', { createdAt: now - 1 * 60 * 1000 })
  engine.queue = ['a', 'b']
  let s = engine.queueStats(now)
  assert.equal(s.queued, 2)
  assert.equal(s.oldestQueuedMs, 3 * 60 * 1000, '最久等待取最早的 createdAt')
  assert.equal(s.starved, false, '并发未占满不判饿')

  // 并发占满 + 排队超阈值 → starved
  engine.running.set('x', { controller: {}, startedAt: now })
  s = engine.queueStats(now)
  assert.equal(s.running, 1)
  assert.equal(s.maxConcurrent, 4)
  assert.equal(s.starved, false, 'running(1) < maxConcurrent(4) 时即使排了 3 分钟也不算堵死')
  engine.running.set('y', {})
  engine.running.set('z', {})
  engine.running.set('w', {})
  s = engine.queueStats(now)
  assert.equal(s.starved, true, '并发占满 + 排队 3 分钟 > 2 分钟阈值 → 堵死')
  s = engine.queueStats(now - 90 * 1000)
  assert.equal(s.starved, false, '阈值边缘（< 2 分钟）不判饿')
})
