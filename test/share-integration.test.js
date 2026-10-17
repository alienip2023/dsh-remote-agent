/**
 * 工作区共享的**集成契约**测试（2026-10-17）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 与 share-service.test.js 的分工
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · share-service.test.js —— 纯函数（共享名、命令生成、权限映射）
 *   · 本文件 —— **接线**：协议帧是否声明、E2E 是否强制、hub 侧 pending 表
 *     是否独立、路由是否强制二次确认
 *
 * 接线断了比纯函数写错更难发现：命令生成得再对，帧没声明 = 功能不存在；
 * 帧声明了但没进 E2E_REQUIRED_TYPES = 工作区绝对路径明文过中继。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 重点钉住：二次确认是**硬要求**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这是本插件唯一主动放宽安全边界的功能。用户要求"在开启时二次确认，说明危险"。
 * 所以 `POST /share` 缺 `confirm: 'yes'` 必须 400 —— 不能有默认通过的分支。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { HUB_TO_NODE, NODE_TO_HUB } from '../lib/protocol.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/* ═══════════════ 1. 协议帧已声明 ═══════════════ */

test('协议：SHARE_REQ / SHARE_RES 帧已声明', () => {
  assert.equal(HUB_TO_NODE.SHARE_REQ, 'share/req')
  assert.equal(NODE_TO_HUB.SHARE_RES, 'share/res')
  // 不能和 fs 帧撞名（撞了会走错分支）
  assert.notEqual(HUB_TO_NODE.SHARE_REQ, HUB_TO_NODE.FS_REQ)
  assert.notEqual(NODE_TO_HUB.SHARE_RES, NODE_TO_HUB.FS_RES)
})

/* ═══════════════ 2. E2E 强制（工作区绝对路径不许明文过中继）═══════════════ */

test('安全：SHARE_REQ 必须在 E2E_REQUIRED_TYPES 里', () => {
  // 帧里含工作区**绝对路径** —— 暴露副机的目录结构，必须加密
  const code = stripComments(read('lib/node/transport.js'))
  const i = code.indexOf('E2E_REQUIRED_TYPES = new Set([')
  assert.ok(i >= 0, '应有 E2E_REQUIRED_TYPES')
  const seg = code.slice(i, i + 800)
  assert.match(seg, /HUB_TO_NODE\.SHARE_REQ/, 'SHARE_REQ 必须进 E2E_REQUIRED_TYPES')
})

/* ═══════════════ 3. hub 侧 pending 表必须独立 ═══════════════ */

test('hub：sharePending 与 fsPending 是两张独立的表', () => {
  const code = stripComments(read('lib/hub/node-registry.js'))
  assert.match(code, /this\.sharePending = new Map\(\)/, '应有 sharePending 表')
  assert.match(code, /this\.fsPending = new Map\(\)/, 'fsPending 应仍在')
  // 不能复用 fsPending（混用会让超时归因变模糊）
  const i = code.indexOf('shareRequest(')
  assert.ok(i >= 0, '应有 shareRequest')
  const seg = code.slice(i, i + 1200)
  assert.match(seg, /this\.sharePending\.set/, 'shareRequest 应写自己的表')
  assert.ok(!/this\.fsPending\.set/.test(seg), 'shareRequest 不得写 fsPending')
})

test('hub：节点断连时 share 等待者也要 fail-fast', () => {
  const code = stripComments(read('lib/hub/node-registry.js'))
  assert.match(code, /shareCancelForNode/, '应有 shareCancelForNode')
  // markOffline 里必须调用它（否则断连后调用方永久挂起）
  const i = code.indexOf('markOffline(')
  assert.ok(i >= 0)
  const seg = code.slice(i, i + 2000)
  assert.match(seg, /this\.shareCancelForNode\(nodeId\)/, 'markOffline 应清 share 等待者')
})

test('hub：SHARE_RES 帧有摄入分支', () => {
  const code = stripComments(read('lib/hub/registry-ingest.js'))
  assert.match(code, /NODE_TO_HUB\.SHARE_RES/, '应有 SHARE_RES 分支')
  assert.match(code, /this\.handleShareRes\(nodeId, d\)/, '应转给 handleShareRes')
})

/* ═══════════════ 4. 二次确认是硬要求 ═══════════════ */

test('安全：POST /share 缺 confirm 必须 400（不能有默认通过）', () => {
  const code = stripComments(read('lib/hub/ui-routes.js'))
  const i = code.indexOf('UI_API_PREFIX}/share')
  assert.ok(i >= 0, '应有 /share 路由')
  const seg = code.slice(i, i + 3000)

  assert.match(seg, /body\?\.confirm !== 'yes'/, "必须校验 confirm === 'yes'")
  assert.match(seg, /error: 'confirm-required'/, '应回明确的 confirm-required')
  // 400 而不是 200 —— 这是拒绝，不是"提示但仍执行"
  const ci = seg.indexOf("confirm !== 'yes'")
  const after = seg.slice(ci, ci + 400)
  assert.match(after, /writeJson\(res, 400/, '缺 confirm 必须 400')
})

test('安全：二次确认的文案必须说明"会绕过边界"', () => {
  const code = read('lib/hub/ui-routes.js')
  const i = code.indexOf('confirm-required')
  const seg = code.slice(Math.max(0, i - 400), i + 400)
  assert.match(seg, /绕过/, '说明里必须写"绕过"边界')
  assert.match(seg, /roots/, '说明里必须点名 roots 失效')
})

test('安全：面板上有勾选框 + 未勾选时按钮禁用', () => {
  const code = stripComments(read('lib/client.js'))
  const i = code.indexOf('function SharePanel')
  assert.ok(i >= 0, '应有 SharePanel 组件')
  const seg = code.slice(i, i + 7000)

  assert.match(seg, /type: 'checkbox'/, '应有确认勾选框')
  assert.match(seg, /disabled: busy \|\| !ack/, '未勾选时按钮必须禁用')
  assert.match(seg, /confirm: 'yes'/, '请求里必须带 confirm')
  // 风险说明必须含关键三条
  assert.match(seg, /绕过/, '应说明绕过安全边界')
  assert.match(seg, /denyPaths/, '应点名 denyPaths 失效')
  assert.match(seg, /\.env|密钥/, '应说明密钥可见')
})

/* ═══════════════ 5. 只读 / 读写两种选项 ═══════════════ */

test('功能：面板提供只读与读写两种权限选择', () => {
  const code = stripComments(read('lib/client.js'))
  const i = code.indexOf('function SharePanel')
  const seg = code.slice(i, i + 7000)
  assert.match(seg, /value: 'read'/, '应有只读选项')
  assert.match(seg, /value: 'write'/, '应有读写选项')
  // 默认必须是只读（最小权限）
  assert.match(seg, /React\.useState\('read'\)/, "默认权限必须是 'read'")
  // 选 write 要有额外警告
  assert.match(seg, /读写模式下主机可以修改/, '选 write 应给额外警告')
})

test('功能：读写映射到 -ChangeAccess（不是 FullAccess）', () => {
  const code = stripComments(read('lib/node/share-service.js'))
  assert.match(code, /ChangeAccess/, '读写应用 -ChangeAccess')
  // FullAccess 会把共享 ACL 也交出去（主机能改权限），不该用
  assert.ok(!/'-FullAccess'|-\$\{?.*FullAccess/.test(code), '不得生成 -FullAccess')
})

/* ═══════════════ 6. 不代执行（需要管理员）═══════════════ */

test('安全：副机侧只生成命令，不执行 New-SmbShare', () => {
  const code = stripComments(read('lib/node/index.js'))
  const i = code.indexOf('function handleShareReq')
  assert.ok(i >= 0, '应有 handleShareReq')
  const seg = code.slice(i, i + 2600)
  // 不得出现真正的执行调用
  assert.ok(!/spawn.*New-SmbShare/.test(seg), '不得 spawn New-SmbShare')
  assert.ok(!/execSync.*New-SmbShare/.test(seg), '不得 execSync New-SmbShare')
  // 只生成命令
  assert.match(seg, /buildShareCommand/, '应只调 buildShareCommand 生成命令')
  assert.match(seg, /admin: isAdmin\(\)/, '应如实回报是否管理员（决定用户要不要提权）')
})

test('安全：plan 的目录必须过 roots 边界', () => {
  const code = stripComments(read('lib/node/index.js'))
  const i = code.indexOf('function handleShareReq')
  const seg = code.slice(i, i + 2600)
  // 共享目录必须经 resolveWorkspace（realpath + roots 前缀 + denyPaths）
  assert.match(seg, /resolveWorkspace\(/, 'plan 必须过 resolveWorkspace')
})
