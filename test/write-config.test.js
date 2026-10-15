/**
 * 向导写盘（cordis.patch.yml 托管块）回归：
 *
 *   - upsertManagedBlock：幂等（跑两次不重复）、替换保留块外原文
 *   - hasUnmanagedRemoteAgent：手写条目必须被拦下（同 id 重复 = 插件挂载两次 = 启动失败）
 *   - writePatchBlock：真实文件上 备份/写入/二次更新/冲突拒绝/force 覆盖/回滚
 *   - patchFilePath / listDshProfiles：路径与 profile 枚举
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  MANAGED_BEGIN,
  MANAGED_END,
  upsertManagedBlock,
  hasUnmanagedRemoteAgent,
  writePatchBlock,
  patchFilePath,
  listDshProfiles,
} from '../lib/setup.js'
import { buildWorkerYaml, buildHubYaml } from '../lib/setup.js'

const tmpdir = (t) => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-write-'))

/* ══════════════════ upsertManagedBlock（纯函数） ══════════════════ */

test('upsertManagedBlock：空文件 → created，标记成对', () => {
  const { text, mode } = upsertManagedBlock('', '- id: remote-agent\n  config:\n    role: worker')
  assert.equal(mode, 'created')
  assert.ok(text.startsWith(MANAGED_BEGIN))
  assert.ok(text.trimEnd().endsWith(MANAGED_END))
})

test('upsertManagedBlock：跑两次结果一致（幂等，不重复追加）', () => {
  const first = upsertManagedBlock('# 我的配置\n- id: ui-theme\n', 'BLOCK_A')
  assert.equal(first.mode, 'created')
  const second = upsertManagedBlock(first.text, 'BLOCK_A')
  assert.equal(second.mode, 'replaced')
  assert.equal(second.text, first.text, '同内容重跑必须零变化')
})

test('upsertManagedBlock：替换只动标记之间，块外原文一字节不碰', () => {
  const original = `- id: ui-chat
  config:
    transcriptView: detailed
${MANAGED_BEGIN}
旧块内容
${MANAGED_END}
- id: ui-theme
  config:
    preference: dark
`
  const { text, mode } = upsertManagedBlock(original, '新块内容')
  assert.equal(mode, 'replaced')
  assert.ok(text.includes('transcriptView: detailed'))
  assert.ok(text.includes('preference: dark'))
  assert.ok(!text.includes('旧块内容'))
  // 标记各只出现一次
  assert.equal(text.split(MANAGED_BEGIN).length - 1, 1)
  assert.equal(text.split(MANAGED_END).length - 1, 1)
})

/* ══════════════════ hasUnmanagedRemoteAgent ══════════════════ */

test('hasUnmanagedRemoteAgent：手写条目（无标记）→ 必须报冲突', () => {
  const text = `- id: other
- id: remote-agent
  config:
    role: hub
`
  assert.equal(hasUnmanagedRemoteAgent(text), true)
})

test('hasUnmanagedRemoteAgent：条目只在托管块内 → 不算冲突', () => {
  const text = `- id: other
${MANAGED_BEGIN}
- id: remote-agent
  config:
    role: worker
${MANAGED_END}
`
  assert.equal(hasUnmanagedRemoteAgent(text), false)
})

test('hasUnmanagedRemoteAgent：干净文件 / remote-web-ui 之类别的 id → 不算冲突', () => {
  assert.equal(hasUnmanagedRemoteAgent(''), false)
  assert.equal(hasUnmanagedRemoteAgent('- id: remote-web-ui\n  name: x\n'), false)
})

/* ══════════════════ writePatchBlock（真实文件） ══════════════════ */

test('writePatchBlock：首次写入 → created + 备份文件内容=原文', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'cordis.patch.yml')
  const original = '- id: ui-chat\n  config:\n    enabled: true\n'
  fs.writeFileSync(file, original, 'utf8')
  const r = writePatchBlock({ file, blockYaml: buildWorkerYaml({ hubUrl: 'ws://h/x', token: 'nt_t' }) })
  assert.ok(r.ok, r.error)
  assert.equal(r.mode, 'created')
  assert.ok(fs.existsSync(r.backup), '备份文件必须存在')
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original)
  const now = fs.readFileSync(file, 'utf8')
  assert.ok(now.includes(MANAGED_BEGIN) && now.includes('role: worker'))
  assert.ok(now.includes('enabled: true'), '用户的原有条目必须原样保留')
})

test('writePatchBlock：二次写入 → replaced，不产生重复条目', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, '- id: ui-chat\n  config:\n    enabled: true\n', 'utf8')
  const y1 = buildWorkerYaml({ hubUrl: 'ws://old:1/x', token: 'nt_old' })
  assert.ok(writePatchBlock({ file, blockYaml: y1 }).ok)
  const y2 = buildWorkerYaml({ hubUrl: 'ws://new:2/x', token: 'nt_new' })
  const r2 = writePatchBlock({ file, blockYaml: y2 })
  assert.ok(r2.ok, r2.error)
  assert.equal(r2.mode, 'replaced')
  const now = fs.readFileSync(file, 'utf8')
  assert.equal(now.split('- id: remote-agent').length - 1, 1, '同 id 条目只能有一份')
  assert.ok(now.includes('ws://new:2/x') && !now.includes('ws://old:1/x'))
})

test('writePatchBlock：有手写 remote-agent 条目 → 默认拒绝（错误点名 --force）', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, '- id: remote-agent\n  config:\n    role: hub\n', 'utf8')
  const r = writePatchBlock({ file, blockYaml: buildWorkerYaml({ hubUrl: 'ws://h/x' }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /--force|手写|重复/)
  // 文件必须原封不动
  assert.equal(fs.readFileSync(file, 'utf8'), '- id: remote-agent\n  config:\n    role: hub\n')
})

test('writePatchBlock：force=true 覆盖手写条目场景（写入托管块）', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, '- id: remote-agent\n  config:\n    role: hub\n', 'utf8')
  const r = writePatchBlock({ file, blockYaml: buildHubYaml({ token: 'nt_x' }), force: true })
  assert.ok(r.ok, r.error)
  assert.ok(fs.readFileSync(file, 'utf8').includes(MANAGED_BEGIN))
})

test('writePatchBlock：文件不存在 → 结构化报错（不写半个文件）', () => {
  const dir = tmpdir()
  const r = writePatchBlock({ file: path.join(dir, 'nope', 'cordis.patch.yml'), blockYaml: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /不存在|读不了/)
})

test('writePatchBlock：ENOTDIR 类读取失败 → 报错且不产生备份', () => {
  const dir = tmpdir()
  const r = writePatchBlock({ file: dir, blockYaml: 'x' }) // 传目录当文件
  assert.equal(r.ok, false)
  assert.equal(r.backup, '')
})

/* ══════════════════ 路径与 profile 枚举 ══════════════════ */

test('patchFilePath：落在 ~/.dsh/profiles/<profile>/cordis.patch.yml，profile 名清洗防穿越', () => {
  const p = patchFilePath('desktop')
  assert.ok(p.includes(path.join('.dsh', 'profiles', 'desktop', 'cordis.patch.yml')))
  assert.ok(!patchFilePath('../evil').includes('..'), '路径穿越字符必须被清洗')
  assert.ok(patchFilePath('..\\..\\x').endsWith(path.join('cordis.patch.yml')))
})

test('listDshProfiles：只算含 cordis.patch.yml 的目录，_ 开头跳过', () => {
  const root = tmpdir()
  for (const name of ['desktop', 'headless', '_tmp_123', 'empty-profile']) {
    fs.mkdirSync(path.join(root, name), { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'desktop', 'cordis.patch.yml'), '[]', 'utf8')
  fs.writeFileSync(path.join(root, 'headless', 'cordis.patch.yml'), '[]', 'utf8')
  fs.writeFileSync(path.join(root, 'empty-profile', 'cordis.yml'), '[]', 'utf8') // 只有 yml 本体不算
  const out = listDshProfiles(root)
  assert.deepEqual(out.sort(), ['desktop', 'headless'])
})

test('listDshProfiles：root 不存在 → 空数组不抛', () => {
  assert.deepEqual(listDshProfiles(path.join(os.tmpdir(), 'definitely-missing-zz')), [])
})
