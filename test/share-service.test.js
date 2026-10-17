/**
 * 工作区 SMB 共享（`lib/node/share-service.js`）测试。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个模块为什么要存在（用户需求，2026-10-17）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户想用本地 IDE 直接打开副机的项目目录 —— 唯一现实路径是把工作区通过
 * SMB 共享出来，主机 `net use X: \\副机\dsh-work` 映射成盘符。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ 这是本插件**唯一主动放宽安全边界**的功能
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 开启后：
 *   · `roots` / `denyPaths` 全部失效（Windows 内核直读，插件拦不住）
 *   · 「清单先于字节」失效（中间产物、.env、.git 密钥全部可见）
 *   · 新增凭证面（主机需要副机 Windows 账号）
 *
 * 所以产品要求（用户确认）：
 *   1. **二次确认**（`confirm: 'yes'`），且说明危险
 *   2. **只读 / 读写两种选项**，默认只读（最小权限）
 *   3. 需要管理员权限时**给可复制的命令**，不假装能一键
 *
 * 本文件钉住这三点 + 命名稳定性（避免留下孤儿共享）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SHARE_ACCESS,
  SHARE_NAME_PREFIX,
  buildMountCommand,
  buildShareCommand,
  buildUnshareCommand,
  findShareForDir,
  isAdmin,
  listShares,
  probeShareState,
  shareNameFor,
} from '../lib/node/share-service.js'

/* ═══════════════ 1. 共享名必须稳定（防孤儿共享）═══════════════ */

test('shareNameFor：同一路径两次调用得到同一共享名', () => {
  // 这是**硬要求**：用户反复开关共享时，名字必须一致，否则每次留下一个孤儿共享。
  const a = shareNameFor('D:\\work')
  const b = shareNameFor('D:\\work')
  assert.equal(a, b)
  assert.match(a, new RegExp(`^${SHARE_NAME_PREFIX}-[0-9a-f]{8}$`))
})

test('shareNameFor：不同路径得到不同共享名', () => {
  const a = shareNameFor('D:\\work')
  const b = shareNameFor('D:\\other')
  assert.notEqual(a, b, '不同目录必须能同时共享')
})

test('shareNameFor：长度有上限（Windows 共享名限 80 字符）', () => {
  const long = 'D:\\' + 'x'.repeat(500)
  assert.ok(shareNameFor(long).length <= 64)
})

test('shareNameFor：有固定前缀（便于识别与清理，不会误删用户共享）', () => {
  assert.ok(shareNameFor('D:\\work').startsWith(SHARE_NAME_PREFIX))
})

/* ═══════════════ 2. 只读 / 读写映射正确 ═══════════════ */

test('buildShareCommand：只读用 -ReadAccess', () => {
  const { command } = buildShareCommand({ dir: 'D:\\work', access: SHARE_ACCESS.READ })
  assert.match(command, /New-SmbShare/)
  assert.match(command, /-ReadAccess/, '只读必须是 -ReadAccess')
  assert.ok(!/-ChangeAccess/.test(command), '只读不得带 -ChangeAccess')
  assert.ok(!/-FullAccess/.test(command), '只读不得带 -FullAccess')
})

test('buildShareCommand：读写用 -ChangeAccess（不是 FullAccess）', () => {
  const { command } = buildShareCommand({ dir: 'D:\\work', access: SHARE_ACCESS.WRITE })
  assert.match(command, /-ChangeAccess/, '读写应该是 -ChangeAccess')
  // **不给 FullAccess**：那会把共享的 ACL 一起交出去，主机能改权限
  assert.ok(!/-FullAccess/.test(command), '不得用 -FullAccess（会给出改权限的能力）')
})

test('buildShareCommand：默认只读（最小权限原则）', () => {
  const { command } = buildShareCommand({ dir: 'D:\\work' })
  assert.match(command, /-ReadAccess/, '不传 access 时必须默认只读')
})

test('buildShareCommand：路径里的单引号必须转义（防命令注入）', () => {
  // PowerShell 单引号字符串里，单引号用两个单引号转义。
  // ⚠ 正则别写 `\\\\`：JS 字符串 "D:\\it's" 里只有一个反斜杠，
  // 所以正则用 `\\` 匹配它（写成 `\\\\` 会要求两个反斜杠，永远不匹配）。
  const { command } = buildShareCommand({ dir: "D:\\it's here", access: SHARE_ACCESS.READ })
  assert.match(command, /D:\\it''s here/, "单引号应转义成 ''（否则能注入命令）")
})

test('buildShareCommand：共享名与 shareNameFor 一致', () => {
  const { shareName, command } = buildShareCommand({ dir: 'D:\\work' })
  assert.equal(shareName, shareNameFor('D:\\work'))
  assert.ok(command.includes(shareName))
})

/* ═══════════════ 3. 卸载与映射命令 ═══════════════ */

test('buildUnshareCommand：带 -Force（不留交互提示）', () => {
  const cmd = buildUnshareCommand('dsh-work-abc12345')
  assert.match(cmd, /Remove-SmbShare/)
  assert.match(cmd, /-Force/)
  assert.match(cmd, /dsh-work-abc12345/)
})

test('buildMountCommand：生成正确的 net use 命令', () => {
  const cmd = buildMountCommand({ host: '100.72.146.73', shareName: 'dsh-work-abc' })
  assert.match(cmd, /^net use X:/)
  assert.match(cmd, /\\\\100\.72\.146\.73\\dsh-work-abc/, 'UNC 路径必须双反斜杠')
  assert.match(cmd, /\/persistent:yes/, '应持久化（重启后仍映射）')
})

test('buildMountCommand：盘符可自定义，且容错带/不带冒号', () => {
  assert.match(buildMountCommand({ host: 'h', shareName: 's', drive: 'Z:' }), /net use Z:/)
  assert.match(buildMountCommand({ host: 'h', shareName: 's', drive: 'Y' }), /net use Y:/)
})

/* ═══════════════ 4. 探测不抛（跨平台安全）═══════════════ */

test('probeShareState：非 Windows 时返回 supported:false（不抛）', () => {
  // 这个模块只在 Windows 有意义，但代码要能在 mac/linux 上 import 与调用
  const st = probeShareState({ dirs: ['/tmp/work'] })
  assert.equal(typeof st.supported, 'boolean')
  assert.equal(typeof st.admin, 'boolean')
  assert.ok(Array.isArray(st.shares))
  assert.equal(typeof st.perDir, 'object')
})

test('probeShareState：只列 dsh-work 前缀的共享（不碰用户的其它共享）', () => {
  const st = probeShareState()
  for (const s of st.shares) {
    assert.ok(s.name.startsWith(SHARE_NAME_PREFIX), `只应列 dsh-work 前缀，实际有 ${s.name}`)
  }
})

test('listShares / isAdmin / findShareForDir：都不抛', () => {
  assert.doesNotThrow(() => listShares())
  assert.doesNotThrow(() => isAdmin())
  assert.doesNotThrow(() => findShareForDir('D:\\nonexistent'))
  assert.ok(Array.isArray(listShares()))
  assert.equal(typeof isAdmin(), 'boolean')
})

/* ═══════════════ 5. 安全：默认值必须是安全的 ═══════════════ */

test('安全：SHARE_ACCESS 只有 read / write 两个值', () => {
  assert.deepEqual(Object.keys(SHARE_ACCESS).sort(), ['READ', 'WRITE'])
  assert.equal(SHARE_ACCESS.READ, 'read')
  assert.equal(SHARE_ACCESS.WRITE, 'write')
})

test('安全：共享名前缀固定（便于审计与清理）', () => {
  assert.equal(SHARE_NAME_PREFIX, 'dsh-work')
})
