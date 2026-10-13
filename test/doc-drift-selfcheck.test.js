/**
 * check-doc-drift.mjs 的自检（relay-cli 在 t12 追加验证时建议）。
 *
 * 为什么需要它：漂移检查脚本是**文档的守卫**。如果它自己的某个断言被改松
 * （例如正则从"锚定 catch 分支"退化成"文件里出现过 403"），脚本会静默变成
 * **永远通过** —— 那比没有守卫更危险，因为它给出虚假的安全感。
 *
 * 做法：在临时副本上注入**真实漂移**，断言脚本必须 exit 1 并报出对应项。
 * 这些注入都是 relay-cli 实际发现过的假阴性形态（900 字符窗口、只查一个键、
 * 两个词存在即通过），所以它们是**回归用例**，不是臆想的边界。
 *
 * 只读真仓库；所有改动都在 mkdtemp 出来的副本里。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT_REL = 'scripts/check-doc-drift.mjs'
// 注入目标：默认 ui-routes.js（guard 等断言在那里）。
// handoffView 相关的断言已随投影搬到 lib/hub/views.js，用 VIEWS_REL 注入。
const TARGET_REL = 'lib/hub/ui-routes.js'
const VIEWS_REL = 'lib/hub/views.js'

/** 把整个包复制到临时目录（只复制检查所需的子集，避免拷 node_modules）。 */
function makeCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-selfcheck-'))
  // 清单必须覆盖 check-doc-drift.mjs 会读的**每一个**文件：
  // lib/client.js、lib/hub/*、lib/hub/index.js、lib/node/*、lib/index.js、
  // lib/protocol.js、lib/glob.js、lib/relay.js、profiles/README.md、
  // KNOWN-ISSUES.md、package.json。
  // 早先漏了 lib/client.js，导致所有用例都因 ENOENT 失败（包括"干净副本必须通过"）。
  const entries = [
    'lib/client.js',
    'lib/index.js',
    'lib/protocol.js',
    'lib/glob.js',
    'lib/relay.js',
    'lib/hub',
    'lib/node',
    'profiles',
    'scripts',
    'package.json',
    'KNOWN-ISSUES.md',
  ]
  for (const rel of entries) {
    const src = path.join(ROOT, rel)
    if (!fs.existsSync(src)) continue
    const dst = path.join(dir, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(src, dst, { recursive: true })
  }
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return dir
}

/** 跑副本里的漂移检查，返回 { code, out }。 */
function runCheck(dir) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, SCRIPT_REL)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/**
 * 在副本的目标文件上做一次字符串替换/插入，然后跑检查。
 * @param {object} t
 * @param {(src:string)=>string} mutate
 * @param {string} [rel] 目标文件，默认 ui-routes.js；handoffView 相关传 views.js
 */
function probe(t, mutate, rel = TARGET_REL) {
  const dir = makeCopy(t)
  const target = path.join(dir, rel)
  const original = fs.readFileSync(target, 'utf8')
  const mutated = mutate(original)
  assert.notEqual(mutated, original, '注入未生效（mutate 没改动文本）—— 用例本身失效，需修断言而非放宽')
  fs.writeFileSync(target, mutated, 'utf8')
  return runCheck(dir)
}

/**
 * 断言锚点字符串在源码里**恰好出现一次**。
 *
 * 为什么需要（relay-cli 在 t12 追加验证时提出，它自己踩过这个坑）：
 * 注入脚本靠 `indexOf(anchor)` 定位插入点。若锚点不唯一，或函数被改名后
 * `indexOf` 返回 -1，插入点会**落到文件里第一个同名文本**上 —— 例如
 * `return {` 在本文件出现 11 次，属于哪个函数完全取决于巧合。
 * 注入落错位置后断言仍"通过"，产生**假绿**：看起来在守，实际守了个空。
 *
 * relay-cli 的原话：它的注入脚本第一版把 `workspace` 注进了 `taskView`
 * 而非 `handoffView`（两个函数都有 `return {`），导致误判"修复无效"。
 *
 * 所以注入前先断言锚点唯一；不唯一就 fail，让人去修锚点，
 * 而不是让测试静默失真。
 */
function assertUniqueAnchor(src, anchor) {
  const n = src.split(anchor).length - 1
  assert.equal(
    n,
    1,
    `注入锚点必须唯一：${JSON.stringify(anchor)} 出现 ${n} 次（期望 1）。若代码重构导致锚点不再唯一，请改用一个唯一的锚点。`,
  )
}

/** 取某个具名函数的完整函数体（与 check-doc-drift.mjs 的 bodyOf 同法）。 */
function bodyOf(src, fnName) {
  const start = src.indexOf(`function ${fnName}`)
  if (start === -1) return ''
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

/** 在指定函数的函数体开头（`return {` 之后）插入一行，锚点唯一性先被断言。 */
function insertIntoFunctionBody(src, fnName, line) {
  assertUniqueAnchor(src, `function ${fnName}`)
  const body = bodyOf(src, fnName)
  assert.notEqual(body, '', `找不到函数 ${fnName} 的函数体`)
  const rel = body.indexOf('return {')
  assert.notEqual(rel, -1, `${fnName} 函数体里找不到 "return {"`)
  const abs = src.indexOf(body) + rel
  return `${src.slice(0, abs + 9)}\n    ${line}${src.slice(abs + 9)}`
}

test('自检：干净副本必须通过（脚本不是"永远失败"）', (t) => {
  const dir = makeCopy(t)
  const { code, out } = runCheck(dir)
  assert.equal(code, 0, `干净副本应 exit 0，实际 ${code}：\n${out.slice(0, 500)}`)
  assert.match(out, /一致/, '应报告全部一致')
})

// handoffView 已随投影提取到 lib/hub/views.js，所以注入目标改为那个文件。
// 这本身是被这次重构暴露的维护点：**投影搬到哪，自检就要跟到哪** ——
// 否则注入落在一个不再被断言的函数上，测试"通过"但守了个空。
test('自检：handoffView 函数尾部注入 logs 必须被检出（防 900 字符窗口回归）', (t) => {
  // 旧断言用 slice(idx, idx+900) 固定窗口，而函数体 2260 字符 —— 尾部注入会漏。
  // 这里用「函数体定位 + 锚点唯一断言」而不是裸 indexOf('return {')，
  // 因为 'return {' 在文件里出现多次，裸 indexOf 可能注错函数（relay-cli 踩过）。
  const { code, out } = probe(
    t,
    (src) => insertIntoFunctionBody(src, 'handoffView', 'logs: h.logs,'),
    VIEWS_REL,
  )
  assert.equal(code, 1, `尾部注入 logs 应被检出（exit 1），实际 exit ${code}`)
  assert.match(out, /\[15b\]/, '应报出 15b')
})

test('自检：handoffView 内部注入 workspace 必须被检出（防"只查一个键"回归）', (t) => {
  // 旧断言标签说查 logs 与 workspace，正则却只查了 logs
  const { code, out } = probe(
    t,
    (src) => insertIntoFunctionBody(src, 'handoffView', 'workspace: h.workspace,'),
    VIEWS_REL,
  )
  assert.equal(code, 1, `内部注入 workspace 应被检出，实际 exit ${code}`)
  assert.match(out, /\[15b\]/, '应报出 15b')
})

test('自检：工具路径裸直出 handoff 必须被检出（防 remote_handoff 回退）', (t) => {
  // 这是本次修复的核心回归点：remote_handoff 曾裸直出 `handoff: t.handoff`。
  // 注入回那个形态，14c 必须报出。
  const { code, out } = probe(
    t,
    (src) => src.replace(/handoff:\s*handoffView\(t\.handoff\)/, 'handoff: t.handoff'),
    'lib/hub/tools.js',
  )
  assert.equal(code, 1, `工具路径裸直出应被检出，实际 exit ${code}`)
  assert.match(out, /\[14c\]/, '应报出 14c')
})

test('自检：registry.taskView 回退成裸拷贝必须被检出', (t) => {
  const { code, out } = probe(
    t,
    (src) => src.replace(/const base = taskProjection\(/, 'const base = ((x) => x)('),
    'lib/hub/node-registry.js',
  )
  assert.equal(code, 1, `taskView 绕过共享投影应被检出，实际 exit ${code}`)
  assert.match(out, /\[14d\]/, '应报出 14d')
})

test('自检：注入锚点必须唯一（防重构后注错位置产生假绿）', (t) => {
  // relay-cli 的建议落地：若锚点不再唯一，注入会落到别的函数上，
  // 断言仍"通过"但实际守了个空。这里显式验证 helper 会 fail。
  const src = fs.readFileSync(path.join(ROOT, VIEWS_REL), 'utf8')
  // 'return {' 出现多次，必须被判为不唯一
  assert.throws(() => assertUniqueAnchor(src, 'return {'), /锚点必须唯一/, "'return {' 不唯一，应抛错")
  // 具名函数锚点当前唯一
  assert.doesNotThrow(() => assertUniqueAnchor(src, 'function handoffView'), '具名函数锚点应唯一')
  assert.doesNotThrow(() => assertUniqueAnchor(src, 'function taskView'), '具名函数锚点应唯一')
})

test('自检：失败关闭改成失败放行必须被检出（防"两个词存在即通过"回归）', (t) => {
  // 旧断言只查 /403/ 与 /requestRejection/ 是否存在；文件里另有 6 处 403
  // 会掩盖 catch 分支的改动 —— 这是安全语义反转，必须能被抓到
  const { code, out } = probe(t, (src) => src.replace(/rejection = 403/g, 'rejection = undefined'))
  assert.equal(code, 1, `失败关闭→放行应被检出，实际 exit ${code}`)
  assert.match(out, /\[12\]/, '应报出 12')
})

test('自检：删掉 guard 调用点必须被检出', (t) => {
  const { code, out } = probe(t, (src) =>
    src.replace(/if \(!guard\(req, res, pathname\)\) return/, '/* removed */'))
  assert.equal(code, 1, `删 guard 调用应被检出，实际 exit ${code}`)
  assert.match(out, /\[12\]/, '应报出 12')
})

test('自检：handoffView 直出（handoff: t.handoff）必须被检出', (t) => {
  const { code, out } = probe(t, (src) =>
    src.replace(/handoff: handoffView\(t\.handoff\)/, 'handoff: t.handoff'))
  assert.equal(code, 1, `裸直出应被检出，实际 exit ${code}`)
  assert.match(out, /\[1[45]/, '应报出 14/15 相关项')
})

test('自检：注释里的反例不得被当成真代码（防剥注释回归）', (t) => {
  // t9 在注释里写了「为什么不能 `{ handoff: t.handoff }` 直接回」——
  // 若不剥注释，这句会被当成真代码命中，造成假阳性（干净代码报漂移）
  const dir = makeCopy(t)
  const target = path.join(dir, TARGET_REL)
  const src = fs.readFileSync(target, 'utf8')
  // 在文件头部加一句含反例的注释
  fs.writeFileSync(target, `// 反例说明：不能写成 { handoff: t.handoff } 直接回\n${src}`, 'utf8')
  const { code } = runCheck(dir)
  assert.equal(code, 0, '注释里的反例不应触发漂移（否则是假阳性，会让人无视脚本）')
})
