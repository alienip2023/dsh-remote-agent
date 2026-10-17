/**
 * 「开箱即用」测试（2026-10-17）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 产品标准
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户装完插件就该能用，不该去读文档、改 YAML、猜字段。此前有三道门槛：
 *
 *   1. **role 默认 ''** → 两台机器都要操作一次
 *   2. **webserver 没绑 0.0.0.0** → 副机永远连不上（且完全静默）
 *   3. **副机表单 4 个字段** → 小白不知道节点 ID / 工作区填什么
 *
 * 本文件逐条钉住修复。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 关键设计：role 默认 `auto`，不是 `hub` 也不是 `''`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · 默认 `hub`：副机装完会以 hub 身份启动 —— 注册一个 nodeToken 为空、
 *     不校验凭证的直连端点。**这是实打实的攻击面**（v0.7.0 之前的老问题）。
 *   · 默认 `''`：两台机器都要操作一次，不是开箱即用。
 *   · 默认 `auto`：按 `hubUrl` 推断 —— 没配 hubUrl 是主机（零操作），
 *     配了 hubUrl 是副机（贴完配对码就零操作）。**两者都开箱即用，且不给
 *     副机开不该开的端点。**
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveRoleDetail, ROLE } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const patch = read('cordis.patch.yml')
const client = read('lib/client.js')
const setupRoutes = read('lib/setup-routes.js')

/* ═══════════════ 1. role auto 推断（核心）═══════════════ */

test('开箱即用：role 默认 auto（不是 hub，也不是空）', () => {
  const code = stripComments(read('lib/index.js'))
  const m = /role:\s*z[\s\S]{0,900}?\.default\((['"])(.*?)\1\)/.exec(code)
  assert.ok(m, '应能解析出 role 的 default')
  assert.equal(m[2], 'auto')
})

test('开箱即用：auto + 没 hubUrl → hub（主机装完零操作）', () => {
  const r = resolveRoleDetail({ role: 'auto' })
  assert.equal(r.role, ROLE.HUB)
  assert.equal(r.inferred, 'no-hubUrl', '推断依据应可追溯')
  assert.notEqual(r.unconfigured, true, 'auto 不该被当成"未配置"（那会要求用户走引导）')
})

test('开箱即用：auto + 有 hubUrl → worker（副机贴完配对码零操作）', () => {
  const r = resolveRoleDetail({ role: 'auto', hubUrl: 'ws://100.86.48.54:19387/api/remote-agent/node' })
  assert.equal(r.role, ROLE.WORKER)
  assert.equal(r.inferred, 'hubUrl')
})

test('开箱即用：auto + hubUrl 是空白 → 仍是 hub（不能因为空格就变副机）', () => {
  for (const v of ['', '   ', '\t']) {
    const r = resolveRoleDetail({ role: 'auto', hubUrl: v })
    assert.equal(r.role, ROLE.HUB, `hubUrl=${JSON.stringify(v)} 应判为 hub`)
  }
})

test('安全：显式 role 永远优先于 auto 推断（用户写的不该被猜掉）', () => {
  // 即使配了 hubUrl，显式写 hub 就是 hub
  assert.equal(resolveRoleDetail({ role: 'hub', hubUrl: 'ws://x/y' }).role, ROLE.HUB)
  assert.equal(resolveRoleDetail({ role: 'worker' }).role, ROLE.WORKER)
  assert.equal(resolveRoleDetail({ role: 'both' }).role, ROLE.BOTH)
})

test('安全：空 role 仍是"未配置"（用户主动清空 → 走引导，不猜）', () => {
  const r = resolveRoleDetail({ role: '' })
  assert.equal(r.role, '')
  assert.equal(r.unconfigured, true)
})

test('安全：非法 role 不回退 hub（那会静默开无鉴权端点）', () => {
  for (const v of ['hubb', 'HUB!', 42, true, {}]) {
    const r = resolveRoleDetail({ role: v })
    assert.equal(r.role, '', `role=${JSON.stringify(v)} 应判为未配置，不得回退 hub`)
    assert.equal(r.unconfigured, true)
  }
})

/* ═══════════════ 2. 包内 patch 让 hub 真能被访问 ═══════════════ */

test('开箱即用：包内 patch 把 webserver 绑到 0.0.0.0:19387', () => {
  // 这是"副机能不能连上"的**决定性一条**：不覆盖 webserver，hub 只监听
  // loopback → 副机永远连不上，而主机侧毫无异常。
  assert.match(patch, /^- id: webserver$/m, '包内 patch 必须 override webserver 行')
  const i = patch.indexOf('- id: webserver')
  const seg = patch.slice(i, i + 300)
  assert.match(seg, /host:\s*'0\.0\.0\.0'/, "webserver 必须绑 0.0.0.0（否则副机连不上）")
  assert.match(seg, /port:\s*19387/, '端口必须是 19387')
  // 必须写明安全披露（绑 0.0.0.0 会暴露整个 DSH Web GUI）
  assert.match(patch, /暴露|安全披露/, '必须披露"绑 0.0.0.0 会暴露 Web GUI"')
})

test('开箱即用：包内 patch 的 role 默认是 auto', () => {
  assert.match(patch, /^\s+role: auto$/m, '包内 patch 的 role 应为 auto')
})

/* ═══════════════ 3. 副机表单简化 ═══════════════ */

test('开箱即用：工作区有预填默认值（不再是空）', () => {
  const code = stripComments(client)
  assert.match(code, /function defaultRootsHint\(\)/, '应有 defaultRootsHint')
  const i = code.indexOf('function defaultRootsHint()')
  const seg = code.slice(i, i + 600)
  assert.match(seg, /D:\\\\work/, 'Windows 默认 D:\\work')
  assert.match(seg, /~\/work/, '其他平台默认 ~/work')
  // 默认值必须是具体子目录，不能是整盘/整家目录（roots 是安全边界）
  assert.ok(!/return 'C:\\\\\\\\'/.test(seg), '默认值不得是整盘')
})

test('开箱即用：节点 ID 折叠为高级选项（默认用主机名）', () => {
  const code = stripComments(client)
  assert.match(code, /showAdv/, '应有高级选项折叠状态')
  assert.match(code, /默认用主机名/, '应提示"默认用主机名"')
  // 折叠后不应默认渲染 nodeId 输入框（少一个要理解的字段）
  const i = code.indexOf('默认用主机名')
  assert.ok(i > 0, '应能找到折叠入口')
})

/* ═══════════════ 4. 工作区自动创建 ═══════════════ */

test('开箱即用：写入配置时自动创建 roots 目录（不存在的才建）', () => {
  const code = stripComments(setupRoutes)
  assert.match(code, /mkdirSync\(r, \{ recursive: true \}\)/, '应自动 mkdir roots')
  // 只建不存在的（不能覆盖已有内容）
  const i = code.indexOf('mkdirSync')
  const seg = code.slice(Math.max(0, i - 500), i + 200)
  assert.match(seg, /existsSync/, '应先用 existsSync 判断（只建不存在的）')
  // 必须校验绝对路径（相对路径交给 resolveRoots 去拒）
  assert.match(seg, /isAbsolute/, '应校验绝对路径')
})

test('开箱即用：建目录的提示随响应回给面板（不能让用户以为已就绪）', () => {
  const code = stripComments(setupRoutes)
  assert.match(code, /applyWarnings/, '应有 warnings 收集')
  assert.match(code, /warnings: applyWarnings/, '成功响应里应带 warnings')
})

/* ═══════════════ 5. 首次自动体检 ═══════════════ */

test('开箱即用：面板首次加载自动跑体检（不用用户点按钮）', () => {
  const code = stripComments(client)
  assert.match(code, /autoChecked/, '应有"只自动跑一次"的闸门')
  assert.match(code, /if \(!autoChecked\.current\)/, '应有首次判断')
  assert.match(code, /autoChecked\.current = true/, '应置位防止重复')
  assert.match(code, /runEnvCheck\(\)/, '应调用体检')
})

/* ═══════════════ 6. setup state 透出推断结果 ═══════════════ */

test('开箱即用：面板能知道"当前生效角色"与"推断依据"', () => {
  const code = stripComments(setupRoutes)
  assert.match(code, /effectiveRole/, '应回 effectiveRole（auto 时是推断结果）')
  assert.match(code, /inferred/, '应回 inferred（推断依据）')
  // auto 必须算"已配置"，否则主机装完会被要求走引导
  assert.match(code, /role === 'auto'/, 'auto 应算已配置')
})
