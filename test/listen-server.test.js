/**
 * 独立监听端口（`lib/listen-server.js`）测试。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这条通道（2026-10-18 架构级修复）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原来副机端点注册在 `ctx.webServer` 上 → 副机必须访问 DSH 的 webserver 端口。
 * 而那个端口：
 *   · **DSH 每次启动重写 profile patch**，把写进去的 `webserver` 段删掉
 *     → 绑回 127.0.0.1 → 副机永远连不上（主机侧毫无异常）
 *   · `webServer` 激活即 listen，没有 rebind 方法
 *   · 新版硬拒绝 0.0.0.0（会让 DSH 启动崩溃，我们踩过 10 份 crash 日志）
 *
 * 所以插件自己开一个 `node:http` server，只服务节点端点。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 测试要点
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · 地址自动选择：Tailscale 优先（本插件的目标场景就是跨网）
 *   · 拒绝 0.0.0.0（与 DSH 同规则：通配地址 = 暴露到所有网卡）
 *   · 路径**精确匹配**（不是前缀/模糊匹配 —— 只承载节点端点）
 *   · 健康检查可用，其它路径 404
 *   · close() 真的释放端口（否则插件卸载后端口泄漏）
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LISTEN_PORT,
  listCandidateAddresses,
  resolveListenHost,
  startListenServer,
} from '../lib/listen-server.js'

/* ═══════════════ 1. 地址选择 ═══════════════ */

test('listen：显式配置的 host 优先', () => {
  const r = resolveListenHost({
    listenHost: '192.168.1.50',
    candidates: [{ address: '100.86.48.54', iface: 'ts', score: 0 }],
  })
  assert.equal(r.host, '192.168.1.50')
  assert.equal(r.source, 'config')
})

test('listen：拒绝 0.0.0.0（与新版 DSH 同规则）', () => {
  // 通配地址会把服务暴露到所有网卡 —— 新版 webserver 就是因此拒绝并崩溃的
  for (const bad of ['0.0.0.0', '::', '[::]', '']) {
    const r = resolveListenHost({
      listenHost: bad,
      candidates: [{ address: '100.86.48.54', iface: 'ts', score: 0 }],
    })
    assert.notEqual(r.host, '0.0.0.0', `listenHost=${JSON.stringify(bad)} 不该被采用`)
    assert.equal(r.host, '100.86.48.54', '应回落到自动选择')
  }
})

test('listen：没有显式配置时优先 Tailscale IP', () => {
  const r = resolveListenHost({
    candidates: [
      { address: '192.168.1.10', iface: 'eth', score: 1 },
      { address: '100.86.48.54', iface: 'tailscale', score: 0 },
    ],
  })
  assert.equal(r.host, '100.86.48.54', 'Tailscale 应优先于私网（固定不变、跨网可达）')
  assert.equal(r.source, 'tailscale')
})

test('listen：没有 Tailscale 时用私网 IP', () => {
  const r = resolveListenHost({
    candidates: [{ address: '192.168.1.10', iface: 'eth', score: 1 }],
  })
  assert.equal(r.host, '192.168.1.10')
  assert.equal(r.source, 'private')
})

test('listen：全都没有时兜底回环（同机 both 模式仍可用）', () => {
  const r = resolveListenHost({ candidates: [] })
  assert.equal(r.host, '127.0.0.1')
  assert.equal(r.source, 'loopback')
})

test('listen：listCandidateAddresses 过滤 APIPA 与 internal', () => {
  const list = listCandidateAddresses()
  assert.ok(Array.isArray(list))
  for (const c of list) {
    assert.ok(!c.address.startsWith('169.254.'), 'APIPA 地址应被过滤')
    assert.notEqual(c.address, '127.0.0.1', '回环应被过滤')
    assert.equal(c.family, 'IPv4')
  }
  // 排序：score 升序（Tailscale 先）
  for (let i = 1; i < list.length; i += 1) {
    assert.ok(list[i - 1].score <= list[i].score, '应按 score 升序')
  }
})

/* ═══════════════ 2. 真实监听行为 ═══════════════ */

test('listen：健康检查 200 + 其它路径 404 + 精确路径匹配', async (t) => {
  const srv = await startListenServer({
    host: '127.0.0.1',
    port: 0, // 随机端口
    path: '/api/remote-agent/node',
    healthPath: '/healthz',
    healthBody: { ok: true, plugin: 'dsh-remote-agent' },
    onUpgrade: () => {},
    log: () => {},
  })
  t.after(() => srv.close())

  assert.ok(srv.port > 0, '应拿到实际端口')
  const base = 'http://127.0.0.1:' + srv.port

  const h = await fetch(base + '/healthz')
  assert.equal(h.status, 200)
  const body = await h.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-remote-agent')

  // 其它路径一律 404 —— 这不是通用 web server
  for (const p of ['/', '/wrong', '/api/remote-agent/node']) {
    const r = await fetch(base + p)
    assert.equal(r.status, 404, `${p} 应 404`)
  }
})

test('listen：close() 真的释放端口（不留泄漏）', async () => {
  const srv = await startListenServer({
    host: '127.0.0.1',
    port: 0,
    path: '/x',
    onUpgrade: () => {},
    log: () => {},
  })
  const port = srv.port
  await srv.close()

  // 再绑同一个端口应该成功（说明前一个真的释放了）
  const srv2 = await startListenServer({
    host: '127.0.0.1',
    port,
    path: '/x',
    onUpgrade: () => {},
    log: () => {},
  })
  assert.equal(srv2.port, port, '同一端口应可复用')
  await srv2.close()
})

test('listen：端口被占用时明确 reject（不静默失败）', async (t) => {
  const first = await startListenServer({
    host: '127.0.0.1',
    port: 0,
    path: '/x',
    onUpgrade: () => {},
    log: () => {},
  })
  t.after(() => first.close())

  // 同一个端口再起一个必然失败
  await assert.rejects(
    () => startListenServer({
      host: '127.0.0.1',
      port: first.port,
      path: '/x',
      onUpgrade: () => {},
      log: () => {},
    }),
    /EADDRINUSE|address already in use/i,
    '端口占用应明确报错 —— 静默失败会让"副机连不上"变成无头案',
  )
})

/* ═══════════════ 3. 默认值 ═══════════════ */

test('listen：默认端口 19387（与历史配置/配对码/文档一致）', () => {
  assert.equal(DEFAULT_LISTEN_PORT, 19387)
})
