import { readFileSync } from 'node:fs'
import assert from 'node:assert'
import { test } from 'node:test'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const ONBOARD = readFileSync(new URL('../lib/hub/ssh-onboard.js', import.meta.url), 'utf8')
const UI_ROUTES = readFileSync(new URL('../lib/hub/ui-routes.js', import.meta.url), 'utf8')

// T1: probeHost returns relayHubToken
test('T1: probeHost 返回 relayHubToken 字段', () => {
  assert.ok(ONBOARD.includes('relayHubToken'), 'ssh-onboard.js 必须包含 relayHubToken')
})

// T2: sftpReadFile helper exists
test('T2: sftpReadFile 辅助函数存在', () => {
  assert.ok(ONBOARD.includes('function sftpReadFile('), 'ssh-onboard.js 必须有 sftpReadFile 函数')
})

// T3: tokens.json is read from relay server
test('T3: probe 阶段读取 tokens.json', () => {
  assert.ok(ONBOARD.includes('tokens.json'), 'ssh-onboard.js 必须读取 tokens.json')
})

// T4: /relay-autoconfig accepts body.autoHubToken as fallback
test('T4: relay-autoconfig 端点接受 autoHubToken 作为 fallback', () => {
  const routeIdx = UI_ROUTES.indexOf('relay-autoconfig')
  assert.ok(routeIdx >= 0)
  const block = UI_ROUTES.slice(routeIdx, routeIdx + 1500)
  assert.ok(block.includes('autoHubToken'), 'relay-autoconfig 端点必须处理 autoHubToken 字段')
})

// T5: client.js passes autoHubToken to relay-autoconfig
test('T5: client.js 把 autoHubToken 传给 relay-autoconfig', () => {
  const fnIdx = SRC.indexOf('function autoConfigRelayFromProbe(')
  assert.ok(fnIdx >= 0)
  const fnBlock = SRC.slice(fnIdx, fnIdx + 900)
  assert.ok(fnBlock.includes('autoHubToken'), '函数必须传递 autoHubToken 字段')
  assert.ok(fnBlock.includes('relayHubToken'), '函数必须从 relayHost.relayHubToken 取值')
})

// M1 变异验证：把 tokens.json 读取去掉后，T3 的主断言必须红
test('M1 变异：删掉 tokens.json 读取后主断言必须红', () => {
  const onboardRaw = readFileSync(new URL('../lib/hub/ssh-onboard.js', import.meta.url), 'utf8')
  assert.ok(onboardRaw.includes('tokens.json'), '基线：ssh-onboard.js 必须含 tokens.json')
  const mutant = onboardRaw.replace(/tokens\.json/g, 'DELETED_TOKENS_FILE')
  assert.notStrictEqual(mutant, onboardRaw, 'mutant 必须 ≠ 原始')
  assert.throws(
    () => assert.ok(mutant.includes('tokens.json'), 'ssh-onboard.js 必须读取 tokens.json'),
    '变异后 T3 主断言必须失败'
  )
})

// M2 变异验证：把 relay-autoconfig 里对 autoHubToken 的使用去掉后，主断言必须红
test('M2 变异：删掉 autoHubToken 处理后主断言必须红', () => {
  const routesRaw = readFileSync(new URL('../lib/hub/ui-routes.js', import.meta.url), 'utf8')
  const routeIdx = routesRaw.indexOf('relay-autoconfig')
  assert.ok(routeIdx >= 0, '基线：ui-routes.js 必须含 relay-autoconfig 端点')
  const block = routesRaw.slice(routeIdx, routeIdx + 1550)
  const mutant = block.replace(/autoHubToken/g, 'DELETED_AUTO_TOKEN')
  assert.notStrictEqual(mutant, block, 'mutant 必须 ≠ 原始')
  assert.throws(
    () => assert.ok(mutant.includes('autoHubToken'), 'relay-autoconfig 必须处理 autoHubToken'),
    '变异后主断言必须失败'
  )
})
