/**
 * P1b.10 第一项：只换 key（或撤销 key）时，节点上的 DSH 是否无需重启就生效？
 *
 * 这不是靠注释推断：测试起的是 DSH 自己的 `LocalCredentialProvider`（chokidar 监听 + `resolve(ref)`），
 * 然后用本包真实的 `handleConfigPush`（临时文件 + chmod 0600 + rename 覆盖）去写 `.credentials.yaml`，
 * 在**不重启**的前提下轮询 `resolve`。
 *
 * DSH 的包不是本仓库的依赖：默认从已解开的安装目录读（`DSH_NODE_MODULES`，缺省 /tmp/dsh-asar/node_modules）。
 * 找不到就整组跳过（CI 不带 DSH 安装）——所以结论记在 docs/p1b1-hot-reload-probe.md，不是靠这条测试在 CI 里常绿。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { handleConfigPush } from '../lib/node/config-sync.js'

const NM = process.env.DSH_NODE_MODULES || '/tmp/dsh-asar/node_modules'
const have = existsSync(join(NM, '@deepseek-ai/dsh-credentials-local/lib/index.js')) && existsSync(join(NM, '@deepseek-ai/cordis/lib/index.js'))

describe('P1b.10 #1: credentials hot-reload with the real DSH credential provider', { skip: !have && `DSH install not found at ${NM}` }, () => {
  let base, dshHome, profileDir, ctx, creds, restarts = 0

  before(async () => {
    const imp = (p) => import(pathToFileURL(join(NM, p)).href)
    const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
    const { LocalCredentialProvider } = await imp('@deepseek-ai/dsh-credentials-local/lib/index.js')
    base = mkdtempSync(join(tmpdir(), 'hot-reload-'))
    dshHome = join(base, '.dsh')
    profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    ctx = new Context()
    // 文件在 provider 启动时还不存在：这正是「节点没有 DEEPSEEK_API_KEY」的真实起点。
    ctx.plugin(LocalCredentialProvider, { path: join(dshHome, '.credentials.yaml'), dshHome, watch: true, debounceMs: 100 })
    await new Promise((r) => setTimeout(r, 500))
    creds = ctx.get('credentials')
  })
  after(() => { try { ctx?.stop?.() } catch { /* ignore */ } rmSync(base, { recursive: true, force: true }) })

  const plugin = (key) => ({ entryId: 'llm-deepseek', config: {}, credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: key }] })
  const push = (revision, key) => handleConfigPush({
    data: { schema: 2, revision, providers: [], plugins: key === null ? [] : [plugin(key)] },
    dshHome, profileDir, send() {}, logger() {}, _restartFn: () => { restarts += 1 },
  })
  async function until(pred, ms = 4000) {
    const t0 = Date.now()
    for (;;) {
      const v = await creds.resolve('DEEPSEEK_API_KEY')
      if (pred(v)) return Date.now() - t0
      if (Date.now() - t0 > ms) return -1
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  test('HOT-0: before any push the provider resolves nothing', async () => {
    assert.equal(await creds.resolve('DEEPSEEK_API_KEY'), undefined)
  })

  test('HOT-1: first push creates .credentials.yaml → the running provider resolves the key without a restart', async () => {
    assert.equal(push(1, 'sk-first-111').ok, true)
    const ms = await until((v) => v?.value === 'sk-first-111')
    assert.ok(ms >= 0, 'key not visible within 4s')
  })

  test('HOT-2: key rotation (tmp + rename over the existing file) is picked up without a restart', async () => {
    assert.equal(push(2, 'sk-second-222').ok, true)
    const ms = await until((v) => v?.value === 'sk-second-222')
    assert.ok(ms >= 0, 'rotated key not visible within 4s')
  })

  test('HOT-3: revoking the key (ownedRefs delete) is picked up without a restart', async () => {
    assert.equal(push(3, null).ok, true)
    const ms = await until((v) => v === undefined)
    assert.ok(ms >= 0, 'revoked key still resolvable after 4s')
  })

  test('HOT-ctl (negative control): the same probe against a provider with watch:false does NOT see the new key — the probe can fail', async () => {
    const imp = (p) => import(pathToFileURL(join(NM, p)).href)
    const { Context } = await imp('@deepseek-ai/cordis/lib/index.js')
    const { LocalCredentialProvider } = await imp('@deepseek-ai/dsh-credentials-local/lib/index.js')
    const other = mkdtempSync(join(tmpdir(), 'hot-reload-ctl-'))
    const home = join(other, '.dsh'); mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const c2 = new Context()
    c2.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), dshHome: home, watch: false })
    await new Promise((r) => setTimeout(r, 300))
    try {
      const r = handleConfigPush({ data: { schema: 2, revision: 1, providers: [], plugins: [plugin('sk-ctl-999')] }, dshHome: home, profileDir: join(home, 'profiles', 'web'), send() {}, logger() {}, _restartFn() {} })
      assert.equal(r.ok, true)
      await new Promise((res) => setTimeout(res, 600))
      assert.equal(await c2.get('credentials').resolve('DEEPSEEK_API_KEY'), undefined, 'without a watcher the running provider keeps its old snapshot')
    } finally { rmSync(other, { recursive: true, force: true }) }
  })
})
