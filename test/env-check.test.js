/**
 * 环境体检（`lib/env-check.js`）测试。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个模块存在的理由（2026-10-17 真实教训）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户装好插件、配好配对码，副机**永远连不上**，而主机侧毫无异常：
 * hub healthz 200、面板能开、工具都在，只有副机连不上。
 *
 * 根因：DSH 的 `webserver` 默认绑 `127.0.0.1`，而本插件是跨机用法。
 * 这个失败**完全静默** —— 用户只能猜"地址错了？token 错了？防火墙？"
 *
 * 所以体检必须做到三件事，本文件逐条钉住：
 *   1. **覆盖那些静默失败的前置条件**（绑 loopback / inject 缺服务 / roots 不存在）
 *   2. **每项都给具体修法**（不是干巴巴一个 ✗）
 *   3. **绝不抛**：任何一项探测失败只影响那一项
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { envChecks, isLoopbackOrigin, renderEnvChecks } from '../lib/env-check.js'

/** 取某一项。 */
const byId = (r, id) => r.items.find((x) => x.id === id)

/* ═══════════════ 1. isLoopbackOrigin ═══════════════ */

test('isLoopbackOrigin：识别 loopback 的各种写法', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:19387'), true)
  assert.equal(isLoopbackOrigin('http://localhost:19387'), true)
  assert.equal(isLoopbackOrigin('http://[::1]:19387'), true)
  assert.equal(isLoopbackOrigin('https://127.0.0.1'), true)
  // 非 loopback
  assert.equal(isLoopbackOrigin('http://0.0.0.0:19387'), false)
  assert.equal(isLoopbackOrigin('http://192.168.1.10:19387'), false)
  assert.equal(isLoopbackOrigin('http://100.86.48.54:19387'), false)
  assert.equal(isLoopbackOrigin('http://10.0.0.5:8080'), false)
})

test('isLoopbackOrigin：非法输入返回 null（不抛、不误判）', () => {
  for (const v of [null, undefined, '', '   ', 'not-a-url', '127.0.0.1', 42, {}]) {
    assert.equal(isLoopbackOrigin(v), null, `输入 ${JSON.stringify(v)} 应返回 null`)
  }
})

test('isLoopbackOrigin：0.0.0.0 不是 loopback（它是"监听所有网卡"）', () => {
  // 这条容易搞反：0.0.0.0 作为【绑定地址】意味着所有网卡都可访问，
  // 恰恰是我们要的。而 127.0.0.1 才是"只有本机"。
  assert.equal(isLoopbackOrigin('http://0.0.0.0:19387'), false)
})

/* ═══════════════ 2. 最贵的一条：可达性 ═══════════════ */

test('可达性：绑 loopback 时判失败，且给具体修法（不是只说"不可达"）', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: 'hub' },
    reachability: { bound: '127.0.0.1', origin: 'http://127.0.0.1:19387', loopback: true, hint: '' },
  })
  const it = byId(r, 'reachability')
  assert.ok(it, '应有 reachability 项')
  assert.equal(it.ok, false, '绑 loopback 必须判失败')
  assert.match(it.fix, /host:\s*'0\.0\.0\.0'/, '修法必须包含具体配置项 host: \'0.0.0.0\'')
  assert.match(it.fix, /重启/, '修法必须说明要重启')
  assert.equal(it.autoFix, true, '这一项应标记为可自动修')
  assert.match(it.detail, /127\.0\.0\.1/, 'detail 应说明当前绑在哪')
})

test('可达性：绑 0.0.0.0 时判通过', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: 'hub' },
    reachability: { bound: '0.0.0.0', origin: 'http://0.0.0.0:19387', loopback: false, hint: '' },
  })
  assert.equal(byId(r, 'reachability').ok, true)
})

test('可达性：拿不到 origin 时不误报（判为"无法判定"而非失败）', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: 'hub' },
    reachability: { bound: null, origin: null, loopback: null, hint: 'getOrigin() 不可用' },
  })
  const it = byId(r, 'reachability')
  assert.equal(it.ok, true, '无法判定时不该判失败（否则是误报）')
  assert.equal(it.severity, 'info')
})

test('可达性：worker 角色不检查这条（它不监听）', () => {
  const r = envChecks({ role: 'worker', config: { role: 'worker', roots: ['/tmp'] } })
  assert.equal(byId(r, 'reachability'), undefined, 'worker 不该有可达性检查项')
})

/* ═══════════════ 3. inject 缺服务 ═══════════════ */

test('inject：hub 缺 tools 时判失败（这正是"hub 半死"的根因）', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: 'hub', inject: ['webServer'] },
  })
  const it = byId(r, 'inject')
  assert.ok(it)
  assert.equal(it.ok, false)
  assert.match(it.detail, /tools/, 'detail 应点名缺了 tools')
  assert.match(it.fix, /webServer.*tools.*systemPrompt/, 'fix 应给出完整正确写法')
})

test('inject：worker 需要的是另一组服务', () => {
  const r = envChecks({
    role: 'worker',
    config: { role: 'worker', inject: ['tools'], roots: ['/tmp'] },
  })
  const it = byId(r, 'inject')
  assert.equal(it.ok, false)
  assert.match(it.detail, /agentLoop|sessions/, 'worker 缺的是 agentLoop/sessions')
})

test('inject：config 里没有 inject 字段时跳过（不误报）', () => {
  // inject 通常在 loader 行上，config 快照里可能拿不到
  const r = envChecks({ role: 'hub', config: { role: 'hub' } })
  assert.equal(byId(r, 'inject'), undefined, '拿不到 inject 时不该报错')
})

/* ═══════════════ 4. roots ═══════════════ */

test('roots：worker 没配 roots 时判失败（任务会被全部拒绝）', () => {
  const r = envChecks({ role: 'worker', config: { role: 'worker', roots: [] } })
  const it = byId(r, 'roots')
  assert.equal(it.ok, false)
  assert.match(it.fix, /roots/, 'fix 应说明怎么配')
  assert.match(it.detail, /workspace-denied/, 'detail 应说明后果')
})

test('roots：路径不存在时判失败并列出具体路径', () => {
  const r = envChecks({
    role: 'worker',
    config: { role: 'worker', roots: ['D:\\work', 'D:\\gone'] },
    missingRoots: ['D:\\gone'],
  })
  const it = byId(r, 'roots')
  assert.equal(it.ok, false)
  // detail 里是真实字符串 `不存在的路径：D:\gone`（一个反斜杠），
  // 所以正则用 `\\` 匹配单个反斜杠 —— 别写成 `\\\\`（那匹配两个）。
  assert.match(it.detail, /D:\\gone/, 'detail 应点名不存在的路径')
})

test('roots：全部存在时通过', () => {
  const r = envChecks({
    role: 'worker',
    config: { role: 'worker', roots: ['D:\\work'] },
    missingRoots: [],
  })
  assert.equal(byId(r, 'roots').ok, true)
})

/* ═══════════════ 5. 角色未配置 ═══════════════ */

test('role：未配置时判失败并指向面板引导（而不是让用户去改 YAML）', () => {
  const r = envChecks({ role: 'hub', config: { role: '' } })
  const it = byId(r, 'role')
  assert.equal(it.ok, false)
  assert.match(it.fix, /面板/, 'fix 应指向面板（零终端路径）')
  assert.equal(it.autoFix, true)
})

test('role：非法值也判失败', () => {
  const r = envChecks({ role: 'hub', config: { role: 'hubb' } })
  assert.equal(byId(r, 'role').ok, false)
})

/* ═══════════════ 6. Tailscale 只提示、不代下载 ═══════════════ */

test('Tailscale：缺失时只给官方链接与说明，不承诺代下载', () => {
  const r = envChecks({ role: 'hub', config: { role: 'hub' }, tailscaleUp: false })
  const it = byId(r, 'tailscale')
  assert.equal(it.ok, false)
  assert.match(it.fix, /https:\/\/tailscale\.com\/download/, '应给官方下载链接')
  assert.match(it.fix, /不会代你下载|不代下载/, '应明确说明本插件不代下载（供应链边界）')
  assert.equal(it.severity, 'warn', 'Tailscale 缺失不该是 error（同局域网不需要它）')
})

test('Tailscale：null（未探测）时不出现在结果里', () => {
  const r = envChecks({ role: 'hub', config: { role: 'hub' }, tailscaleUp: null })
  assert.equal(byId(r, 'tailscale'), undefined)
})

/* ═══════════════ 7. 副机在线 ═══════════════ */

test('副机在线：0 台时给排错清单（按最常见原因排序）', () => {
  const r = envChecks({ role: 'hub', config: { role: 'hub' }, nodesOnline: 0 })
  const it = byId(r, 'nodes')
  assert.equal(it.ok, false)
  assert.equal(it.severity, 'warn')
  // 排错清单必须覆盖最关键的几条
  assert.match(it.fix, /19387/, '应提示检查端口')
  assert.match(it.fix, /可达|loopback|绑/, '应提示检查可达性')
})

/* ═══════════════ 8. 汇总与不抛 ═══════════════ */

test('汇总：failed 只统计 error 级（warn 不算失败）', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: 'hub', inject: ['webServer', 'tools', 'systemPrompt'] },
    reachability: { bound: '0.0.0.0', origin: 'http://0.0.0.0:19387', loopback: false, hint: '' },
    tailscaleUp: false, // warn
    nodesOnline: 0, // warn
  })
  assert.equal(r.failed, 0, 'warn 不该计入 failed')
  assert.equal(r.ok, true)
})

test('汇总：autoFixable 统计可自动修的项', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: '', inject: ['webServer'] },
    reachability: { bound: '127.0.0.1', origin: 'http://127.0.0.1:19387', loopback: true, hint: '' },
  })
  // role / inject / reachability 三项都可自动修
  assert.ok(r.autoFixable >= 3, `应至少 3 项可自动修，实际 ${r.autoFixable}`)
})

test('不抛：所有探测项都传 null / 缺省时也不炸', () => {
  for (const args of [
    {},
    { role: 'hub' },
    { role: 'worker' },
    { role: 'both', config: null },
    { role: 'hub', config: { role: 'hub', inject: 'not-an-array' } },
    { role: 'hub', config: { role: 'hub', roots: 'not-an-array' } },
    { role: 'hub', reachability: 'not-an-object' },
    { role: 'hub', reachability: {} },
  ]) {
    assert.doesNotThrow(() => envChecks(args), `输入 ${JSON.stringify(args)} 不该抛`)
  }
})

/* ═══════════════ 9. 渲染 ═══════════════ */

test('renderEnvChecks：每项失败都带"怎么修"', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: '', inject: ['webServer'] },
    reachability: { bound: '127.0.0.1', origin: 'http://127.0.0.1:19387', loopback: true, hint: '' },
  })
  const { text, failed } = renderEnvChecks(r)
  assert.ok(failed > 0)
  assert.match(text, /怎么修/, '渲染必须含修法')
  // 每个 ✗ 后面都该有 ↳ 怎么修
  const failLines = text.split('\n').filter((l) => l.startsWith('✗'))
  const fixLines = text.split('\n').filter((l) => l.includes('怎么修'))
  assert.ok(fixLines.length >= failLines.length, `✗ 有 ${failLines.length} 个，修法只有 ${fixLines.length} 条`)
})

test('renderEnvChecks：可自动修的项要明说', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: 'hub' },
    reachability: { bound: '127.0.0.1', origin: 'http://127.0.0.1:19387', loopback: true, hint: '' },
  })
  const { text } = renderEnvChecks(r)
  assert.match(text, /可以自动修/, '应提示该项可自动修')
})

test('renderEnvChecks：全通过时给出明确结论', () => {
  const r = envChecks({
    role: 'hub',
    config: { role: 'hub', inject: ['webServer', 'tools', 'systemPrompt'] },
    reachability: { bound: '0.0.0.0', origin: 'http://0.0.0.0:19387', loopback: false, hint: '' },
  })
  const { text, failed } = renderEnvChecks(r)
  assert.equal(failed, 0)
  assert.match(text, /全部通过/)
})
