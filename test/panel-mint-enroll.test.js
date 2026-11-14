/**
 * 面板当场铸造入网口令（从 fork.36 合入 .80）。
 *
 * 假 relay 只听本机随机端口。断言响应体不含 hubToken。
 * Hub 模式 relayUrl 走一次性 DSH_HOME 的 /apply，不写正在用的 profile。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { registerUiRoutes, UI_API_PREFIX } from '../lib/hub/ui-routes.js'
import { currentPatchFile, registerSetupRoutes } from '../lib/setup-routes.js'
import { MANAGED_BEGIN, MANAGED_END } from '../lib/setup.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const HUB_TOKEN = 'hub-secret-do-not-leak'
const MINT_PATH = `${UI_API_PREFIX}/mint-enroll`

function sliceFn(src, name, next) {
  const start = src.indexOf(`function ${name}`)
  assert.ok(start >= 0, `缺少 function ${name}`)
  const end = src.indexOf(`function ${next}`, start + 1)
  assert.ok(end > start, `${name} 后面应该是 ${next}`)
  return src.slice(start, end)
}

function mountUi(config) {
  const routes = new Map()
  registerUiRoutes({
    ctx: {
      webServer: {
        register(spec) {
          routes.set(spec.path, spec.handler)
          return () => {}
        },
      },
    },
    registry: { list() { return [] }, listTasks() { return [] } },
    pulls: {},
    log() {},
    config,
    uiTemplatesFile: path.join(tmpdir(), `mint-tpl-${process.pid}-${Date.now()}.json`),
  })
  return routes
}

function invoke(handler, { method = 'POST', body = {}, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
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
      url: MINT_PATH,
      headers,
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

function startFakeRelay(onRequest) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json = {}
        try { json = raw ? JSON.parse(raw) : {} } catch { json = {} }
        onRequest(req, res, json)
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
    server.on('error', reject)
  })
}

function relayConfig(port, extra = {}) {
  return {
    role: 'hub',
    transportMode: 'relay',
    relay: { url: `ws://127.0.0.1:${port}/relay`, token: HUB_TOKEN },
    ...extra,
  }
}

test('mint 成功：假 relay 返回 token，响应不含 hubToken', async () => {
  let seen = null
  const relay = await startFakeRelay((req, res, json) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seen = { path: url.pathname, token: url.searchParams.get('token'), nodeId: json.nodeId }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'enr_once', expiresInMs: 900000, echoed: HUB_TOKEN }))
  })
  try {
    const { port } = relay.address()
    const handler = mountUi(relayConfig(port)).get(MINT_PATH)
    assert.equal(typeof handler, 'function', `缺少路由 ${MINT_PATH}`)
    const res = await invoke(handler, { body: { nodeId: 'worker-a' } })
    assert.equal(res.status, 200, res.raw)
    assert.deepEqual(res.body, { token: 'enr_once', expiresInMs: 900000 })
    assert.equal(res.raw.includes(HUB_TOKEN), false, '响应体不得含 hubToken')
    assert.equal(seen.path, '/api/relay/token')
    assert.equal(seen.token, HUB_TOKEN, '出站必须带 config.relay.token')
    assert.equal(seen.nodeId, 'worker-a')
  } finally {
    await new Promise((resolve) => relay.close(resolve))
  }
})

test('relay 403：中文 code，不含 hubToken，不回裸栈', async () => {
  const relay = await startFakeRelay((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'forbidden', token: HUB_TOKEN, stack: 'Error: at relay.js:1' }))
  })
  try {
    const { port } = relay.address()
    const handler = mountUi(relayConfig(port)).get(MINT_PATH)
    const res = await invoke(handler, { body: {} })
    assert.equal(res.status, 403, res.raw)
    assert.equal(res.body.error, 'relay-forbidden')
    assert.match(res.body.message, /口令过期或错误/)
    assert.equal(res.raw.includes(HUB_TOKEN), false)
    assert.equal(res.raw.includes('at relay.js'), false)
  } finally {
    await new Promise((resolve) => relay.close(resolve))
  }
})

test('relay 不可达：中文 code，不抛 500 裸栈', async () => {
  const handler = mountUi(relayConfig(1)).get(MINT_PATH)
  const res = await invoke(handler, { body: {} })
  assert.equal(res.status, 502, res.raw)
  assert.equal(res.body.error, 'relay-unreachable')
  assert.match(res.body.message, /中继不可达/)
  assert.equal(res.raw.includes(HUB_TOKEN), false)
  assert.equal(/\n\s+at /.test(res.raw), false, res.raw)
})

test('direct 模式但地址和口令齐备：铸造成功，响应只含 token 与 expiresInMs', async () => {
  let seen = null
  const relay = await startFakeRelay((req, res, json) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seen = { path: url.pathname, token: url.searchParams.get('token'), nodeId: json.nodeId }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'enr_direct', expiresInMs: 900000, echoed: HUB_TOKEN }))
  })
  try {
    const { port } = relay.address()
    const handler = mountUi(relayConfig(port, { transportMode: 'direct' })).get(MINT_PATH)
    const res = await invoke(handler, { body: { nodeId: 'worker-direct' } })
    assert.equal(res.status, 200, res.raw)
    assert.deepEqual(Object.keys(res.body).sort(), ['expiresInMs', 'token'])
    assert.deepEqual(res.body, { token: 'enr_direct', expiresInMs: 900000 })
    assert.equal(res.raw.includes(HUB_TOKEN), false, '响应体不得含 hubToken')
    assert.equal(seen.path, '/api/relay/token')
    assert.equal(seen.token, HUB_TOKEN)
    assert.equal(seen.nodeId, 'worker-direct')
  } finally {
    await new Promise((resolve) => relay.close(resolve))
  }
})

test('缺口令：400 no-relay-token，不打中继，不回显 hubToken', async () => {
  let hits = 0
  const relay = await startFakeRelay((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'should-not-run', expiresInMs: 1 }))
  })
  try {
    const { port } = relay.address()
    const config = relayConfig(port, { transportMode: 'direct' })
    config.relay = { url: config.relay.url, token: '' }
    const handler = mountUi(config).get(MINT_PATH)
    const res = await invoke(handler, { body: {} })
    assert.equal(res.status, 400, res.raw)
    assert.equal(res.body.error, 'no-relay-token')
    assert.equal(res.raw.includes(HUB_TOKEN), false)
    assert.equal(hits, 0)
  } finally {
    await new Promise((resolve) => relay.close(resolve))
  }
})

test('缺地址：400 no-relay-url，不打中继', async () => {
  let hits = 0
  const relay = await startFakeRelay((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'should-not-run', expiresInMs: 1 }))
  })
  try {
    const { port } = relay.address()
    const config = relayConfig(port, { transportMode: 'direct' })
    config.relay = { url: '', token: HUB_TOKEN }
    const handler = mountUi(config).get(MINT_PATH)
    const res = await invoke(handler, { body: {} })
    assert.equal(res.status, 400, res.raw)
    assert.equal(res.body.error, 'no-relay-url')
    assert.equal(res.raw.includes(HUB_TOKEN), false)
    assert.equal(hits, 0)
  } finally {
    await new Promise((resolve) => relay.close(resolve))
  }
})

test('跨站请求被守卫拦住，且不打中继', async () => {
  let hits = 0
  const relay = await startFakeRelay((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'should-not-run', expiresInMs: 1 }))
  })
  try {
    const { port } = relay.address()
    const handler = mountUi(relayConfig(port)).get(MINT_PATH)
    const res = await invoke(handler, { body: {}, headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(res.status, 403, res.raw)
    assert.equal(res.body.error, 'forbidden')
    assert.equal(hits, 0, '守卫必须先于铸造')
    assert.equal(res.raw.includes(HUB_TOKEN), false)
  } finally {
    await new Promise((resolve) => relay.close(resolve))
  }
})

test('面板走 /mint-enroll，只显示一次口令，不回显 hubToken', () => {
  const enroll = sliceFn(CLIENT, 'EnrollPanel(props)', 'EnvPanel(props)')
  assert.match(enroll, /\+ 添加副机/)
  assert.match(enroll, /15 分钟内有效，仅显示这一次/)
  assert.equal(enroll.includes('hubToken'), false)
  const mint = sliceFn(CLIENT, 'mintEnroll()', 'previewFix()')
  assert.match(mint, /\/mint-enroll/)
  assert.equal(mint.includes('/relay-enroll'), false, '面板不得再打旧的 /relay-enroll')
})

test('Hub 模式提交 relayUrl 后 /apply 落盘', async () => {
  const start = CLIENT.indexOf('function submit(kind, opts)')
  const end = CLIENT.indexOf('const submitHub', start)
  const submit = CLIENT.slice(start, end)
  assert.match(submit, /body\.relayUrl = relayUrl\.trim\(\)/)
  assert.equal(submit.includes("use !== 'hub'"), false, 'Hub 表单不得跳过 relayUrl')

  const home = path.join(tmpdir(), `mint-apply-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const file = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, [
    '# outside-head', MANAGED_BEGIN, '- id: remote-agent', '  config:',
    '    role: hub', '    transportMode: relay', MANAGED_END, '# outside-tail', '',
  ].join('\n'))
  const prevHome = process.env.DSH_HOME
  const prevProfile = process.env.DSH_PROFILE
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'web'
  try {
    assert.equal(currentPatchFile(), file)
    assert.equal(file.includes('/Users/kjclaw/Library/Application Support/'), false)
    const routes = new Map()
    registerSetupRoutes({
      webServer: {
        register(spec) { routes.set(spec.path, spec.handler); return () => {} },
      },
    }, { role: 'hub', transportMode: 'relay', stateDir: path.join(home, 'state') }, () => {})
    const wanted = 'ws://203.0.113.10:8890/relay'
    const res = await invoke(routes.get('/api/remote-agent/setup/apply'), {
      body: { role: 'hub', transportMode: 'relay', relayUrl: wanted },
    })
    assert.equal(res.status, 200, res.raw)
    const written = readFileSync(file, 'utf8')
    assert.match(written, /relayUrl: 'ws:\/\/203\.0\.113\.10:8890\/relay'/)
    assert.equal(written.includes(HUB_TOKEN), false)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = prevProfile
  }
})
