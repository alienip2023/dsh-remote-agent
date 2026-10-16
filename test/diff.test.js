/**
 * diff.js 单测（提案 #21）：纯 JS unified diff 的行为契约。
 *
 * 覆盖：新增/修改/删除三种形态、无差异返回 null、
 * 中段超限统计式降级、输出字节截断、输入行数裁剪。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unifiedDiff } from '../lib/node/diff.js'

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')

test('新增文件：beforeText 为空 → 单 hunk 纯增行', () => {
  const d = unifiedDiff({ path: 'new.txt', beforeText: '', afterText: 'a\nb\n' })
  assert.ok(d, '应有输出')
  assert.equal(d.path, 'new.txt')
  assert.equal(d.truncated, false)
  assert.match(d.diff, /^--- a\/new\.txt\n\+\+\+ b\/new\.txt\n/)
  assert.match(d.diff, /@@ -0,0 \+1,2 @@/)
  assert.match(d.diff, /\+a\n\+b\n/)
  assert.ok(!d.diff.includes('\n-'), '新增不应有删除行')
})

test('修改一行：hunk 里 - 旧行 + 新行，上下文各 3 行', () => {
  const before = [lines(3, 'head'), 'old line', lines(3, 'tail')].join('\n')
  const after = [lines(3, 'head'), 'new line', lines(3, 'tail')].join('\n')
  const d = unifiedDiff({ path: 'm.txt', beforeText: before, afterText: after })
  assert.ok(d)
  assert.equal(d.truncated, false)
  // 前像 7 行 → hunk = 3 上下文 + 1 删 + 1 增 + 3 上下文 → -1,7 +1,7
  assert.match(d.diff, /@@ -1,7 \+1,7 @@/)
  assert.match(d.diff, /-old line\n/)
  assert.match(d.diff, /\+new line\n/)
  assert.match(d.diff, / head 1\n/)
})

test('删除文件：afterText 为空 → 纯删行，@@ 头 bStart=0,0', () => {
  const before = 'x\ny\nz\n'
  const d = unifiedDiff({ path: 'gone.txt', beforeText: before, afterText: '' })
  assert.ok(d)
  assert.match(d.diff, /-x\n-y\n-z\n/)
  // 全删 hunk：body 里没有非 '-' 行 → 后像段是 -from0+0+1 … 实际形态 0,0
  assert.match(d.diff, /@@ -1,3 \+0,0 @@/)
})

test('无文本差异返回 null', () => {
  assert.equal(unifiedDiff({ path: 'same.txt', beforeText: 'a\nb\n', afterText: 'a\nb\n' }), null)
  assert.equal(unifiedDiff({ path: 'empty.txt', beforeText: '', afterText: '' }), null)
})

test('中段超限（>600 行）统计式降级：truncated=true 且含降级标注', () => {
  const before = lines(700, 'a')
  const after = lines(700, 'b')
  const d = unifiedDiff({ path: 'huge.txt', beforeText: before, afterText: after })
  assert.ok(d)
  assert.equal(d.truncated, true)
  assert.match(d.diff, /内容过长未逐行展开/)
  assert.match(d.diff, /@@ -1,700 \+1,700 @@/)
  // 统计式降级不展开行，输出必须很小
  assert.ok(Buffer.byteLength(d.diff) < 1024, `降级输出应远小于 1KB，实际 ${Buffer.byteLength(d.diff)}`)
})

test('输出超过 maxBytes 截断并标注', () => {
  const before = ''
  const after = lines(200, 'x')
  const d = unifiedDiff({ path: 'big.txt', beforeText: before, afterText: after, maxBytes: 200 })
  assert.ok(d)
  assert.equal(d.truncated, true)
  assert.ok(Buffer.byteLength(d.diff) <= 200 + 80, '截断后输出应贴着上限（加标注余量）')
  assert.match(d.diff, /已截断/)
})

test('输入超过 1500 行：裁剪参与 diff 并标注 truncated', () => {
  // 1600 行：公共前缀 700 + 中段改动 5 行 + 公共后缀 895 —— 裁剪后中段
  // 仍在 LCS 上限内，逐行展开；但输入被裁过，truncated 必须为 true
  const prefix = lines(700, 'p')
  const suffix = Array.from({ length: 895 }, (_, i) => `s ${i + 1}`).join('\n')
  const before = `${prefix}\n${lines(5, 'old')}\n${suffix}`
  const after = `${prefix}\n${lines(5, 'new')}\n${suffix}`
  assert.ok(before.split('\n').length > 1500, '构造必须超限')

  const d = unifiedDiff({ path: 'long.txt', beforeText: before, afterText: after })
  assert.ok(d)
  assert.equal(d.truncated, true, '输入被裁剪应标注 truncated')
  assert.match(d.diff, /-old 5\n/)
  assert.match(d.diff, /\+new 5\n/)
  // 被裁掉的尾巴不参与 diff
  assert.ok(!d.diff.includes('s 1600\n'), '超出 1500 行的尾巴不得出现')
})

test('纯新增超过 1500 行：裁剪后中段仍超限 → 统计式降级（不逐行展开）', () => {
  const d = unifiedDiff({ path: 'huge-add.txt', beforeText: '', afterText: lines(1600, 'y') })
  assert.ok(d)
  assert.equal(d.truncated, true)
  assert.match(d.diff, /内容过长未逐行展开/)
  assert.ok(!d.diff.includes('+y 1\n'), '降级路径不得展开具体行')
})

test('CRLF 输入按行归一处理，不产生伪差异', () => {
  const d = unifiedDiff({ path: 'crlf.txt', beforeText: 'a\r\nb\r\n', afterText: 'a\nb\n' })
  assert.equal(d, null, '仅行尾差异不应产出 diff')
})
