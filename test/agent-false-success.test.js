/**
 * agent 后端「假成功」回归测试（2026-10-21 真实使用发现的 bug）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 现场
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户真实派发了一个任务（"给我做一个光效酷炫的网页"），面板显示：
 *
 *     状态: completed          ← 显示成功
 *     结果摘要: [agent 错误] {"turn":1,"step":1,"error":{"message":
 *               "DeepSeek Messages transport failed.","code":"TRANSPORT"}}
 *     成品: 0 项
 *
 * **一次 agent 完全失败的任务被标记成 completed。**
 *
 * ── 根因 ────────────────────────────────────────────────────────────────
 *
 * DSH 的 `kick()` 是 `try { while (await this.turn()) } catch (_error) {}`
 * —— turn 内的错误被完全吞掉，只通过 `agent/error` 事件暴露。
 *
 * 我们**已经**监听了那个事件，但只把文案推进 `liveText`（所以它出现在摘要里）。
 * `ok` 的判定是 `!timedOut && !aborted` —— **没看这个错误**。
 *
 * ── 为什么这比直接报错更糟 ──────────────────────────────────────────────
 *
 * 报错至少知道要重试；"假成功"会让人以为事情做完了 —— 用户可能就这样交付了
 * 一个什么都没生成的任务。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * 1. `agent/error` 里置 `hadError = true` + 记 `firstError`
 * 2. `ok` 必须包含 `&& !hadError`
 * 3. `stderr` 带上第一个错误 → engine 会把它写进 task/end 的 error 字段
 *
 * 本测试用**源码断言**锁住这三条（runner 的 agent 分支依赖真实 DSH agent
 * 上下文，无法在单测里跑起来；但这三条是纯逻辑，可以静态钉住）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const RUNNER = path.join(process.cwd(), 'lib', 'node', 'runner.js')
const src = fs.readFileSync(RUNNER, 'utf8')

test('回归：agent/error 必须置 hadError（不能只记文案）', () => {
  // 找 agent/error 的监听体
  const i = src.indexOf("this.ctx.on('agent/error'")
  assert.ok(i >= 0, '必须监听 agent/error —— 否则 turn 内错误完全不可见')
  const seg = src.slice(i, i + 1600)

  assert.match(seg, /hadError\s*=\s*true/, 'agent/error 必须置 hadError —— 这是"假成功"的根因')
  assert.match(seg, /firstError\s*=\s*msg/, '必须记下第一个错误，供 stderr 透出')
  // 仍然要保留文案记录（排查需要）
  assert.match(seg, /liveText\.push/, '仍要把错误文案推进 liveText（摘要里要能看到）')
})

test('回归：ok 必须排除 hadError（否则失败会显示 completed）', () => {
  // 找 agent 分支的 return（ok 判定处）
  const i = src.indexOf('ok: !timedOut && !aborted')
  assert.ok(i >= 0, '应找到 ok 判定')
  const line = src.slice(i, i + 200)

  assert.match(
    line,
    /ok:\s*!timedOut\s*&&\s*!aborted\s*&&\s*!hadError/,
    'ok 必须包含 !hadError —— 少了它，agent 失败的任务会落成 completed',
  )
})

test('回归：失败时 exitCode 与 stderr 必须反映错误', () => {
  const i = src.indexOf('ok: !timedOut && !aborted && !hadError')
  assert.ok(i >= 0)
  const seg = src.slice(i, i + 900)

  // exitCode 非 0（让任何依赖退出码的判定也能看出失败）
  assert.match(seg, /exitCode:\s*timedOut\s*\|\|\s*aborted\s*\?\s*null\s*:\s*\(hadError\s*\?\s*1\s*:\s*0\)/,
    'agent 报错时 exitCode 应为 1（不能是 0）')
  // stderr 带第一个错误 → engine 会写进 task/end 的 error
  assert.match(seg, /stderr:\s*hadError\s*\?\s*firstError\s*:\s*''/,
    'stderr 必须带上第一个错误，否则任务详情里看不到失败原因')
})

test('回归：engine 会把 ok=false 落成 failed（映射链完整）', () => {
  const engine = fs.readFileSync(
    path.join(process.cwd(), 'lib', 'node', 'task-engine.js'),
    'utf8',
  )
  // engine 的映射是嵌套三元：
  //   result.aborted ? ABORTED : result.timedOut ? INTERRUPTED : result.ok ? COMPLETED : FAILED
  // ⚠ 锚点要用 `: result.ok`（前面是 INTERRUPTED 分支），不是 `? result.ok`。
  const i = engine.indexOf(': result.ok')
  assert.ok(i >= 0, 'engine 应有 result.ok 判定')
  const seg = engine.slice(Math.max(0, i - 400), i + 400)
  assert.match(seg, /TASK_STATUS\.COMPLETED/, 'ok=true 应落 completed')
  assert.match(seg, /TASK_STATUS\.FAILED/, 'ok=false 应落 failed')
  // 失败原因要从 stderr 透出（我们刚把 agent 错误放进了 stderr）
  assert.match(seg, /result\.stderr/, '失败消息应取 result.stderr —— 否则看不到原因')
})

test('回归：timedOut / aborted 的原有语义没被破坏', () => {
  // 这两条是之前修过的（#26-5：取消不是成功），本次改动不能回退它们
  const i = src.indexOf('ok: !timedOut && !aborted && !hadError')
  const line = src.slice(i, i + 120)
  assert.match(line, /!timedOut/, '超时仍要判失败')
  assert.match(line, /!aborted/, '取消仍要判失败（#26-5）')
})
