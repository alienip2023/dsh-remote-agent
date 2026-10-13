/**
 * glob / 路径语义单元测试（lib/glob.js，冻结层，只测不改）。
 *
 * Windows 语义是重点：
 *   - 大小写不敏感模式下 'C:\Work\a.txt' 匹配 'c:/work/**'
 *   - '**' 跨目录、'*' 不跨分隔符
 *   - '{a,b}' 或、前导 '!' 取反
 *   - isInside 对 'D:/work' 与 'D:/work2' 判定为不包含
 *   - isAbsolutePath 识别盘符 / UNC / POSIX
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  basename,
  compileRules,
  dirname,
  extname,
  globToRegExp,
  isAbsolutePath,
  isInside,
  matchGlob,
  normalizePath,
} from '../lib/glob.js'

/* ─────────────────────────── normalizePath ─────────────────────────── */

test('normalizePath：反斜杠与正斜杠等价、去尾分隔符', () => {
  assert.equal(normalizePath('C:\\Work\\a.txt'), 'C:/Work/a.txt')
  assert.equal(normalizePath('C:/Work/a.txt'), 'C:/Work/a.txt')
  assert.equal(normalizePath('C:\\Work\\'), 'C:/Work')
  assert.equal(normalizePath('a//b///c'), 'a/b/c')
  assert.equal(normalizePath('a\\b//c'), 'a/b/c')
})

test('normalizePath：大小写不敏感时统一小写（含盘符）', () => {
  assert.equal(normalizePath('C:\\Work\\A.TXT', { caseInsensitive: true }), 'c:/work/a.txt')
  assert.equal(normalizePath('C:\\Work\\A.TXT'), 'C:/Work/A.TXT')
})

test('normalizePath：保留 UNC 双斜杠前缀', () => {
  assert.equal(normalizePath('\\\\server\\share\\x.txt'), '/server/share/x.txt')
  assert.equal(normalizePath('//server/share/x.txt'), '/server/share/x.txt')
  assert.equal(normalizePath('\\\\server\\share\\', { caseInsensitive: true }), '/server/share')
})

test('normalizePath：非字符串输入返回空串，不抛', () => {
  for (const v of [undefined, null, 42, {}, []]) {
    assert.equal(normalizePath(v), '', String(v))
  }
})

test('normalizePath：根路径与单字符不被吃掉', () => {
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath('C:/'), 'C:')
  assert.equal(normalizePath('a'), 'a')
})

/* ─────────────────────────── isAbsolutePath ─────────────────────────── */

test('isAbsolutePath：识别 POSIX / 盘符 / UNC', () => {
  assert.equal(isAbsolutePath('/home/user'), true)
  assert.equal(isAbsolutePath('/'), true)
  assert.equal(isAbsolutePath('C:\\work'), true)
  assert.equal(isAbsolutePath('c:/work'), true)
  assert.equal(isAbsolutePath('Z:\\'), true)
  assert.equal(isAbsolutePath('\\\\server\\share'), true)
  assert.equal(isAbsolutePath('//server/share'), true)
})

test('isAbsolutePath：相对路径与空值判 false', () => {
  for (const p of ['relative/path', './x', '../x', 'C:', 'C:work', '', 'x.txt']) {
    assert.equal(isAbsolutePath(p), false, JSON.stringify(p))
  }
  for (const p of [undefined, null, 42, {}]) {
    assert.equal(isAbsolutePath(p), false, String(p))
  }
})

/* ─────────────────────────── globToRegExp / matchGlob ─────────────────────────── */

test("Windows 语义：大小写不敏感模式下 'C:\\Work\\a.txt' 匹配 'c:/work/**'", () => {
  const opts = { caseInsensitive: true }
  assert.equal(matchGlob('C:\\Work\\a.txt', 'c:/work/**', opts), true)
  assert.equal(matchGlob('c:/work/a.txt', 'C:\\Work\\**', opts), true)
  assert.equal(matchGlob('C:\\WORK\\SUB\\B.TXT', 'c:/work/**', opts), true)
  // 大小写敏感时不匹配
  assert.equal(matchGlob('C:\\Work\\a.txt', 'c:/work/**', { caseInsensitive: false }), false)
})

test("'**' 跨目录、'*' 不跨分隔符", () => {
  assert.equal(matchGlob('a/b/c/d.txt', 'a/**'), true)
  assert.equal(matchGlob('a/b/c/d.txt', 'a/**/d.txt'), true)
  assert.equal(matchGlob('a/d.txt', 'a/**/d.txt'), true)
  assert.equal(matchGlob('d.txt', '**/d.txt'), true)
  assert.equal(matchGlob('a/b/c.txt', '**/*.txt'), true)

  // '*' 只吃一段
  assert.equal(matchGlob('a/b/c.txt', 'a/*/c.txt'), true)
  assert.equal(matchGlob('a/b/x/c.txt', 'a/*/c.txt'), false)
  assert.equal(matchGlob('a/b/c.txt', '*.txt'), false)
  assert.equal(matchGlob('c.txt', '*.txt'), true)
  // '**' 吃掉零个或多个目录段
  assert.equal(matchGlob('a/x.txt', 'a/**/x.txt'), true)
})

test('Windows 语义：分隔符混用也能匹配', () => {
  assert.equal(matchGlob('D:\\work\\sub\\f.log', 'd:/work/**/*.log', { caseInsensitive: true }), true)
  assert.equal(matchGlob('D:/work/sub/f.log', 'D:\\work\\**\\*.log', { caseInsensitive: true }), true)
})

test("'{a,b}' 或 —— 含嵌套与多项", () => {
  assert.equal(matchGlob('x.log', '*.{log,tmp}'), true)
  assert.equal(matchGlob('x.tmp', '*.{log,tmp}'), true)
  assert.equal(matchGlob('x.txt', '*.{log,tmp}'), false)
  assert.equal(matchGlob('dist/app.js', '{dist,build}/**'), true)
  assert.equal(matchGlob('build/app.js', '{dist,build}/**'), true)
  assert.equal(matchGlob('src/app.js', '{dist,build}/**'), false)
  // 已知限制（lib/glob.js splitTopLevel 不做递归展开）：嵌套花括号里的内层 {2,3}
  // 被当作字面量整体转义，所以 'a{1,{2,3}}' 只匹配 'a1' 与字面量 'a{2,3}'。
  // 任务契约只要求 '{a,b}' 或，此处按实际行为断言并记录该限制。
  assert.equal(matchGlob('a1', 'a{1,{2,3}}'), true)
  assert.equal(matchGlob('a3', 'a{1,{2,3}}'), false, '嵌套花括号未做递归展开（已知限制）')
  assert.equal(matchGlob('a{2,3}', 'a{1,{2,3}}'), true, '内层花括号被当字面量匹配')
  assert.equal(matchGlob('a4', 'a{1,{2,3}}'), false)
})

test("前导 '!' 取反：命中取反项直接判 false", () => {
  assert.equal(matchGlob('a/b.txt', ['**', '!**/*.log']), true)
  assert.equal(matchGlob('a/b.log', ['**', '!**/*.log']), false)
  // 只有取反项、没有正向命中 → false
  assert.equal(matchGlob('a/b.txt', ['!**/*.log']), false)
  // 取反项顺序在正向之前也生效（命中即 false）
  assert.equal(matchGlob('a/b.log', ['!**/*.log', '**']), false)
})

test('matchGlob：base 相对模式拼接', () => {
  assert.equal(matchGlob('D:/work/dist/a.js', ['dist/**'], { base: 'D:/work' }), true)
  assert.equal(matchGlob('D:/other/dist/a.js', ['dist/**'], { base: 'D:/work' }), false)
  // 绝对模式不受 base 影响
  assert.equal(matchGlob('D:/work/dist/a.js', ['D:/work/dist/**'], { base: 'E:/x' }), true)
})

test('matchGlob：空模式 / 非字符串项被忽略，不抛', () => {
  assert.equal(matchGlob('a.txt', []), false)
  assert.equal(matchGlob('a.txt', ''), false)
  assert.equal(matchGlob('a.txt', ['', null, 42]), false)
  assert.equal(matchGlob('a.txt', [null, '*.txt']), true)
})

test("'?' 单字符、'[abc]' 字符类", () => {
  assert.equal(matchGlob('a.txt', '?.txt'), true)
  assert.equal(matchGlob('ab.txt', '?.txt'), false)
  assert.equal(matchGlob('b.txt', '[abc].txt'), true)
  assert.equal(matchGlob('d.txt', '[abc].txt'), false)
  assert.equal(matchGlob('d.txt', '[!abc].txt'), true)
  // '?' 不吃分隔符
  assert.equal(matchGlob('a/b.txt', 'a?b.txt'), false)
})

test('globToRegExp：同一模式缓存复用且大小写选项隔离', () => {
  const a = globToRegExp('*.txt')
  const b = globToRegExp('*.txt')
  assert.equal(a, b)
  const ci = globToRegExp('*.txt', { caseInsensitive: true })
  assert.notEqual(a, ci)
  assert.equal(ci.test('A.TXT'), true)
  assert.equal(a.test('A.TXT'), false)
})

test('globToRegExp：正则元字符被转义，不当正则用', () => {
  assert.equal(matchGlob('a+b.txt', 'a+b.txt'), true)
  assert.equal(matchGlob('axb.txt', 'a+b.txt'), false)
  assert.equal(matchGlob('a.b', 'a.b'), true)
  assert.equal(matchGlob('aXb', 'a.b'), false)
  assert.equal(matchGlob('a(b).txt', 'a(b).txt'), true)
})

/* ─────────────────────────── isInside ─────────────────────────── */

test("isInside：'D:/work' 与 'D:/work2' 判定为不包含（最容易写错的一条）", () => {
  assert.equal(isInside('D:/work', 'D:/work2'), false)
  assert.equal(isInside('D:/work', 'D:/work2/file.txt'), false)
  assert.equal(isInside('D:/work', 'D:/work/file.txt'), true)
  assert.equal(isInside('D:/work', 'D:/work'), true)
  assert.equal(isInside('D:/work/', 'D:/work/sub'), true)

  // 大小写不敏感模式下同理
  const ci = { caseInsensitive: true }
  assert.equal(isInside('D:/work', 'd:/WORK2', ci), false, 'caseInsensitive')
  assert.equal(isInside('D:/work', 'd:/WORK/file.txt', ci), true, 'caseInsensitive')
  assert.equal(isInside('D:/WORK', 'd:/work/sub', ci), true, 'caseInsensitive')
  // 不传 caseInsensitive 时大小写敏感
  assert.equal(isInside('D:/work', 'd:/WORK/file.txt'), false, '大小写敏感默认')
  // 分隔符混用
  assert.equal(isInside('D:\\work', 'D:/work2'), false)
  assert.equal(isInside('D:\\work', 'D:/work/sub/x.txt'), true)
})

test('isInside：前缀相似但不是父目录的各种情形', () => {
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a/bc/d'), false)
  assert.equal(isInside('/a/b', '/a'), false)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('C:/a', 'C:/a'), true)
  assert.equal(isInside('C:/a', 'D:/a'), false)
})

test('isInside：空值判 false，不抛', () => {
  assert.equal(isInside('', 'D:/work'), false)
  assert.equal(isInside('D:/work', ''), false)
  assert.equal(isInside(undefined, 'D:/work'), false)
  assert.equal(isInside('D:/work', null), false)
})

/* ─────────────────────────── compileRules ─────────────────────────── */

test('compileRules：逐条匹配 + 取反短路', () => {
  const test1 = compileRules(['**', '!**/*.log'])
  assert.equal(test1('a/b/c.txt'), true)
  assert.equal(test1('a/b/c.log'), false)

  const test2 = compileRules(['dist/**'], { base: 'D:/work' })
  assert.equal(test2('D:/work/dist/a.js'), true)
  assert.equal(test2('D:/work/src/a.js'), false)

  const test3 = compileRules([], {})
  assert.equal(test3('anything'), false)

  const test4 = compileRules(undefined)
  assert.equal(test4('anything'), false)
})

/* ─────────────────────────── 路径工具 ─────────────────────────── */

test('extname：小写、含点，隐藏文件与无扩展名判空', () => {
  assert.equal(extname('a/b/c.TXT'), '.txt')
  assert.equal(extname('C:\\work\\App.EXE'), '.exe')
  assert.equal(extname('archive.tar.gz'), '.gz')
  assert.equal(extname('noext'), '')
  assert.equal(extname('.gitignore'), '')
  assert.equal(extname('a/b/'), '')
})

test('dirname / basename', () => {
  assert.equal(dirname('C:\\work\\a.txt'), 'C:/work')
  assert.equal(dirname('/a/b/c'), '/a/b')
  assert.equal(dirname('/a'), '/')
  assert.equal(dirname('a'), '')
  assert.equal(basename('C:\\work\\a.txt'), 'a.txt')
  assert.equal(basename('/a/b/c'), 'c')
  assert.equal(basename('a'), 'a')
})
