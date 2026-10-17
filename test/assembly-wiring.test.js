/**
 * 装配级测试（v0.9.0 审查补强，2026-10-17）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（审查报告的核心结论）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * v0.9.0 的两个 High 都是同一种病：
 *
 *   | 项 | 模块本身 | 装配进系统时 |
 *   |---|---|---|
 *   | H1 | `env-check.js` 单元测试 24 条全绿 | 路由传了**原始 `role`**，`
 *   |    |                          | auto` 没被解析 → 五项检查全跳过 |
 *   | H2 | `share-service.js` 17 条全绿 | 面板恒发 `dir: ''` → 100% 失败 |
 *
 * 共同点：**模块级测试覆盖得很好，没人测"模块被装配进系统时的形状"**。
 *
 * 单测能证明 `envChecks({role:'hub'})` 正确，但证明不了
 * `ui-routes` 的 `/env-check` 路由传的是解析后的角色。
 * 单测能证明 `buildShareCommand` 正确，但证明不了面板真的把 dir 传下来。
 *
 * 所以本文件的断言**全部锚在接线处**，不测模块内部逻辑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { envChecks } from '../lib/env-check.js'
import { resolveRole } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ═══════════════ H1：env-check 路由必须传解析后的角色 ═══════════════ */

test('H1 装配：/env-check 路由不得把原始 config.role 直接传给 envChecks', async () => {
  const src = read('lib/hub/ui-routes.js')
  const i = src.indexOf('/env-check`')
  assert.ok(i >= 0, '应有 /env-check 路由')
  const seg = src.slice(i, i + 900)

  // 原 bug 就长这样：`role: typeof config.role === 'string' ? config.role : 'hub'`
  // —— config.role 是 'auto'（默认安装），直接传进去 envChecks 会判 isHub=false。
  assert.ok(
    !/role:\s*typeof config\.role === 'string'\s*\?\s*config\.role/.test(seg),
    '路由不得把**原始** config.role 传给 envChecks —— `auto` 会因未解析而'
    + '判成非 hub，导致 reachability/port/firewall/tailscale/nodes 五项全跳过',
  )
  // 必须用解析后的角色（或直接传 'hub'，因为该路由只在 hub/both 时注册）
  assert.match(seg, /resolveRole|role:\s*'hub'/, '应传解析后的角色（resolveRole 或字面量 hub）')
})

test('H1 装配：envChecks 自己能解析 auto（不依赖调用方传对）', () => {
  // 双保险：即使某个调用方仍然传了 'auto'，envChecks 内部也要能推断。
  const r = envChecks({
    role: 'auto',
    config: { role: 'auto', inject: ['webServer', 'tools', 'systemPrompt'] },
    reachability: { bound: '127.0.0.1', origin: 'http://127.0.0.1:19387', loopback: true, hint: '' },
  })
  const ids = r.items.map((x) => x.id)
  assert.ok(ids.includes('reachability'), `role=auto 必须走 hub 分支，实际项：${ids.join(',')}`)
  // role 检查本身必须通过（auto 是合法工作模式）
  assert.equal(r.items.find((x) => x.id === 'role').ok, true, 'auto 应算已配置')
  // inject 必须按 hub 三件套判定并通过
  assert.equal(r.items.find((x) => x.id === 'inject').ok, true, 'hub 的正确 inject 不该被判缺服务')
})

test('H1 装配：auto + hubUrl 必须推断成 worker（不查可达性）', () => {
  const r = envChecks({
    role: 'auto',
    config: { role: 'auto', hubUrl: 'ws://100.86.48.54:19387/api/remote-agent/node', inject: ['tools', 'agentLoop', 'sessions'], roots: ['D:\\work'] },
  })
  const ids = r.items.map((x) => x.id)
  assert.ok(!ids.includes('reachability'), 'worker 不该有可达性检查（它不监听）')
  assert.ok(ids.includes('roots'), 'worker 应查 roots')
})

test('H1 装配：resolveRole 是唯一实现（setup-routes 与 env-check 都用它）', () => {
  // 项目原则：角色判据只有一份。三处必须都用同一份实现。
  for (const f of ['lib/setup-routes.js', 'lib/env-check.js']) {
    const src = read(f)
    assert.match(src, /resolveRole/, `${f} 应复用 resolveRole（判据只有一份）`)
  }
  // 且 resolveRole 对 auto 的推断与 envChecks 的判定一致
  assert.equal(resolveRole({ role: 'auto' }), 'hub')
  assert.equal(resolveRole({ role: 'auto', hubUrl: 'ws://x/y' }), 'worker')
})

/* ═══════════════ H2：SharePanel 必须真的发 dir ═══════════════ */

test('H2 装配：SharePanel 不得恒定发送空 dir', async () => {
  const src = read('lib/client.js')
  const i = src.indexOf('function doPlan()')
  assert.ok(i >= 0, '应有 doPlan')
  const seg = src.slice(i, i + 900)

  // 原 bug：`dir: ''` 写死 → 副机按设计拒绝空 dir → 100% 失败
  assert.ok(
    !/dir:\s*''/.test(seg),
    "doPlan 不得写死 dir: '' —— 副机侧 `if (dir === '')` 会拒绝，"
    + 'SMB 共享的唯一主动作 100% 失败（v0.9.0 的 H2）',
  )
  assert.match(seg, /dir:\s*shareDir/, 'dir 应来自目录选择（shareDir）')
})

test('H2 装配：SharePanel 必须有目录选择 UI（数据源 node.roots）', () => {
  const src = read('lib/client.js')
  const i = src.indexOf('function SharePanel')
  assert.ok(i >= 0, '应有 SharePanel')
  const seg = src.slice(i, i + 9000)

  assert.match(seg, /nodeRoots/, '应从 node.roots 取候选目录')
  assert.match(seg, /shareDir/, '应有 shareDir 状态')
  assert.match(seg, /'共享目录'/, '应有「共享目录」选择行')
  // 无可选 roots 时给可手填的输入框（旧副机 / 未配置场景）
  assert.match(seg, /placeholder:.*绝对路径|需要.*roots/, '无 roots 时应提示手填或说明原因')
})

test('H2 装配：shareDir 为空时按钮必须禁用（不给用户点了才失败）', () => {
  const src = read('lib/client.js')
  const i = src.indexOf('function SharePanel')
  const seg = src.slice(i, i + 9000)
  assert.match(seg, /shareDir\.trim\(\) === ''/, '空目录时按钮应禁用')
})

/* ═══════════════ M1：CLI doctor 必须有 loopback 检查 ═══════════════ */

test('M1 装配：CLI --doctor 必须调用 envChecks（不能只有 doctorChecks）', () => {
  const src = read('bin/dsh-remote-setup.js')
  assert.match(src, /envChecks/, 'CLI 应调用 envChecks（补上可达性/loopback 诊断）')
  assert.match(src, /isLoopbackOrigin/, 'CLI 应判定 loopback')
  // 两段都要跑（CLI 独有项 + 运行时态项）
  assert.match(src, /doctorChecks\(/, 'CLI 仍应保留 doctorChecks 的静态校验')
})

test('M1 装配：CLI doctor 不得把 role 写死成 hub', () => {
  const src = read('bin/dsh-remote-setup.js')
  const i = src.indexOf('const config = {')
  assert.ok(i >= 0)
  const seg = src.slice(i, i + 600)
  // 原实现 `role: grab('role') || 'hub'` —— 让 auto-worker 被当 hub 体检
  assert.ok(
    !/role:\s*grab\('role'\)\s*\|\|\s*'hub'/.test(seg),
    "不得 `grab('role') || 'hub'` —— 会让 auto-worker 被当 hub 体检（判据全错）",
  )
  // 应交给 resolveRole
  assert.match(src, /resolveRole\(config\)/, '应交给 resolveRole 推断')
})

/* ═══════════════ L3：不得承诺不存在的修复能力 ═══════════════ */

test('L3 装配：全仓库不得出现虚构的 --fix 参数或修复按钮', () => {
  // ⚠ 只查**字符串字面量**，不扫注释（本测试第一版扫全文 → 命中了修复说明
  // 注释里的 "加 --fix" 字样，恒失败）。注释里提到"原来看板写 --fix，但那个
  // 参数不存在"恰恰是**正确的留档**，不该被断言判违规。
  const literalRe = /'[^']*(加 --fix|可以自动修)[^']*'|"[^"]*(加 --fix|可以自动修)[^"]*"/g
    const files = ['lib/env-check.js', 'lib/client.js', 'bin/dsh-remote-setup.js']
  for (const f of files) {
    const src = read(f)
    // 剥掉行注释后再查（去掉 `// ...` 到行尾）
    const noLineComments = src.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const hits = noLineComments.match(literalRe) || []
    assert.equal(
      hits.length,
      0,
      `${f} 里不得有承诺 --fix / 可以自动修的**字符串字面量**，实际：${hits.join(' | ')}`,
    )
  }
  // autoFix 的语义已改为"修法机械"，文案不能再说"可以自动修"
  const env = read('lib/env-check.js')
  const envNoComments = env.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(!/'[^']*可以自动修[^']*'/.test(envNoComments), '不得再写"可以自动修"（没有修复动作）')
})
