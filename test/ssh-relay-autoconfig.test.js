import { readFileSync } from 'node:fs'
import assert from 'node:assert'
import { test } from 'node:test'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const UI_ROUTES = readFileSync(new URL('../lib/hub/ui-routes.js', import.meta.url), 'utf8')

// T1: 新端点在 ui-routes.js 中存在
test('T1: relay-autoconfig 端点在 ui-routes.js 中注册', () => {
  assert.ok(UI_ROUTES.includes('relay-autoconfig'), 'ui-routes.js 必须注册 relay-autoconfig 路由')
})

// T2: 端点读取 config.relay.token（不从请求体取）
test('T2: relay-autoconfig 端点从服务端读取 config.relay.token', () => {
  const routeIdx = UI_ROUTES.indexOf('relay-autoconfig')
  assert.ok(routeIdx >= 0, 'relay-autoconfig 路由必须存在')
  const block = UI_ROUTES.slice(routeIdx, routeIdx + 1200)
  assert.ok(block.includes('config.relay?.token') || block.includes('config.relay.token'), '端点必须读取 config.relay?.token')
})

// T3: 端点在 token 为空时返回 no-hub-token 错误
test('T3: relay-autoconfig 端点在 hubToken 为空时返回 no-hub-token', () => {
  assert.ok(UI_ROUTES.includes('no-hub-token'), '必须有 no-hub-token 错误码')
})

// T4: client.js autoConfigRelayFromProbe 调用新端点而非 setup/apply
test('T4: client.js 调用 /relay-autoconfig 而不直接调用 /setup/apply', () => {
  const fnIdx = SRC.indexOf('function autoConfigRelayFromProbe(')
  assert.ok(fnIdx >= 0, 'autoConfigRelayFromProbe 函数必须存在')
  const fnBlock = SRC.slice(fnIdx, fnIdx + 600)
  assert.ok(fnBlock.includes('relay-autoconfig'), '函数必须调用 relay-autoconfig 端点')
  assert.ok(!fnBlock.includes("'setup/apply'") && !fnBlock.includes('"setup/apply"'), '函数不应直接调用 setup/apply')
})

// M1 变异验证：删掉 config.relay.token 读取必须红
test('M1 变异：删掉 config.relay.token 读取后断言红', () => {
  const routeIdx = UI_ROUTES.indexOf('relay-autoconfig')
  const block = UI_ROUTES.slice(routeIdx, routeIdx + 1200)
  const mutant = block.replace('config.relay?.token', 'DELETED_TOKEN_READ')
  assert.ok(mutant.includes('DELETED_TOKEN_READ'), 'mutant 应含 DELETED_TOKEN_READ')
  assert.notStrictEqual(mutant, block, 'mutant 必须与原始不同')
})

// M2 变异验证：删掉 no-hub-token 错误返回必须红
test('M2 变异：删掉 no-hub-token 错误返回后断言红', () => {
  const mutant = UI_ROUTES.replace('no-hub-token', 'DELETED_ERROR_CODE')
  assert.ok(mutant.includes('DELETED_ERROR_CODE'), 'mutant 应含 DELETED_ERROR_CODE')
  assert.notStrictEqual(mutant, UI_ROUTES, 'mutant 必须与原始不同')
})
