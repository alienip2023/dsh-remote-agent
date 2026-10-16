/**
 * UI 控制路由的回归测试（安全边界 + 全链路）。
 *
 * 组成是**真实实现**，没有替身 lib：
 *   主机侧：真 http server + 真 applyHub（NodeRegistry + PullManager + UI 路由）
 *   副机侧：真 applyWorker（TaskStore + ArtifactService + TaskEngine + NodeTransport）
 *   中间： 真 relay（lib/relay.js）
 *
 * 刻意不 mock lib：UI 路由的安全结论建立在"真实 webServer 注册语义 +
 * 真实 pull 链路"之上，用替身测出来的"通过"没有意义。
 *
 * ── 两条测试基建约束（踩过坑，别改）──
 *
 * 【1】不用全局 fetch()。undici 的 keep-alive 连接池会让 node --test 的事件循环
 *      不退出、整套挂死。这里用 node:http + agent:false + connection:close。
 *
 * 【2】teardown 顺序必须是 worker → hub → server。
 *      http server 的 close() 要等所有连接结束才回调，而 upgrade 过的 socket
 *      不在 closeAllConnections() 管辖范围内；先停 worker 才会关掉那条连接。
 *
 * ── 关于 UI 路由的鉴权（测试必须反映真实语义）──
 * lib/hub/ui-routes.js 注册的是 kind:'exact'，而 DSH 的 /api 围栏是 kind:'prefix'，
 * WebServer.match() exact 优先 → UI 路由**绕过**框架围栏。因此 ui-routes 自己
 * 调 `ctx.connection.requestRejection` 补上这道门。本文件用两种 ctx 覆盖：
 *   - 无 connection 服务（下面的默认 setup）：走 sameOriginOk 兜底
 *   - 有 connection 服务：走框架围栏（见"鉴权围栏"分组）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { applyHub } from '../lib/hub/index.js'
import { applyWorker } from '../lib/node/index.js'
import { registerUiRoutes } from '../lib/hub/ui-routes.js'
import { createRelay, newRelayToken } from '../lib/relay.js'
import { decodePairCode } from '../lib/pairing.js'

const IS_WIN = process.platform === 'win32'

const UI = '/api/remote-agent/ui'

/** 7 条 UI 路由（顺序与 ui-routes.js 一致）。 */
const UI_ROUTES = [
  `${UI}/overview`,
  `${UI}/nodes`,
  `${UI}/tasks`,
  `${UI}/task`,
  `${UI}/dispatch`,
  `${UI}/cancel`,
  `${UI}/pull`,
]

/** 建一个独立临时根（已 realpath，避免 Windows 8.3 短名干扰路径断言）。 */
function tmpRoot(t) {
  const dir = fs.realpathSync.native
    ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-')))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return dir
}

async function waitFor(fn, { timeoutMs = 20000, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function writeFileCmd(file, content) {
  if (IS_WIN) {
    const esc = String(content).replace(/'/g, "''")
    return `Set-Content -LiteralPath '${file}' -Value '${esc}' -Encoding UTF8`
  }
  const esc = String(content).replace(/'/g, `'\\''`)
  return `printf '%s\\n' '${esc}' > '${file}'`
}

/**
 * 极简 Cordis 上下文替身：只提供本测试需要的服务。
 * @param {object} o
 * @param {object} o.server 真 http server（承载 exact 路由）
 * @param {object} [o.connection] 可选的 connection 服务（测围栏用）
 */
function makeCtx({ server, connection }) {
  const exact = new Map()
  const effects = []
  const toolDefs = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect(fn, label) {
      const d = fn()
      if (typeof d === 'function') effects.push({ label, dispose: d })
      return d
    },
    get(name) {
      return name === 'connection' ? connection : undefined
    },
    webServer: {
      register({ path: p, handler }) {
        // 复刻真实语义：重复 (kind,path) 会抛
        if (exact.has(p)) throw new Error(`webserver: duplicate exact route "${p}"`)
        exact.set(p, handler)
        return () => exact.delete(p)
      },
      registerUpgrade({ path: p, handler }) {
        const onUpgrade = (req, socket, head) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          if (url.pathname !== p) {
            socket.destroy()
            return
          }
          handler(req, socket, head)
        }
        server.on('upgrade', onUpgrade)
        return () => server.removeListener('upgrade', onUpgrade)
      },
    },
    tools: {
      register(def) {
        toolDefs.set(def.name, def)
        return () => toolDefs.delete(def.name)
      },
    },
    systemPrompt: { section: () => () => {} },
    subagents: { registerProvider: () => () => {} },
  }
  return {
    ctx,
    exact,
    toolDefs,
    effects,
    dispose() {
      for (const e of effects) {
        try {
          e.dispose()
        } catch {
          /* 已释放 */
        }
      }
    },
  }
}

/** 起真 http server，按 exact 表分发。 */
function startHttpServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler = server.__exact?.get(url.pathname)
    if (handler) {
      handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not-found' }))
  })
  // exact 表由 makeCtx 维护；这里把引用接上
  server.__exact = new Map()
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/**
 * HTTP 请求（不用 fetch）。
 * @param {number} port
 * @param {string} p
 * @param {object} [o] { method, body, headers }
 */
function httpReq(port, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        agent: false,
        headers: {
          connection: 'close',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode, text, json })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function startRelay(t) {
  const hubToken = newRelayToken('rt')
  const enrollToken = newRelayToken('en')
  const relay = createRelay({ port: 0, host: '127.0.0.1', hubToken, enrollToken })
  return new Promise((resolve) => {
    relay.listen(() => {
      const port = relay.address().port
      t.after(async () => {
        for (const n of [...relay.nodes.values()]) {
          try {
            n.conn.socket?.destroy?.()
          } catch {
            /* 已断 */
          }
        }
        for (const h of [...relay.hubs]) {
          try {
            h.socket?.destroy?.()
          } catch {
            /* 已断 */
          }
        }
        await Promise.race([
          relay.close(),
          new Promise((r) => {
            const timer = setTimeout(r, 3000)
            if (timer.unref) timer.unref()
          }),
        ])
      })
      resolve({ relay, port, hubToken, enrollToken, url: `ws://127.0.0.1:${port}/relay` })
    })
  })
}

/**
 * 装配完整的 hub + worker（真 relay）。
 * @param {object} t
 * @param {object} o { root, relay, uiPullRoot, connection }
 */
async function setup(t, { root, relay, uiPullRoot, connection, nodeId = 'ui-worker', nodeToken } = {}) {
  const wsRoot = path.join(root, 'ws')
  fs.mkdirSync(wsRoot, { recursive: true })

  const { server, port } = await startHttpServer()
  const hubCtx = makeCtx({ server, connection })

  // 把 hubCtx 的 exact 表接到 server 上
  const origRegister = hubCtx.ctx.webServer.register
  hubCtx.ctx.webServer.register = (route) => {
    const dispose = origRegister(route)
    server.__exact.set(route.path, route.handler)
    return () => {
      dispose()
      server.__exact.delete(route.path)
    }
  }

  // stateDir 必须落在临时目录（同 hub-worker-e2e，防审计写进用户真实状态目录）
  const hubConfig = { role: 'hub', systemPrompt: false, stateDir: path.join(root, 'hub-state'), relay: { url: relay.url, token: relay.hubToken } }
  if (uiPullRoot !== undefined) hubConfig.uiPullRoot = uiPullRoot
  if (nodeToken !== undefined) hubConfig.nodeToken = nodeToken
  const hub = applyHub(hubCtx.ctx, hubConfig)

  const workerCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect(fn) {
      return fn()
    },
    get() {
      return undefined
    },
  }
  const workerDispose = applyWorker(workerCtx, {
    role: 'worker',
    nodeId,
    transportMode: 'relay',
    relayUrl: relay.url,
    token: relay.enrollToken,
    stateDir: path.join(root, 'worker-state'),
    roots: [wsRoot],
    maxConcurrent: 2,
    resumeQueued: false,
  })

  // teardown 顺序：worker → hub → server（见文件头【2】）
  t.after(async () => {
    try {
      workerDispose()
    } catch {
      /* 已释放 */
    }
    try {
      hubCtx.dispose()
    } catch {
      /* 已释放 */
    }
    await new Promise((r) => {
      server.closeAllConnections?.()
      server.close(() => r())
      const timer = setTimeout(r, 3000)
      if (timer.unref) timer.unref()
    })
  })

  await waitFor(() => hub.registry.onlineNodes().length === 1, { label: 'worker online', timeoutMs: 25000 })

  return {
    hub,
    hubCtx,
    port,
    server,
    wsRoot,
    nodeId,
    get: (p, o) => httpReq(port, p, o),
    post: (p, body, o) => httpReq(port, p, { method: 'POST', body, ...o }),
  }
}

/** 派一条 exec 任务并等终态。 */
async function runExec(t, env, { goal, workspace, outputs, timeoutMs } = {}) {
  const r = await env.post(`${UI}/dispatch`, {
    node: env.nodeId,
    goal,
    mode: 'exec',
    workspace: workspace ?? env.wsRoot,
    outputs,
    timeoutMs,
    // 提案 #2 起 exec 默认挂起审批 —— 这批用例测的是 pull/投影/校验链路，
    // 显式 auto 保持"派了就跑"；审批链路在 approval.test.js / e2e 覆盖。
    approval: 'auto',
  })
  assert.equal(r.status, 200, `dispatch 失败: ${r.text}`)
  const taskId = r.json.taskId
  await env.hub.registry.awaitTerminal(taskId, { timeoutMs: timeoutMs ? timeoutMs + 20000 : 60000 })
  return { taskId, task: env.hub.registry.getTask(taskId) }
}

/* ══════════════════════════════════════════════════════════════════
 * 1. 路由注册
 * ══════════════════════════════════════════════════════════════════ */

test('UI 路由：7 条路由全部注册为 exact', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay, uiPullRoot: path.join(root, 'pulled') })

  for (const p of UI_ROUTES) {
    assert.ok(env.server.__exact.has(p), `未注册: ${p}`)
  }
  assert.equal(env.server.__exact.size >= 7, true, 'exact 路由数应 ≥ 7')

  // 未注册路径 404（确认不是"全兜底"）
  const nf = await env.get('/api/remote-agent/ui/nope')
  assert.equal(nf.status, 404)
})

/* ══════════════════════════════════════════════════════════════════
 * 2. overview 形状 + capabilities.pull
 * ══════════════════════════════════════════════════════════════════ */

test('UI overview：形状正确，capabilities.pull 反映 uiPullRoot 配置', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const pullRoot = path.join(root, 'pulled')
  const env = await setup(t, { root, relay, uiPullRoot: pullRoot })

  const r = await env.get(`${UI}/overview`)
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.nodes))
  assert.equal(r.json.nodes.length, 1)
  assert.equal(r.json.nodes[0].nodeId, env.nodeId)
  assert.equal(r.json.nodes[0].online, true)

  // counts
  assert.equal(typeof r.json.counts.nodes, 'number')
  assert.equal(typeof r.json.counts.online, 'number')
  assert.equal(typeof r.json.counts.tasks, 'number')
  assert.equal(typeof r.json.counts.running, 'number')
  assert.equal(typeof r.json.counts.activePulls, 'number')

  // capabilities：配了 pullRoot → pull 可用
  assert.equal(r.json.capabilities.pull, true)
  assert.equal(r.json.capabilities.pullRoot, pullRoot)
  assert.equal(r.json.capabilities.dispatch, true)

  // 节点视图不含内部字段（白名单，非 spread）
  for (const n of r.json.nodes) {
    assert.ok(!('hello' in n), 'nodeView 不应含 hello')
    assert.ok(!('conn' in n), 'nodeView 不应含 conn')
    assert.ok(!('pendingPulls' in n), 'nodeView 不应含 pendingPulls')
    assert.ok(!('tasks' in n), 'nodeView 不应含 tasks Map')
  }
})

test('UI overview：未配置 uiPullRoot 时 capabilities.pull=false', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay }) // 不传 uiPullRoot

  const r = await env.get(`${UI}/overview`)
  assert.equal(r.status, 200)
  assert.equal(r.json.capabilities.pull, false, '未配置时应为 false')
  assert.equal(r.json.capabilities.pullRoot, null)
})

/* ══════════════════════════════════════════════════════════════════
 * 3. 路径穿越（两种写法）
 * ══════════════════════════════════════════════════════════════════ */

test('UI pull：路径穿越被拒（../ 与反斜杠两种写法）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const pullRoot = path.join(root, 'pulled')
  const env = await setup(t, { root, relay, uiPullRoot: pullRoot })

  const goal = writeFileCmd(path.join(env.wsRoot, 'ui-out.txt'), 'ui-ok')
  const { taskId } = await runExec(t, env, { goal })

  // '\' 是否为分隔符是平台语义：Windows 上 `..\..\Windows` 是真实穿越，
  // 必须拒；POSIX 上它是**合法字面文件名**，落在 pullRoot 内（不构成逃逸），
  // 如实断言"接受且落点在 pullRoot 里"，而不是把 Windows 语义硬套全平台。
  const escapes = [
    '../../../../etc',
    '../../../',
    '..',
    'sub/../../..',
    path.join(root, '..', '..', 'escaped'),
  ]
  if (process.platform === 'win32') escapes.splice(1, 0, '..\\..\\Windows')

  for (const dest of escapes) {
    const r = await env.post(`${UI}/pull`, { taskId, paths: ['ui-out.txt'], dest })
    assert.equal(r.status, 403, `dest=${JSON.stringify(dest)} 应被拒，实际 ${r.status} ${r.text}`)
    assert.match(r.json.error, /^dest-outside-pull-root/, `dest=${JSON.stringify(dest)} code=${r.json.error}`)
  }

  if (process.platform !== 'win32') {
    const r = await env.post(`${UI}/pull`, { taskId, paths: ['ui-out.txt'], dest: '..\\..\\Windows' })
    assert.equal(r.status, 200, `POSIX 上反斜杠是字面文件名，应接受：${r.text}`)
    assert.ok(
      fs.existsSync(path.join(pullRoot, '..\\..\\Windows', 'ui-out.txt')),
      '落盘必须还在 pullRoot 内（字面名，不构成逃逸）',
    )
  }

  // 越界目录里不应有落盘文件
  assert.ok(!fs.existsSync(path.join(root, '..', '..', 'escaped')), '不应在 pullRoot 外建目录/落文件')
})

test('UI pull：绝对路径 dest 也被拒（不能被当成"已在 root 内"）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const pullRoot = path.join(root, 'pulled')
  const env = await setup(t, { root, relay, uiPullRoot: pullRoot })

  const goal = writeFileCmd(path.join(env.wsRoot, 'abs.txt'), 'abs')
  const { taskId } = await runExec(t, env, { goal })

  // path.resolve(pullRoot, absolutePath) → absolutePath；必须被 isInside 拦下
  const outside = path.join(root, 'outside-abs')
  const r = await env.post(`${UI}/pull`, { taskId, paths: ['abs.txt'], dest: outside })
  assert.equal(r.status, 403, `绝对路径越界应被拒: ${r.text}`)
  assert.ok(!fs.existsSync(path.join(outside, 'abs.txt')), '不应在 pullRoot 外落文件')
})

/* ══════════════════════════════════════════════════════════════════
 * 4. 未知节点 / 未知 taskId / 空 goal
 * ══════════════════════════════════════════════════════════════════ */

test('UI dispatch：空 goal 被拒（400 goal-required）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay })

  for (const body of [{ goal: '' }, { goal: '   ' }, {}, { goal: 123 }, { goal: null }]) {
    const r = await env.post(`${UI}/dispatch`, body)
    assert.equal(r.status, 400, `body=${JSON.stringify(body)} 应 400`)
    assert.equal(r.json.error, 'goal-required')
  }
})

test('UI dispatch：未知节点被拒（404 node-unknown）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay })

  const r = await env.post(`${UI}/dispatch`, { goal: 'x', node: 'no-such-node' })
  assert.equal(r.status, 404)
  assert.equal(r.json.error, 'node-unknown')
  assert.equal(r.json.nodeId, 'no-such-node')
})

test('UI task/cancel/pull：未知 taskId 一律 404 task-unknown', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const pullRoot = path.join(root, 'pulled')
  const env = await setup(t, { root, relay, uiPullRoot: pullRoot })

  const td = await env.get(`${UI}/task?taskId=does-not-exist`)
  assert.equal(td.status, 404)
  assert.equal(td.json.error, 'task-unknown')

  const cx = await env.post(`${UI}/cancel`, { taskId: 'does-not-exist' })
  assert.equal(cx.status, 404)
  assert.equal(cx.json.error, 'task-unknown')

  const pl = await env.post(`${UI}/pull`, { taskId: 'does-not-exist', paths: ['a.txt'] })
  assert.equal(pl.status, 404)
  assert.equal(pl.json.error, 'task-unknown')

  // 缺 taskId
  const cx2 = await env.post(`${UI}/cancel`, {})
  assert.equal(cx2.status, 400)
  assert.equal(cx2.json.error, 'taskId-required')

  const pl2 = await env.post(`${UI}/pull`, { taskId: '', paths: [] })
  assert.equal(pl2.status, 400)
  assert.equal(pl2.json.error, 'taskId-and-paths-required')
})

/* ══════════════════════════════════════════════════════════════════
 * 5. method 约束
 * ══════════════════════════════════════════════════════════════════ */

test('UI 路由：GET 路由拒绝 POST，POST 路由拒绝 GET', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay, uiPullRoot: path.join(root, 'pulled') })

  for (const p of [`${UI}/overview`, `${UI}/nodes`, `${UI}/tasks`, `${UI}/task`]) {
    const r = await env.post(p, {})
    assert.equal(r.status, 405, `POST ${p} 应 405`)
    assert.equal(r.json.error, 'method')
  }

  for (const p of [`${UI}/dispatch`, `${UI}/cancel`, `${UI}/pull`]) {
    const r = await env.get(p)
    assert.equal(r.status, 405, `GET ${p} 应 405`)
    assert.equal(r.json.error, 'method')
  }
})

/* ══════════════════════════════════════════════════════════════════
 * 6. 凭证泄漏
 * ══════════════════════════════════════════════════════════════════ */

test('UI 响应：不含凭证字样，也不含内部连接对象', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const pullRoot = path.join(root, 'pulled')
  const env = await setup(t, { root, relay, uiPullRoot: pullRoot })

  const goal = writeFileCmd(path.join(env.wsRoot, 'leak.txt'), 'leak-check')
  const { taskId } = await runExec(t, env, { goal })

  const responses = [
    await env.get(`${UI}/overview`),
    await env.get(`${UI}/nodes`),
    await env.get(`${UI}/tasks`),
    await env.get(`${UI}/task?taskId=${encodeURIComponent(taskId)}`),
    await env.post(`${UI}/cancel`, { taskId }),
    await env.post(`${UI}/pull`, { taskId, paths: ['leak.txt'] }),
  ]

  // 凭证形态：relay token 前缀、常见 key 名、bearer
  const SECRET_RE = /rt_|en_|nt_|apiKey|api_key|secret|password|passwd|bearer|authorization|sk-[A-Za-z0-9]/i
  for (const r of responses) {
    assert.ok(!SECRET_RE.test(r.text), `响应疑似泄漏凭证: ${r.text.slice(0, 300)}`)
    // 内部连接对象绝不能出现
    assert.ok(!/"conn"\s*:/.test(r.text), '响应不应含 conn')
    assert.ok(!/"pendingPulls"\s*:/.test(r.text), '响应不应含 pendingPulls')
    assert.ok(!/WebSocket|socket|EventEmitter/.test(r.text), '响应不应含 socket 细节')
  }

  // handoff 经白名单投影：不含副机侧的 logs 对象 / 绝对路径字段
  const td = await env.get(`${UI}/task?taskId=${encodeURIComponent(taskId)}`)
  assert.ok(td.json.handoff, 'handoff 应存在')
  assert.ok(!('logs' in td.json.handoff), 'handoffView 不应含 logs')
  assert.ok(!('workspace' in td.json.handoff), 'handoffView 不应含 workspace（避免回显绝对路径）')
})

/* ══════════════════════════════════════════════════════════════════
 * 6b. 副机接入（pair-info：配对码生成 + token 披露边界）
 * ══════════════════════════════════════════════════════════════════ */

test('UI pair-info：形状正确 —— hubUrl 用传入端口，码可被 decodePairCode 解回', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay })

  const r = await env.get(`${UI}/pair-info?port=19387`)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.port, 19387)
  assert.equal(r.json.tokenSet, false)
  assert.equal(r.json.scope, 'tokenless')
  assert.ok(Array.isArray(r.json.codes))
  assert.ok(typeof r.json.firewallHint === 'string' && r.json.firewallHint.includes('19387'))
  // 无 token 的码必须真的不含 token
  for (const c of r.json.codes) {
    assert.equal(c.includesToken, false)
    const dec = decodePairCode(c.pairCode)
    assert.ok(dec.ok, `码应可解析：${dec.ok ? '' : dec.error}`)
    assert.equal(dec.payload.hubUrl, c.hubUrl)
    assert.equal(dec.payload.token, undefined)
  }
  // 非 loopback 测试同款断言：明文 token 不得出现在任何响应里
  assert.ok(!/nt_[A-Za-z0-9_-]{8,}/.test(r.text), '响应不应含明文 token')
})

test('UI pair-info：本机回环请求 → 完整配对码含 token（可解回原文）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  // 测试客户端从 127.0.0.1 连入 = 回环 = 允许含 token 的完整码
  const env = await setup(t, { root, relay, nodeToken: 'nt_testtoken123' })

  const r = await env.get(`${UI}/pair-info?port=19999`)
  assert.equal(r.json.scope, 'full')
  assert.equal(r.json.tokenSet, true)
  assert.ok(r.json.codes.length >= 1, '本机至少应有一个局域网地址')
  for (const c of r.json.codes) {
    assert.equal(c.includesToken, true)
    const dec = decodePairCode(c.pairCode)
    assert.ok(dec.ok)
    assert.equal(dec.payload.token, 'nt_testtoken123', '回环请求拿到的码要能用（token 原样编入）')
    assert.equal(new URL(dec.payload.hubUrl).port, '19999')
  }
})

test('UI pair-info：非回环请求 → 只给不含 token 的码（lanBind 暴露面收紧）', async (t) => {
  // 直接构造 handler：真实 HTTP 客户端只会从 127.0.0.1 连入，
  // 非回环语义用伪造 req（remoteAddress=局域网地址）直接打到 handler 上验证。
  const captured = []
  const ctx = {
    webServer: { register: (r) => { captured.push(r); return () => {} } },
    connection: undefined,
  }
  registerUiRoutes({
    ctx,
    registry: { list: () => [], getNode: () => null, onlineNodes: () => [] },
    pulls: {},
    log: () => {},
    config: { role: 'hub', nodeToken: 'nt_secret123' },
  })
  const handler = captured.find((r) => r.path === '/api/remote-agent/ui/pair-info').handler

  const fakeRes = () => {
    const out = { statusCode: 0, headers: null, body: '' }
    return {
      out,
      writeHead(status, headers) { out.statusCode = status; out.headers = headers },
      end(payload) { out.body = payload ?? '' },
    }
  }
  const fakeReq = (remote) => ({
    method: 'GET',
    url: '/api/remote-agent/ui/pair-info?port=19387',
    headers: {},
    socket: { remoteAddress: remote },
  })

  // 局域网来源（模拟 lanBind 后另一台机器打开面板）
  const res1 = fakeRes()
  await handler(fakeReq('192.168.5.9'), res1)
  const body1 = JSON.parse(res1.out.body)
  assert.equal(body1.scope, 'tokenless', '非回环必须拿不到含 token 的码')
  for (const c of body1.codes) assert.equal(c.includesToken, false)
  const dec1 = decodePairCode(body1.codes[0]?.pairCode ?? '')
  if (dec1.ok) assert.equal(dec1.payload.token, undefined)

  // 回环来源（对照：同一 handler，回环给全码）
  const res2 = fakeRes()
  await handler(fakeReq('127.0.0.1'), res2)
  const body2 = JSON.parse(res2.out.body)
  assert.equal(body2.scope, 'full')
  assert.equal(decodePairCode(body2.codes[0].pairCode).payload.token, 'nt_secret123')
})

/* ══════════════════════════════════════════════════════════════════
 * 7. pull 禁用
 * ══════════════════════════════════════════════════════════════════ */

test('UI pull：未配置 uiPullRoot 时返回 403 pull-disabled', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay }) // 不配 uiPullRoot

  const goal = writeFileCmd(path.join(env.wsRoot, 'x.txt'), 'x')
  const { taskId } = await runExec(t, env, { goal })

  const r = await env.post(`${UI}/pull`, { taskId, paths: ['x.txt'] })
  assert.equal(r.status, 403)
  assert.equal(r.json.error, 'pull-disabled')
})

/* ══════════════════════════════════════════════════════════════════
 * 8. 全链路
 * ══════════════════════════════════════════════════════════════════ */

test('UI 全链路：worker 上线 → dispatch(exec) → completed → pull 落盘且内容正确', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const pullRoot = path.join(root, 'pulled')
  const env = await setup(t, { root, relay, uiPullRoot: pullRoot })

  const finalName = '报告.txt'
  const content = '这是副机产出的成品'
  const goal = [
    writeFileCmd(path.join(env.wsRoot, finalName), content),
    writeFileCmd(path.join(env.wsRoot, 'build.log'), 'intermediate noise'),
  ].join(IS_WIN ? '; ' : '\n')

  const { taskId, task } = await runExec(t, env, { goal, outputs: ['*'] })
  assert.equal(task.status, 'completed', `任务应 completed，实际 ${task.status}`)

  // tasks 列表能看到
  const tl = await env.get(`${UI}/tasks`)
  assert.equal(tl.status, 200)
  const row = tl.json.tasks.find((x) => x.taskId === taskId)
  assert.ok(row, 'tasks 列表应含该任务')
  assert.equal(row.status, 'completed')

  // 按 node 过滤
  const fl = await env.get(`${UI}/tasks?node=${encodeURIComponent(env.nodeId)}`)
  assert.ok(fl.json.tasks.some((x) => x.taskId === taskId), '按 node 过滤应命中')
  const fl2 = await env.get(`${UI}/tasks?node=nope`)
  assert.equal(fl2.json.tasks.length, 0, '过滤到不存在的 node 应为空')

  // 详情 + handoff 白名单投影
  const td = await env.get(`${UI}/task?taskId=${encodeURIComponent(taskId)}`)
  assert.equal(td.status, 200)
  assert.equal(td.json.task.taskId, taskId)
  assert.ok(td.json.handoff, 'handoff 应存在')
  assert.equal(td.json.handoff.taskId, taskId)
  assert.ok(Array.isArray(td.json.handoff.artifacts.final))

  // pull：落盘到 pullRoot，内容逐字节正确
  const pl = await env.post(`${UI}/pull`, { taskId, paths: [finalName] })
  assert.equal(pl.status, 200, `pull 失败: ${pl.text}`)
  assert.equal(pl.json.results.length, 1)
  const first = pl.json.results[0]
  assert.equal(first.ok, true, `pull 应成功: ${JSON.stringify(first)}`)
  assert.ok(first.bytes > 0)

  const landed = path.join(pullRoot, finalName)
  assert.ok(fs.existsSync(landed), `应落盘到 ${landed}`)
  assert.ok(fs.readFileSync(landed, 'utf8').includes(content), '落盘内容应含原始文本')

  // 落盘目录在 pullRoot 内
  const rel = path.relative(pullRoot, pl.json.dest)
  assert.ok(!rel.startsWith('..'), 'dest 应在 pullRoot 内')
})

test('UI 全链路：pull 到子目录（合法相对路径）应成功', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const pullRoot = path.join(root, 'pulled')
  const env = await setup(t, { root, relay, uiPullRoot: pullRoot })

  const goal = writeFileCmd(path.join(env.wsRoot, 'sub.txt'), 'sub-ok')
  const { taskId } = await runExec(t, env, { goal })

  const r = await env.post(`${UI}/pull`, { taskId, paths: ['sub.txt'], dest: 'nested/dir' })
  assert.equal(r.status, 200, `合法子目录应成功: ${r.text}`)
  assert.equal(r.json.results[0].ok, true)
  assert.ok(fs.existsSync(path.join(pullRoot, 'nested', 'dir', 'sub.txt')), '应落在嵌套子目录内')
})

/* ══════════════════════════════════════════════════════════════════
 * 9. 鉴权围栏（结论 1 的加固）
 * ══════════════════════════════════════════════════════════════════ */

test('UI 围栏：存在 connection 服务时走框架 requestRejection（401/403）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)

  // 假 connection：模拟"cookie 缺失"（401）与"跨源"（403）
  const seen = []
  const connection = {
    requestRejection(request) {
      const origin = request.headers.origin
      seen.push(origin)
      if (origin !== undefined && origin !== 'http://127.0.0.1') return 403
      // 无 cookie → 401
      const cookie = request.headers.cookie
      if (!cookie) return 401
      return undefined
    },
  }
  const env = await setup(t, { root, relay, connection, uiPullRoot: path.join(root, 'pulled') })

  // 无 cookie → 401
  const r1 = await env.get(`${UI}/overview`)
  assert.equal(r1.status, 401, `无凭证应 401，实际 ${r1.status} ${r1.text}`)
  assert.equal(r1.json.error, 'unauthorized')

  // 带 cookie → 放行
  const r2 = await env.get(`${UI}/overview`, { headers: { cookie: 'dsh-auth-x=v1.abc.def' } })
  assert.equal(r2.status, 200, `带凭证应放行，实际 ${r2.status}`)

  // 跨源 → 403（即使带 cookie）
  const r3 = await env.get(`${UI}/overview`, {
    headers: { cookie: 'dsh-auth-x=v1.abc.def', origin: 'http://evil.example' },
  })
  assert.equal(r3.status, 403, `跨源应 403，实际 ${r3.status}`)
  assert.equal(r3.json.error, 'forbidden')

  assert.ok(seen.length >= 3, 'connection.requestRejection 应被调用')
})

test('UI 围栏：围栏自身抛错时失败关闭（不静默放行）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const connection = {
    requestRejection() {
      throw new Error('fence exploded at C:\\secret\\path')
    },
  }
  const env = await setup(t, { root, relay, connection })

  const r = await env.get(`${UI}/overview`)
  assert.equal(r.status, 403, `围栏抛错应失败关闭，实际 ${r.status}`)
  // 且不应把抛错信息里的路径回给浏览器
  assert.ok(!r.text.includes('secret'), `不应回显围栏内部路径: ${r.text}`)
})

test('UI 围栏：无 connection 服务时兜底拒绝跨源（sec-fetch-site / Origin）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay }) // 无 connection

  // 同源/无 Origin → 放行（CLI、测试、本机面板）
  const ok = await env.get(`${UI}/overview`)
  assert.equal(ok.status, 200, '无 Origin 应放行')

  // 显式跨站标记 → 403
  const cross1 = await env.get(`${UI}/overview`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(cross1.status, 403, 'sec-fetch-site: cross-site 应 403')

  // Origin 与 Host 不一致 → 403
  const cross2 = await env.get(`${UI}/overview`, { headers: { origin: 'http://evil.example' } })
  assert.equal(cross2.status, 403, '跨源 Origin 应 403')
})

/* ══════════════════════════════════════════════════════════════════
 * 10. 错误处理：不回堆栈
 * ══════════════════════════════════════════════════════════════════ */

test('UI 错误处理：不回堆栈，消息截断且不含绝对路径栈帧', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)

  // 让 pullRoot 指向一个"文件"而非目录 → resolvePullDest 内部抛错
  const bogus = path.join(root, 'not-a-dir')
  fs.writeFileSync(bogus, 'i am a file', 'utf8')

  const env = await setup(t, { root, relay, uiPullRoot: bogus })

  const goal = writeFileCmd(path.join(env.wsRoot, 'e.txt'), 'e')
  const { taskId } = await runExec(t, env, { goal })

  const r = await env.post(`${UI}/pull`, { taskId, paths: ['e.txt'] })
  // 应是一个受控错误（403/500），且响应体里没有堆栈痕迹
  assert.ok(r.status === 403 || r.status === 500, `应受控失败，实际 ${r.status}`)
  assert.ok(r.json && typeof r.json.error === 'string', '应回稳定 code')
  assert.ok(!/\n\s+at\s/.test(r.text), `不应回堆栈: ${r.text.slice(0, 200)}`)
  assert.ok(!r.text.includes('node:internal'), '不应回内部栈帧')
  // 消息长度受控
  if (typeof r.json.message === 'string') {
    assert.ok(r.json.message.length <= 300, `消息应截断，实际 ${r.json.message.length}`)
  }
})

test('UI 错误处理：坏 body 被拒且不崩', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay, uiPullRoot: path.join(root, 'pulled') })

  // 非 JSON
  const r1 = await env.post(`${UI}/dispatch`, 'not-json-at-all')
  assert.equal(r1.status, 400)
  assert.equal(r1.json.error, 'bad-body')

  // JSON 但不是对象
  const r2 = await env.post(`${UI}/dispatch`, '[1,2,3]')
  assert.equal(r2.status, 400)
  assert.equal(r2.json.error, 'bad-body')

  // 空 body
  const r3 = await httpReq(env.port, `${UI}/dispatch`, { method: 'POST', body: '' })
  assert.equal(r3.status, 400)

  // 服务仍然可用（没被打挂）
  const after = await env.get(`${UI}/overview`)
  assert.equal(after.status, 200, '坏 body 不应打挂 host')
})

test('UI pull：paths 非数组 / 元素非字符串被过滤', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, relay, uiPullRoot: path.join(root, 'pulled') })

  const goal = writeFileCmd(path.join(env.wsRoot, 'f.txt'), 'f')
  const { taskId } = await runExec(t, env, { goal })

  const r1 = await env.post(`${UI}/pull`, { taskId, paths: 'f.txt' })
  assert.equal(r1.status, 400, 'paths 非数组应 400')

  const r2 = await env.post(`${UI}/pull`, { taskId, paths: [1, null, {}, 'f.txt'] })
  assert.equal(r2.status, 200)
  assert.equal(r2.json.results.length, 1, '只有字符串元素应被保留')
  assert.equal(r2.json.results[0].path, 'f.txt')
})

/* ══════════════════════════════════════════════════════════════════
 * 11. 生命周期
 * ══════════════════════════════════════════════════════════════════ */

test('UI 路由：uiEnabled=false 时不注册任何 UI 路由', async (t) => {
  tmpRoot(t)
  const relay = await startRelay(t)
  const { server } = await startHttpServer()
  const hubCtx = makeCtx({ server })
  hubCtx.ctx.webServer.register = (route) => {
    server.__exact.set(route.path, route.handler)
    return () => server.__exact.delete(route.path)
  }

  applyHub(hubCtx.ctx, {
    role: 'hub',
    systemPrompt: false,
    uiEnabled: false,
    relay: { url: relay.url, token: relay.hubToken },
  })

  t.after(async () => {
    hubCtx.dispose()
    await new Promise((r) => {
      server.closeAllConnections?.()
      server.close(() => r())
      const timer = setTimeout(r, 3000)
      if (timer.unref) timer.unref()
    })
  })

  for (const p of UI_ROUTES) {
    assert.ok(!server.__exact.has(p), `uiEnabled=false 时不应注册 ${p}`)
  }
  // healthz 仍应注册（它不受 uiEnabled 控制）
  assert.ok(server.__exact.has('/api/remote-agent/healthz'), 'healthz 应仍注册')
})

/* ══════════════════════════════════════════════════════════════════
 * [D2-1 回归] taskView 必须做**元素级投影**，不能只截长度
 *
 * 缺陷（t11 补审发现，captain 独立复现）：taskView 的 changed 只做
 * `t.changed.slice(0, 50)`，元素原样出。而 changed 来自**副机上报**
 * （node-registry 把 handoff.changed 原样存进任务投影），副机只要上报一个
 * `null` 元素，客户端 `c.op` 就抛 TypeError —— 渲染期抛错会让**整个 slot
 * entry 空白**（面板白屏）。这是跨信任边界的缺陷：副机是可被攻陷的远端，
 * 不能让它的上报内容决定主机 UI 是否崩。
 *
 * 同类不一致一并覆盖：exit/error 曾原样透传（handoffView 里却投影了）、
 * workspace 曾回传绝对路径（handoffView 刻意移除、客户端从不读）。
 * ══════════════════════════════════════════════════════════════════ */

/** 构造一个"敌意任务投影"：changed/exit/error 都塞进畸形与敏感字段。 */
function hostileTask() {
  return {
    taskId: 't-hostile',
    nodeId: 'node-x',
    nodeOnline: true,
    status: 'completed',
    mode: 'exec',
    goal: 'g',
    // 绝对路径：不应回传（会回显主机目录结构）
    workspace: 'D:\\secret\\host\\workspace',
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    // 副机可控的 exit/error：塞敏感字段
    exit: { code: 0, timedOut: false, SECRET_TOKEN: 'leak' },
    error: { code: 'x', message: 'm', SECRET_ERR: 'leak' },
    summary: { text: 's' },
    // 畸形元素矩阵：null / 字符串 / 数字 / 空对象 / 缺字段 / 类型错 / 合法
    changed: [
      null,
      'not-an-object',
      42,
      {},
      { path: 'only-path.txt' },
      { op: 123 },
      { op: 'add', path: 'ok.txt', bytes: 5 },
    ],
    manifest: { counts: { final: 1 } },
    progressTail: [],
    logTail: [],
  }
}

test('[D2-1 回归] taskView 对 changed 做元素级投影（副机上报畸形元素不白屏）', async (t) => {
  const { server, port } = await startHttpServer()
  const c = makeCtx({ server })
  // 把 makeCtx 维护的 exact 表接到 server 上（startHttpServer 的 handler 从 __exact 取）
  server.__exact = c.exact

  const task = hostileTask()
  const registry = {
    list: () => [],
    listTasks: () => [task],
    getTask: (id) => (id === task.taskId ? task : undefined),
    taskView: (x) => ({ ...x, nodeOnline: true }),
    getNode: () => ({}),
    createTask: () => ({}),
    cancelTask: () => true,
  }
  const pulls = { activeCount: 0, pull: async () => ({}) }
  const disposers = registerUiRoutes({
    ctx: c.ctx,
    registry,
    pulls,
    log: () => {},
    defaults: {},
    pullRoot: '',
  })
  t.after(() => {
    for (const d of disposers) d()
    c.dispose()
    server.closeAllConnections?.()
    server.close()
  })

  const res = await httpReq(port, `${UI}/task?taskId=${task.taskId}`)
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${res.text?.slice(0, 200)}`)
  const { task: v } = JSON.parse(res.text)

  // ① 非对象元素被丢弃：7 个进，4 个对象出（null/字符串/数字 被丢）
  assert.equal(v.changed.length, 4, `应保留 4 个对象元素，实际 ${v.changed.length}`)
  assert.ok(v.changed.every((x) => x && typeof x === 'object'), 'changed 元素必须全是对象')

  // ② 每个元素恰 4 键，且都是白名单字段
  for (const x of v.changed) {
    assert.deepEqual(
      Object.keys(x).sort(),
      ['bytes', 'deltaBytes', 'op', 'path'],
      `元素键集不符：${JSON.stringify(x)}`,
    )
  }

  // ③ 缺字段/类型错时给安全默认值
  assert.equal(v.changed[0].op, 'unknown', '缺 op 应回 unknown')
  assert.equal(v.changed[0].path, '', '缺 path 应回空串')
  assert.equal(v.changed[0].bytes, 0, '缺 bytes 应回 0')
  assert.equal(v.changed[2].op, 'unknown', 'op 非字符串应回 unknown')

  // ④ 合法元素完整保留
  const okItem = v.changed.find((x) => x.path === 'ok.txt')
  assert.ok(okItem, '合法元素应保留')
  assert.equal(okItem.op, 'add')
  assert.equal(okItem.bytes, 5)

  // ⑤ changedCount 仍反映原始长度（面板标题用它，不该被投影影响）
  assert.equal(v.changedCount, 7, 'changedCount 应为原始 7')

  // ⑥ 客户端渲染路径不崩 —— 本缺陷的核心：旧实现在这里抛 TypeError
  assert.doesNotThrow(() => {
    for (const x of v.changed) {
      // 等价于 client.js 里的 c.op / c.path / c.bytes 解引用
      void x.op
      void x.path
      void x.bytes
    }
  }, '客户端解引用 changed 元素不应抛错（抛错会让整个 slot entry 空白）')

  // ⑦ 同类不一致一并回归
  assert.ok(!('workspace' in v), 'workspace（绝对路径）不应回传')
  assert.ok(!('SECRET_TOKEN' in (v.exit || {})), 'exit 应经投影，不透传副机字段')
  assert.ok(!('SECRET_ERR' in (v.error || {})), 'error 应经投影，不透传副机字段')

  // ⑧ 整体响应体不含任何敏感字样
  for (const bad of ['SECRET_TOKEN', 'SECRET_ERR', 'secret\\\\host', 'secret/host']) {
    assert.ok(!res.text.includes(bad), `响应体不应含 ${bad}`)
  }
})
