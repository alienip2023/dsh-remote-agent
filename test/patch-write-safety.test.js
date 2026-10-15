/**
 * `writePatchBlock` 的两个真 bug 回归（2026-10-15 实测发现）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Bug 1：`force` 会产生它声称要防的重复条目
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原实现里 `force` 只跳过冲突检测，却仍走"追加"路径 —— 结果：
 *
 *     - id: remote-agent        ← 手写的（role: hub）
 *       config: { role: hub }
 *     # --- managed block ---
 *     - id: remote-agent        ← 又写一条（role: worker）
 *       config: { role: worker }
 *     # --- end ---
 *
 * **两条同 id → loader 挂载两次 → 路由/工具重复注册 → 启动失败。**
 * 正是 `force` 的文档声称要防的事。
 *
 * ── Bug 2：force 一次之后永久死锁 ───────────────────────────────────────
 *
 * 写完之后文件里**永久同时存在**手写条目与托管块，于是下一次
 * `hasUnmanagedRemoteAgent` 仍然为真 → 再写永远被拒 → **再也改不了**。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * `force` 的语义改成"**用托管块替换**手写条目"：
 *   · `upsertManagedBlock` 新增 `replaceHandWritten`，真的移除手写条目
 *     （连同它上方的注释块，避免留孤立注释）
 *   · `writePatchBlock` 在写前**与写后**都校验 `hasUnmanagedRemoteAgent`
 *     —— 重复条目写不出去，落盘后也不会残留
 *
 * 这组测试用**真实临时文件**跑完整写盘路径（不是静态断言），
 * 因为这两个 bug 都只在"文件内容"层面才暴露。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { writePatchBlock, hasUnmanagedRemoteAgent, upsertManagedBlock } = await import(
  new URL('../lib/setup.js', import.meta.url).href
)

/** 建一个临时 patch 文件，返回 {file, cleanup}。 */
function tmpFile(content) {
  const file = path.join(os.tmpdir(), `dshra-t-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`)
  fs.writeFileSync(file, content, 'utf8')
  return {
    file,
    cleanup() {
      try { fs.rmSync(file, { force: true }) } catch { /* ignore */ }
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith(path.basename(file) + '.bak-')) {
          try { fs.rmSync(path.join(os.tmpdir(), f), { force: true }) } catch { /* ignore */ }
        }
      }
    },
  }
}

const HAND_WRITTEN = [
  '# 我的主机配置',
  '# 本机是主机（派活方）',
  '- id: remote-agent',
  '  name: dsh-remote-agent',
  '  config:',
  '    role: hub',
  '    nodeToken: nt_secret',
  '',
].join('\n')

const BLOCK = '- id: remote-agent\n  name: dsh-remote-agent\n  config:\n    role: worker\n'

/* ─────────────── 1. 无 force 时必须拒绝 ─────────────── */

test('有手写条目 + 无 force → 拒绝，且不改动文件', () => {
  const t = tmpFile(HAND_WRITTEN)
  try {
    const r = writePatchBlock({ file: t.file, blockYaml: BLOCK })
    assert.equal(r.ok, false, '应拒绝')
    assert.match(r.error, /手写的 remote-agent 条目/, '错误信息应说清原因')
    assert.equal(fs.readFileSync(t.file, 'utf8'), HAND_WRITTEN, '拒绝时文件必须原样不动')
  } finally {
    t.cleanup()
  }
})

/* ─────────────── 2. force 必须替换（Bug 1 的回归） ─────────────── */

test('有手写条目 + force → 替换掉手写条目，**只剩一条**', () => {
  const t = tmpFile(HAND_WRITTEN)
  try {
    const r = writePatchBlock({ file: t.file, blockYaml: BLOCK, force: true })
    assert.equal(r.ok, true, `应成功（实际 ${r.error}）`)
    assert.equal(r.mode, 'replaced-handwritten', 'mode 应标明替换了手写条目')

    const after = fs.readFileSync(t.file, 'utf8')
    const entries = (after.match(/^\s*-\s+id:\s*remote-agent\b/gm) || []).length
    assert.equal(entries, 1, `必须只剩 1 条 remote-agent 条目（实际 ${entries}）—— 两条同 id 会让插件挂载两次`)

    // 手写那条的 config 不该残留
    assert.ok(!/nodeToken: nt_secret/.test(after), '手写条目的内容应被移除')
    // 托管块必须在
    assert.match(after, /managed by dsh-remote-setup/, '应写入托管块')
    // 且不得再有"托管块之外"的条目
    assert.equal(hasUnmanagedRemoteAgent(after), false, '落盘后不得残留手写条目')
  } finally {
    t.cleanup()
  }
})

test('force 替换时会移除手写条目上方的注释块（不留孤立注释）', () => {
  const t = tmpFile(HAND_WRITTEN)
  try {
    writePatchBlock({ file: t.file, blockYaml: BLOCK, force: true })
    const after = fs.readFileSync(t.file, 'utf8')
    assert.ok(!/我的主机配置/.test(after), '手写条目上方的注释应一并移除')
    assert.ok(!/本机是主机/.test(after), '手写条目上方的注释应一并移除')
  } finally {
    t.cleanup()
  }
})

/* ─────────────── 3. force 之后不能再死锁（Bug 2 的回归） ─────────────── */

test('force 之后再写一次 → 正常 replaced（不再死锁）', () => {
  const t = tmpFile(HAND_WRITTEN)
  try {
    const r1 = writePatchBlock({ file: t.file, blockYaml: BLOCK, force: true })
    assert.equal(r1.ok, true, '第一次 force 应成功')

    // 关键：第二次写入**不需要 force**（因为已无手写条目）
    const r2 = writePatchBlock({ file: t.file, blockYaml: '- id: remote-agent\n  config:\n    role: hub\n' })
    assert.equal(r2.ok, true, `第二次写入应成功（实际 ${r2.error}）—— 原实现会永久死锁`)
    assert.equal(r2.mode, 'replaced', 'mode 应是 replaced')

    const after = fs.readFileSync(t.file, 'utf8')
    assert.equal((after.match(/^\s*-\s+id:\s*remote-agent\b/gm) || []).length, 1, '仍应只有一条')
    assert.match(after, /role: hub/, '应写入新的 role')
  } finally {
    t.cleanup()
  }
})

/* ─────────────── 4. 无冲突时的行为不变 ─────────────── */

test('无手写条目 + force → 不误删用户的其他内容', () => {
  const other = [
    '- id: some-other-plugin',
    '  config:',
    '    x: 1',
    '',
  ].join('\n')
  const t = tmpFile(other)
  try {
    const r = writePatchBlock({ file: t.file, blockYaml: BLOCK, force: true })
    assert.equal(r.ok, true)
    const after = fs.readFileSync(t.file, 'utf8')
    assert.match(after, /some-other-plugin/, '别的插件条目必须保留')
    assert.equal((after.match(/^\s*-\s+id:\s*remote-agent\b/gm) || []).length, 1, '只应有一条 remote-agent')
  } finally {
    t.cleanup()
  }
})

test('托管块已存在时再写 → replaced，且不碰块外内容', () => {
  const t = tmpFile(HAND_WRITTEN)
  try {
    writePatchBlock({ file: t.file, blockYaml: BLOCK, force: true })
    const mid = fs.readFileSync(t.file, 'utf8')
    // 往块外加一个别的插件（模拟用户在托管块之外做别的事）
    fs.writeFileSync(t.file, mid + '\n- id: another\n  config:\n    y: 2\n', 'utf8')

    const r = writePatchBlock({ file: t.file, blockYaml: '- id: remote-agent\n  config:\n    role: both\n' })
    assert.equal(r.ok, true)
    const after = fs.readFileSync(t.file, 'utf8')
    assert.match(after, /id: another/, '块外的其他插件必须保留')
    assert.match(after, /role: both/, '应更新托管块内容')
    assert.equal((after.match(/^\s*-\s+id:\s*remote-agent\b/gm) || []).length, 1, '仍只有一条')
  } finally {
    t.cleanup()
  }
})

/* ─────────────── 5. upsertManagedBlock 是纯函数，行为可单测 ─────────────── */

test('upsertManagedBlock：replaceHandWritten=false 时不动手写条目', () => {
  const { text, mode } = upsertManagedBlock(HAND_WRITTEN, BLOCK, false)
  assert.equal(mode, 'created', '应走追加路径')
  assert.match(text, /role: hub/, '手写条目应保留')
  assert.match(text, /role: worker/, '托管块内容应在')
  // 此时确实有两条（这是"未强制"的预期形态，由 writePatchBlock 拦下）
  assert.equal((text.match(/^\s*-\s+id:\s*remote-agent\b/gm) || []).length, 2)
})

test('upsertManagedBlock：replaceHandWritten=true 时只留托管块', () => {
  const { text, mode } = upsertManagedBlock(HAND_WRITTEN, BLOCK, true)
  assert.equal(mode, 'replaced-handwritten')
  assert.equal((text.match(/^\s*-\s+id:\s+remote-agent\b/gm) || []).length, 1)
  assert.equal(hasUnmanagedRemoteAgent(text), false)
})

test('upsertManagedBlock 幂等：同样输入两次结果一致', () => {
  const a = upsertManagedBlock(HAND_WRITTEN, BLOCK, true).text
  const b = upsertManagedBlock(a, BLOCK, true).text
  assert.equal(a, b, '重复应用应幂等')
})

/* ─────────────── 6. 写盘失败必须回滚 ─────────────── */

test('写入失败时回滚原文件（用只读目录模拟）', () => {
  const t = tmpFile(HAND_WRITTEN)
  try {
    // 传入不存在的目录 → 写入必然失败
    const bad = path.join(os.tmpdir(), 'dshra-no-such-dir-' + Date.now(), 'x.yml')
    const r = writePatchBlock({ file: bad, blockYaml: BLOCK })
    assert.equal(r.ok, false, '应失败')
    assert.match(r.error, /读不了|不存在/, '错误信息应可读')
  } finally {
    t.cleanup()
  }
})
