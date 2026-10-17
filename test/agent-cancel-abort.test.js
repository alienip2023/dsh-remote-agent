/**
 * #26-5：agent 任务的取消必须**真打断**（2026-10-17）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 事故
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `InProcessRunner.run` 等 agent 停稳用的是：
 *
 *     const raced = await Promise.race([
 *       agent.whenIdle().then(() => ({ timedOut: false })),
 *       timeoutPromise,
 *     ])
 *
 * **取消信号不在 race 里。** 而 `cancel()` 做的是
 * `agent.cancel({kind:'user'})` + `controller.abort()` ——
 * abort 只是置了个标志，没有任何人在 await 它。
 *
 * DSH 的 agent 循环**不监听外部 AbortSignal**，所以 `whenIdle()` 不会因为
 * abort 而提前返回。后果：
 *
 *   hub 发 task/cancel → remote_cancel 返回 `requested: true` →
 *   但任务**一直 running 到 agent 自己跑完** → 最终状态落成
 *   **completed**（不是 aborted）→ 用户以为取消成功，实际白跑还烧额度。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * 把 abort 做成可 race 的 promise，并让 `ok` 排除 aborted：
 *
 *     ok: !timedOut && !aborted
 *     aborted,
 *
 * ── 为什么这组测试是静态的 ──────────────────────────────────────────────
 *
 * 真正跑一遍"取消一个正在跑的 agent"需要一个活的 DSH agent 会话（模型调用、
 * 几十秒），放进单测会让 CI 变慢且不稳定。所以这里锁**代码形态**：
 *
 *   · `Promise.race` 的竞争者里必须有 `abortPromise`
 *   · `aborted` 必须参与 `ok` 判定
 *   · `timedOut` 为真时 abort 不得把状态改写成 aborted（超时 ≠ 取消）
 *
 * 行为侧的端到端验证在 `test/engine-e2e.test.js` 的 cancel 用例
 * （exec 侧已有；agent 侧靠本文件的形态断言 + 真机验证）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RUNNER = path.join(ROOT, 'lib', 'node', 'runner.js')

const src = fs.readFileSync(RUNNER, 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const code = stripComments(src)

/** 取 `class InProcessRunner` 的完整类体（花括号配对）。 */
function inProcessBody() {
  const i = code.indexOf('class InProcessRunner')
  assert.ok(i >= 0, '应存在 class InProcessRunner')
  let depth = 0
  for (let k = code.indexOf('{', i); k < code.length; k += 1) {
    if (code[k] === '{') depth += 1
    else if (code[k] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(i, k + 1)
    }
  }
  throw new Error('InProcessRunner 花括号配对失败')
}

const body = inProcessBody()

/* ─────────────── 1. race 必须包含 abort ─────────────── */

test('#26-5：Promise.race 的竞争者必须包含 abortPromise', () => {
  const i = body.indexOf('Promise.race([')
  assert.ok(i >= 0, 'InProcessRunner 应有 Promise.race')
  const seg = body.slice(i, i + 700)
  assert.match(seg, /agent\.whenIdle\(\)/, 'race 里应有 whenIdle')
  assert.match(seg, /timeoutPromise/, 'race 里应有 timeoutPromise')
  assert.match(seg, /abortPromise/, 'race 里**必须**有 abortPromise —— 否则取消不打断')
})

test('#26-5：abortPromise 必须在 controller.signal 的 abort 事件上 resolve', () => {
  const i = body.indexOf('const abortPromise')
  assert.ok(i >= 0, '应定义 abortPromise')
  const seg = body.slice(i, i + 900)
  assert.match(seg, /controller\.signal\.addEventListener\(\s*'abort'/, 'abortPromise 应监听 controller.signal 的 abort')
  assert.match(seg, /resolve\(\{\s*aborted:\s*true\s*\}\)/, '应 resolve { aborted: true }')
  // 已中止时的短路分支
  assert.match(seg, /controller\.signal\.aborted/, '已中止时应短路（不必等事件）')
})

/* ─────────────── 2. ok 必须排除 aborted ─────────────── */

test('#26-5：返回值 ok 必须排除 aborted（否则取消被落成 completed）', () => {
  // 找 InProcessRunner.run 的 return 块
  const i = body.indexOf('ok: !timedOut')
  assert.ok(i >= 0, '应有 ok 判定')
  const seg = body.slice(i, i + 200)
  assert.match(seg, /ok:\s*!timedOut\s*&&\s*!aborted/, 'ok 必须是 `!timedOut && !aborted`')
  assert.ok(
    !/ok:\s*!timedOut\s*,/.test(seg),
    '不得退回只判 timedOut —— 那样取消会落成 completed',
  )
})

test('#26-5：返回值必须带 aborted 字段（engine 靠它映射 ABORTED）', () => {
  const i = body.indexOf('ok: !timedOut && !aborted')
  assert.ok(i >= 0)
  const seg = body.slice(i, i + 400)
  assert.match(seg, /aborted,/, '返回对象里必须有 aborted 字段')
  assert.match(seg, /exitCode:\s*timedOut \|\| aborted \? null : 0/, '取消时 exitCode 应为 null')
})

/* ─────────────── 3. 超时与取消的语义不能混 ─────────────── */

test('#26-5：timedOut 为真时 abort 不得把状态改写成 aborted', () => {
  const i = body.indexOf('const abortPromise')
  const seg = body.slice(i, i + 900)
  // 必须有 `if (!timedOut) aborted = true` 这类保护
  assert.match(seg, /if\s*\(!timedOut\)\s*aborted\s*=\s*true/, '超时触发的 abort 不应标 aborted')
  assert.match(seg, /resolve\(\{\s*aborted:\s*!timedOut\s*\}\)/, 'resolve 的 aborted 值应取 !timedOut')
})

/* ─────────────── 4. cancel 仍要调 agent.cancel + abort ─────────────── */

test('#26-5：cancel() 必须同时调 agent.cancel 与 controller.abort', () => {
  const i = body.indexOf('async cancel(taskId)')
  assert.ok(i >= 0, '应有 cancel 方法')
  const seg = body.slice(i, i + 700)
  assert.match(seg, /agent\.cancel\(\{\s*kind:\s*'user'\s*\}\)/, '应通知 agent 取消')
  assert.match(seg, /controller\.abort\(\)/, '应触发 abort（现在它真的会打断 race）')
})

/* ─────────────── 5. finally 必须 dispose ─────────────── */

test('#26-5：finally 必须 dispose agent（否则取消后 agent 泄漏）', () => {
  const i = body.indexOf('} finally {')
  assert.ok(i >= 0, '应有 finally')
  const seg = body.slice(i, i + 800)
  assert.match(seg, /await handle\?\.dispose\(\)/, '应 dispose agent handle')
  assert.match(seg, /clearTimeout\(timer\)/, '应清掉超时 timer')
})

/* ─────────────── 6. engine 侧映射必须认 aborted ─────────────── */

test('#26-5：engine 的状态映射必须把 aborted 落成 ABORTED（不是 FAILED/COMPLETED）', () => {
  const engineSrc = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'node', 'task-engine.js'), 'utf8'))
  const i = engineSrc.indexOf('const status = result.aborted')
  assert.ok(i >= 0, '应有 `const status = result.aborted` 映射')
  const seg = engineSrc.slice(i, i + 400)
  assert.match(seg, /TASK_STATUS\.ABORTED/, '应映射到 ABORTED')
  // 顺序：aborted 必须在 timedOut / ok 之前判定
  const aIdx = seg.indexOf('result.aborted')
  const tIdx = seg.indexOf('result.timedOut')
  const oIdx = seg.indexOf('result.ok')
  assert.ok(aIdx < tIdx && tIdx < oIdx, '判定顺序必须是 aborted → timedOut → ok')
})
