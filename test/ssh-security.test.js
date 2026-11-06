import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC_PATH = fileURLToPath(new URL('../lib/hub/ssh-onboard.js', import.meta.url))
function src() { return readFileSync(SRC_PATH, 'utf-8') }

test('落盘安全：nodeToken 行直接用 enrollToken，不经 maskSecret', () => {
  const s = src()
  // Find the nodeToken config write line
  const match = s.match(/nodeToken.*\$\{([^}]+)\}/)
  assert.ok(match, '应有 nodeToken 配置行含模板插值')
  const expr = match[1]
  assert.ok(!expr.includes('maskSecret'), `nodeToken 不得经 maskSecret，实际: ${expr}`)
  assert.equal(expr.trim(), 'enrollToken', `nodeToken 应直接用 enrollToken，实际: ${expr}`)
})

test('落盘安全：nodeToken 配置行不含三星打码 ***', () => {
  const s = src()
  const lines = s.split('\n')
  const line = lines.find((l) => l.includes('nodeToken') && l.includes('enrollToken'))
  assert.ok(line, '应找到 nodeToken enrollToken 行')
  assert.ok(!line.includes('maskSecret'), `行不得含 maskSecret`)
  assert.ok(!line.includes('***'), `行不得含 ***`)
})

test('落盘安全（变异验证）：引入 maskSecret(enrollToken) 时本测试红', () => {
  const s = src()
  // Original must NOT contain maskSecret(enrollToken) in the write path
  assert.ok(!s.includes('maskSecret(enrollToken)'),
    '原始文件不应含 maskSecret(enrollToken) — 若此断言失败，说明有人把打码写回了落盘路径')
})

test('keyPath 错误信息不泄露路径', () => {
  const s = src()
  const line = s.split('\n').find((l) => l.includes('无法读取密钥文件'))
  assert.ok(line, '应有密钥文件错误行')
  assert.ok(!line.includes('auth.keyPath'), `错误行不得含 auth.keyPath，实际: ${line.trim()}`)
})

test('无中继配置时 startDeploy 提前失败（alias 不存在路径）', async () => {
  const { startDeploy, getDeployJob } = await import('../lib/hub/ssh-onboard.js')
  const jobId = startDeploy({
    alias: '__relay_test_nonexistent__',
    config: { relayUrl: '', relayToken: '' },
    registry: null,
  })
  await new Promise((r) => setTimeout(r, 300))
  const job = getDeployJob(jobId)
  assert.equal(job.status, 'failed')
})
