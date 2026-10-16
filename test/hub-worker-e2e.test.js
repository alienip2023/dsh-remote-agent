/**
 * hub ⇄ worker 全链路端到端测试（最关键的一条）。
 *
 * 组成全是**真实实现**，没有替身：
 *   主机侧：真 http server + lib/hub/index.js 的 applyHub（NodeRegistry +
 *           PullManager + 七个 remote_* 工具 + healthz 路由）
 *   副机侧：lib/node/index.js 的 applyWorker（TaskStore + ArtifactService +
 *           TaskEngine + NodeTransport）
 *   中间：  lib/relay.js 的真中继（或 direct 直连）
 *
 * agent 模式不依赖真实模型 —— 全链路走 mode:'exec'，用真实 PowerShell/sh 命令。
 *
 * ─────────────────────── 两条重要的帧语义约定 ───────────────────────
 *
 * 【约定 1】任务完成**不会**自动推 task/sync。
 *   副机完成时只推 task/summary + task/end。task/sync 只在
 *   ① node 上线（重连后）② hub 主动发 task/query 两个时机发。
 *   所以"拿某任务的完整状态"要主动 query / 读副机磁盘 / 只用 task/summary 的
 *   handoff 字段，不能从"收到的帧集合"里翻 logTail（会拿到空数据而误报失败）。
 *
 * 【约定 2】"断连"类断言只看**状态**（online 翻转、nodes 减少），
 *   不断言日志行数或 close 回调次数 —— 冻结层 close 修复与上层兜底并存会让
 *   这类回调触发两次，reason 文本也因来源而异，那是预期行为。
 *
 * ─────────────────────── 已知冻结层缺陷 ───────────────────────
 *   [D3] lib/relay.js:139 forwardToNode 用 TEXT 帧转发二进制下行帧，
 *        净荷被 UTF-8 有损转换 → **relay 模式下 hub→node 的产物分块全部损坏**，
 *        sha256 必然 hash-mismatch。本文件用两条用例把它钉住：
 *        - 产物 pull 在 **direct 直连**下完整走通（验收标准在此路径上满足）
 *        - 产物 pull 在 **relay** 下失败，并断言失败形态与根因一致
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { applyHub } from '../lib/hub/index.js'
import { applyWorker } from '../lib/node/index.js'
import { PROTOCOL_VERSION, TASK_STATUS } from '../lib/protocol.js'
import { createRelay, newRelayToken } from '../lib/relay.js'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

/** 建一个独立临时根目录（工作区 + 主副机状态目录都放这里）。 */
function tmpRoot(t) {
  const dir = fs.realpathSync.native
    ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hubworker-')))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hubworker-'))
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

/** 平台相关：写文件命令。 */
function writeFileCmd(file, content) {
  if (IS_WIN) {
    const esc = String(content).replace(/'/g, "''")
    return `Set-Content -LiteralPath '${file}' -Value '${esc}' -Encoding UTF8`
  }
  const esc = String(content).replace(/'/g, `'\\''`)
  return `printf '%s\\n' '${esc}' > '${file}'`
}

/** 极简 Cordis 上下文替身：只提供本测试真正需要的服务。 */
function makeCtx({ server }) {
  const effects = []
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect(fn, label) {
      const d = fn()
      if (typeof d === 'function') {
        disposers.push(d)
        effects.push({ label, dispose: d })
      }
      return d
    },
    get() {
      return undefined
    },
    webServer: {
      /** 真 upgrade 路由：把 handler 挂到真 http server 上。 */
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
      /** 真 HTTP 路由（exact 匹配）。 */
      register({ path: p, handler }) {
        const table = server.__exact ?? (server.__exact = new Map())
        table.set(p, handler)
        return () => table.delete(p)
      },
    },
    tools: {
      register(def) {
        toolDefs.set(def.name, def)
        return () => toolDefs.delete(def.name)
      },
    },
    systemPrompt: {
      section() {
        return () => {}
      },
    },
  }
  const toolDefs = new Map()
  return { ctx, toolDefs, effects, dispose: () => { for (const e of effects) { try { e.dispose() } catch { /* 已释放 */ } } } }
}

/**
 * 起一个真 http server（承载 hub 的 upgrade + healthz 路由）。
 *
 * **刻意不在内部注册 t.after**：node:test 的 after 钩子按注册顺序执行，
 * 若在这里就登记 server.close()，它会排在 worker 释放**之前**跑 ——
 * 而 http server 的 close() 要等所有连接结束才回调，worker 的 websocket
 * 此时还连着（upgrade 过的 socket 不在 closeAllConnections 的管辖范围内），
 * 于是 server.close() 永不回调 → after 钩子挂死、整个测试超时。
 * 正确做法是让 setup() 在 worker 建好之后注册一个统一的 teardown，
 * 按 worker → hub → server 的顺序释放。
 */
function startHttpServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const table = server.__exact ?? new Map()
    const handler = table.get(url.pathname)
    if (handler) {
      handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not-found' }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 极简的 HTTP GET（不用 fetch，避免 undici keep-alive 挂住测试）。 */
function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: p, agent: false, headers: { connection: 'close' } },
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
    req.end()
  })
}

/** 中继启动/关闭（关闭时硬销毁 socket，避免 after 钩子挂死）。 */
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
 * 装配一套完整的 hub + worker。
 * @param {object} o
 * @param {string} o.root 临时根
 * @param {'relay'|'direct'} o.mode
 * @param {object} [o.relay] relay 句柄（relay 模式必填）
 */
async function setup(t, { root, mode, relay }) {
  const wsRoot = path.join(root, 'ws')
  fs.mkdirSync(wsRoot, { recursive: true })

  const { server, port } = await startHttpServer()
  const hubCtx = makeCtx({ server })

  const hubConfig = { role: 'hub', systemPrompt: false }
  if (mode === 'relay') {
    hubConfig.relay = { url: relay.url, token: relay.hubToken }
  }
  const hub = applyHub(hubCtx.ctx, hubConfig)

  // ── worker ──────────────────────────────────────────────────────
  const workerCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect(fn) {
      const d = fn()
      return d
    },
    get() {
      return undefined
    },
  }
  const workerConfig = {
    role: 'worker',
    nodeId: 'test-worker',
    stateDir: path.join(root, 'worker-state'),
    roots: [wsRoot],
    maxConcurrent: 2,
    resumeQueued: false,
  }
  if (mode === 'relay') {
    workerConfig.transportMode = 'relay'
    workerConfig.relayUrl = relay.url
    workerConfig.token = relay.enrollToken
  } else {
    workerConfig.transportMode = 'direct'
    workerConfig.hubUrl = `ws://127.0.0.1:${port}/api/remote-agent/node`
  }
  const workerDispose = applyWorker(workerCtx, workerConfig)

  /**
   * 统一的、**顺序正确**的 teardown。
   *
   * 顺序：worker → hub 运行时 → http server。
   * 必须先停 worker：它会关掉拨入的 websocket；否则 http server 的 close()
   * 要等这条 upgrade 连接结束才回调，而 upgrade socket 不受
   * closeAllConnections() 管辖 → after 钩子永不返回、测试超时。
   */
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

  // 等节点在 hub 侧上线
  await waitFor(() => hub.registry.onlineNodes().length === 1, {
    label: `worker online (${mode})`,
    timeoutMs: 25000,
  })

  const tool = (name) => {
    const def = hubCtx.toolDefs.get(name)
    if (!def) throw new Error(`tool not registered: ${name}`)
    return (args, exec) => def.execute(args, exec ?? { signal: undefined })
  }

  return {
    hub,
    hubCtx,
    port,
    wsRoot,
    nodeId: 'test-worker',
    tool,
    tools: hubCtx.toolDefs,
    httpGet: (p) => httpGet(port, p),
  }
}

/** 派一条 exec 任务并等它进入终态，返回 { taskId, handoff, status }。 */
async function runExecTask(t, env, { goal, workspace, outputs, timeoutMs } = {}) {
  const r = await env.tool('remote_task')({
    node: env.nodeId,
    goal,
    mode: 'exec',
    workspace: workspace ?? env.wsRoot,
    outputs,
    timeoutMs,
  })
  assert.equal(r.accepted, true, `派单未被接受: ${JSON.stringify(r)}`)

  const task = env.hub.registry.getTask(r.taskId)
  await env.hub.registry.awaitTerminal(r.taskId, { timeoutMs: timeoutMs ? timeoutMs + 20000 : 60000 })

  const handoff = await env.tool('remote_handoff')({ taskId: r.taskId })
  return { taskId: r.taskId, handoff, task, accept: r }
}

/* ══════════════════════════════════════════════════════════════════
 * 用例 1：relay 模式全链路（任务生命周期 + 工具层）
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e（relay）：remote_task → accept → 完成 → handoff 卡片', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  // remote_nodes 能看到这台副机
  const nodes = await env.tool('remote_nodes')({})
  assert.equal(nodes.protocol, PROTOCOL_VERSION)
  assert.equal(nodes.nodes.length, 1)
  assert.equal(nodes.nodes[0].nodeId, env.nodeId)
  assert.equal(nodes.nodes[0].online, true)
  assert.equal(nodes.nodes[0].agentMode, true)
  // hello.os 来自副机的 detectOs()：windows/darwin/linux 三选一
  assert.equal(nodes.nodes[0].os, IS_WIN ? 'windows' : IS_MAC ? 'darwin' : 'linux')
  assert.ok(nodes.nodes[0].roots.includes(env.wsRoot))

  // healthz 也确认节点注册（比间接推断更硬）
  const hz = await env.httpGet('/api/remote-agent/healthz')
  assert.equal(hz.status, 200)
  assert.equal(hz.json.ok, true)
  assert.equal(hz.json.plugin, 'dsh-remote-agent')
  assert.equal(hz.json.role, 'hub')
  assert.equal(hz.json.nodes, 1)
  assert.equal(hz.json.online, 1)

  // 派一条真实 exec 任务：产出成品 + 中间产物
  const finalName = '报告.txt'
  const goal = [
    writeFileCmd(finalName, '这是副机产出的成品'),
    writeFileCmd('build.log', 'intermediate noise'),
  ].join(IS_WIN ? '; ' : '\n')

  const { taskId, handoff, accept } = await runExecTask(t, env, { goal })

  // task/accept 已被 hub 收到
  assert.equal(accept.accepted, true)
  assert.equal(accept.node, env.nodeId)

  // 任务完成
  assert.equal(handoff.available, true, `handoff 不可用: ${JSON.stringify(handoff)}`)
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)
  const card = handoff.handoff
  assert.equal(card.taskId, taskId)
  assert.equal(card.nodeId, env.nodeId)
  assert.equal(card.mode, 'exec')

  // handoff 卡片：summary.text + changed 是契约要求的两个字段
  assert.equal(typeof card.summary.text, 'string')
  assert.ok(card.summary.text.length > 0, 'summary.text 不能为空')
  assert.ok(Array.isArray(card.changed))
  assert.ok(
    card.changed.some((c) => c.path === finalName),
    `changed 应包含 ${finalName}，实际 ${JSON.stringify(card.changed)}`,
  )

  // 产物清单：成品是 final，build.log 是 intermediate（只上报元数据）
  assert.ok(
    card.artifacts.final.some((f) => f.path === finalName),
    `final 应包含 ${finalName}: ${JSON.stringify(card.artifacts.final)}`,
  )
  assert.equal(
    card.artifacts.final.some((f) => f.path === 'build.log'),
    false,
    'build.log 不应是 final',
  )
  assert.ok(card.artifacts.intermediateCount >= 1)

  // remote_status 读的是 hub 侧投影
  const status = await env.tool('remote_status')({ taskId })
  assert.equal(status.status, TASK_STATUS.COMPLETED)
  assert.equal(status.nodeOnline, true)
  assert.equal(status.accepted, true)

  // remote_manifest 不含文件字节
  const manifest = await env.tool('remote_manifest')({ taskId })
  assert.equal(manifest.taskId, taskId)
  assert.ok(manifest.final.some((f) => f.path === finalName))
  assert.ok(manifest.counts.final >= 1)
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 2：direct 直连全链路 + 产物 pull 逐字节比对（验收标准）
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e（direct）：remote_pull 把 final 产物拉到主机，sha256 与字节全一致', async (t) => {
  const root = tmpRoot(t)
  const env = await setup(t, { root, mode: 'direct' })

  // 成品 1：中文文本（走 exec 命令产出）
  const textName = '产物.txt'
  const textContent = '副机产出的中文成品内容\n'
  // 成品 2：含非 UTF-8 字节的二进制文件（预先放好，验证 pull 是字节安全而非文本安全）
  const binName = 'blob.png'
  const binContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28, 0x0d, 0x0a])
  fs.writeFileSync(path.join(env.wsRoot, binName), binContent)

  const goal = [
    writeFileCmd(textName, textContent.trim()),
    writeFileCmd('build.log', 'intermediate'),
  ].join(IS_WIN ? '; ' : '\n')

  const { taskId, handoff, task } = await runExecTask(t, env, { goal })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)
  const card = handoff.handoff

  const finalPaths = card.artifacts.final.map((f) => f.path)
  assert.ok(finalPaths.includes(textName), `final 应含 ${textName}: ${JSON.stringify(finalPaths)}`)
  assert.ok(finalPaths.includes(binName), `final 应含 ${binName}: ${JSON.stringify(finalPaths)}`)

  // 磁盘上的真身
  const srcText = fs.readFileSync(path.join(env.wsRoot, textName))
  const srcBin = fs.readFileSync(path.join(env.wsRoot, binName))

  // manifest 里声明的 sha256 必须与真身一致
  const declared = (p) => card.artifacts.final.find((f) => f.path === p).sha256
  assert.equal(declared(textName), createHash('sha256').update(srcText).digest('hex'))
  assert.equal(declared(binName), createHash('sha256').update(srcBin).digest('hex'))

  // ── remote_pull ───────────────────────────────────────────────
  const dest = path.join(root, 'pulled')
  const pulled = await env.tool('remote_pull')({ taskId, paths: [textName, binName], dest })

  assert.equal(pulled.dest, path.resolve(dest))
  assert.equal(pulled.skipped.length, 0, `不应有跳过项: ${JSON.stringify(pulled.skipped)}`)
  assert.equal(pulled.pulled.length, 2)

  const byPath = new Map(pulled.pulled.map((p) => [p.path, p]))

  // sha256 与 manifest 一致
  assert.equal(byPath.get(textName).sha256, declared(textName))
  assert.equal(byPath.get(binName).sha256, declared(binName))
  assert.equal(byPath.get(textName).bytes, srcText.length)
  assert.equal(byPath.get(binName).bytes, srcBin.length)

  // 落盘内容与副机原文件**逐字节相等**
  const gotText = fs.readFileSync(byPath.get(textName).dest)
  const gotBin = fs.readFileSync(byPath.get(binName).dest)
  assert.equal(Buffer.compare(gotText, srcText), 0, '文本产物逐字节相等')
  assert.equal(Buffer.compare(gotBin, srcBin), 0, '二进制产物逐字节相等')

  // 文本内容可读回（注意：PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
  // 所以这里剥掉 BOM 再比对；上面那次逐字节比较才是权威断言）
  const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
  assert.equal(
    stripBom(gotText.toString('utf8')).replace(/\r\n/g, '\n'),
    `${textContent.trim()}\n`,
    '中文文本内容正确（无 GBK 乱码）',
  )

  // 落盘文件路径名取最后一段
  assert.equal(path.basename(byPath.get(textName).dest), textName)
  assert.equal(path.basename(byPath.get(binName).dest), binName)

  // 临时文件已清理（要么 rename 成最终文件，要么什么都没有）
  const leftovers = fs.readdirSync(dest).filter((n) => n.startsWith('.dsh-remote-agent-'))
  assert.deepEqual(leftovers, [], '不应残留 .part 临时文件')

  // ── intermediate 不可 pull ────────────────────────────────────
  const denied = await env.tool('remote_pull')({ taskId, paths: ['build.log'], dest })
  assert.equal(denied.pulled.length, 0)
  assert.equal(denied.skipped.length, 1)
  assert.match(denied.skipped[0].reason, /artifact-denied|artifact-missing|not in manifest/)
  assert.equal(fs.existsSync(path.join(dest, 'build.log')), false, 'intermediate 不应落到主机')

  // ── 清单里没有的路径不可 pull ─────────────────────────────────
  const ghost = await env.tool('remote_pull')({ taskId, paths: ['nope.txt'], dest })
  assert.equal(ghost.pulled.length, 0)
  assert.equal(ghost.skipped.length, 1)

  assert.ok(task.manifest, 'hub 侧从 handoff 派生了 manifest')
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 3：失败任务在 hub 侧如实可见（exec.js 修复 2 的端到端回归防线）
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：失败的 cmdlet 任务上报 failed（修复 2 端到端防线）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  const failGoal = IS_WIN
    ? "Get-Item -LiteralPath 'C:\\__dsh_no_such_path__' -ErrorAction Stop"
    : 'ls /__dsh_no_such_path__'

  const { handoff } = await runExecTask(t, env, { goal: failGoal })

  assert.equal(handoff.available, true)
  assert.equal(
    handoff.status,
    TASK_STATUS.FAILED,
    '失败的 cmdlet 必须上报 failed（修复前会被静默折成 completed）',
  )
  const card = handoff.handoff
  assert.equal(card.exit.code !== 0, true, `exit.code 应为非 0，实际 ${card.exit.code}`)
  assert.equal(typeof card.summary.text, 'string')
  assert.ok(card.summary.text.length > 0, 'summary.text 应如实带上错误信息')
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 4：healthz 与 remote_nodes 不含任何凭证
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：healthz 与 remote_nodes 响应不含凭证字样', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  const hz = await env.httpGet('/api/remote-agent/healthz')
  assert.equal(hz.status, 200)
  for (const bad of ['token', 'apiKey', 'api_key', 'credential', 'password', 'secret', 'authorization']) {
    assert.equal(
      hz.text.toLowerCase().includes(bad.toLowerCase()),
      false,
      `healthz 不得含 "${bad}"：${hz.text}`,
    )
  }

  const nodes = await env.tool('remote_nodes')({})
  const nodeText = JSON.stringify(nodes)
  for (const bad of ['token', 'apiKey', 'credential', 'password', 'secret']) {
    assert.equal(
      nodeText.toLowerCase().includes(bad.toLowerCase()),
      false,
      `remote_nodes 不得含 "${bad}"`,
    )
  }
  // 明文 token 本身也绝不能出现
  assert.equal(hz.text.includes(relay.hubToken), false)
  assert.equal(hz.text.includes(relay.enrollToken), false)
  assert.equal(nodeText.includes(relay.hubToken), false)
  assert.equal(nodeText.includes(relay.enrollToken), false)
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 5：relay 模式下产物 pull 同样逐字节正确
 * ══════════════════════════════════════════════════════════════════ */

/**
 * relay 模式下 pull 与 direct 同样正确 —— 这条用例推翻了"relay 拉产物会坏"的假设。
 *
 * 依据（本仓实测）：
 *   产物分块是 **node → hub** 方向，走 relay.js:377-381 broadcastHubsBinary()
 *   → WSConnection.sendBinary()（BINARY 帧），字节安全。
 *   而 lib/relay.js:136-144 forwardToNode() 的 TEXT 转发缺陷（见 relay-e2e.test.js
 *   的 [D3] 用例）只影响 **hub → node** 方向的二进制帧。
 *
 *   hub → node 二进制通道在 v0.1 里**没有任何调用者**：
 *   NodeRegistry.sendBinary（node-registry.js:1034）在全仓只被自己引用，
 *   pull-manager / tools / index 都不调用它。所以 D3 是**潜伏缺陷**，
 *   当前产品流程不可达 —— 但一旦有人用上这条通道（例如后续做双向文件同步），
 *   就会立刻踩中。relay-e2e.test.js 里的 [D3] 用例把这条通道钉住。
 */
test('hub⇄worker e2e（relay）：产物 pull 逐字节正确（分块走 node→hub，不受 D3 影响）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  const name = 'bin.png'
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28, 0x0d, 0x0a])
  fs.writeFileSync(path.join(env.wsRoot, name), content)

  const { taskId, handoff } = await runExecTask(t, env, {
    goal: writeFileCmd('note.txt', 'ok'),
    outputs: ['*.png', '*.txt'],
  })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)
  assert.ok(handoff.handoff.artifacts.final.some((f) => f.path === name))

  const dest = path.join(root, 'pulled-relay')
  const pulled = await env.tool('remote_pull')({ taskId, paths: [name], dest })

  assert.equal(pulled.skipped.length, 0, `不应有跳过项: ${JSON.stringify(pulled.skipped)}`)
  assert.equal(pulled.pulled.length, 1)

  // sha256 与 manifest 一致，且与副机原文件逐字节相等
  const declared = handoff.handoff.artifacts.final.find((f) => f.path === name).sha256
  assert.equal(pulled.pulled[0].sha256, declared)
  assert.equal(declared, createHash('sha256').update(content).digest('hex'))
  assert.equal(pulled.pulled[0].bytes, content.length)

  const got = fs.readFileSync(pulled.pulled[0].dest)
  assert.equal(Buffer.compare(got, content), 0, 'relay 模式下二进制产物逐字节相等')

  const leftovers = fs.readdirSync(dest).filter((n) => n.startsWith('.dsh-remote-agent-'))
  assert.deepEqual(leftovers, [], '不应残留 .part 临时文件')
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 6：节点掉线 → hub 投影只翻 online，不清任务（断连不终止）
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：副机掉线后 hub 只翻 online，任务投影保留', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  const { taskId, handoff } = await runExecTask(t, env, { goal: writeFileCmd('a.txt', 'a') })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)

  const before = env.hub.registry.listTasks().length
  assert.ok(before >= 1)

  // 把中继侧那条 node 连接硬销毁，模拟副机掉线
  const rec = relay.relay.nodes.get(env.nodeId)
  assert.ok(rec, '中继侧应有该节点')
  rec.conn.socket.destroy()

  await waitFor(() => env.hub.registry.onlineNodes().length === 0, { label: 'node marked offline' })

  // 状态：online 翻了，但任务投影还在（任务状态真身在副机）
  assert.equal(env.hub.registry.onlineNodes().length, 0)
  assert.equal(env.hub.registry.listTasks().length, before, '掉线不应清掉任务投影')
  const status = await env.tool('remote_status')({ taskId })
  assert.equal(status.status, TASK_STATUS.COMPLETED, '已完成任务的状态不应因掉线而变')
  assert.equal(status.nodeOnline, false)

  // 节点记录仍在（只是 offline），hostname / roots 等信息保留
  const nodes = await env.tool('remote_nodes')({})
  assert.equal(nodes.nodes.length, 1)
  assert.equal(nodes.nodes[0].online, false)
  assert.ok(nodes.nodes[0].roots.includes(env.wsRoot))
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 7：remote_cancel 打断长任务
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：remote_cancel 打断长任务并进入终态', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  const sleepGoal = IS_WIN ? 'Start-Sleep -Seconds 60' : 'sleep 60'
  const accept = await env.tool('remote_task')({
    node: env.nodeId,
    goal: sleepGoal,
    mode: 'exec',
    workspace: env.wsRoot,
  })
  assert.equal(accept.accepted, true)

  // 等它真的开始跑
  await waitFor(() => env.hub.registry.getTask(accept.taskId).status === TASK_STATUS.RUNNING, {
    label: 'task running',
  })

  const cancelled = await env.tool('remote_cancel')({ taskId: accept.taskId })
  assert.equal(cancelled.requested, true)

  try {
    await env.hub.registry.awaitTerminal(accept.taskId, { timeoutMs: 40000 })
  } catch (err) {
    // ── 诊断转储（macos runner 首跑必挂、同机重跑秒过，2026-10-16 起 4/4）──
    // 超时只有两种可能：kill 没杀掉（孤儿 sleep 持有 stdio → close 拖到 60s）
    // 或 cancel 帧根本没到 worker。把两边现场都拍下来再抛。
    let psDump = '(windows 无 ps)'
    if (!IS_WIN) {
      try {
        psDump = execSync("ps -ef | grep -E 'sleep|sh -c' | grep -v grep || echo '(无相关进程)'", { encoding: 'utf8' })
      } catch (e) {
        psDump = `ps 失败: ${e.message}`
      }
    }
    const view = env.hub.registry.getTask(accept.taskId)
    throw new Error(
      `awaitTerminal 超时。hub 视图: status=${view?.status} accepted=${view?.accepted} `
      + `endedAt=${view?.endedAt ?? '无'}\n── 进程快照 ──\n${psDump}`,
      { cause: err },
    )
  }
  const status = await env.tool('remote_status')({ taskId: accept.taskId })
  assert.ok(
    [TASK_STATUS.FAILED, TASK_STATUS.ABORTED, TASK_STATUS.INTERRUPTED].includes(status.status),
    `取消后应进入终态，实际 ${status.status}`,
  )

  // D6 已修复：引擎把"取消"正确映射成 aborted（原缺陷是落成 failed）。
  // 详见 engine-e2e.test.js 的 [D6 回归] 用例。
  assert.equal(status.status, TASK_STATUS.ABORTED, 'D6 修复：取消应落成 aborted')
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 8：subagent provider 已注册（provider 层接线）
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：remote-agent subagent provider 接线正确', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  // 七个 remote_* 工具都注册了
  for (const name of [
    'remote_nodes',
    'remote_task',
    'remote_status',
    'remote_handoff',
    'remote_manifest',
    'remote_pull',
    'remote_cancel',
  ]) {
    assert.ok(env.tools.has(name), `缺少工具 ${name}`)
    const def = env.tools.get(name)
    assert.equal(typeof def.description, 'string')
    assert.ok(def.description.length > 0, `${name} 应有描述`)
    assert.equal(typeof def.execute, 'function')
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.output.schema, 'object')
    assert.equal(typeof def.output.render, 'function')
  }

  // 未提供 node 且只有一个在线节点时能自动选中；多节点/无节点时的行为在 tools.js 单测覆盖
  const auto = await env.tool('remote_task')({
    goal: writeFileCmd('auto.txt', 'auto'),
    mode: 'exec',
    workspace: env.wsRoot,
  })
  assert.equal(auto.accepted, true)
  assert.equal(auto.node, env.nodeId)
  await env.hub.registry.awaitTerminal(auto.taskId, { timeoutMs: 40000 })

  // render 不应把成功调用变成失败
  const nodesDef = env.tools.get('remote_nodes')
  const rendered = nodesDef.output.render({}, await env.tool('remote_nodes')({}))
  assert.ok(Array.isArray(rendered))
  assert.equal(rendered[0].type, 'text')
  assert.equal(typeof rendered[0].text, 'string')
  assert.ok(rendered[0].text.length > 0)

  // render 遇到残缺 value 也不应抛（容错层）
  for (const broken of [undefined, null, {}, { nodes: undefined }, { final: undefined }]) {
    assert.doesNotThrow(() => nodesDef.output.render({}, broken), `render(${JSON.stringify(broken)})`)
  }
})
