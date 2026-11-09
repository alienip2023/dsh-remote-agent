/**
 * P1b-2 前置收尾（验收官 R2/R3/R4 三条）：
 *   1. scheduleRestart 在没有 systemctl 的节点上不得拖垮进程；非 systemd 回执 restartMode:'manual'
 *   2. credentials 临时文件建出来就是 0600（不是先 0644 再 chmod）
 *   3. 手写条目与 ref 同一条所有权规则：首次接管 → 原文另存 + 回执 adoptedEntries；撤销时不删
 * 全部行为断言：真实 handleConfigPush / 真实文件 / 真实子进程。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { handleConfigPush } from '../lib/node/config-sync.js'

const KEY = 'sk-deepseek-SECRET-0123456789'

function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'cfg-prestage-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir, cred: join(dshHome, '.credentials.yaml'), patch: join(profileDir, 'cordis.patch.yml'), state: join(dshHome, 'config-sync.json'), bak: join(dshHome, 'config-sync.bak') }
}
const deepseek = () => ({
  entryId: 'llm-deepseek', config: { thinking: 'enabled', reasoningEffort: 'high', models: [{ id: 'deepseek-flash', name: 'Flash', contextWindow: 1000000 }] },
  credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: KEY }],
})
const v2 = (revision, { plugins = [deepseek()], providers = [] } = {}) => ({ schema: 2, revision, providers, plugins, cliExpect: [] })
function push(home, data, extra = {}) {
  const acks = []
  const restarts = []
  const result = handleConfigPush({
    data, dshHome: home.dshHome, profileDir: home.profileDir,
    send: (type, d) => acks.push(d), logger() {}, _restartFn: (...a) => restarts.push(a), ...extra,
  })
  return { result, acks, restarts }
}

describe('R2: restart on a node without systemctl', () => {
  test('P1b1b-spawn-enoent: scheduleRestart where systemctl does not exist must not kill the process (a real child, empty PATH)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-systemctl-'))
    try {
      const mod = pathToFileURL(join(import.meta.dirname, '../lib/node/config-sync.js')).href
      const script = `import { scheduleRestart } from ${JSON.stringify(mod)}
        const logs = []
        scheduleRestart(0, (level, msg, meta) => logs.push([level, msg, meta?.code ?? null]))
        setTimeout(() => { console.log(JSON.stringify(logs)); process.exit(0) }, 600)`
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: empty }, encoding: 'utf-8', timeout: 15000 })
      assert.equal(r.status, 0, `the node process must survive; stderr: ${r.stderr.slice(0, 300)}`)
      const logs = JSON.parse(r.stdout.trim().split('\n').at(-1))
      assert.ok(logs.some(([level, msg, code]) => level === 'warn' && /restart not possible/.test(msg) && code === 'ENOENT'), JSON.stringify(logs))
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })

  describe('restartMode in the receipt', () => {
    let home
    beforeEach(() => { home = makeHome() })
    afterEach(() => rmSync(home.base, { recursive: true, force: true }))

    test('P1b1b-manual: a node that is not under systemd reports shouldRestart:true, restartMode:manual and does NOT try to restart', () => {
      const { result, acks, restarts } = push(home, v2(1), { _systemd: false })
      assert.equal(result.ok, true)
      assert.equal(acks[0].shouldRestart, true)
      assert.equal(acks[0].restartMode, 'manual')
      assert.equal(restarts.length, 0, 'no restart attempt on a node that cannot do it')
      assert.match(readFileSync(home.patch, 'utf-8'), /- id: llm-deepseek/, 'the config is still applied')
    })

    test('P1b1b-systemd: under systemd the receipt says so and the restart is scheduled once, 300ms out', () => {
      const { acks, restarts } = push(home, v2(1), { _systemd: true })
      assert.equal(acks[0].restartMode, 'systemd')
      assert.deepEqual(restarts.map(a => a[0]), [300])
    })

    test('P1b1b-no-restart-no-mode: when nothing needs a restart the receipt carries no restartMode', () => {
      push(home, v2(1), { _systemd: false })
      const second = push(home, v2(2), { _systemd: false })
      assert.equal(second.acks[0].shouldRestart, false)
      assert.equal('restartMode' in second.acks[0], false)
    })
  })
})

describe('R3: credentials are created with 0600', () => {
  test('P1b1b-mode-at-create: the key file is 0600 even when chmod is unavailable (the file is created with the mode, not fixed afterwards)', () => {
    const home = makeHome()
    const realChmod = fs.chmodSync
    const oldUmask = process.umask(0o022)
    fs.chmodSync = () => {}
    syncBuiltinESMExports()
    try {
      const { result } = push(home, v2(1))
      assert.equal(result.ok, true)
      assert.equal(statSync(home.cred).mode & 0o777, 0o600, 'with a 022 umask a default-mode create would leave 0644 here')
    } finally {
      fs.chmodSync = realChmod
      syncBuiltinESMExports()
      process.umask(oldUmask)
      rmSync(home.base, { recursive: true, force: true })
    }
  })
})

describe('R4: a hand-written entry is not the hub\'s to delete', () => {
  let home
  const HAND = [
    '- id: remote-agent',
    '  name: "@x/remote-agent"',
    '',
    '- id: llm-deepseek',
    '  name: "@deepseek-ai/dsh-llm-deepseek-api-key"',
    '  config:',
    '    reasoningEffort: low',
    '',
    '- id: permission',
    '  config:',
    '    mode: "ask"',
    '',
  ].join('\n')
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('P1b1b-adopt: first push over a hand-written llm-deepseek replaces it, saves the original (0600) and says so in the receipt', () => {
    writeFileSync(home.patch, HAND)
    const { result, acks } = push(home, v2(1), { _systemd: true })
    assert.equal(result.ok, true)
    assert.deepEqual(acks[0].adoptedEntries, ['llm-deepseek'])
    assert.match(readFileSync(home.patch, 'utf-8'), /thinking: "enabled"/, 'replaced with the hub\'s content')
    assert.equal(readFileSync(home.patch, 'utf-8').includes('reasoningEffort: low'), false)
    const saved = join(home.bak, 'adopted-llm-deepseek.yml')
    assert.equal(readFileSync(saved, 'utf-8'), '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek-api-key"\n  config:\n    reasoningEffort: low\n')
    assert.equal(statSync(saved).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(home.state, 'utf-8')).ownedEntries, [], 'an adopted entry is not owned')
  })

  test('P1b1b-adopt-revoke: the hub drops the plugin → the adopted entry stays (it was the node\'s), neighbours intact; the ref the hub created is deleted', () => {
    writeFileSync(home.patch, HAND)
    push(home, v2(1))
    const { result } = push(home, v2(2, { plugins: [] }))
    assert.equal(result.ok, true)
    const patch = readFileSync(home.patch, 'utf-8')
    assert.match(patch, /- id: llm-deepseek/, 'a hand-written entry is never deleted by a revocation')
    assert.match(patch, /- id: permission\n {2}config:\n {4}mode: "ask"/)
    assert.match(patch, /- id: remote-agent/)
    assert.equal(/DEEPSEEK_API_KEY:/.test(readFileSync(home.cred, 'utf-8')), false, 'refs keep their own ownership: the one this push created is removed')
  })

  test('P1b1b-adopt-stable: pushing again while the adopted entry is still there does not turn it into an owned one, and no second "adopted" notice is raised for an owned entry', () => {
    writeFileSync(home.patch, HAND)
    push(home, v2(1))
    const again = push(home, { ...v2(2), plugins: [{ ...deepseek(), config: { thinking: 'disabled', reasoningEffort: 'off' } }] })
    assert.equal(again.result.ok, true)
    assert.deepEqual(JSON.parse(readFileSync(home.state, 'utf-8')).ownedEntries, [])
  })

  test('P1b1b-created-owned: an entry the hub itself created is owned, has no adopted notice and is removed on revoke', () => {
    writeFileSync(home.patch, '- id: permission\n  config:\n    mode: "ask"\n')
    const first = push(home, v2(1))
    assert.equal('adoptedEntries' in first.acks[0], false)
    assert.deepEqual(JSON.parse(readFileSync(home.state, 'utf-8')).ownedEntries, ['llm-deepseek'])
    push(home, v2(2, { plugins: [] }))
    assert.equal(/llm-deepseek/.test(readFileSync(home.patch, 'utf-8')), false)
    assert.equal(existsSync(join(home.bak, 'adopted-llm-deepseek.yml')), false, 'nothing was adopted, nothing was saved')
  })
})
