import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildHeadlessArgs, HeadlessRunner, readDshCliVersion } from '../lib/node/runner.js'

for (const version of ['0.2.2-rc.1', '0.2.0', '0.3.0', '1.0.0', '2.0.0-rc.1']) {
  test(`buildHeadlessArgs：${version} 固定启动 headless 配置`, () => {
    assert.deepEqual(buildHeadlessArgs({ profile: 'web', version }), [
      '--profile', 'headless', '--json', '-',
    ])
  })
}

for (const version of ['0.1.5-rc.1', 'unknown', null, undefined, '0.2', '0.2.0oops']) {
  test(`buildHeadlessArgs：${String(version)} 保留旧版形式`, () => {
    assert.deepEqual(buildHeadlessArgs({ profile: 'web', version }), [
      '--profile', 'web', 'headless', '--json', '-',
    ])
  })
}

test('buildHeadlessArgs：旧版空配置名省略 --profile', () => {
  assert.deepEqual(buildHeadlessArgs({ profile: '', version: '0.1.5-rc.1' }), [
    'headless', '--json', '-',
  ])
})

test('buildHeadlessArgs：新版空配置名仍启动 headless', () => {
  assert.deepEqual(buildHeadlessArgs({ profile: '', version: '0.2.0' }), [
    '--profile', 'headless', '--json', '-',
  ])
})

test('buildHeadlessArgs：额外参数放在两种形式的末尾 - 之前，不修改输入', () => {
  const extraArgs = Object.freeze(['--verbose', '--label', 'two words'])
  assert.deepEqual(buildHeadlessArgs({ profile: 'web', version: '0.2.2-rc.1', extraArgs }), [
    '--profile', 'headless', '--json', '--verbose', '--label', 'two words', '-',
  ])
  assert.deepEqual(buildHeadlessArgs({ profile: 'web', version: '0.1.5-rc.1', extraArgs }), [
    '--profile', 'web', 'headless', '--json', '--verbose', '--label', 'two words', '-',
  ])
})

test('buildHeadlessArgs：含 --json、空格和换行的任务书不进入 argv', () => {
  const goal = 'reply OK --json with spaces\nand a second line'
  assert.deepEqual(buildHeadlessArgs({ profile: 'web', version: '0.2.2-rc.1', goal }), [
    '--profile', 'headless', '--json', '-',
  ])
  assert.deepEqual(buildHeadlessArgs({ profile: 'web', version: null, goal }), [
    '--profile', 'web', 'headless', '--json', '-',
  ])
})

function fakeDsh(t, output, exitCode = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-args-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'dsh')
  const calls = path.join(dir, 'calls')
  const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`
  fs.writeFileSync(bin, `#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = '--version' ] || exit 99
printf 'version\\n' >> ${shellQuote(calls)}
printf '%s' ${shellQuote(output)}
exit ${exitCode}
`, { mode: 0o755 })
  return { bin, calls }
}

test('版本探测：构造时捕获并裁剪 stdout，同一路径只探测一次', (t) => {
  const { bin, calls } = fakeDsh(t, '  0.2.2-rc.1\n')
  const first = new HeadlessRunner({ dshBin: bin, profile: 'web' })
  assert.equal(first.version, '0.2.2-rc.1')
  fs.writeFileSync(bin, 'invalid executable')
  const second = new HeadlessRunner({ dshBin: bin, profile: 'web' })
  assert.equal(second.version, '0.2.2-rc.1')
  assert.equal(readDshCliVersion(bin), '0.2.2-rc.1')
  assert.equal(fs.readFileSync(calls, 'utf8'), 'version\n')
  const other = fakeDsh(t, '0.1.5-rc.1\n')
  assert.equal(readDshCliVersion(other.bin), '0.1.5-rc.1')
})

test('版本探测：失败返回 null 并缓存，不使用失败进程的 stdout', (t) => {
  const { bin, calls } = fakeDsh(t, '0.2.2-rc.1\n', 1)
  assert.equal(readDshCliVersion(bin), null)
  assert.equal(readDshCliVersion(bin), null)
  assert.equal(fs.readFileSync(calls, 'utf8'), 'version\n')
})

test('版本探测：空 stdout 或可执行文件不存在时返回 null', (t) => {
  const { bin } = fakeDsh(t, ' \n')
  assert.equal(readDshCliVersion(bin), null)
  assert.equal(readDshCliVersion(path.join(path.dirname(bin), 'missing')), null)
})
