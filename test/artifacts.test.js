/**
 * 产物判定与清单单元测试（lib/artifacts.js，冻结层，只测不改）。
 *
 * 覆盖：
 *   - classify：intermediate / final+file / final+report / final+media / final+diff / other
 *   - 显式 artifactRules.intermediate 优先于 final（'dist/**' final 但 'dist/**\/*.log' intermediate）
 *   - buildManifest：临时目录上跑，断言 counts 与 sha256
 *   - authorizePull：intermediate 返回 ok:false 且 code === 'artifact-denied'
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  authorizePull,
  buildManifest,
  classify,
  hashFile,
  hashText,
  matchesOutputs,
  walk,
} from '../lib/artifacts.js'
import { ARTIFACT_KIND, ARTIFACT_ROLE } from '../lib/protocol.js'

/** 建一个独立临时目录，注册清理。 */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifacts-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  })
  return dir
}

/* ─────────────────────────── classify ─────────────────────────── */

test('classify：日志 / 临时 / 缓存 / 中间构建 → intermediate', () => {
  const cases = [
    'build.log',
    'logs/run.log',
    'dist/app.log',
    'tmp/x.tmp',
    'x.temp',
    'cache.data.cache',
    'a.lock',
    'a.pid',
    'a.swp',
    'a.bak',
    'app.js.map',
    'tsconfig.tsbuildinfo',
    'node_modules/foo/index.js',
    'src/node_modules/bar/x.js',
    '.cache/y.json',
    'temp/z.txt',
    '__pycache__/m.pyc',
    'coverage/lcov.info',
    'obj/x.o',
    'target/debug/app',
    '.dsh-remote-agent/tasks/t1.json',
  ]
  for (const p of cases) {
    const c = classify(p)
    assert.equal(c.role, ARTIFACT_ROLE.INTERMEDIATE, p)
    assert.equal(c.role, 'intermediate', p)
  }
})

test('classify：.exe / .dll / .zip → final + file', () => {
  for (const p of ['dist/app.exe', 'lib/native.dll', 'release/bundle.zip', 'a.so', 'a.wasm', 'pkg.tar.gz', 'a.apk', 'a.jar']) {
    const c = classify(p)
    assert.equal(c.role, ARTIFACT_ROLE.FINAL, p)
    assert.equal(c.kind, ARTIFACT_KIND.FILE, p)
    assert.equal(c.kind, 'file', p)
  }
})

test('classify：.pdf / .docx / .md → final + report', () => {
  for (const p of ['out/report.pdf', 'out/spec.docx', 'README.md', 'data.csv', 'notes.txt', 'book.xlsx', 'deck.pptx']) {
    const c = classify(p)
    assert.equal(c.role, ARTIFACT_ROLE.FINAL, p)
    assert.equal(c.kind, ARTIFACT_KIND.REPORT, p)
    assert.equal(c.kind, 'report', p)
  }
})

test('classify：.png / .mp4 → final + media', () => {
  for (const p of ['shots/a.png', 'video/out.mp4', 'img/x.jpg', 'a.svg', 'a.mp3', 'm.glb']) {
    const c = classify(p)
    assert.equal(c.role, ARTIFACT_ROLE.FINAL, p)
    assert.equal(c.kind, ARTIFACT_KIND.MEDIA, p)
    assert.equal(c.kind, 'media', p)
  }
})

test('classify：.diff / .patch → final + diff', () => {
  for (const p of ['changes.diff', 'fix.patch', 'patches/001.patch']) {
    const c = classify(p)
    assert.equal(c.role, ARTIFACT_ROLE.FINAL, p)
    assert.equal(c.kind, ARTIFACT_KIND.DIFF, p)
    assert.equal(c.kind, 'diff', p)
  }
})

test('classify：未命中任何规则 → other', () => {
  for (const p of ['src/app.ts', 'Makefile', 'src/main.go', 'index.js', 'a/b/c.xyz', 'noext']) {
    const c = classify(p)
    assert.equal(c.role, ARTIFACT_ROLE.OTHER, p)
    assert.equal(c.role, 'other', p)
  }
})

test('classify：显式 intermediate 规则优先于显式 final 规则', () => {
  const rules = { final: ['dist/**'], intermediate: ['dist/**/*.log'] }

  // 同时命中两条规则 → intermediate 赢
  const both = classify('dist/build.log', rules)
  assert.equal(both.role, ARTIFACT_ROLE.INTERMEDIATE, 'dist/build.log 应命中 intermediate')
  assert.equal(both.reason, 'rule:intermediate')
  assert.equal(classify('dist/sub/deep/err.log', rules).role, ARTIFACT_ROLE.INTERMEDIATE)

  // 只命中 final → final
  const onlyFinal = classify('dist/app.exe', rules)
  assert.equal(onlyFinal.role, ARTIFACT_ROLE.FINAL, 'dist/app.exe 应命中 final')
  assert.equal(onlyFinal.reason, 'rule:final')
  assert.equal(classify('dist/bundle.zip', rules).role, ARTIFACT_ROLE.FINAL)

  // 都不命中、也不命中内置表 → other
  assert.equal(classify('src/app.ts', rules).role, ARTIFACT_ROLE.OTHER)
})

test('classify：显式 intermediate 优先于内置 final 表', () => {
  // notes.md 内置是 final+report，但显式 intermediate 把它拦下
  const c = classify('drafts/notes.md', { intermediate: ['drafts/**'] })
  assert.equal(c.role, ARTIFACT_ROLE.INTERMEDIATE)
  assert.equal(c.reason, 'rule:intermediate')
})

test('classify：显式 final 覆盖内置 other', () => {
  const c = classify('src/app.ts', { final: ['src/**'] })
  assert.equal(c.role, ARTIFACT_ROLE.FINAL)
  assert.equal(c.reason, 'rule:final')
})

test('classify：内置 intermediate 优先于显式 final（日志不该被 "**" 捞成成品）', () => {
  const c = classify('build.log', { final: ['**'] })
  assert.equal(c.role, ARTIFACT_ROLE.INTERMEDIATE, '内置 intermediate 扩展名应先于显式 final 生效')
  assert.equal(c.reason, 'builtin:ext')
})

test('classify：caseInsensitive 传递到规则匹配', () => {
  // 用 .xyz（不在任何内置扩展名表里）+ zeta/（不在任何内置目录表里），
  // 这样结果只由显式规则决定。
  // 注意：captain 修复 A3-1 时给内置表加了 FINAL_DIR（dist/build/out/release/bundle），
  // 所以 fixture 目录不能再用 dist/ —— 否则内置 final-dir 规则会先命中，
  // 测的就不再是「显式规则的 CI 传递」而是「内置目录规则」了。
  const ci = { final: ['ZETA/**'], caseInsensitive: true }
  assert.equal(classify('zeta/APP.xyz', ci).role, ARTIFACT_ROLE.FINAL, 'CI 下 ZETA/** 应匹配 zeta/APP.xyz')
  const cs = { final: ['ZETA/**'], caseInsensitive: false }
  assert.equal(classify('zeta/APP.xyz', cs).role, ARTIFACT_ROLE.OTHER, '大小写敏感时不匹配')
  assert.equal(classify('ZETA/APP.xyz', cs).role, ARTIFACT_ROLE.FINAL)
})

test('classify：目录路径不判 final', () => {
  const c = classify('')
  assert.equal(c.kind, ARTIFACT_KIND.DIR)
  assert.equal(c.role, ARTIFACT_ROLE.OTHER)
})

/* ─────────────────────────── hashFile / hashText ─────────────────────────── */

test('hashFile：与 hashText 对同样内容给出同一 sha256', async (t) => {
  const dir = tmpDir(t)
  const f = path.join(dir, 'a.txt')
  const content = 'hello 内容\n'
  fs.writeFileSync(f, content, 'utf8')
  const fromFile = await hashFile(f)
  const fromText = hashText(content)
  assert.equal(fromFile, fromText)
  assert.match(fromFile, /^[0-9a-f]{64}$/)
})

/* ─────────────────────────── buildManifest ─────────────────────────── */

test('buildManifest：在临时目录上跑，counts 与 sha256 正确', async (t) => {
  const root = tmpDir(t)
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'foo'), { recursive: true })

  fs.writeFileSync(path.join(root, 'dist', 'app.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0x01]))
  fs.writeFileSync(path.join(root, 'notes.md'), '# notes\n', 'utf8')
  fs.writeFileSync(path.join(root, 'build.log'), 'log line\n', 'utf8')
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1\n', 'utf8')
  // node_modules 被 walk 的 ignoreDirs 整个跳过，不进清单
  fs.writeFileSync(path.join(root, 'node_modules', 'foo', 'index.js'), 'module.exports={}\n', 'utf8')

  const manifest = await buildManifest({ workspace: root, caseInsensitive: true })

  assert.equal(manifest.counts.total, 4, JSON.stringify(manifest.counts))
  assert.equal(manifest.counts.final, 2)
  assert.equal(manifest.counts.intermediate, 1)
  assert.equal(manifest.counts.other, 1)

  const byPath = new Map(manifest.items.map((i) => [i.path, i]))
  assert.equal(byPath.has('node_modules/foo/index.js'), false, 'node_modules 不应进清单')

  const exe = byPath.get('dist/app.exe')
  assert.equal(exe.role, ARTIFACT_ROLE.FINAL)
  assert.equal(exe.kind, ARTIFACT_KIND.FILE)
  assert.equal(exe.bytes, 4)
  assert.match(exe.sha256, /^[0-9a-f]{64}$/, 'final 条目必须有 sha256')
  assert.equal(exe.sha256, await hashFile(path.join(root, 'dist', 'app.exe')))

  const md = byPath.get('notes.md')
  assert.equal(md.role, ARTIFACT_ROLE.FINAL)
  assert.equal(md.kind, ARTIFACT_KIND.REPORT)
  assert.equal(md.sha256, hashText('# notes\n'))

  const log = byPath.get('build.log')
  assert.equal(log.role, ARTIFACT_ROLE.INTERMEDIATE)
  assert.equal(log.sha256, undefined, 'intermediate 不算 sha256（字节不过河）')

  const ts = byPath.get('src/app.ts')
  assert.equal(ts.role, ARTIFACT_ROLE.OTHER)

  // bytesFinal 只累加 final
  assert.equal(manifest.bytesFinal, 4 + Buffer.byteLength('# notes\n', 'utf8'))
  assert.equal(manifest.workspace, manifest.workspace.toLowerCase())
  assert.equal(typeof manifest.generatedAt, 'number')

  // items 按 path 排序
  const paths = manifest.items.map((i) => i.path)
  assert.deepEqual(paths, [...paths].sort())
})

test('buildManifest：outputs 过滤 + includeOther=false', async (t) => {
  const root = tmpDir(t)
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist', 'a.exe'), 'A', 'utf8')
  fs.writeFileSync(path.join(root, 'notes.md'), 'B', 'utf8')
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'C', 'utf8')

  const onlyDist = await buildManifest({ workspace: root, outputs: ['dist/**'], caseInsensitive: true })
  assert.deepEqual(onlyDist.items.map((i) => i.path), ['dist/a.exe'])
  assert.equal(onlyDist.counts.final, 1)

  const noOther = await buildManifest({ workspace: root, includeOther: false, caseInsensitive: true })
  assert.equal(noOther.counts.other, 0)
  assert.equal(noOther.items.some((i) => i.path === 'src/a.ts'), false)
})

test('buildManifest：denyPaths 与 hashFinal=false', async (t) => {
  const root = tmpDir(t)
  fs.mkdirSync(path.join(root, 'secret'), { recursive: true })
  fs.mkdirSync(path.join(root, 'pub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'secret', 'a.exe'), 'A', 'utf8')
  fs.writeFileSync(path.join(root, 'pub', 'b.exe'), 'B', 'utf8')

  // 相对 denyPaths 正常工作：walk() 拿 childRel（相对工作区）去比对
  const rel = await buildManifest({ workspace: root, denyPaths: ['secret'], caseInsensitive: true })
  assert.deepEqual(rel.items.map((i) => i.path), ['pub/b.exe'])

  const noHash = await buildManifest({ workspace: root, hashFinal: false, caseInsensitive: true })
  assert.equal(noHash.counts.final, 2)
  assert.ok(noHash.items.every((i) => i.sha256 === undefined))
})

/**
 * 【D1 已修复】绝对 denyPaths 曾被杀静默忽略。
 *
 * 原缺陷：lib/artifacts.js 的 walk 把 denyPaths 与 `childNorm`（**相对**工作区的路径）
 * 比较，而所有真实调用方传的都是**绝对**路径：
 *   - lib/node/index.js   denyPaths = [...cfg.denyPaths, stateDir]（stateDir 绝对）
 *   - lib/node/task-engine.js  [...this.denyPaths, ...rec.constraints.denyPaths]
 * 绝对 ≠ 相对，于是 denyPaths 全部失效：被禁目录里的文件照常进入 manifest，
 * 命中 final 规则后**可被 remote_pull 拉回主机**。
 *
 * 修复：walk 把每条 deny 同时归一成「工作区内相对形式」与「绝对形式」并都参与比对；
 * authorizePull 采用保守匹配（祖先/相等/被包含任一命中即拒）。
 * 本用例现断言**修复后的正确行为**。
 */
test('[D1 回归] 绝对与相对 denyPaths 都必须生效，被禁目录不可进清单也不可 pull', async (t) => {
  const root = tmpDir(t)
  fs.mkdirSync(path.join(root, 'secret'), { recursive: true })
  fs.writeFileSync(path.join(root, 'secret', 'token.md'), 'SENSITIVE', 'utf8')
  fs.writeFileSync(path.join(root, 'ok.md'), 'PUBLIC', 'utf8')

  // 绝对 denyPaths 必须生效
  const abs = await buildManifest({
    workspace: root,
    denyPaths: [path.join(root, 'secret')],
    caseInsensitive: true,
  })
  assert.deepEqual(
    abs.items.map((i) => i.path),
    ['ok.md'],
    'D1 修复：绝对 denyPaths 生效，被禁目录不进清单',
  )

  // 连带防线：即便清单被别的方式构造出来，authorizePull 也必须拒绝
  const forged = { items: [{ path: 'secret/token.md', role: ARTIFACT_ROLE.FINAL, bytes: 9, kind: 'report' }] }
  const authAbs = authorizePull(forged, 'secret/token.md', {
    caseInsensitive: true,
    denyPaths: [path.join(root, 'secret')],
  })
  assert.equal(authAbs.ok, false, 'D1 修复：绝对 denyPaths 下被禁文件不可 pull')
  assert.equal(authAbs.code, 'artifact-denied')

  // 相对写法同样生效（两种写法结果必须一致）
  const rel = await buildManifest({ workspace: root, denyPaths: ['secret'], caseInsensitive: true })
  assert.deepEqual(rel.items.map((i) => i.path), ['ok.md'], '相对 denyPaths 生效')
  const authRel = authorizePull(forged, 'secret/token.md', { caseInsensitive: true, denyPaths: ['secret'] })
  assert.equal(authRel.ok, false, '相对 denyPaths 下被禁文件不可 pull')

  // 不误伤：未被禁的文件照常可 pull
  const okManifest = await buildManifest({ workspace: root, denyPaths: [path.join(root, 'secret')], caseInsensitive: true })
  const okAuth = authorizePull(okManifest, 'ok.md', {
    caseInsensitive: true,
    denyPaths: [path.join(root, 'secret')],
  })
  assert.equal(okAuth.ok, true, 'D1 修复：未被禁的文件仍可 pull（不误伤）')

  // 工作区自身被禁 → 整棵树都不扫
  const selfDenied = await buildManifest({ workspace: root, denyPaths: [root], caseInsensitive: true })
  assert.deepEqual(selfDenied.items, [], 'D1 修复：工作区自身被禁时返回空清单')
})

test('walk：不跟随符号链接、遵守 maxEntries', async (t) => {
  const root = tmpDir(t)
  fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8')
  fs.writeFileSync(path.join(root, 'b.txt'), 'b', 'utf8')
  fs.writeFileSync(path.join(root, 'c.txt'), 'c', 'utf8')

  const all = walk(root, {})
  assert.equal(all.length, 3)
  assert.ok(all.every((e) => typeof e.bytes === 'number' && typeof e.mtimeMs === 'number'))

  const limited = walk(root, { maxEntries: 2 })
  assert.equal(limited.length, 2)

  const aborted = walk(root, { signal: AbortSignal.abort() })
  assert.equal(aborted.length, 0)
})

/* ─────────────────────────── authorizePull ─────────────────────────── */

test("authorizePull：intermediate 返回 ok:false 且 code === 'artifact-denied'", async (t) => {
  const root = tmpDir(t)
  fs.writeFileSync(path.join(root, 'build.log'), 'noise\n', 'utf8')
  fs.writeFileSync(path.join(root, 'notes.md'), '# ok\n', 'utf8')
  const manifest = await buildManifest({ workspace: root, caseInsensitive: true })

  const denied = authorizePull(manifest, 'build.log')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'artifact-denied')
  assert.equal(denied.code, 'artifact-denied')
  assert.match(denied.message, /intermediate/)
  assert.match(denied.message, /role:final/)

  const ok = authorizePull(manifest, 'notes.md')
  assert.equal(ok.ok, true)
  assert.equal(ok.item.path, 'notes.md')
  assert.equal(ok.item.role, ARTIFACT_ROLE.FINAL)
})

test("authorizePull：other 也不可 pull（artifact-denied）", async (t) => {
  const root = tmpDir(t)
  fs.writeFileSync(path.join(root, 'src.ts'), 'x', 'utf8')
  const manifest = await buildManifest({ workspace: root, caseInsensitive: true })
  const r = authorizePull(manifest, 'src.ts')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'artifact-denied')
})

test("authorizePull：不在清单里 → artifact-missing", async (t) => {
  const root = tmpDir(t)
  fs.writeFileSync(path.join(root, 'notes.md'), 'x', 'utf8')
  const manifest = await buildManifest({ workspace: root, caseInsensitive: true })
  const r = authorizePull(manifest, 'nope.md')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'artifact-missing')
})

test('authorizePull：超 maxBytes → artifact-too-large', async (t) => {
  const root = tmpDir(t)
  fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(100), 'utf8')
  const manifest = await buildManifest({ workspace: root, caseInsensitive: true })
  const r = authorizePull(manifest, 'big.md', { maxBytes: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'artifact-too-large')
})

test('authorizePull：denyPaths 命中 final → artifact-denied', async (t) => {
  const root = tmpDir(t)
  fs.mkdirSync(path.join(root, 'out'), { recursive: true })
  fs.writeFileSync(path.join(root, 'out', 'a.md'), 'x', 'utf8')
  const manifest = await buildManifest({ workspace: root, caseInsensitive: true })
  const r = authorizePull(manifest, 'out/a.md', { denyPaths: ['out'] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'artifact-denied')
})

test('authorizePull：大小写不敏感匹配', async (t) => {
  const root = tmpDir(t)
  fs.writeFileSync(path.join(root, 'Notes.MD'), 'x', 'utf8')

  // CI 构建的清单里 path 已被归一化为小写
  const ciManifest = await buildManifest({ workspace: root, caseInsensitive: true })
  assert.deepEqual(ciManifest.items.map((i) => i.path), ['notes.md'])
  assert.equal(authorizePull(ciManifest, 'notes.md', { caseInsensitive: true }).ok, true)
  // 用不同大小写去查同一个条目，CI 下应命中
  assert.equal(authorizePull(ciManifest, 'NOTES.md', { caseInsensitive: true }).ok, true)

  // 大小写敏感构建：path 保留原大小写
  const csManifest = await buildManifest({ workspace: root, caseInsensitive: false })
  assert.deepEqual(csManifest.items.map((i) => i.path), ['Notes.MD'])
  assert.equal(authorizePull(csManifest, 'Notes.MD', { caseInsensitive: false }).ok, true)
  assert.equal(authorizePull(csManifest, 'notes.md', { caseInsensitive: false }).ok, false)
})

/* ─────────────────────────── matchesOutputs ─────────────────────────── */

test('matchesOutputs：空 outputs 全通过，否则走 glob', () => {
  assert.equal(matchesOutputs('anything.txt', []), true)
  assert.equal(matchesOutputs('anything.txt', undefined), true)
  assert.equal(matchesOutputs('dist/a.exe', ['dist/**']), true)
  assert.equal(matchesOutputs('src/a.ts', ['dist/**']), false)
})
