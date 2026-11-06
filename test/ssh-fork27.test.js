import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf-8')
const ONBOARD = readFileSync(fileURLToPath(new URL('../lib/hub/ssh-onboard.js', import.meta.url)), 'utf-8')
const WORKER = readFileSync(fileURLToPath(new URL('../bin/dsh-remote-worker.js', import.meta.url)), 'utf-8')

test('A: missing > 0 时渲染「安装运行环境」按钮', () => {
  assert.ok(SRC.includes('安装运行环境'), '应包含「安装运行环境」按钮文案')
  assert.ok(SRC.includes("'/ssh-deploy/install-runtime'"), '应调用 /ssh-deploy/install-runtime 端点')
  assert.ok(SRC.includes("probe.missing && probe.missing.length > 0"), '缺环境条件判断必须存在')
})

test('A: missing 为空时不渲染安装按钮（条件检查）', () => {
  // 按钮在 probe.missing && probe.missing.length > 0 条件下渲染
  const idx = SRC.indexOf('安装运行环境')
  const before = SRC.slice(Math.max(0, idx - 400), idx)
  assert.ok(before.includes('probe.missing') && before.includes('length > 0'),
    '安装按钮只在 missing.length > 0 时渲染')
})

// M2 变异验证：计数断言，删掉任一条件守卫后 cnt 必降为 1
test('A 变异验证(M2)：probe.missing 条件出现次数 ≥ 2', () => {
  const cnt = (SRC.match(/probe\.missing && probe\.missing\.length > 0/g) || []).length
  assert.strictEqual(cnt, 4, `probe.missing 条件应出现精确 4 次，实际 ${cnt} 次（删任一处即红）`)
})

test('A 变异验证：删除安装按钮逻辑后测试红', () => {
  assert.ok(SRC.includes("sshInstallBusy[alias]"), '应有 sshInstallBusy 状态引用')
  assert.ok(SRC.includes('runInstallRuntime'), '应调用 runInstallRuntime 函数')
})

test('B: 未检测时显示灰色「未检测」徽章', () => {
  assert.ok(SRC.includes("'未检测'"), '应有「未检测」状态文案')
  assert.ok(SRC.includes("'缺环境'"), '应有「缺环境」状态文案')
  assert.ok(SRC.includes("'已上桥'"), '应有「已上桥」状态文案')
  assert.ok(SRC.includes("'可上桥'"), '应有「可上桥」状态文案')
})

test('B: 7种徽章状态全部实现', () => {
  const badgeStates = ['未检测', '探测失败', '缺环境', '可上桥', '上桥中', '已上桥', '失败']
  for (const s of badgeStates) {
    assert.ok(SRC.includes("'" + s + "'"), `应包含徽章状态：${s}`)
  }
})

test('C: relay.url 为空时上桥被拦截，提示配置中继', () => {
  assert.ok(SRC.includes('curRelayUrl'), '应有 curRelayUrl 变量')
  assert.ok(SRC.includes('请先在上方配置区填写并保存中继地址'), '应有缺中继提示文案')
})

test('C 变异验证：删除 relay check 后测试红', () => {
  assert.ok(SRC.includes('curRelayUrl.trim()'), '应检查 curRelayUrl.trim()')
  assert.ok(SRC.includes("window.alert"), '应用 window.alert 提示用户')
  // 确保 relay check 在 runSshDeploy 函数内
  const deployIdx = SRC.indexOf('function runSshDeploy(')
  assert.ok(deployIdx >= 0)
  const deployBlock = SRC.slice(deployIdx, deployIdx + 500)
  assert.ok(deployBlock.includes('curRelayUrl'), 'relay check 必须在 runSshDeploy 函数内')
})

test('confirm 二次确认在 runInstallRuntime 内', () => {
  assert.ok(SRC.includes('window.confirm('), '应有 window.confirm 二次确认')
  const installIdx = SRC.indexOf('function runInstallRuntime(')
  assert.ok(installIdx >= 0, 'runInstallRuntime 函数必须存在')
  const installBlock = SRC.slice(installIdx, installIdx + 300)
  assert.ok(installBlock.includes('window.confirm'), 'confirm 必须在 runInstallRuntime 函数内')
})

// M1 变异验证：enrollToken 必须以真实值写入 nodeToken，不得打码
test('M1 变异验证：enrollToken 真实写入 nodeToken，不得打码', () => {
  // 原始内容必须含 "${enrollToken}" 模板字面量
  assert.ok(
    ONBOARD.includes('"nodeToken": "${enrollToken}"') ||
    ONBOARD.includes("`  \"nodeToken\": \"${enrollToken}\",`"),
    'ssh-onboard.js 必须用 ${enrollToken} 写入真实 token，不得打码'
  )
  // 确认不含打码形式
  assert.ok(!ONBOARD.includes('"nodeToken": "${maskSecret('), 'nodeToken 不得使用 maskSecret 打码')
  // 构造 mutant：把 enrollToken 替换为 ***，断言与原始不同
  const mutant = ONBOARD.replace('"nodeToken": "${enrollToken}"', '"nodeToken": "***"')
  assert.ok(mutant.includes('"nodeToken": "***"'), 'mutant 应含打码行')
  assert.notStrictEqual(mutant, ONBOARD, 'mutant 必须与原始不同')
})

// M4 变异验证：bin/dsh-remote-worker.js 调用 applyWorker(ctx, config)
test('M4 变异验证：bin/dsh-remote-worker.js 调用 applyWorker', () => {
  assert.ok(WORKER.includes('applyWorker(ctx, config)'), 'dsh-remote-worker.js 必须调用 applyWorker(ctx, config)')
  // 构造 mutant：删掉 applyWorker 调用
  const mutant = WORKER.replace('applyWorker(ctx, config)', '')
  assert.ok(!mutant.includes('applyWorker(ctx, config)'), 'mutant 不应含 applyWorker 调用')
  assert.notStrictEqual(mutant, WORKER, 'mutant 必须与原始不同')
})
