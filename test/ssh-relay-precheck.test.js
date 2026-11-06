import { readFileSync } from 'node:fs'
import assert from 'node:assert'
import { test } from 'node:test'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const ONBOARD = readFileSync(new URL('../lib/hub/ssh-onboard.js', import.meta.url), 'utf8')

// T1: relay 自动探测函数存在
test('T1: autoConfigRelayFromProbe 函数存在', () => {
  assert.ok(SRC.includes('function autoConfigRelayFromProbe('), 'autoConfigRelayFromProbe 函数必须存在')
})

// T2: probe.isRelay 被检测
test('T2: probe.isRelay 中继主机探测在 client.js', () => {
  assert.ok(SRC.includes('probe.isRelay'), 'client.js 必须检查 probe.isRelay')
  assert.ok(SRC.includes("'中继'"), "中继徽章文案必须存在")
})

// T3: ssh-onboard.js 探测 8890 端口判断是否为中继主机
test('T3: ssh-onboard.js probe 阶段检测 8890 端口', () => {
  assert.ok(ONBOARD.includes('8890'), 'ssh-onboard.js 必须检测 8890 端口')
  assert.ok(ONBOARD.includes('isRelay'), 'ssh-onboard.js 必须返回 isRelay')
})

// T4: 部署流程中，中继未配置时调用 autoConfigRelayFromProbe 而非直接 alert 报错
test('T4: relay 未配置时自动探测，不是直接报错退出', () => {
  const deployIdx = SRC.indexOf('function runSshDeploy(')
  assert.ok(deployIdx >= 0, 'runSshDeploy 函数必须存在')
  const deployBlock = SRC.slice(deployIdx, deployIdx + 800)
  assert.ok(deployBlock.includes('autoConfigRelayFromProbe'), 'runSshDeploy 未配置中继时必须调用 autoConfigRelayFromProbe')
})

// M1 变异验证：删 autoConfigRelayFromProbe 调用在 runSshDeploy 内必须红
test('M1 变异：删掉 runSshDeploy 内 autoConfigRelayFromProbe 调用后断言红', () => {
  const deployIdx = SRC.indexOf('function runSshDeploy(')
  assert.ok(deployIdx >= 0)
  const deployBlock = SRC.slice(deployIdx, deployIdx + 800)
  const mutant = deployBlock.replace('autoConfigRelayFromProbe', 'DELETED_RELAY_CHECK')
  assert.ok(!mutant.includes('autoConfigRelayFromProbe'), 'mutant 不含 autoConfigRelayFromProbe')
  assert.notStrictEqual(mutant, deployBlock, 'mutant 必须与原始不同')
})

// M2 变异验证：删掉 ssh-onboard.js 里的 isRelay 后必须红
test('M2 变异：删掉 ssh-onboard.js isRelay 返回必须红', () => {
  // isRelay 在 return 语句中以 "isRelay, relayUrl" 形式出现
  assert.ok(ONBOARD.includes('isRelay, relayUrl'), 'ssh-onboard.js return 必须含 isRelay, relayUrl')
  const mutant = ONBOARD.replace('isRelay, relayUrl', 'DELETED_RELAY_FLAG, relayUrl')
  assert.ok(mutant.includes('DELETED_RELAY_FLAG'), 'mutant 应含 DELETED 占位符')
  assert.notStrictEqual(mutant, ONBOARD, 'mutant 必须与原始不同')
})
