/**
 * 原子写的 EPERM 防线（2026-10-17，第 5 次 CI 失败后立项修）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 事故史
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `atomicWriteJson` 的 rename 在 Windows 上会被 EPERM 拦（目标正被另一个
 * 句柄读着）。历次调整：
 *
 *   · 6 次 × 10ms 线性（总 210ms）→ 被饿过窗口（run 38894088627）
 *   · 10 次指数退避封顶 200ms（总 ~1.3s）→ 仍失败（run 39012045381）
 *
 * 第 5 次失败时终于承认：**这不是"抖动"，是"窗口太短"**。
 * 失败的那个用例是「并发写 + 并发读」，**多个 rename 互相争抢同一个目标**，
 * 而 CI runner 高峰期的磁盘延迟能到秒级。
 *
 * ── 最终修法（三层）──────────────────────────────────────────────────────
 *
 *   1. 总窗口拉到 **~6s**（16 次，封顶 500ms）
 *   2. 最后一次尝试前做 **unlink 兜底**（删掉目标再 rename，绕开
 *      "目标存在且被锁"的 EPERM）
 *   3. unlink 只在**前 15 次全失败**后才走 —— 它破坏"任何时刻都能读到
 *      完整文件"的严格原子性（删除与 rename 之间读方看到 ENOENT），
 *      所以必须当最后手段而不是常规路径
 *
 * ── 为什么 unlink 兜底是安全的 ──────────────────────────────────────────
 *
 * 读方（`store.list()`、测试里的 reader）**本来就容忍 ENOENT**
 * （首次写之前文件不存在是正常状态）。所以兜底造成的瞬时 ENOENT 落在
 * 既有的容忍范围内，不会让读方看到半截 JSON —— 那是原子写真正要防的。
 *
 * 这组测试锁住三件事：窗口足够长、兜底存在且时机正确、兜底不破坏语义。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TEMPLATES = path.join(ROOT, 'lib', 'hub', 'templates.js')

const src = fs.readFileSync(TEMPLATES, 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const code = stripComments(src)

/* ─────────────── 1. 重试窗口必须够长 ─────────────── */

test('EPERM：rename 重试窗口必须 ≥ 5s（16 次 × 封顶 500ms）', () => {
  const retries = code.match(/const RENAME_RETRIES\s*=\s*(\d+)/)
  const maxMs = code.match(/const RENAME_BACKOFF_MAX_MS\s*=\s*(\d+)/)
  assert.ok(retries, '应有 RENAME_RETRIES 常量')
  assert.ok(maxMs, '应有 RENAME_BACKOFF_MAX_MS 常量')

  const n = Number(retries[1])
  const cap = Number(maxMs[1])
  assert.ok(n >= 16, `重试次数应 ≥ 16（实际 ${n}）—— 10 次 × 200ms 只有 1.3s，已被饿过两次`)
  assert.ok(cap >= 500, `封顶退避应 ≥ 500ms（实际 ${cap}）—— CI runner 磁盘延迟能到秒级`)

  // 总窗口的下界估算：前几次指数退避 + 剩余次数 × 封顶
  const totalLowerBound = (n - 4) * cap
  assert.ok(totalLowerBound >= 5000, `总窗口下界应 ≥ 5s（实际约 ${totalLowerBound}ms）`)
})

/* ─────────────── 2. unlink 兜底必须存在且时机正确 ─────────────── */

test('EPERM：最后一次尝试前必须有 unlink 兜底', () => {
  assert.match(code, /RENAME_UNLINK_FALLBACK_AT/, '应定义兜底触发点常量')
  const i = code.indexOf('function atomicWriteJson')
  assert.ok(i >= 0, '应存在 atomicWriteJson')
  const seg = code.slice(i, i + 2000)

  assert.match(seg, /attempt === RENAME_UNLINK_FALLBACK_AT/, '应在特定 attempt 触发兜底')
  assert.match(seg, /fs\.promises\.rm\(file, \{ force: true \}\)/, '兜底应删除目标文件')
})

test('EPERM：兜底触发点必须是最后一次（不能提前，否则破坏原子性）', () => {
  // 兜底点的定义必须是 `RENAME_RETRIES - N`（引用常量，不写死数字）。
  const m = code.match(/const RENAME_UNLINK_FALLBACK_AT\s*=\s*RENAME_RETRIES\s*-\s*(\d+)/)
  assert.ok(m, '兜底点应基于 RENAME_RETRIES 计算，不写死数字（否则改重试次数时会脱钩）')
  const at = Number(m[1])
  assert.equal(
    at,
    1,
    `兜底应在 RENAME_RETRIES - 1（最后一次）触发，实际是 -${at} —— 提前会破坏"任何时刻读到完整文件"`,
  )
  // 再确认一次：常量定义处引用了 RENAME_RETRIES 而不是写死数字
  assert.match(
    code,
    /const RENAME_UNLINK_FALLBACK_AT\s*=\s*RENAME_RETRIES\s*-\s*\d+/,
    '兜底点应基于 RENAME_RETRIES 计算，不写死数字（否则改重试次数时会脱钩）',
  )
})

/* ─────────────── 3. 兜底不破坏读方语义 ─────────────── */

test('EPERM：读路径必须容忍 ENOENT（兜底造成的瞬时缺失落在既有容忍范围）', () => {
  // 读路径是 `readAll()`（`list()` 调它）—— 不是 `list()` 自己。
  // ⚠ 锚**定义处**不锚调用点：`list()` 里也可能出现 ENOENT 字样，
  // 但真正的容忍逻辑在 readAll 的 catch 分支里。
  const i = code.indexOf('async function readAll()')
  assert.ok(i >= 0, '应存在 readAll()')
  const seg = code.slice(i, i + 1400)
  assert.match(seg, /ENOENT/, 'readAll() 必须显式处理 ENOENT')
  // 且 ENOENT 分支必须返回**空库 + 不 degraded**（首次使用是正常状态）
  const eIdx = seg.indexOf("err?.code === 'ENOENT'")
  assert.ok(eIdx >= 0, '应有 ENOENT 判定')
  const branch = seg.slice(eIdx, eIdx + 300)
  assert.match(branch, /templates:\s*\[\]/, 'ENOENT 应返回空数组')
  assert.match(branch, /degraded:\s*false/, 'ENOENT 不该标 degraded（首次使用是正常状态）')
})

test('EPERM：兜底只对 transient 错误生效（非 transient 立即抛，不浪费时间）', () => {
  const i = code.indexOf('function atomicWriteJson')
  const seg = code.slice(i, i + 2000)
  // transient 判定必须存在且覆盖 EPERM/EBUSY/EACCES
  assert.match(seg, /const transient =/, '应有 transient 判定')
  assert.match(seg, /'EPERM'/, '应覆盖 EPERM')
  assert.match(seg, /'EBUSY'/, '应覆盖 EBUSY')
  assert.match(seg, /'EACCES'/, '应覆盖 EACCES')
  // 非 transient 必须直接 throw（不进入退避循环）
  assert.match(seg, /if \(!transient \|\| attempt >= RENAME_RETRIES\) throw err/, '非 transient 应立即抛')
})

/* ─────────────── 4. 行为验证：目标被目录占住时仍干净失败 ─────────────── */

test('EPERM：目标被目录占住时干净失败且不留临时文件', async (t) => {
  const { atomicWriteJson } = await import(new URL('../lib/hub/templates.js', import.meta.url).href)
    .then((m) => ({ atomicWriteJson: m.__atomicWriteJsonForTest ?? m.atomicWriteJson }))
    .catch(() => ({ atomicWriteJson: undefined }))

  // atomicWriteJson 是内部函数、未导出。跳过（形态断言已覆盖），
  // 行为由 templates.test.js 的「rename 失败时清理临时文件」用例守着。
  if (typeof atomicWriteJson !== 'function') {
    t.skip('atomicWriteJson 未导出，行为由 templates.test.js 覆盖')
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'))
  const target = path.join(root, 'occupied')
  fs.mkdirSync(target, { recursive: true })
  await assert.rejects(() => atomicWriteJson(target, { a: 1 }))
  const leftovers = fs.readdirSync(root).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '失败后不得留临时文件')
  fs.rmSync(root, { recursive: true, force: true })
})
