/**
 * 面板配置写盘契约。
 *
 * 只打一次性 DSH_HOME。currentPatchFile() 必须先解析到临时文件，
 * 否则直接抛错，不调用 /apply。正在用的 profile 只比修改时间。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { currentPatchFile, registerSetupRoutes } from '../lib/setup-routes.js'
import { MANAGED_BEGIN, MANAGED_END } from '../lib/setup.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const LIVE = '/Users/kjclaw/Library/Application Support/dsh-desktop/harness/profiles/web/cordis.patch.yml'
const EVIDENCE = '/tmp/panel-config-1-evidence.txt'

function stamp(file) {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

const liveBefore = stamp(LIVE)

function outside(text) {
  const i = text.indexOf(MANAGED_BEGIN)
  const j = text.indexOf(MANAGED_END)
  assert.ok(i >= 0 && j > i, '托管标记必须成对')
  return {
    before: text.slice(0, i),
    after: text.slice(j + MANAGED_END.length),
  }
}

function assertOutsideSame(before, after, label) {
  const a = outside(before)
  const b = outside(after)
  assert.equal(b.before, a.before, `${label}: 托管块之前不能变`)
  assert.equal(b.after, a.after, `${label}: 托管块之后不能变`)
}

function initialPatch() {
  return [
    '# outside-head',
    'plugins:',
    '  - id: mcp-geelark',
    '    disabled: true',
    '    note: listenPort: 1',
    '',
    MANAGED_BEGIN,
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    "  inject: ['webServer', 'tools', 'systemPrompt']",
    '  config:',
    '    role: hub',
    '    nodeId: hub-1',
    '    transportMode: relay',
    "    relayUrl: 'ws://relay.example/relay'",
    "    hubUrl: 'http://192.168.1.10:19387'",
    "    listenHost: '100.86.48.54'",
    '    listenPort: 19387',
    "    nodeToken: 'nt_keep_me'",
    "    uiPullRoot: '/tmp/pull-keep'",
    '    relay:',
    "      url: 'ws://relay.example/relay'",
    "      token: 'rt_keep_me'",
    MANAGED_END,
    '# outside-tail keep this line',
    '',
  ].join('\n')
}

function handwrittenPatch() {
  return [
    '# outside-head',
    'plugins:',
    '  - id: mcp-geelark',
    '    disabled: true',
    '  - id: remote-agent',
    '    name: handwritten',
    '    config:',
    '      role: worker',
    '- id: keep-after',
    '  note: outside-tail',
    '',
  ].join('\n')
}

function restoreEnv(prevHome, prevProfile) {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  if (prevProfile === undefined) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = prevProfile
}

function makeHome(text) {
  const home = path.join(tmpdir(), `panel-config-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const file = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return { home, file }
}

function mount(home, logs) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => {}
      },
    },
  }
  const config = {
    role: 'hub',
    transportMode: 'relay',
    listenHost: '100.86.48.54',
    listenPort: 19387,
    relayUrl: 'ws://relay.example/relay',
    relay: { url: 'ws://relay.example/relay', token: 'rt_keep_me' },
    stateDir: path.join(home, 'state'),
  }
  registerSetupRoutes(ctx, config, (level, msg, extra) => {
    logs.push({ level, msg, extra })
  })
  return routes
}

function invoke(handler, { method = 'POST', body, remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = {
      method,
      headers: {},
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() {
        if (payload) yield payload
      },
    }
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(text) {
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 非 JSON 原样留下 */ }
        done({ status: this.status, body: parsed, raw: String(text ?? '') })
      },
    }
    Promise.resolve(handler(req, res)).then(() => {
      if (!settled) done({ status: res.status, body: null, raw: '' })
    }, reject)
  })
}

async function apply(text, body, { remoteAddress = '127.0.0.1', method = 'POST', pathName = '/api/remote-agent/setup/apply' } = {}) {
  const { home, file } = makeHome(text)
  const prevHome = process.env.DSH_HOME
  const prevProfile = process.env.DSH_PROFILE
  const logs = []
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'web'
  try {
    const resolved = currentPatchFile()
    assert.equal(resolved, file, '测试必须打到一次性 cordis.patch.yml')
    assert.ok(!resolved.includes('/Users/kjclaw/Library/Application Support/'), '拒绝写正在用的 profile')
    const routes = mount(home, logs)
    const handler = routes.get(pathName)
    assert.equal(typeof handler, 'function', `缺少路由 ${pathName}`)
    const res = await invoke(handler, { method, body, remoteAddress })
    return { res, file, logs, home, before: text }
  } finally {
    restoreEnv(prevHome, prevProfile)
  }
}

test('版本是 0.10.1-fork.35', () => {
  assert.equal(PKG.version, '0.10.1-fork.35')
})

test('listenPort 0 与 65536 拒绝，文件原样', async () => {
  const seed = initialPatch()
  for (const listenPort of [0, '0', 65536, '65536', 1.5, -1]) {
    const { res, file } = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort })
    assert.equal(res.status, 400, `listenPort=${listenPort} 应 400，实际 ${res.status} ${res.raw}`)
    assert.equal(res.body.error, 'bad-listen-port')
    assert.equal(readFileSync(file, 'utf8'), seed, `listenPort=${listenPort} 不能写盘`)
    assert.equal(readdirSync(path.dirname(file)).some((name) => name.includes('.bak-')), false)
  }
})

test('listenPort 1 与 65535 写入，块外不动', async () => {
  const seed = initialPatch()
  for (const listenPort of [1, '1', 65535, '65535']) {
    const { res, file, before } = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort })
    assert.equal(res.status, 200, res.raw)
    const text = readFileSync(file, 'utf8')
    assert.match(text, new RegExp(`^    listenPort: ${Number(listenPort)}$`, 'm'))
    assert.doesNotMatch(text, /listenPort: 19387/)
    assertOutsideSame(before, text, `listenPort ${listenPort}`)
  }
})

test('没传 listenHost 保留原值；空字符串表示自动，不保留旧值', async () => {
  const seed = initialPatch()
  const kept = await apply(seed, { role: 'hub', transportMode: 'direct', hubUrl: 'http://10.0.0.8:19387' })
  assert.equal(kept.res.status, 200, kept.res.raw)
  const keptText = readFileSync(kept.file, 'utf8')
  assert.match(keptText, /listenHost: '100\.86\.48\.54'/)
  assertOutsideSame(seed, keptText, '省略 listenHost')

  const dropped = await apply(seed, { role: 'hub', transportMode: 'relay', listenHost: '' })
  assert.equal(dropped.res.status, 200, dropped.res.raw)
  const droppedText = readFileSync(dropped.file, 'utf8')
  assert.doesNotMatch(droppedText, /listenHost:/)
  assert.match(droppedText, /listenPort: 19387/)
  assertOutsideSame(seed, droppedText, '空 listenHost')
})

test('没传 listenPort 保留原值；空字符串不保留旧端口', async () => {
  const seed = initialPatch()
  const kept = await apply(seed, { role: 'worker', hubUrl: 'http://10.0.0.8:19387' })
  assert.equal(kept.res.status, 200, kept.res.raw)
  const keptText = readFileSync(kept.file, 'utf8')
  assert.match(keptText, /listenPort: 19387/)
  assertOutsideSame(seed, keptText, '省略 listenPort')

  const dropped = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort: '' })
  assert.equal(dropped.res.status, 200, dropped.res.raw)
  const droppedText = readFileSync(dropped.file, 'utf8')
  const droppedBlock = outside(droppedText)
  assert.doesNotMatch(droppedText.slice(droppedText.indexOf(MANAGED_BEGIN), droppedText.indexOf(MANAGED_END)), /listenPort:/)
  assert.match(droppedBlock.before, /note: listenPort: 1/)
  assert.match(droppedText, /listenHost: '100\.86\.48\.54'/)
  assertOutsideSame(seed, droppedText, '空 listenPort')
})

test('/apply 只接受白名单，注入字段写不进去', async () => {
  const seed = initialPatch()
  const { res, file, before } = await apply(seed, {
    role: 'hub',
    transportMode: 'relay',
    listenHost: '10.0.0.8',
    listenPort: 19400,
    pwned: 'yes\n    evil: true\n  - id: injected',
    nodeToken: 'nt_attacker',
    uiPullRoot: '/tmp/should-not-replace',
  })
  assert.equal(res.status, 200, res.raw)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /listenHost: '10\.0\.0\.8'/)
  assert.match(text, /listenPort: 19400/)
  assert.match(text, /nodeToken: 'nt_keep_me'/)
  assert.match(text, /uiPullRoot: '\/tmp\/pull-keep'/)
  assert.doesNotMatch(text, /pwned|evil: true|id: injected|nt_attacker|should-not-replace/)
  assertOutsideSame(before, text, '白名单')
})

test('不传 relayUrl 和 hubToken 仍 200，旧中继保留', async () => {
  const seed = initialPatch()
  const { res, file, before } = await apply(seed, { role: 'hub', transportMode: 'relay' })
  assert.equal(res.status, 200, res.raw)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /relayUrl: 'ws:\/\/relay\.example\/relay'/)
  assert.match(text, /token: 'rt_keep_me'/)
  assertOutsideSame(before, text, '省略中继字段')
})

test('手写冲突 409；force 才覆盖并记日志', async () => {
  const seed = handwrittenPatch()
  const blocked = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort: 19400 })
  assert.equal(blocked.res.status, 409, blocked.res.raw)
  assert.equal(blocked.res.body.error, 'handwritten-conflict')
  assert.equal(readFileSync(blocked.file, 'utf8'), seed)
  assert.equal(blocked.logs.some((row) => row.msg === 'setup applied'), false)

  const forced = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort: 19400, force: true })
  assert.equal(forced.res.status, 200, forced.res.raw)
  const text = readFileSync(forced.file, 'utf8')
  assert.match(text, /listenPort: 19400/)
  assert.match(text, new RegExp(MANAGED_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, /mcp-geelark/)
  assert.match(text, /outside-head/)
  assert.match(text, /id: keep-after/)
  assert.match(text, /note: outside-tail/)
  assert.doesNotMatch(text, /name: handwritten/)
  const applied = forced.logs.find((row) => row.msg === 'setup applied')
  assert.ok(applied, `缺少 setup applied 日志 ${JSON.stringify(forced.logs)}`)
  writeFileSync(EVIDENCE, [
    '# 409 force',
    JSON.stringify({ status: forced.res.status, body: forced.res.body, log: applied }, null, 2),
    '',
  ].join('\n'))
})

test('relay 改 direct 再改回 relay，git diff 只有托管块', async () => {
  const seed = initialPatch()
  const { home, file } = makeHome(seed)
  const prevHome = process.env.DSH_HOME
  const prevProfile = process.env.DSH_PROFILE
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'web'
  const logs = []
  try {
    assert.equal(currentPatchFile(), file)
    execFileSync('git', ['init'], { cwd: home })
    execFileSync('git', ['add', 'profiles/web/cordis.patch.yml'], { cwd: home })
    execFileSync('git', ['-c', 'user.email=panel-config@example.invalid', '-c', 'user.name=panel-config', 'commit', '-m', 'seed'], { cwd: home })
    const routes = mount(home, logs)
    const handler = routes.get('/api/remote-agent/setup/apply')

    const direct = await invoke(handler, {
      body: { role: 'hub', transportMode: 'direct', hubUrl: 'http://10.0.0.8:19387' },
    })
    assert.equal(direct.status, 200, direct.raw)
    const afterDirect = readFileSync(file, 'utf8')
    assertOutsideSame(seed, afterDirect, 'relay 到 direct')
    assert.match(afterDirect, /transportMode: direct/)
    assert.match(afterDirect, /listenHost: '100\.86\.48\.54'/)
    assert.match(afterDirect, /listenPort: 19387/)
    const diffDirect = execFileSync('git', ['diff', '--', 'profiles/web/cordis.patch.yml'], { cwd: home, encoding: 'utf8' })
    assertOnlyManagedDiff(diffDirect, 'direct')

    const back = await invoke(handler, {
      body: { role: 'hub', transportMode: 'relay', listenPort: '19400' },
    })
    assert.equal(back.status, 200, back.raw)
    const afterRelay = readFileSync(file, 'utf8')
    assertOutsideSame(seed, afterRelay, 'direct 回到 relay')
    assert.match(afterRelay, /transportMode: relay/)
    assert.match(afterRelay, /listenPort: 19400/)
    assert.match(afterRelay, /listenHost: '100\.86\.48\.54'/)
    assert.match(afterRelay, /token: 'rt_keep_me'/)
    assert.match(afterRelay, /relayUrl: 'ws:\/\/relay\.example\/relay'/)
    const diffRelay = execFileSync('git', ['diff', '--', 'profiles/web/cordis.patch.yml'], { cwd: home, encoding: 'utf8' })
    assertOnlyManagedDiff(diffRelay, 'relay')

    const prev = existsSync(EVIDENCE) ? readFileSync(EVIDENCE, 'utf8') : ''
    writeFileSync(EVIDENCE, [
      prev,
      '# git diff relay to direct',
      diffDirect,
      '# git diff back to relay with listenPort 19400, relayUrl/hubToken omitted',
      diffRelay,
      '# yml after round trip',
      afterRelay,
      '',
    ].join('\n'))
  } finally {
    restoreEnv(prevHome, prevProfile)
  }
})

function assertOnlyManagedDiff(diff, label) {
  const changed = diff.split('\n').filter((line) => /^[+-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---'))
  assert.ok(changed.length > 0, `${label} 应有托管块差异`)
  for (const line of changed) {
    assert.doesNotMatch(line, /outside-head|outside-tail|mcp-geelark|disabled: true/, `${label} 块外进了 diff: ${line}`)
  }
}

test('/state 回环才回 hubToken 明文，并预填监听字段', async () => {
  const { res, file } = await apply(initialPatch(), undefined, {
    method: 'GET',
    pathName: '/api/remote-agent/setup/state',
  })
  assert.equal(res.status, 200, res.raw)
  assert.equal(res.body.current.hubToken, 'rt_keep_me')
  assert.equal(res.body.current.relayUrl, 'ws://relay.example/relay')
  assert.equal(res.body.current.listenHost, '100.86.48.54')
  assert.equal(res.body.current.listenPort, 19387)
  assert.equal(readFileSync(file, 'utf8'), initialPatch())

  const remote = await apply(initialPatch(), undefined, {
    method: 'GET',
    pathName: '/api/remote-agent/setup/state',
    remoteAddress: '10.9.9.9',
  })
  assert.equal(remote.res.status, 200, remote.res.raw)
  assert.equal(remote.res.body.current.hubToken, '')
  assert.equal(remote.res.body.current.tokenSet, true)
  assert.equal(remote.res.body.current.relayUrl, 'ws://relay.example/relay')
})

test('配置页只有一处保存，预填完成前不挂表单', () => {
  assert.equal((CLIENT.match(/fetch\(SETUP_APPLY_PATH/g) || []).length, 1)
  assert.match(CLIENT, /重启后复检/)
  assert.ok((CLIENT.match(/强制覆盖/g) || []).length >= 3)
  assert.match(CLIENT, /setup: null, setupLoadError: ''/)
  assert.match(CLIENT, /if \(!state\.setup\)/)
  const code = CLIENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const i = code.indexOf('function SetupView(')
  assert.ok(i >= 0)
  const seg = code.slice(i, i + 20000)
  assert.ok(seg.includes('我是主机'))
  assert.match(seg, /fetch\(SETUP_APPLY_PATH/)
  assert.match(seg, /body\.listenHost = listenHost\.trim\(\)/)
  assert.match(seg, /body\.listenPort = listenPort\.trim\(\)/)
})

test('正在用的 profile 没有被这个文件碰到', () => {
  assert.equal(stamp(LIVE), liveBefore)
})
