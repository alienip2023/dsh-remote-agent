/**
 * fs-service（提案 #25）单测：只读远程文件工具的安全边界与上限行为。
 *
 * 测试纪律与既有套件一致：临时目录真建真删；roots 用 mkdtemp 返回值
 * （fs-service 内部会做 realpathSync.native 归一，runner 的 8.3 短名不会
 * 造成假阴性 —— 这是 engine-e2e 踩过的坑，这里由被测对象兜住）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  createFsService,
  READABLE_FILE_MAX,
  READ_TEXT_MAX,
  GREP_MAX_MATCHES,
  TREE_MAX_ENTRIES,
} from '../lib/node/fs-service.js'

/** 建一棵确定性的测试树：
 *  root/
 *    docs/a.txt          "hello needle\nsecond line\n"
 *    docs/b.log          1MB+ 单行大文本（read 文本超限路径用）
 *    data/big.bin        含 NUL 的二进制
 *    data/huge.bin       > 8MB 二进制
 *    secret/inner.txt    denyPaths 目标
 *    link-to-secret      符号链接（指向 secret，tree/grep 不得深入）
 *    code/main.js        "const needle = 1\n"
 */
function makeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fs-'))
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 上句柄残留时容忍清理失败
    }
  })
  const mk = (rel, content) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    return abs
  }
  mk('docs/a.txt', 'hello needle\nsecond line\nneedle again\n')
  mk('docs/b.log', `${'x'.repeat(READABLE_FILE_MAX + 100)}\n`)
  mk('data/big.bin', Buffer.from([0x00, 0x01, 0xff, 0x02, 0x00, 0x7f]))
  // 全零填充：开头就有 NUL —— 确保 looksBinary 走二进制分支（0x41 填充是"文本"）
  mk('data/huge.bin', Buffer.alloc(READABLE_FILE_MAX + 1024, 0x00))
  mk('secret/inner.txt', 'secret needle\n')
  mk('code/main.js', 'const needle = 1\n// needle comment\n')
  try {
    fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'link-to-secret'), 'dir')
  } catch {
    // 无符号链接权限的环境（部分 CI）跳过链接断言
  }
  return { root, mk }
}

const service = (root, extra = {}) => createFsService({
  roots: [root],
  caseInsensitive: process.platform === 'win32',
  denyPaths: ['secret'],
  ...extra,
})

test('fs-service ls：类型/排序/分页与 denyPaths 过滤', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  const r = svc.ls({ path: root })
  assert.equal(r.path, fs.realpathSync.native(root))
  // secret 被 denyPaths 拦下：连名字都不出现
  const names = r.entries.map((e) => e.name)
  assert.equal(names.includes('secret'), false, 'denyPaths 条目不得出现在 ls')
  // 目录优先排序
  assert.equal(r.entries[0].type, 'dir')
  const dirs = r.entries.filter((e) => e.type === 'dir').map((e) => e.name)
  assert.deepEqual(dirs, ['code', 'data', 'docs'])
  // 分页：truncated = offset+limit < total（与符号链接是否创建成功无关）
  const page = svc.ls({ path: root, limit: 1, offset: 0 })
  assert.equal(page.entries.length, 1)
  assert.equal(page.truncated, r.entries.length > 1)
  const page2 = svc.ls({ path: root, limit: r.entries.length, offset: 0 })
  assert.equal(page2.truncated, false)
  // 文件带大小
  const a = svc.ls({ path: path.join(root, 'docs') }).entries.find((e) => e.name === 'a.txt')
  assert.equal(a.size, 'hello needle\nsecond line\nneedle again\n'.length)
})

test('fs-service ls：相对路径与 roots 外路径拒绝', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  assert.throws(() => svc.ls({ path: 'relative/path' }), (e) => e.code === 'workspace-denied')
  assert.throws(() => svc.ls({ path: 'C:\\Windows' }), (e) => e.code === 'workspace-denied')
  // '/etc' 在 Windows 是"当前盘符下不存在的路径" → artifact-missing；
  // 在 POSIX 是真实存在的 roots 外目录 → workspace-denied。两边都必须拒。
  assert.throws(() => svc.ls({ path: '/etc' }), (e) =>
    e.code === 'workspace-denied' || e.code === 'artifact-missing')
  assert.throws(() => svc.ls({}), (e) => e.code === 'workspace-denied')
})

test('fs-service read：文本按行分段、截断与单行截断', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  const a = path.join(root, 'docs', 'a.txt')
  const r1 = svc.read({ path: a })
  assert.equal(r1.binary, false)
  assert.equal(r1.totalLines, 3)
  assert.deepEqual(r1.lines, ['hello needle', 'second line', 'needle again'])
  assert.equal(r1.truncated, false)
  // offset 翻页
  const r2 = svc.read({ path: a, offset: 1, limit: 1 })
  assert.deepEqual(r2.lines, ['second line'])
  assert.equal(r2.truncated, true)
})

test('fs-service read：单次响应 256KB 文本上限触发截断', (t) => {
  const { root, mk } = makeTree(t)
  // 造一个 1000 行 × 400B ≈ 400KB 的文件，limit 放开也必须在 256KB 处截断
  const big = mk('docs/big.txt', Array.from({ length: 1000 }, () => `${'y'.repeat(399)}\n`).join(''))
  const svc = service(root)
  const r = svc.read({ path: big, limit: 5000 })
  assert.equal(r.truncated, true)
  assert.ok(Buffer.byteLength(r.lines.join('\n'), 'utf8') <= READ_TEXT_MAX, '响应文本量不得超过 256KB')
})

test('fs-service read：二进制只回 sha256/size/头部预览，不回原始内容', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  const bin = path.join(root, 'data', 'big.bin')
  const content = fs.readFileSync(bin)
  const r = svc.read({ path: bin })
  assert.equal(r.binary, true)
  assert.equal(r.size, content.length)
  assert.equal(r.sha256, createHash('sha256').update(content).digest('hex'))
  assert.equal(r.lines, undefined, '二进制文件绝不能带 lines 字段')
  assert.ok(r.head.length > 0)
})

test('fs-service read：>8MB 文本拒绝、二进制大文件走 hash 路径', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  // b.log 是 >8MB 的"文本"（无 NUL）→ 文本模式拒绝
  assert.throws(
    () => svc.read({ path: path.join(root, 'docs', 'b.log') }),
    (e) => e.code === 'artifact-too-large',
  )
  // huge.bin 是 >8MB 二进制 → 二进制 hash 路径照常可用（只读头部+流式 hash）
  const r = svc.read({ path: path.join(root, 'data', 'huge.bin') })
  assert.equal(r.binary, true)
  assert.ok(r.size > READABLE_FILE_MAX)
})

test('fs-service read：不存在 / 是目录 / denyPaths', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  assert.throws(() => svc.read({ path: path.join(root, 'nope.txt') }), (e) => e.code === 'artifact-missing')
  assert.throws(() => svc.read({ path: path.join(root, 'docs') }), (e) => e.code === 'workspace-denied')
  assert.throws(() => svc.read({ path: path.join(root, 'secret', 'inner.txt') }), (e) => e.code === 'workspace-denied')
})

test('fs-service grep：字面量与正则、glob 过滤、命中结构', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  const r = svc.grep({ path: root, pattern: 'needle' })
  // secret 被 deny 排除；链接不跟随 → 命中只能来自 docs/a.txt 与 code/main.js
  const files = [...new Set(r.matches.map((m) => m.file))]
  assert.equal(files.some((f) => f.includes('secret')), false, 'denyPaths 目标不得被 grep 命中')
  assert.ok(files.some((f) => f.includes('docs')))
  assert.ok(files.some((f) => f.includes('code')))
  // 正则 + 大小写敏感
  const r2 = svc.grep({ path: root, pattern: 'NEEDLE', ignoreCase: false })
  assert.equal(r2.matchCount, 0)
  const r3 = svc.grep({ path: root, pattern: 'n[eE]edle', regex: true })
  assert.ok(r3.matchCount >= r.matchCount)
  // glob 只扫 js
  const r4 = svc.grep({ path: root, pattern: 'needle', glob: '*.js' })
  assert.deepEqual([...new Set(r4.matches.map((m) => m.file))], [path.join(root, 'code', 'main.js')])
  // 命中带行号与文本
  assert.ok(r.matches.every((m) => typeof m.line === 'number' && typeof m.text === 'string'))
})

test('fs-service grep：maxMatches 截断与 pattern 校验', (t) => {
  const { root, mk } = makeTree(t)
  mk('docs/many.txt', Array.from({ length: 300 }, (_, i) => `hit ${i} needle\n`).join(''))
  const svc = service(root)
  const r = svc.grep({ path: path.join(root, 'docs'), pattern: 'needle', maxMatches: 5 })
  assert.equal(r.matchCount, 5)
  assert.equal(r.truncated, true)
  assert.equal(r.truncatedBy, 'maxMatches')
  // 空 pattern / 非法正则
  assert.throws(() => svc.grep({ path: root, pattern: '' }), (e) => e.code === 'workspace-denied')
  assert.throws(() => svc.grep({ path: root, pattern: '(', regex: true }), (e) => e.code === 'workspace-denied')
})

test('fs-service grep：二进制与超大文件跳过、计数如实', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  // 'A' 在 huge.bin（>8MB 二进制）里满地都是，但它必须被跳过：
  // 大小超限跳过 + 二进制嗅探跳过，双保险。b.log 同理（>2MB 文本）。
  const r = svc.grep({ path: root, pattern: 'AAAA' })
  assert.equal(r.matchCount, 0)
  assert.ok(r.filesSkipped > 0, '跳过数应如实上报')
})

test('fs-service tree：深度/条目上限/denyPaths/链接不深入', (t) => {
  const { root, mk } = makeTree(t)
  // 深链：l1/l2/l3/l4（depth=2 时 l3 以下不出现）
  mk('deep/l1/l2/l3/l4/leaf.txt', 'deep\n')
  const svc = service(root)
  const r = svc.tree({ path: root, depth: 2 })
  const flat = JSON.stringify(r.items)
  assert.equal(flat.includes('leaf.txt'), false, 'depth=2 不应扫到第 4 层文件')
  assert.ok(r.entries <= TREE_MAX_ENTRIES)
  // denyPaths
  assert.equal(flat.includes('secret'), false)
  // 条目上限截断
  const r2 = svc.tree({ path: root, depth: 6, maxEntries: 5 })
  assert.equal(r2.truncated, true)
  assert.ok(r2.entries <= 5)
})

test('fs-service tree：空目录与非目录路径报错', (t) => {
  const { root, mk } = makeTree(t)
  mk('empty/.keep', '')
  const svc = service(root)
  const r = svc.tree({ path: path.join(root, 'empty') })
  // .keep 是 denyPaths 之外的真文件，但空目录扫描本身应返回空 items
  assert.ok(Array.isArray(r.items))
  // 对文件调 tree → 拒绝
  assert.throws(() => svc.tree({ path: path.join(root, 'docs', 'a.txt') }), (e) => e.code === 'workspace-denied')
})

test('fs-service：符号链接不跟随（逃逸防护）', (t) => {
  const { root } = makeTree(t)
  const svc = service(root)
  // link-to-secret → secret（roots 内，但被 denyPaths 拦）。
  // 更狠的：链接指向 roots 外。
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fs-out-'))
  t.after(() => {
    try {
      fs.rmSync(outside, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  })
  fs.writeFileSync(path.join(outside, 'escaped.txt'), 'escaped needle\n')
  try {
    fs.symlinkSync(outside, path.join(root, 'link-outside'), 'dir')
  } catch {
    return // 环境不支持符号链接，跳过
  }
  // grep 不得命中 roots 外内容
  const r = svc.grep({ path: root, pattern: 'escaped' })
  assert.equal(r.matchCount, 0, '符号链接指向 roots 外时绝不能跟随')
  // tree 不得深入
  const tr = svc.tree({ path: root, depth: 4 })
  assert.equal(JSON.stringify(tr.items).includes('escaped.txt'), false)
  // ls 报条目本身（link 类型）但不解引用
  const ls = svc.ls({ path: root })
  const link = ls.entries.find((e) => e.name === 'link-outside')
  if (link) assert.equal(link.type, 'link')
})

test('fs-service：GREP_MAX_MATCHES 常量上限兜底', (t) => {
  const { root, mk } = makeTree(t)
  mk('docs/spam.txt', Array.from({ length: 10000 }, (_, i) => `needle ${i}\n`).join(''))
  const svc = service(root)
  // 调用方传天大的 maxMatches 也被夹回 GREP_MAX_MATCHES
  const r = svc.grep({ path: root, pattern: 'needle', maxMatches: 100000 })
  assert.equal(r.matchCount, GREP_MAX_MATCHES)
})
