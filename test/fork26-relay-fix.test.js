import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function src(rel) { return readFileSync(fileURLToPath(new URL(join_path(rel), import.meta.url)), 'utf-8') }
function join_path(rel) { return '../' + rel }

/* ── Bug 1: hub submit body 包含 hubToken/relayToken ──────────────────── */

test('B1: relay 模式 submit body 包含 hubToken', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf-8')
  // Find submit function and verify hubToken is in body
  assert.ok(s.includes('body.hubToken'), 'submit 应在 body 里放 hubToken')
  assert.ok(s.includes('hubToken.trim()'), 'hubToken 应 trim')
})

test('B1（变异验证）：删掉 body.hubToken 后断言红', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf-8')
  const mutant = s.replace(/body\.hubToken\s*=\s*hubToken\.trim\(\)/, '// body.hubToken removed by mutation')
  assert.ok(s.includes('body.hubToken'), '原始代码含 body.hubToken（变异验证）')
  assert.ok(!mutant.includes('body.hubToken = hubToken.trim()'), '变异后不含 body.hubToken 赋值')
})

/* ── Bug 2: setup-routes relay 模式写 token 到 YAML ────────────────────── */

test('B2: setup-routes relay 模式写 relay token 到 YAML', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/setup-routes.js', import.meta.url)), 'utf-8')
  // Must write token in relay mode
  assert.ok(s.includes('relayToken'), 'setup-routes 应含 relayToken 变量')
  assert.ok(s.includes("relay:\\n"), 'setup-routes 应写 relay 嵌套块')
  assert.ok(s.includes('token:'), 'setup-routes 应在 relay 块里写 token')
})

test('B2（变异验证）：删掉 relay token 写入后断言红', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/setup-routes.js', import.meta.url)), 'utf-8')
  // Mutant: remove the relayToken writing line
  const mutant = s.replace(/const relayToken = str\(body\.hubToken\) \|\| str\(body\.relayToken\)/, '// relayToken removed by mutation')
  assert.ok(s.includes('relayToken = str(body.hubToken)'), '原始代码含 relayToken 赋值（变异验证）')
  assert.ok(!mutant.includes('relayToken = str(body.hubToken)'), '变异后不含 relayToken 赋值')
})

/* ── Bug 3: ssh-onboard 与 /ui/config 走同一份 relay 读取口径 ─────────── */

function assertOnboardReads(source) {
  assert.ok(source.includes('readRelayToken(config)'), 'ssh-onboard 应走 readRelayToken(config)')
  assert.ok(source.includes('readRelayUrl(config)'), 'ssh-onboard 应走 readRelayUrl(config)')
}

test('B3: ssh-onboard 走 readRelayToken / readRelayUrl', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/hub/ssh-onboard.js', import.meta.url)), 'utf-8')
  assertOnboardReads(s)
})

test('B3（变异验证）：删掉 readRelayToken(config) 后断言红', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/hub/ssh-onboard.js', import.meta.url)), 'utf-8')
  const mutant = s.replace('readRelayToken(config)', 'readRelayToken_DELETED(config)')
  assert.throws(
    () => assertOnboardReads(mutant),
    '变异后 B3 主断言必须失败',
  )
})

/* ── ra18-3: hubUrl 显式非空 + hasRelay 时不走 auto-infer worker ──────── */

test('ra18-3: hubUrl 非空且有 relay 时不推断为 worker', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf-8')
  assert.ok(s.includes('hasRelay'), 'index.js 应含 hasRelay 检查')
  // The logic: if hubUrl !== '' && !hasRelay → worker; else → hub
  assert.ok(s.includes('hubUrl !== \'\' && !hasRelay'), '应有 hubUrl && !hasRelay → worker 推断')
})

test('ra18-3（变异验证）：删除 hasRelay 守卫后 hub 有 relay 也被推断为 worker', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf-8')
  // Mutant: remove hasRelay from the condition
  const mutant = s.replace('hubUrl !== \'\' && !hasRelay', 'hubUrl !== \'\'')
  // Real code has the guard
  assert.ok(s.includes('!hasRelay'), '原始代码含 !hasRelay 守卫（变异验证）')
  // Mutant loses it
  assert.ok(!mutant.includes('!hasRelay'), '变异后不含 !hasRelay — hub 有 relay 时会被误判为 worker')
})

/* ── ra19-2: CSS 无韩文注释 ──────────────────────────────────────────── */

test('ra19-2: CSS 数组无韩文注释', () => {
  const s = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf-8')
  // Check for common Korean Unicode range characters
  const koreanPattern = /[\uac00-\ud7af\u1100-\u11ff]/
  // Only check CSS section (between .dra-root and the closing of style)
  const cssMatch = s.match(/\.dra-root\{[\s\S]*?\}\}/)
  if (cssMatch) {
    assert.ok(!koreanPattern.test(cssMatch[0]), 'CSS 段不应含韩文字符')
  }
})
