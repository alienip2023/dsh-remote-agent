/**
 * worker 分支取可选服务的方式（真机 `/api/remote-agent/status` 404 的回归）。
 *
 * cordis 的 `ctx.get(name, strict = true)` 只返回「提供者 fiber 当前活跃」的服务。
 * worker 在 install 早期注册 status 端点与系统提示段时，webServer / systemPrompt
 * 可能已经就绪但 fiber 还没激活 → 严格查找返回 undefined → 两段注册被
 * `safeInvoke` 静默跳过。真机表现就是带 token 请求 `/api/remote-agent/status`
 * 得到 404，面板「副机」视图整页报错。
 *
 * 这里造一个「只有属性可访问、ctx.get 严格查找返回 undefined」的 ctx，直接驱动
 * 真实的 `applyWorker`；两条注册各有一条断言，刀切回严格查找时两条都要红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyWorker } from '../lib/node/index.js'

function startWorker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ra-worker-lookup-'))
  const routes = []
  const sections = []
  const lookups = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: (fn) => fn(),
    webServer: {
      register(route) { routes.push(route); return () => {} },
      getOrigin() { return 'http://127.0.0.1:0' },
    },
    systemPrompt: { section(def) { sections.push(def); return () => {} } },
    // 严格查找的语义：提供者 fiber 未活跃 → undefined。
    get(name, strict = true) { lookups.push([name, strict]); return undefined },
  }
  const dispose = applyWorker(ctx, {
    url: '',
    stateDir: dir,
    roots: [dir],
    preferHeadless: true,
    resourceIntervalMs: 0,
    reposIntervalMs: 0,
  })
  const stop = () => {
    try { dispose() } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  return { routes, sections, lookups, stop }
}

test('worker registers its status route from property access alone', () => {
  const w = startWorker()
  try {
    assert.deepEqual(w.routes.map((r) => r.path), ['/api/remote-agent/status'])
    assert.ok(w.lookups.every(([, strict]) => strict === false), `不允许用严格 ctx.get 判断服务是否存在：${JSON.stringify(w.lookups)}`)
  } finally {
    w.stop()
  }
})

test('worker registers its prompt section from property access alone', () => {
  const w = startWorker()
  try {
    assert.equal(w.sections.length, 1)
    assert.equal(w.sections[0].name, 'dsh-remote-agent-worker')
    assert.ok(w.lookups.every(([, strict]) => strict === false), `不允许用严格 ctx.get 判断服务是否存在：${JSON.stringify(w.lookups)}`)
  } finally {
    w.stop()
  }
})
