/**
 * 独立配置（`lib/instance-config.js`）测试。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-18 实测事故）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  01:44  cordis.patch.yml = 3962B / 15 条（含 role + webserver）  ✅
 *  12:05  cordis.patch.yml =  696B /  4 条（**我们的段整段消失**）  ❌
 *
 * 12:05 前后用户在 DSH 里**卸载重装了插件**。结论：DSH 的插件管理器在改动
 * 依赖时会重写 `cordis.patch.yml`，只保留它自己管理的条目。
 *
 * 这就是"每次设置完重启又回引导页"的真正根因。
 *
 * ── 方案：配置分两层 ────────────────────────────────────────────────────
 *
 *   1. `cordis.patch.yml` 的 `- id: remote-agent` —— 只让 loader 加载插件
 *   2. `<stateDir>/instance.json` —— 真正的配置，**DSH 冲不掉**
 *
 * 加载时第 2 层合并回来（覆盖第 1 层，因为那是用户明确设置过的值）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  INSTANCE_FILE_NAME,
  instanceFilePath,
  mergeInstanceConfig,
  readInstanceConfig,
  resolveStateDir,
  writeInstanceConfig,
} from '../lib/instance-config.js'

/** 建一个临时 stateDir 并在结束后清理。 */
function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'))
  t.after(() => {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  })
  return d
}

/* ═══════════════ 1. 基本读写 ═══════════════ */

test('instance：写进去能读回来（role / hubUrl / roots）', (t) => {
  const dir = tmpDir(t)
  const cfg = { stateDir: dir }
  const r = writeInstanceConfig({
    role: 'worker',
    nodeId: 'slave-pc',
    hubUrl: 'ws://100.86.48.54:19387/api/remote-agent/node',
    transportMode: 'direct',
    roots: ['D:\\work', 'D:\\data'],
  }, cfg)
  assert.equal(r.ok, true, '写入应成功')
  assert.ok(r.file.endsWith(INSTANCE_FILE_NAME))

  const back = readInstanceConfig(cfg)
  assert.ok(back, '应能读回')
  assert.equal(back.role, 'worker')
  assert.equal(back.nodeId, 'slave-pc')
  assert.equal(back.hubUrl, 'ws://100.86.48.54:19387/api/remote-agent/node')
  assert.deepEqual(back.roots, ['D:\\work', 'D:\\data'])
})

test('instance：文件不存在时返回 null（不是抛错）', (t) => {
  const dir = tmpDir(t)
  assert.equal(readInstanceConfig({ stateDir: dir }), null)
})

test('instance：文件损坏时返回 null（不让 DSH 起不来）', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, INSTANCE_FILE_NAME), '{ 这不是 JSON', 'utf8')
  assert.equal(readInstanceConfig({ stateDir: dir }), null)
})

test('instance：文件是数组/字符串时返回 null', (t) => {
  const dir = tmpDir(t)
  for (const bad of ['[]', '"hello"', '42', 'null']) {
    fs.writeFileSync(path.join(dir, INSTANCE_FILE_NAME), bad, 'utf8')
    assert.equal(readInstanceConfig({ stateDir: dir }), null, `内容 ${bad} 应返回 null`)
  }
})

/* ═══════════════ 2. 字段白名单（防配置注入）═══════════════ */

test('instance：只存白名单字段，未知字段被丢弃', (t) => {
  const dir = tmpDir(t)
  writeInstanceConfig({
    role: 'hub',
    // 下面这些都不该被持久化
    EVIL_FIELD: 'x',
    __proto__: { polluted: true },
    constructor: 'nope',
  }, { stateDir: dir })

  const back = readInstanceConfig({ stateDir: dir })
  assert.ok(back)
  assert.equal(back.role, 'hub')
  assert.ok(!('EVIL_FIELD' in back), '未知字段不得被持久化')
  assert.ok(!('polluted' in back), '__proto__ 注入不得生效')
})

test('instance：空值和空 roots 不落盘', (t) => {
  const dir = tmpDir(t)
  writeInstanceConfig({ role: 'hub', nodeId: '', roots: [] }, { stateDir: dir })
  const back = readInstanceConfig({ stateDir: dir })
  assert.equal(back.role, 'hub')
  assert.ok(!('nodeId' in back), '空字符串不该落盘')
  assert.ok(!('roots' in back), '空数组不该落盘')
})

/* ═══════════════ 3. 合并优先级（核心）═══════════════ */

test('合并：独立配置**覆盖** loader config（关键：这是防冲掉的核心）', (t) => {
  const dir = tmpDir(t)
  writeInstanceConfig({ role: 'worker', hubUrl: 'ws://x:19387/y' }, { stateDir: dir })

  // loader config 只给了包内默认（role: auto）—— 正是"被冲掉"后的样子
  const loader = { role: 'auto', stateDir: dir }
  const { config, source } = mergeInstanceConfig(loader)

  assert.ok(source, '应报告读到了独立配置')
  assert.equal(config.role, 'worker', '独立配置必须覆盖 loader 的 auto')
  assert.equal(config.hubUrl, 'ws://x:19387/y')
  assert.equal(config.stateDir, dir, 'loader 独有的字段应保留')
})

test('合并：没有独立配置时原样返回 loader config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-none-'))
  try {
    const loader = { role: 'hub', stateDir: dir }
    const { config, source } = mergeInstanceConfig(loader)
    assert.equal(source, null)
    assert.deepEqual(config, loader)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('合并：独立配置里没有的字段，用 loader 的值', (t) => {
  const dir = tmpDir(t)
  writeInstanceConfig({ role: 'worker' }, { stateDir: dir })
  const { config } = mergeInstanceConfig({ role: 'auto', nodeId: 'from-loader', stateDir: dir })
  assert.equal(config.role, 'worker', '独立配置优先')
  assert.equal(config.nodeId, 'from-loader', 'loader 独有的字段保留')
})

test('合并：loader config 为 null 时也不抛', () => {
  assert.doesNotThrow(() => mergeInstanceConfig(null))
  assert.doesNotThrow(() => mergeInstanceConfig(undefined))
})

/* ═══════════════ 4. stateDir 解析 ═══════════════ */

test('stateDir：显式配置优先', () => {
  const d = resolveStateDir({ stateDir: 'C:\\custom\\dir' })
  assert.equal(d, path.resolve('C:\\custom\\dir'))
})

test('stateDir：未配置时用 ~/.dsh-remote-agent', () => {
  const d = resolveStateDir({})
  assert.ok(d.includes('.dsh-remote-agent'))
  assert.ok(d === path.join(os.homedir(), '.dsh-remote-agent'))
})

test('stateDir：配置文件路径在 stateDir 下', () => {
  const d = resolveStateDir({ stateDir: 'C:\\x' })
  assert.equal(instanceFilePath({ stateDir: 'C:\\x' }), path.join(d, INSTANCE_FILE_NAME))
})

/* ═══════════════ 5. 原子写与权限 ═══════════════ */

test('instance：写完后目录里没有 .tmp 残骸', (t) => {
  const dir = tmpDir(t)
  writeInstanceConfig({ role: 'hub' }, { stateDir: dir })
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '不得留临时文件')
})

test('instance：文件权限 0600（可能含 token）', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 不支持 POSIX 权限位')
    return
  }
  const dir = tmpDir(t)
  const r = writeInstanceConfig({ nodeToken: 'nt_secret' }, { stateDir: dir })
  const mode = fs.statSync(r.file).mode & 0o777
  assert.equal(mode, 0o600, '应 0600（含凭证）')
})

test('instance：重复写覆盖旧值（不是追加）', (t) => {
  const dir = tmpDir(t)
  writeInstanceConfig({ role: 'hub' }, { stateDir: dir })
  writeInstanceConfig({ role: 'worker' }, { stateDir: dir })
  const back = readInstanceConfig({ stateDir: dir })
  assert.equal(back.role, 'worker', '后写的应覆盖先写的')
})
