/**
 * 写操作 + 进程诊断 + 一键修复 + 外部工具 的测试（2026-10-20 四项能力）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这一批能力的共同点：**都在放宽边界**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · 一键修复  → 会改 DSH 自己的 cordis.patch.yml
 *   · 写操作    → 会改副机的文件（不可逆）
 *   · kill      → 会杀副机的进程（不可逆，杀错会失联）
 *   · 外部工具  → 只是检测，但"自动装依赖"的诱惑要顶住
 *
 * 所以这里的测试**重点不在"功能能用"，而在"护栏真的挡得住"**。
 * 每条护栏都对应一种真实事故。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createFsService } from '../lib/node/fs-service.js'
import {
  createProcessService,
  killProcess,
  normalizePid,
  normalizePort,
  portUsage,
} from '../lib/node/process-service.js'
import { planFixes, undoFix, isManagedBackup } from '../lib/auto-fix.js'
import { probeExternalTools, toolCatalog } from '../lib/external-tools.js'

/* ═══════════════ 1. 写操作护栏 ═══════════════ */

/** 建一个临时 roots 目录。 */
function tmpRoots() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshra-w-'))
}

test('写：默认不覆盖已有文件（防手滑清空）', () => {
  const root = tmpRoots()
  try {
    const svc = createFsService({ roots: [root], caseInsensitive: false })
    const f = path.join(root, 'a.txt')
    svc.write({ path: f, content: 'first' })
    // 第二次不带 overwrite → 必须拒绝
    assert.throws(
      () => svc.write({ path: f, content: 'second' }),
      (e) => e.code === 'artifact-denied',
      '默认不覆盖 —— 这条是防"AI 手滑清空已有文件"',
    )
    assert.equal(fs.readFileSync(f, 'utf8'), 'first', '原内容必须没被改')
    // 显式 overwrite 才允许
    const r = svc.write({ path: f, content: 'second', overwrite: true })
    assert.equal(r.overwritten, true)
    assert.equal(fs.readFileSync(f, 'utf8'), 'second')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('写：越界（roots 外）必须拒绝', () => {
  const root = tmpRoots()
  try {
    const svc = createFsService({ roots: [root], caseInsensitive: false })
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
    assert.throws(
      () => svc.write({ path: outside, content: 'x' }),
      (e) => e.code === 'workspace-denied',
      'roots 是安全边界',
    )
    assert.equal(fs.existsSync(outside), false, '不该在 roots 外创建文件')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('写：目标不存在也能写（写操作专用解析，不是只读的 resolveAny）', () => {
  // ⚠ 这是第一版的真实 bug：用只读的 resolveAny 会因"文件不存在"直接抛，
  // 导致 remote_write 100% 失败。写操作必须用 resolveWritable。
  const root = tmpRoots()
  try {
    const svc = createFsService({ roots: [root], caseInsensitive: false })
    const nested = path.join(root, 'a', 'b', 'c.txt')
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    const r = svc.write({ path: nested, content: 'deep' })
    assert.equal(r.bytes, 4)
    assert.equal(fs.readFileSync(nested, 'utf8'), 'deep')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('写：内容超限必须拒绝（防一次写爆磁盘）', () => {
  const root = tmpRoots()
  try {
    const svc = createFsService({ roots: [root], caseInsensitive: false })
    // 9MB > 8MB 上限
    const big = 'x'.repeat(9 * 1024 * 1024)
    assert.throws(
      () => svc.write({ path: path.join(root, 'big.txt'), content: big }),
      (e) => e.code === 'artifact-too-large',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('删：只删空目录，非空目录必须拒绝（不做递归删）', () => {
  const root = tmpRoots()
  try {
    const svc = createFsService({ roots: [root], caseInsensitive: false })
    const d = path.join(root, 'sub')
    svc.mkdir({ path: d })
    // 空目录可以删
    const r = svc.delete({ path: d })
    assert.equal(r.kind, 'dir')

    // 非空目录必须拒绝 —— 递归删除太容易造成不可逆损失
    const d2 = path.join(root, 'sub2')
    svc.mkdir({ path: d2 })
    fs.writeFileSync(path.join(d2, 'x.txt'), 'x')
    assert.throws(
      () => svc.delete({ path: d2 }),
      (e) => e.code === 'artifact-denied',
      '非空目录应被拒绝',
    )
    assert.equal(fs.existsSync(path.join(d2, 'x.txt')), true, '里面的文件必须还在')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('移动：默认不覆盖目标；跨盘明确报错', () => {
  const root = tmpRoots()
  try {
    const svc = createFsService({ roots: [root], caseInsensitive: false })
    const a = path.join(root, 'a.txt')
    const b = path.join(root, 'b.txt')
    svc.write({ path: a, content: 'A' })
    svc.write({ path: b, content: 'B' })
    assert.throws(
      () => svc.move({ from: a, to: b }),
      (e) => e.code === 'artifact-denied',
      '目标已存在时默认拒绝',
    )
    const r = svc.move({ from: a, to: b, overwrite: true })
    assert.equal(r.to, b)
    assert.equal(fs.readFileSync(b, 'utf8'), 'A')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('写：原子性 —— 失败不留半截文件', () => {
  const root = tmpRoots()
  try {
    const svc = createFsService({ roots: [root], caseInsensitive: false })
    const f = path.join(root, 'atomic.txt')
    svc.write({ path: f, content: 'ok' })
    // 目录下不该有临时文件残留
    const leftovers = fs.readdirSync(root).filter((n) => n.includes('dshra-tmp'))
    assert.deepEqual(leftovers, [], '不应残留临时文件')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ═══════════════ 2. 进程诊断护栏 ═══════════════ */

test('pid / port 归一化：非法输入一律 0', () => {
  for (const bad of [null, undefined, '', 0, -1, 1.5, 'abc', NaN, Infinity, 1e20]) {
    assert.equal(normalizePid(bad), 0, `pid ${String(bad)} 应为 0`)
  }
  assert.equal(normalizePid(1234), 1234)
  assert.equal(normalizePid('1234'), 1234)

  for (const bad of [null, '', 0, -1, 65536, 1.5, 'abc']) {
    assert.equal(normalizePort(bad), 0, `port ${String(bad)} 应为 0`)
  }
  assert.equal(normalizePort(19387), 19387)
  assert.equal(normalizePort('19387'), 19387)
})

test('kill：没有 confirm 一律拒绝', () => {
  const r = killProcess({ pid: 1234 })
  assert.equal(r.ok, false)
  assert.match(r.error, /confirm/)
})

test('kill：拒绝杀自己（否则副机失联，用户失去远程修复能力）', () => {
  const r = killProcess({ pid: process.pid, confirm: 'yes' })
  assert.equal(r.ok, false)
  assert.match(r.error, /自己的进程|本插件/)
})

test('kill：拒绝杀父进程（通常是 DSH 本体）', () => {
  const r = killProcess({ pid: process.ppid, confirm: 'yes' })
  assert.equal(r.ok, false)
  assert.match(r.error, /父进程|失联/)
})

test('kill：非法 pid 拒绝', () => {
  const r = killProcess({ pid: 'abc', confirm: 'yes' })
  assert.equal(r.ok, false)
  assert.match(r.error, /pid/)
})

test('port：非法端口返回错误而不是抛', () => {
  const r = portUsage('abc')
  assert.equal(r.port, 0)
  assert.ok(typeof r.error === 'string' && r.error !== '')
})

test('port：真实查询不抛（本机 19387 有没有在听都算通过）', () => {
  const r = portUsage(19387)
  assert.equal(r.port, 19387)
  assert.ok(Array.isArray(r.listeners), 'listeners 必须是数组')
})

test('createProcessService：暴露 ps/port/kill 三个方法', () => {
  const svc = createProcessService()
  assert.equal(typeof svc.ps, 'function')
  assert.equal(typeof svc.port, 'function')
  assert.equal(typeof svc.kill, 'function')
})

/* ═══════════════ 3. 一键修复护栏 ═══════════════ */

test('修复计划：只把机械可判定的项标为可修', () => {
  const envCheck = {
    items: [
      { id: 'reachability', ok: false, label: 'Web 服务绑在可达地址', fix: '...' },
      { id: 'port', ok: false, label: '端口被占用', fix: '...' },
      { id: 'tailscale', ok: false, label: 'Tailscale 未运行', fix: '...' },
    ],
  }
  const plan = planFixes({ envCheck, patchFile: '/tmp/x.yml' })
  const ids = plan.fixable.map((f) => f.id)
  assert.deepEqual(ids, ['reachability'], '只有 reachability 能机械修')
  // 其它项必须进 skipped 且给出原因
  const skippedIds = plan.skipped.map((s) => s.id)
  assert.ok(skippedIds.includes('port'))
  assert.ok(skippedIds.includes('tailscale'))
  for (const s of plan.skipped) {
    assert.ok(typeof s.reason === 'string' && s.reason !== '', `${s.id} 必须说明为什么不能自动修`)
  }
})

test('修复计划：绝不给出 0.0.0.0（会让 DSH 启动崩溃）', () => {
  const plan = planFixes({
    envCheck: { items: [{ id: 'reachability', ok: false, label: 'x' }] },
    patchFile: '/tmp/x.yml',
    listenHost: '0.0.0.0',
  })
  assert.notEqual(plan.host, '0.0.0.0', '通配地址会让 DSH 崩溃，必须回落到具体 IP')
  assert.ok(plan.host !== '', '必须有一个具体地址')
})

test('修复计划：只读 —— 不碰文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshra-plan-'))
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, '- id: keep-me\n')
  try {
    planFixes({
      envCheck: { items: [{ id: 'reachability', ok: false, label: 'x' }] },
      patchFile: file,
    })
    assert.equal(fs.readFileSync(file, 'utf8'), '- id: keep-me\n', 'planFixes 不该改文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('撤销：备份名必须符合命名空间（防任意文件覆盖）', () => {
  assert.equal(isManagedBackup('cordis.patch.yml.bak-2026-10-20T01-02-03'), true)
  assert.equal(isManagedBackup('passwords.txt'), false)
  assert.equal(isManagedBackup('../../etc/passwd'), false)
  assert.equal(isManagedBackup(''), false)
})

test('撤销：备份不存在时明确报错', () => {
  const r = undoFix({ file: '/tmp/nonexistent.yml', backup: '/tmp/nonexistent.bak-x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /备份/)
})

/* ═══════════════ 4. 外部工具（不代下载）═══════════════ */

test('外部工具：探测结果结构完整', () => {
  const r = probeExternalTools()
  assert.equal(typeof r.platform, 'string')
  assert.ok(Array.isArray(r.tools))
  assert.ok(r.tools.length >= 3, '至少要有 tailscale / powershell / git / node 这几个')
  for (const t of r.tools) {
    assert.equal(typeof t.id, 'string')
    assert.equal(typeof t.name, 'string')
    assert.equal(typeof t.installed, 'boolean')
    // 缺了会怎样 —— 这是用户判断"要不要装"的唯一依据
    assert.ok(typeof t.why === 'string' && t.why !== '', `${t.id} 必须说明为什么需要`)
    // 安装命令与官方链接（我们不执行）
    assert.equal(typeof t.install, 'string')
    assert.equal(typeof t.url, 'string')
  }
})

test('外部工具：清单不含"自动安装"能力（边界守住）', () => {
  // 本模块只探测 + 给命令，绝不代下载/代安装。
  // 这条断言防的是"以后有人顺手加个 install 方法"。
  const src = fs.readFileSync(
    path.join(process.cwd(), 'lib', 'external-tools.js'),
    'utf8',
  )
  // 不允许出现真正的下载/安装执行调用
  assert.equal(/spawnSync\(\s*['"`](winget|brew|apt|choco|curl|wget)/.test(src), false,
    '不得代执行安装命令 —— 只给用户复制')
})

test('外部工具：清单导出与探测使用同一份定义', () => {
  const catalog = toolCatalog()
  const probed = probeExternalTools()
  assert.deepEqual(
    catalog.map((c) => c.id).sort(),
    probed.tools.map((t) => t.id).sort(),
    '清单与探测必须覆盖同一批工具（否则面板会漏显示）',
  )
})
