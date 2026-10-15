/**
 * 小白向导（lib/setup.js）纯逻辑回归：
 *
 *   - detectLanIps：结构契约（排除 loopback / 链路本地）
 *   - normalizeRoots：~ 展开、相对路径落 home、去重、标出缺失目录
 *   - buildHubUrl：三种写法收敛成一个合法 ws:// 直连地址
 *   - buildHubYaml / buildWorkerYaml：生成的配置必须可直接粘贴 ——
 *     worker 片段的 `inject: []` 是部署失败头号坑，必须由生成器替用户填好
 *   - doctorChecks：小白最容易踩的每一条都要有"✗ + 怎么修"
 *   - friendlyConnectError：错误码 → 人话
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  newNodeToken,
  normalizeRoots,
  buildHubUrl,
  buildHubYaml,
  buildWorkerYaml,
  doctorChecks,
  renderDoctor,
  friendlyConnectError,
  NODE_ID_RE,
} from '../lib/setup.js'

/* ══════════════════ token ══════════════════ */

test('newNodeToken：nt_ 前缀 + 每次不同 + 无易混淆歧义字符问题（base64url）', () => {
  const a = newNodeToken()
  const b = newNodeToken()
  assert.match(a, /^nt_[A-Za-z0-9_-]{32}$/)
  assert.notEqual(a, b)
})

/* ══════════════════ roots ══════════════════ */

test('normalizeRoots：~ 展开、相对路径落 home、尾斜杠剥离、去重（大小写不敏感）', () => {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const { clean, missing } = normalizeRoots([
      'D:\\work\\',
      'd:/work', // 同目录不同写法 → 去重
      '~/dsh-remote-work',
      'relative-dir',
      '',
      42,
    ])
    assert.equal(clean[0], 'D:\\work')
    assert.equal(clean[1], path.join(home, 'dsh-remote-work'))
    assert.equal(clean[2], path.join(home, 'relative-dir'))
    // 去重：6 个输入进 3 个（'' 与 42 被丢）
    assert.equal(clean.length, 3)
    assert.ok(Array.isArray(missing))
  } else {
    // POSIX：反斜杠不是分隔符，'D:\work' 是普通（非法形态的）目录名 ——
    // 盘符路径的收敛规则只在 Windows 上成立，不能跨平台断言。
    const { clean, missing } = normalizeRoots([
      '~/dsh-remote-work',
      'relative-dir',
      'x//', // 尾分隔符剥离
      'x', // 与上一条同目录 → 去重
      '',
      42,
    ])
    assert.equal(clean[0], path.join(home, 'dsh-remote-work'))
    assert.equal(clean[1], path.join(home, 'relative-dir'))
    assert.equal(clean[2], path.join(home, 'x'))
    assert.equal(clean.length, 3)
    assert.ok(Array.isArray(missing))
  }
})

/* ══════════════════ hubUrl ══════════════════ */

test('buildHubUrl：裸 IP:端口 / 带协议 / 完整地址 三种写法收敛一致', () => {
  const want = 'ws://192.168.1.10:19387/api/remote-agent/node'
  assert.equal(buildHubUrl('192.168.1.10:19387'), want)
  assert.equal(buildHubUrl('ws://192.168.1.10:19387'), want)
  assert.equal(buildHubUrl('ws://192.168.1.10:19387/api/remote-agent/node'), want)
  // http(s) 自动升级
  assert.equal(buildHubUrl('http://192.168.1.10:19387'), want)
  // 只有 IP → 补默认端口与路径
  assert.equal(buildHubUrl('192.168.1.10'), want)
  assert.equal(buildHubUrl(''), '')
  assert.equal(buildHubUrl('not a url//'), '')
})

/* ══════════════════ YAML 生成 ══════════════════ */

test('buildWorkerYaml：inject: [] 必须在片段里（部署失败头号坑由生成器填好）', () => {
  const yaml = buildWorkerYaml({
    hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node',
    token: 'nt_x',
    nodeId: 'slave-pc',
    roots: ['D:\\work'],
  })
  assert.match(yaml, /^\s*inject:\s*\[\]\s*(#.*)?$/m)
  assert.match(yaml, /role: worker/)
  assert.match(yaml, /hubUrl: ws:\/\/192\.168\.1\.10:19387\/api\/remote-agent\/node/)
  assert.match(yaml, /token: nt_x/)
  assert.match(yaml, /- D:\\work/)
})

test('buildWorkerYaml：含特殊字符的 token 走单引号转义（YAML 安全）', () => {
  const yaml = buildWorkerYaml({ hubUrl: 'ws://h/x', token: "nt_a'b" })
  assert.match(yaml, /token: 'nt_a''b'/)
})

test('buildHubYaml：nodeToken 与 uiPullRoot 落进 config', () => {
  const yaml = buildHubYaml({ token: 'nt_x', roots: ['D:\\work'] })
  assert.match(yaml, /role: hub/)
  assert.match(yaml, /nodeToken: nt_x/)
  assert.match(yaml, /uiPullRoot: D:\\work/)
})

/* ══════════════════ doctor ══════════════════ */

test('doctorChecks（worker）：缺 hubUrl / 缺 roots / 坏 nodeId 都有可执行的修法', () => {
  const checks = doctorChecks({ role: 'worker', config: { role: 'worker', hubUrl: '', roots: [], nodeId: '!!' } })
  const bad = checks.filter((c) => !c.ok)
  assert.ok(bad.length >= 3)
  for (const c of bad) assert.ok(c.fix !== '', `检查 "${c.label}" 失败但没给修法`)
  // 修法里必须点名配置字段
  const hubUrlFix = bad.find((c) => c.label.includes('hubUrl'))
  assert.ok(hubUrlFix.fix.includes('hubUrl'))
})

test('doctorChecks（worker）：合法私网配置全绿（盘上真实存在的临时目录）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-'))
  const checks = doctorChecks({
    role: 'worker',
    config: {
      role: 'worker',
      hubUrl: 'ws://192.168.1.10:19387/api/remote-agent/node',
      token: 'nt_x',
      roots: [dir],
      nodeId: 'slave-pc',
    },
  })
  assert.equal(checks.filter((c) => !c.ok).length, 0, JSON.stringify(checks.filter((c) => !c.ok)))
})

test('doctorChecks（worker）：roots 指向不存在的目录 → 单独一条 ✗', () => {
  const nope = path.join(os.tmpdir(), 'definitely-missing-dir-xyz')
  const checks = doctorChecks({
    role: 'worker',
    config: { role: 'worker', hubUrl: 'ws://192.168.1.10:19387/x', token: 't', roots: [nope] },
  })
  const missing = checks.find((c) => !c.ok && c.label.includes(nope))
  assert.ok(missing, '必须指出哪个目录不存在')
  assert.match(missing.fix, /创建|路径/)
})

test('doctorChecks（hub）：token 为空 + 本机有公网地址 → 必须红', () => {
  const checks = doctorChecks({
    role: 'hub',
    config: { role: 'hub', nodeToken: '', uiPullRoot: '' },
    lanIps: [{ name: 'eth0', address: '1.2.3.4', private: false }],
  })
  const tokenCheck = checks.find((c) => !c.ok && /nodeToken|token/.test(c.label))
  assert.ok(tokenCheck, '公网 + 空 token 必须报红')
})

test('doctorChecks（hub）：uiPullRoot 未配置 → 提示面板拉取会被禁用', () => {
  const checks = doctorChecks({
    role: 'hub',
    config: { role: 'hub', nodeToken: 'nt_x', uiPullRoot: '' },
    lanIps: [],
  })
  const pull = checks.find((c) => !c.ok && c.label.includes('uiPullRoot'))
  assert.ok(pull)
  assert.match(pull.fix, /拉取|目录/)
})

test('renderDoctor：失败数与退出语义一致', () => {
  const { text, failed } = renderDoctor([
    { ok: true, label: 'a', fix: '' },
    { ok: false, label: 'b', fix: '修 b' },
  ])
  assert.equal(failed, 1)
  assert.match(text, /✓ a/)
  assert.match(text, /✗ b/)
  assert.match(text, /怎么修：修 b/)
  assert.match(text, /共 1 项需要处理/)
})

/* ══════════════════ 错误翻译 ══════════════════ */

test('friendlyConnectError：常见错误码 → 指向具体排查动作的人话', () => {
  const cases = [
    ['ECONNREFUSED', /没人听|防火墙/],
    ['ENOTFOUND', /解析/],
    ['ETIMEDOUT', /网段|不可达/],
  ]
  for (const [code, re] of cases) {
    const msg = friendlyConnectError({ code }, { host: '192.168.1.10', port: 19387 })
    assert.match(msg, re, code)
    assert.match(msg, /192\.168\.1\.10:19387/)
  }
  // 未知错误码退回原始 message，不吞信息
  assert.equal(friendlyConnectError({ code: 'EXX', message: 'boom' }).includes('boom'), true)
})

test('NODE_ID_RE：与 protocol.validateHello 的规则一致（关键形状抽查）', () => {
  assert.ok(NODE_ID_RE.test('slave-pc'))
  assert.ok(NODE_ID_RE.test('a'.repeat(64)))
  assert.ok(!NODE_ID_RE.test('-lead'))
  assert.ok(!NODE_ID_RE.test('has space'))
  assert.ok(!NODE_ID_RE.test('中文'))
  assert.ok(!NODE_ID_RE.test('a'.repeat(65)))
})
