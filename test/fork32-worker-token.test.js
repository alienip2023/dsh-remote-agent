import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveToken } from '../lib/node/index.js'

const onboardPath = fileURLToPath(new URL('../lib/hub/ssh-onboard.js', import.meta.url))
const nodePath = fileURLToPath(new URL('../lib/node/index.js', import.meta.url))

const TOKEN_WRITE_LINE = '`  "token": "${enrollToken}",`'
const NODETOKEN_WRITE_LINE = '`  "nodeToken": "${enrollToken}",`'
const ENROLL_ASSIGN_LINE = "if (parsedTokens && typeof parsedTokens.enrollToken === 'string') enrollToken = parsedTokens.enrollToken"
const NODETOKEN_FALLBACK = "if (typeof c.nodeToken === 'string' && c.nodeToken.trim() !== '') return c.nodeToken.trim()"
const EMPTY_GUARD = "job.error = '无可用 enrollToken'"

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
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

function assertTokenWriteLine(source) {
  assert.ok(source.includes(TOKEN_WRITE_LINE), 'configure 必须写入 "token": enrollToken')
}

function assertEnrollAssignLine(source) {
  assert.ok(source.includes(ENROLL_ASSIGN_LINE), 'configure 必须从 tokens.json 赋值 enrollToken')
}

function configureBlock(source) {
  const start = source.indexOf("stepUpdate(job, 'configure', 'running'")
  assert.ok(start >= 0, 'configure 步骤必须存在')
  const end = source.indexOf("stepUpdate(job, 'configure', 'done'", start)
  assert.ok(end > start, 'configure done 必须在 running 之后')
  return source.slice(start, end)
}

test('T1: configure 写入 worker 实际使用的 token 字段', () => {
  const source = readFileSync(onboardPath, 'utf8')
  assertTokenWriteLine(source)
  assert.ok(source.includes(NODETOKEN_WRITE_LINE), 'nodeToken 仍写同一个 enrollToken，兼容旧读法')
  const cfgStart = source.indexOf('const configContent = [')
  const cfgEnd = source.indexOf('].join(', cfgStart)
  const cfg = source.slice(cfgStart, cfgEnd)
  assert.ok(!cfg.includes('hubToken'), 'hubToken 不得写进副机 config')
  assert.ok(!/rt_[A-Za-z0-9_-]{8,}/.test(cfg), '不得硬编码 hubToken')
  assert.ok(!/en_[A-Za-z0-9_-]{8,}/.test(cfg), '不得硬编码 enrollToken')
})

test('M1: 删掉 token 写入行后主断言必须红', () => {
  withDiskMutation(
    onboardPath,
    (source) => source.replace(TOKEN_WRITE_LINE, ''),
    assertTokenWriteLine,
  )
})

test('T2: config.token 为空时回退 config.nodeToken', () => {
  assert.equal(resolveToken({ nodeToken: 'static-enroll' }, ''), 'static-enroll')
  assert.equal(resolveToken({ token: '   ', nodeToken: 'static-enroll' }, ''), 'static-enroll')
  assert.equal(resolveToken({ token: 'cfg-token', nodeToken: 'other' }, ''), 'cfg-token')
  assert.equal(resolveToken({ nodeToken: '   ' }, ''), '')
})

test('M2: 删掉 resolveToken 的 nodeToken 回退后同一断言必须红', async () => {
  const original = readFileSync(nodePath)
  const originalSha = sha256(original)
  try {
    writeFileSync(nodePath, original.toString('utf8').replace(NODETOKEN_FALLBACK + '\n', ''))
    const href = pathToFileURL(nodePath).href + '?fork32m2=' + Date.now()
    const mod = await import(href)
    assert.throws(() => {
      assert.equal(mod.resolveToken({ nodeToken: 'static-enroll' }, ''), 'static-enroll')
    })
  } finally {
    writeFileSync(nodePath, original)
    assert.strictEqual(sha256(readFileSync(nodePath)), originalSha)
  }
})

test('T3: configure 用已有连接读 tokens.json 的静态 enrollToken', () => {
  const source = readFileSync(onboardPath, 'utf8')
  assertEnrollAssignLine(source)
  const block = configureBlock(source)
  assert.ok(block.includes('sftpOpen(conn)'), '必须复用已有 SSH 连接，不得新开 connect')
  assert.ok(!block.includes('await connect('), 'configure 不得新开 SSH 连接')
  assert.ok(block.includes('/.dsh-remote-agent-relay/tokens.json'), '必须读和 hubToken 同一条 tokens.json 路径')
  assert.ok(block.includes("tokenFile.replace(/^~(?=\\/)/, '/root')"), '路径改写必须和 hubToken 读取一致')
  const assignAt = block.indexOf(ENROLL_ASSIGN_LINE)
  const mintAt = block.indexOf('/api/relay/token')
  const guardAt = block.indexOf(EMPTY_GUARD)
  assert.ok(assignAt >= 0 && mintAt > assignAt, '铸造只能发生在静态 enrollToken 读取之后')
  assert.ok(guardAt > mintAt, '空 token 必须在写入前失败')
  assert.ok(block.includes('if (!enrollToken.trim())'), '静态码为空才允许铸造')
  for (const call of block.match(/stepUpdate\([\s\S]*?\)/g) || []) {
    assert.ok(!call.includes('${enrollToken}'), 'step 文案不得插入 token 明文')
    assert.ok(!call.includes('${rawTokens}'), 'step 文案不得插入 tokens.json 正文')
  }
})

test('M3: 删掉 tokens.json enrollToken 赋值后主断言必须红', () => {
  withDiskMutation(
    onboardPath,
    (source) => source.replace(ENROLL_ASSIGN_LINE, ''),
    assertEnrollAssignLine,
  )
})
