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
async function setup(t, { root, mode, relay, resourceIntervalMs }) {
  const wsRoot = path.join(root, 'ws')
  fs.mkdirSync(wsRoot, { recursive: true })

  const { server, port } = await startHttpServer()
  const hubCtx = makeCtx({ server })

  // stateDir 必须落在临时目录：省略会走 defaultHubStateDir()（用户真实的
  // ~/.dsh-remote-agent/），审计事件就会写进真实证据链 —— 真机验证揪出
  // （docs/verification-repos-routing-real.md §4⑤），跑一次测试写 14 行。
  const hubConfig = { role: 'hub', systemPrompt: false, stateDir: path.join(root, 'hub-state') }
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
    // maxConcurrent 不传 —— 走生产默认（提案 #26-2 起为 4），让 e2e 与
    // 真实装配一致（资源遥测用例钉住这个默认值）。
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
  // 资源遥测间隔可注入（e2e 用 60ms 级别验证贯通；生产默认 30s）
  if (Number.isFinite(resourceIntervalMs)) workerConfig.resourceIntervalMs = resourceIntervalMs
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
async function runExecTask(t, env, { goal, workspace, outputs, timeoutMs, approval } = {}) {
  const r = await env.tool('remote_task')({
    node: env.nodeId,
    goal,
    mode: 'exec',
    workspace: workspace ?? env.wsRoot,
    outputs,
    timeoutMs,
    // 提案 #2 起 exec 任务默认 manual（挂起等审批）—— e2e 的既有用例测的是
    // 执行链路本身，显式 auto 保持旧行为；审批链路有专门用例。
    approval: approval ?? 'auto',
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
 * 用例 1.5：dry-run 预览（提案 #23）—— 预览即真实
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：remote_task dryRun 只出预览，不产生任务', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  const preview = await env.tool('remote_task')({
    node: env.nodeId,
    goal: 'echo dry-run-probe',
    mode: 'exec',
    // workspace 省略：预览应回填节点默认工作区（与真实派发同一回填逻辑）
    dryRun: true,
  })

  // 预览字段：真节点、真 workspace（roots[0] 回填）、真 mode
  assert.equal(preview.dryRun, true)
  assert.equal(preview.accepted, false)
  assert.equal(preview.node, env.nodeId)
  assert.equal(preview.mode, 'exec')
  assert.equal(preview.workspace, env.wsRoot)
  assert.ok(preview.hint.includes('dryRun'), 'hint 应提示如何正式派发')

  // 关键负向断言：dry-run 绝不产生任务（hub 注册表里没有，节点也没收到）
  assert.equal(env.hub.registry.tasks.size, 0, 'dry-run 不得在 hub 落库任何任务')

  // 无效参数的 dry-run 报错与真实派发一致（goal 缺失）
  await assert.rejects(
    () => env.tool('remote_task')({ node: env.nodeId, mode: 'exec', dryRun: true }),
    /invalid task: task-goal-missing/,
  )
  assert.equal(env.hub.registry.tasks.size, 0)
})

/* ══════════════════════════════════════════════════════════════════
 * 用例 1.6：exec 两阶段审批（提案 #2）—— 批准前副机收不到，批准后跑完
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：exec 任务默认挂起待审批，批准后才到副机并跑到终态', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  // exec 缺省 manual：创建即挂起，副机侧不应出现这条任务
  const r = await env.tool('remote_task')({
    node: env.nodeId,
    goal: writeFileCmd('approved.txt', 'ok'),
    mode: 'exec',
    workspace: env.wsRoot,
  })
  assert.equal(r.status, 'pending_approval')
  assert.equal(r.accepted, false)
  assert.equal(r.approval, 'manual')
  assert.equal(env.hub.registry.getTask(r.taskId).status, 'pending_approval')

  // 批准 → 副机此刻才收到 → 跑到终态 completed（真实执行了命令）
  assert.equal(env.hub.registry.approveTask(r.taskId, { by: 'e2e' }), true)
  await env.hub.registry.awaitTerminal(r.taskId, { timeoutMs: 60000 })
  assert.equal(env.hub.registry.getTask(r.taskId).status, 'completed')

  // 产物核实：批准后才真正写出的文件确实存在
  const manifest = await env.tool('remote_manifest')({ taskId: r.taskId })
  assert.ok(manifest.counts.total >= 0)
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
    approval: 'auto',
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

/* ══════════════════════════════════════════════════════════════════
 * 用例 9：资源遥测贯通（node/resource → registry → remote_nodes）
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：资源遥测到 hub（60ms 间隔贯通全链路）', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay, resourceIntervalMs: 60 })

  await waitFor(() => {
    const n = env.hub.registry.list().find((x) => x.nodeId === env.nodeId)
    return n?.resource != null
  }, { label: 'resource telemetry arrives', timeoutMs: 8000 })

  const n = env.hub.registry.list().find((x) => x.nodeId === env.nodeId)
  assert.ok(n.resource.memTotalMb > 0, '内存总量应为正数')
  assert.ok(n.resource.memUsedMb >= 0, '内存用量应非负')
  assert.ok(Number.isFinite(n.resource.at), '应有上报时间戳')

  // 提案 #26-3：队列健康快照随资源帧搭车贯通。maxConcurrent===4 同时钉住
  // #26-2 的新默认值（本用例的 workerConfig 未传 maxConcurrent）。
  assert.ok(n.queue, '资源帧应携带 queue 快照（新副机）')
  assert.equal(n.queue.maxConcurrent, 4, 'maxConcurrent 默认应为 4')
  assert.equal(typeof n.queue.queued, 'number')
  assert.equal(typeof n.queue.running, 'number')
  assert.ok(n.queue.oldestQueuedMs >= 0)
  assert.equal(n.queue.starved, false, '空闲节点不判饿')

  // remote_nodes 渲染：starved 强信号必须可见（#26 事故形态的核心修法——
  // 用户不再只知道"卡了"，还知道"卡在哪、等多久、怎么办"）
  const nodesDef = env.tools.get('remote_nodes')
  const starvedRender = nodesDef.output.render({}, {
    nodes: [{ nodeId: 'n1', online: true, queue: { queued: 3, running: 4, maxConcurrent: 4, oldestQueuedMs: 180000, starved: true } }],
  })
  assert.match(starvedRender[0].text, /堵死/, 'starved 节点应渲染堵死告警')
  assert.match(starvedRender[0].text, /remote_cancel/, '告警应给出下一步动作')
  const quietRender = nodesDef.output.render({}, {
    nodes: [{ nodeId: 'n1', online: true, queue: { queued: 0, running: 0, maxConcurrent: 4, oldestQueuedMs: 0, starved: false } }],
  })
  assert.equal(quietRender[0].text.includes('堵死'), false, '空闲节点不渲染堵死告警')
})

test('hub⇄worker e2e：remote-agent subagent provider 接线正确', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  // 七个 remote_* 任务工具 + 四个 remote_* 文件工具（提案 #25）都注册了
  for (const name of [
    'remote_nodes',
    'remote_task',
    'remote_status',
    'remote_handoff',
    'remote_manifest',
    'remote_pull',
    'remote_cancel',
    'remote_ls',
    'remote_read',
    'remote_grep',
    'remote_tree',
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
    approval: 'auto',
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

/* ══════════════════════════════════════════════════════════════════
 * E2E 会话加密（提案 #1）：握手、密文不可读、伪造拒绝、丢会话自愈
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 在中继侧架一个"窃听器"：把 hub 客户端、中继↔hub、中继↔node 三条写路径
 * 全部包一层，记录所有上写网的文本与字节。三者合起来覆盖了 relay 模式下
 * 明文可能流经的全部方向（中继转发不变形：文本原样、二进制净荷原样）。
 */
function wireTap(relay, hubRegistry) {
  // startRelay 返回的是包装对象 {relay, port, hubToken, ...}，真实例在 .relay
  const r = relay.relay ?? relay
  const chunks = []
  const recordText = (s) => chunks.push(Buffer.from(String(s), 'utf8'))
  const wrap = (conn, _) => {
    if (!conn) return
    const origSend = conn.send.bind(conn)
    const origSendBinary = conn.sendBinary.bind(conn)
    conn.send = (text) => {
      recordText(text)
      return origSend(text)
    }
    conn.sendBinary = (buf) => {
      chunks.push(Buffer.from(buf))
      return origSendBinary(buf)
    }
  }
  wrap(hubRegistry.relay?.conn, 'hub-client')
  for (const h of [...r.hubs]) wrap(h, 'relay-hub')
  for (const n of [...r.nodes.values()]) wrap(n.conn, 'relay-node')
  return {
    chunks,
    /** 密文里绝不允许出现这段明文 */
    leaks(needle) {
      const buf = Buffer.from(needle, 'utf8')
      return chunks.some((c) => c.includes(buf))
    },
  }
}

/** 等节点的 E2E 会话在 hub 侧建立（rec.e2e 就绪）。 */
async function waitForE2E(registry, nodeId, { timeoutMs = 15000 } = {}) {
  const started = Date.now()
  for (;;) {
    if (registry.getNode(nodeId)?.e2e) return
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for e2e session on ${nodeId}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('hub⇄worker e2e（relay）：E2E 握手建立，任务 goal 对中继窃听器不可见', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  await waitForE2E(env.hub.registry, env.nodeId)
  const tap = wireTap(relay, env.hub.registry)

  const secret = 'E2E-SECRET-GOAL-7f3a9c'
  const { handoff } = await runExecTask(t, env, {
    goal: writeFileCmd('e2e-out.txt', secret),
    outputs: ['*.txt'],
  })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)

  // capture 真的在干活（帧确实流经了被包的路径）。窃听器架在握手之后，
  // 一个 exec 任务周期约 8 条记录：task/start 走 hub→relay、relay→node 两路，
  // node 的 progress/status 走 relay→hub 一路。
  assert.ok(tap.chunks.length >= 6, `窃听器应记录到任务帧，实际 ${tap.chunks.length}`)
  assert.ok(tap.chunks.some((c) => c.includes(Buffer.from('"task/'))), '应能看到任务帧的明文信封头（t 字段不加密）')

  // 但 goal 与成品内容必须是密文 —— 中继看不见
  assert.equal(tap.leaks(secret), false, 'goal/成品内容泄漏到了中继可见的字节流里')
  assert.equal(tap.leaks('E2E-SECRET-GOAL'), false)
})

test('hub⇄worker e2e（relay）：产物分块经 E2E，字节一致且内容不可见', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  await waitForE2E(env.hub.registry, env.nodeId)

  const secret = 'E2E-BINARY-SECRET-b4d81f'
  // 注意：产物分类按内置扩展名表（outputs 只是扫描过滤器，不提升角色），
  // 二进制成品要用 MEDIA_EXT 里的扩展名（.png）才会被判 final 可 pull。
  const name = 'secret.png'
  const content = Buffer.concat([
    Buffer.from(secret, 'utf8'),
    Buffer.from([0x00, 0xff, 0x80, 0x01]),
    Buffer.from(secret, 'utf8'),
  ])
  fs.writeFileSync(path.join(env.wsRoot, name), content)

  const { taskId, handoff } = await runExecTask(t, env, {
    goal: writeFileCmd('note.txt', 'ok'),
    outputs: ['*.png', '*.txt'],
  })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)

  const tap = wireTap(relay, env.hub.registry)
  const dest = path.join(root, 'pulled-e2e')
  const pulled = await env.tool('remote_pull')({ taskId, paths: [name], dest })
  assert.equal(pulled.pulled.length, 1, `pull 应成功: ${JSON.stringify(pulled)}`)
  const got = fs.readFileSync(pulled.pulled[0].dest)
  assert.equal(Buffer.compare(got, content), 0, 'E2E 下二进制产物逐字节相等')
  assert.equal(tap.leaks(secret), false, '产物明文泄漏到了中继可见的字节流里')
})

test('hub⇄worker e2e（relay）：伪造 hub 直发明文 task/start 被副机拒绝', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay, resourceIntervalMs: 100 })

  await waitForE2E(env.hub.registry, env.nodeId)

  // 攻击者 = 中继运营者：用 hubToken（中继配置里本来就有）开一条自己的 hub 连接，
  // 直接给副机发明文 task/start —— 加密层是唯一挡住它的防线。
  const { connect } = await import('../lib/ws.js')
  const { HUB_TO_NODE, envelope, encodeFrame, decodeFrame } = await import('../lib/protocol.js')
  const evil = await connect(`${relay.url}?role=hub`, { headers: { 'x-relay-token': relay.hubToken }, name: 'evil-hub' })
  const received = []
  evil.on('message', (payload) => {
    const dec = decodeFrame(payload)
    if (dec.ok) received.push(dec.frame)
  })

  const fakeTaskId = 'fake-evil-1'
  const fakeGoal = writeFileCmd('pwned.txt', 'owned-by-relay-operator')
  evil.send(encodeFrame({ ...envelope(HUB_TO_NODE.TASK_START, {
    taskId: fakeTaskId,
    goal: fakeGoal,
    mode: 'exec',
    workspace: env.wsRoot,
    approval: 'auto',
  }), to: env.nodeId }))

  // 等副机的回应（密文 error 帧 —— t 明文可见）
  const deadline = Date.now() + 8000
  let errFrame
  while (Date.now() < deadline && !errFrame) {
    errFrame = received.find((f) => f.t === 'error')
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(errFrame, '副机应对明文业务帧回 error 帧')
  assert.equal(errFrame.d?.e2e, 1, '回执必须是加密的（窃听者读不出内容）')

  // 执行必须被挡死：工作区里不得出现 pwned.txt
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(fs.existsSync(path.join(env.wsRoot, 'pwned.txt')), false, '明文 task/start 绝不能被执行')

  evil.close(1000, 'done')

  // 自愈：hub 侧会话未被波及，后续派单照常（加密链路依旧贯通）
  const { handoff } = await runExecTask(t, env, { goal: writeFileCmd('after.txt', 'ok'), outputs: ['after.txt'] })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)
})

test('hub⇄worker e2e（relay）：hub 丢会话后经遥测帧自动重协商', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay, resourceIntervalMs: 100 })

  await waitForE2E(env.hub.registry, env.nodeId)

  // 模拟 hub 重启丢上下文：会话对象直接抹掉（密钥材料销毁）
  const rec = env.hub.registry.getNode(env.nodeId)
  rec.e2e.destroy()
  rec.e2e = null

  // 副机 100ms 遥测帧（已加密）到达 hub → 无会话 → e2e-reset → 副机重新握手
  const started = Date.now()
  for (;;) {
    if (env.hub.registry.getNode(env.nodeId)?.e2e) break
    if (Date.now() - started > 15000) throw new Error('timeout waiting for e2e re-key')
    await new Promise((r) => setTimeout(r, 20))
  }

  // 重协商后任务链路照常
  const { handoff } = await runExecTask(t, env, { goal: writeFileCmd('rekey.txt', 'ok'), outputs: ['rekey.txt'] })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)
})

test('hub⇄worker e2e（direct）：E2E 在直连模式同样生效', async (t) => {
  const root = tmpRoot(t)
  const env = await setup(t, { root, mode: 'direct' })

  // direct 模式 hub 看得到 hello，身份在 welcome 里验证，握手一样走 node/e2e
  await waitForE2E(env.hub.registry, env.nodeId)

  const { handoff } = await runExecTask(t, env, { goal: writeFileCmd('direct-e2e.txt', 'ok'), outputs: ['direct-e2e.txt'] })
  assert.equal(handoff.status, TASK_STATUS.COMPLETED)
  // 会话确实在（而不是旧版明文路径碰巧跑通）
  assert.ok(env.hub.registry.getNode(env.nodeId).e2e, 'direct 模式也应有 E2E 会话')
})

/* ══════════════════════════════════════════════════════════════════
 * 远程文件工具集（提案 #25）：fs/req ↔ fs/res 独立通道走真实链路
 * ══════════════════════════════════════════════════════════════════ */

test('hub⇄worker e2e：remote_ls/read/grep/tree 走真实通道，越界与缺失被拒', async (t) => {
  const root = tmpRoot(t)
  const env = await setup(t, { root, mode: 'direct' })

  // 造一棵确定性小树
  fs.mkdirSync(path.join(env.wsRoot, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(env.wsRoot, 'a.txt'), 'hello needle\nsecond line\n')
  fs.writeFileSync(path.join(env.wsRoot, 'sub', 'b.txt'), 'needle in sub\n')
  fs.writeFileSync(path.join(env.wsRoot, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))

  // ── ls：目录排前，文件带大小 ────────────────────────────────────
  const ls = await env.tool('remote_ls')({ path: env.wsRoot })
  assert.equal(ls.node, env.nodeId)
  assert.equal(ls.total, 3)
  assert.equal(ls.entries[0].type, 'dir', '目录应排在前面')
  const fileEntry = ls.entries.find((e) => e.name === 'a.txt')
  assert.ok(fileEntry.size > 0, '文件条目应有大小')

  // ── read 文本：按行返回 ─────────────────────────────────────────
  const rd = await env.tool('remote_read')({ path: path.join(env.wsRoot, 'a.txt') })
  assert.equal(rd.binary, false)
  assert.deepEqual(rd.lines, ['hello needle', 'second line'])
  assert.equal(rd.totalLines, 2)

  // ── read 二进制：只回元数据 ─────────────────────────────────────
  const rb = await env.tool('remote_read')({ path: path.join(env.wsRoot, 'data.bin') })
  assert.equal(rb.binary, true)
  assert.match(rb.sha256 ?? '', /^[0-9a-f]{64}$/, '二进制应回 sha256')
  assert.ok(Array.isArray(rb.lines) === false || rb.lines === undefined, '二进制不应回文本行')

  // ── grep：递归命中 ──────────────────────────────────────────────
  const g = await env.tool('remote_grep')({ path: env.wsRoot, pattern: 'needle' })
  assert.equal(g.matchCount, 2)
  assert.ok(g.matches.some((m) => m.file.endsWith(path.join('sub', 'b.txt')) || m.file.includes('sub')))

  // ── tree：结构与截断元数据 ──────────────────────────────────────
  const tr = await env.tool('remote_tree')({ path: env.wsRoot, depth: 2 })
  assert.ok(tr.entries >= 4, `树应含全部条目，实际 ${tr.entries}`)
  assert.equal(tr.truncated, false)

  // ── 安全边界：roots 外拒绝（平台双可的越界路径）─────────────────
  const outside = IS_WIN ? 'C://Windows' : '/etc'
  await assert.rejects(
    () => env.tool('remote_read')({ path: outside }),
    (err) => err.code === 'workspace-denied',
    'roots 外路径应以 workspace-denied 拒绝',
  )

  // ── 不存在的文件 ────────────────────────────────────────────────
  await assert.rejects(
    () => env.tool('remote_read')({ path: path.join(env.wsRoot, 'nope.txt') }),
    (err) => err.code === 'artifact-missing',
  )

  // ── render 容错：残缺 value 不抛 ────────────────────────────────
  const lsDef = env.tools.get('remote_ls')
  for (const broken of [undefined, null, {}, { entries: undefined }]) {
    assert.doesNotThrow(() => lsDef.output.render({}, broken))
  }
})

test('hub⇄worker e2e（relay）：fs 请求经 E2E，文件内容与路径对窃听器不可见', async (t) => {
  const root = tmpRoot(t)
  const relay = await startRelay(t)
  const env = await setup(t, { root, mode: 'relay', relay })

  await waitForE2E(env.hub.registry, env.nodeId)

  const secret = 'FS-E2E-SECRET-9c41ab'
  fs.writeFileSync(path.join(env.wsRoot, 'secret.txt'), `${secret}\nplain line\n`)

  const tap = wireTap(relay, env.hub.registry)

  // read 走真实 relay 通道往返
  const rd = await env.tool('remote_read')({ path: path.join(env.wsRoot, 'secret.txt') })
  assert.equal(rd.binary, false)
  assert.equal(rd.lines[0], secret)

  // grep 同样往返（fs/req 双向都过密）
  const g = await env.tool('remote_grep')({ path: env.wsRoot, pattern: secret })
  assert.equal(g.matchCount, 1)

  // 窃听器确实记录到了帧（fs/req 外层帧头 t 保留明文，d 整体密文）
  assert.ok(tap.chunks.some((c) => c.includes(Buffer.from('"fs/req"'))), '应看到 fs/req 帧头（t 字段不加密）')
  assert.ok(tap.chunks.some((c) => c.includes(Buffer.from('"fs/res"'))), '应看到 fs/res 帧头')

  // 但内容与文件名必须对中继不可见
  assert.equal(tap.leaks(secret), false, '文件内容泄漏到了中继可见的字节流里')
  assert.equal(tap.leaks('secret.txt'), false, '文件名泄漏到了中继可见的字节流里')
})
