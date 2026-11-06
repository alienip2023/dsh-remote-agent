import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const onboardPath = fileURLToPath(new URL('../lib/hub/ssh-onboard.js', import.meta.url))
const routesPath = fileURLToPath(new URL('../lib/hub/ui-routes.js', import.meta.url))

const HUB_TOKEN_LINE = "if (parsed && typeof parsed.hubToken === 'string') relayHubToken = parsed.hubToken"
const BODY_AUTO = 'body.autoHubToken'
// comment L1447 + two uses on L1449
const BODY_AUTO_COUNT = 3

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function assertHubTokenAssignLine(source) {
  assert.ok(source.includes(HUB_TOKEN_LINE), 'ssh-onboard.js 必须保留整行: ' + HUB_TOKEN_LINE)
}

function assertBodyAutoHubToken(source) {
  const n = source.split(BODY_AUTO).length - 1
  assert.ok(source.includes(BODY_AUTO), 'ui-routes.js 必须保留 body.autoHubToken')
  assert.strictEqual(n, BODY_AUTO_COUNT, 'ui-routes.js 的 body.autoHubToken 必须仍在')
}

function withDiskMutation(filePath, mutate, predicate) {
  const original = readFileSync(filePath)
  const originalSha = sha256(original)
  try {
    writeFileSync(filePath, mutate(original.toString('utf8')))
    const reread = readFileSync(filePath, 'utf8')
    assert.throws(() => predicate(reread))
  } finally {
    writeFileSync(filePath, original)
    const restored = readFileSync(filePath)
    assert.strictEqual(sha256(restored), originalSha)
  }
}

function mutateLine232(source) {
  const nl = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  lines[231] = '// MUTATION'
  return lines.join(nl)
}

function mutateBodyAuto(source) {
  return source.replaceAll(BODY_AUTO, 'body.DELETED')
}

const SRC = readFileSync(clientPath, 'utf8')
const ONBOARD = readFileSync(onboardPath, 'utf8')

test('T1: probeHost 返回 relayHubToken 字段', () => {
  assert.ok(ONBOARD.includes('relayHubToken'), 'ssh-onboard.js 必须包含 relayHubToken')
})

test('T2: sftpReadFile 辅助函数存在', () => {
  assert.ok(ONBOARD.includes('function sftpReadFile('), 'ssh-onboard.js 必须有 sftpReadFile 函数')
})

test('T3: probe 阶段保留 hubToken 赋值行', () => {
  assertHubTokenAssignLine(readFileSync(onboardPath, 'utf8'))
})

test('T4: relay-autoconfig 保留 body.autoHubToken', () => {
  assertBodyAutoHubToken(readFileSync(routesPath, 'utf8'))
})

test('T5: client.js 把 autoHubToken 传给 relay-autoconfig', () => {
  const fnIdx = SRC.indexOf('function autoConfigRelayFromProbe(')
  assert.ok(fnIdx >= 0)
  const fnBlock = SRC.slice(fnIdx, fnIdx + 900)
  assert.ok(fnBlock.includes('autoHubToken'), '函数必须传递 autoHubToken 字段')
  assert.ok(fnBlock.includes('relayHubToken'), '函数必须从 relayHost.relayHubToken 取值')
})

test('M1 变异：ssh-onboard.js:232 换成 // MUTATION 后 T3 主断言必须红', () => {
  withDiskMutation(onboardPath, mutateLine232, assertHubTokenAssignLine)
})

test('M2 变异：body.autoHubToken 换成 body.DELETED 后 T4 主断言必须红', () => {
  withDiskMutation(routesPath, mutateBodyAuto, assertBodyAutoHubToken)
})
