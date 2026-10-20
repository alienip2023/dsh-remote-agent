/**
 * DSH `webServer` 契约测试（0.9.5，修 "duplicate upgrade route" 激活失败）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要专门一个文件
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户装上 0.9.4 后 DSH 报：
 *
 *     webserver: duplicate upgrade route "/api/remote-agent/node"
 *     1 entry did not activate remote-agent (dsh-remote-agent)
 *
 * 根因不是"我们写了两处注册"，而是**我们的注册不可回收**：
 *
 *   · DSH 的 `webServer.registerUpgrade(path)` 按 path 查表，同路径第二次
 *     注册直接抛（组合级契约，它这么做是对的）；
 *   · 我们的注册收集在 `__disposers` 里、通过 `applyHub()` 的返回值交给调用方
 *     —— 但 **DSH 不认识那个返回值**，热重载 / 安装后 reload 只会重新 `apply`，
 *     不会回头调 disposer；
 *   · 于是第二代压在第一代的残留上 → 撞车 → 整个 entry 激活失败。
 *
 * **为什么全部既有测试都没抓到**：仓库里的测试桩太宽容 ——
 * `hub-worker-e2e.test.js` 的 `makeCtx()` 里 `register()` 是 `table.set()`
 * （同名静默覆盖）、`registerUpgrade()` 是再 `server.on('upgrade')` 一次。
 * 真宿主会抛，桩不会。**桩比宿主宽松 = 测试给假绿灯**，这是本项目第三次
 * 栽在"装配没测对"上（前两次：env-check 传原始 role、share 面板传空 dir）。
 *
 * 所以这里刻意造一个**和宿主一样严格**的 ctx：重复注册就抛。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { apply } from '../lib/index.js'

/**
 * 严格 ctx：完全按 DSH `webServer` 的语义，重复注册即抛。
 *
 * 对应宿主源码（D:/DeepSeek Harness/resources/app.asar，检索
 * "duplicate upgrade route"）：
 *
 *     register(route) {
 *       const table = route.kind === 'exact' ? this.exact : this.prefixes
 *       if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
 *       table.set(route.path, route)
 *       return () => { table.delete(route.path) }
 *     }
 *     registerUpgrade(route) {
 *       if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
 *       this.upgrades.set(route.path, route)
 *       return () => { this.upgrades.delete(route.path) }
 *     }
 */
function makeStrictCtx() {
  const exact = new Map()
  const prefixes = new Map()
  const upgrades = new Map()
  const tools = new Map()
  const logs = []

  const pick = (kind) => (kind === 'exact' ? exact : prefixes)

  const ctx = {
    logger: {
      info: (msg) => logs.push(['info', msg]),
      warn: (msg) => logs.push(['warn', msg]),
      error: (msg) => logs.push(['error', msg]),
      debug: () => {},
    },
    effect(fn) {
      return fn()
    },
    get() {
      return undefined
    },
    webServer: {
      register({ kind = 'exact', path: p, handler }) {
        const table = pick(kind)
        if (table.has(p)) throw new Error(`webserver: duplicate ${kind} route "${p}"`)
        table.set(p, handler)
        return () => table.delete(p)
      },
      registerUpgrade({ path: p, handler }) {
        if (upgrades.has(p)) throw new Error(`webserver: duplicate upgrade route "${p}"`)
        upgrades.set(p, handler)
        return () => upgrades.delete(p)
      },
      getOrigin() {
        return 'http://127.0.0.1:0'
      },
    },
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error(`tool already registered: ${def.name}`)
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    systemPrompt: { section: () => () => {} },
    agentLoop: {},
    sessions: {},
  }

  return { ctx, exact, prefixes, upgrades, tools, logs }
}

/** 不启独立监听的配置（把注意力集中在 webServer 那条路上）。 */
const baseConfig = (extra = {}) => ({
  role: 'hub',
  systemPrompt: false,
  listenPort: 0,
  stateDir: undefined, // 由各用例按需覆盖；undefined 走默认目录（只读审计时会落）
  ...extra,
})

/** 临时 stateDir，避免测试写进用户真实目录。 */
const tmpState = () => {
  const p = `${process.env.TEMP || '/tmp'}/dsh-ra-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return p
}

test('契约：单次 apply 只在 webServer 上注册一条 upgrade 路由', () => {
  const { ctx, upgrades } = makeStrictCtx()
  const h = apply(ctx, baseConfig({ stateDir: tmpState() }))
  assert.deepEqual([...upgrades.keys()], ['/api/remote-agent/node'])
  h.dispose()
})

test('契约：同一个 ctx 上重复 apply 不抛（0.9.4 的 duplicate 崩溃回归）', () => {
  const { ctx, upgrades } = makeStrictCtx()
  const stateDir = tmpState()
  const cfg = () => baseConfig({ stateDir })

  const h1 = apply(ctx, cfg())
  // 这一行就是用户装 0.9.4 时炸掉的那一步：DSH 热重载，不调 disposer 直接再 apply
  const h2 = apply(ctx, cfg())

  assert.deepEqual([...upgrades.keys()], ['/api/remote-agent/node'], 'upgrade 路由必须仍然只有一条')
  // 上一代被摘掉了，新 handle 仍然可用
  assert.equal(typeof h2.dispose, 'function')
  // h1 的 dispose 已是"过期世代"，调用它不能把 h2 的注册也拆掉
  h1.dispose()
  assert.deepEqual([...upgrades.keys()], ['/api/remote-agent/node'], '旧世代的 dispose 不得影响新世代')
  h2.dispose()
  assert.deepEqual([...upgrades.keys()], [], '新世代 dispose 后应清空')
})

test('契约：apply → dispose → apply 在同 ctx 上可反复进行（幂等）', () => {
  const { ctx, upgrades, exact } = makeStrictCtx()
  const stateDir = tmpState()
  for (let i = 0; i < 3; i += 1) {
    const h = apply(ctx, baseConfig({ stateDir }))
    assert.equal(upgrades.size, 1, `第 ${i + 1} 轮 upgrade 路由数`)
    h.dispose()
    assert.equal(upgrades.size, 0, `第 ${i + 1} 轮 dispose 后应清空`)
    assert.equal(exact.size, 0, `第 ${i + 1} 轮 dispose 后 exact 路由应清空`)
  }
})

test('契约：重复 apply 不会把工具注册成两份', () => {
  const { ctx, tools } = makeStrictCtx()
  const stateDir = tmpState()
  const h1 = apply(ctx, baseConfig({ stateDir }))
  const before = [...tools.keys()].sort()
  const h2 = apply(ctx, baseConfig({ stateDir }))
  const after = [...tools.keys()].sort()
  assert.deepEqual(after, before, '工具集合不该因重入而变多（严格桩会先抛，这里再兜一层）')
  assert.ok(before.length > 0, '应注册了 remote_* 工具')
  h1.dispose()
  h2.dispose()
})

test('契约：重入时独立监听能重新绑上同一端口（端口刚被关掉的竞态）', async () => {
  // 先借一个空闲端口
  const port = await new Promise((resolve, reject) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })

  const { ctx } = makeStrictCtx()
  const cfg = () => baseConfig({ stateDir: tmpState(), listenHost: '127.0.0.1', listenPort: port })

  const h1 = apply(ctx, cfg())
  await waitFor(() => h1.hub?.registry !== undefined, 'worker/hub 起来')
  // 不 dispose 直接再 apply —— 上一代会 close 掉监听，新的一代必须能抢回同一端口
  const h2 = apply(ctx, cfg())

  // 给重试窗口留时间（4 次 × 200/400/600ms 上限）
  const ok = await waitFor(async () => {
    const body = await httpGetJson(`http://127.0.0.1:${port}/api/remote-agent/healthz`)
    return body !== null && body.ok === true
  }, '重入后 healthz 仍可访问', 4000)

  assert.equal(ok, true, '重入后独立监听必须仍然可用（否则热重载会把端点变成永久不可用）')
  h2.dispose()
  await new Promise((r) => setTimeout(r, 100))
  // dispose 之后端口应释放（能重新绑上）
  await new Promise((resolve, reject) => {
    const s = http.createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => s.close(() => resolve()))
  })
})

/* ── 小工具 ─────────────────────────────────────────────────────── */

function httpGetJson(url) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: 'GET', agent: false, headers: { connection: 'close' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

async function waitFor(fn, label, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const v = await fn()
    if (v) return true
    await new Promise((r) => setTimeout(r, 60))
  }
  return false
}
