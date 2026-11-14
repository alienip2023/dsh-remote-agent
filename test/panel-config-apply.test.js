/**
 * 面板配置写盘契约（从 fork.36 合入 .80）。
 *
 * 只打一次性 DSH_HOME。currentPatchFile() 必须先解析到临时文件，
 * 否则直接抛错，不调用 /apply。正在用的 profile 只比修改时间。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { currentPatchFile, registerSetupRoutes } from '../lib/setup-routes.js'
import { readInstanceConfig } from '../lib/instance-config.js'
import { MANAGED_BEGIN, MANAGED_END } from '../lib/setup.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const LIVE = '/Users/kjclaw/Library/Application Support/dsh-desktop/harness/profiles/web/cordis.patch.yml'

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
  return { before: text.slice(0, i), after: text.slice(j + MANAGED_END.length) }
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
  const config = {
    role: 'hub',
    transportMode: 'relay',
    listenHost: '100.86.48.54',
    listenPort: 19387,
    relayUrl: 'ws://relay.example/relay',
    relay: { url: 'ws://relay.example/relay', token: 'rt_keep_me' },
    stateDir: path.join(home, 'state'),
  }
  registerSetupRoutes({
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => {}
      },
    },
  }, config, (level, msg, extra) => { logs.push({ level, msg, extra }) })
  return { routes, config }
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

async function apply(text, body, { remoteAddress = '127.0.0.1' } = {}) {
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
    const { routes, config } = mount(home, logs)
    const handler = routes.get('/api/remote-agent/setup/apply')
    assert.equal(typeof handler, 'function', '缺少 /apply')
    const res = await invoke(handler, { body, remoteAddress })
    return { res, file, logs, home, before: text, config }
  } finally {
    restoreEnv(prevHome, prevProfile)
  }
}

test('listenPort 越界拒绝，文件原样；0 表示关闭独立监听，必须能写入', async () => {
  const seed = initialPatch()
  for (const listenPort of [-1, 65536, '65536', 1.5]) {
    const { res, file } = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort })
    assert.equal(res.status, 400, `listenPort=${listenPort} 应 400，实际 ${res.status} ${res.raw}`)
    assert.equal(res.body.error, 'bad-listen-port')
    assert.equal(readFileSync(file, 'utf8'), seed, `listenPort=${listenPort} 不能写盘`)
  }
  const off = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort: 0 })
  assert.equal(off.res.status, 200, off.res.raw)
  const offText = readFileSync(off.file, 'utf8')
  assert.match(offText, /^    listenPort: 0$/m)
  assert.doesNotMatch(offText, /listenPort: 19387/)
  assertOutsideSame(seed, offText, 'listenPort 0')
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
  const saved = readInstanceConfig(dropped.config)
  assert.equal(saved.listenHost, undefined, '空字符串必须从 instance.json 清掉')
})

test('没传 listenPort 保留原值；空字符串不保留旧端口', async () => {
  const seed = initialPatch()
  const kept = await apply(seed, { role: 'worker', hubUrl: 'http://10.0.0.8:19387' })
  assert.equal(kept.res.status, 200, kept.res.raw)
  assert.match(readFileSync(kept.file, 'utf8'), /listenPort: 19387/)

  const dropped = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort: '' })
  assert.equal(dropped.res.status, 200, dropped.res.raw)
  const droppedText = readFileSync(dropped.file, 'utf8')
  const block = droppedText.slice(droppedText.indexOf(MANAGED_BEGIN), droppedText.indexOf(MANAGED_END))
  assert.doesNotMatch(block, /listenPort:/)
  assert.match(outside(droppedText).before, /note: listenPort: 1/)
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
  assert.equal(readFileSync(blocked.file, 'utf8'), seed, '409 不能写盘')

  const forced = await apply(seed, { role: 'hub', transportMode: 'relay', listenPort: 19400, force: true })
  assert.equal(forced.res.status, 200, forced.res.raw)
  assert.match(readFileSync(forced.file, 'utf8'), /listenPort: 19400/)
  assert.ok(forced.logs.some((l) => l.msg === 'setup applied'), 'force 覆盖必须记日志')
})

test('面板有监听字段的输入，提交时带上', () => {
  const start = CLIENT.indexOf('function SetupView')
  const end = CLIENT.indexOf('function Panel()', start)
  const view = CLIENT.slice(start, end)
  assert.match(view, /listenHost/)
  assert.match(view, /listenPort/)
  assert.match(view, /body\.listenHost = listenHost\.trim\(\)/)
  assert.match(view, /body\.listenPort = listenPort\.trim\(\)/)
})

test('正在用的 profile 没有被这个文件碰到', () => {
  if (existsSync(LIVE)) assert.equal(stamp(LIVE), liveBefore, '测试不得改正在用的 profile')
})
