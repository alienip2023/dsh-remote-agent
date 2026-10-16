/**
 * 任务模板库（配方）的回归测试。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个文件守的是什么
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 模板库有三条"看起来能跑、坏了也不会立刻发现"的性质，所以必须钉住：
 *
 *   ① **模板会被回填成派发参数** —— 它因此是一条**输入通道**。若白名单松了，
 *      今天多存一个字段没人管，明天协议新增一个同名字段就自动生效。所以
 *      "拒绝未知字段/超长/超量"的断言是**安全断言**，不是风格断言。
 *
 *   ② **磁盘状态有三种失败形态** —— 文件不存在（正常）、内容损坏（断电/手改）、
 *      并发写（连点保存）。三者的正确行为都不一样：
 *        · 不存在 → 空库且**不创建文件**
 *        · 损坏   → 空库 + degraded（**不抛**），下次保存就地恢复
 *        · 并发   → 串行化 + 原子写（不能丢更新、不能读到半截 JSON）
 *      前两条一旦退化成"抛异常"，面板的派发功能会跟着模板库一起坏。
 *
 *   ③ **路由必须复用同一道围栏** —— ui-routes.js 的路由是 kind:'exact'，
 *      绕过 DSH 的 /api prefix 鉴权（见该文件头"结论 1"）。新增的三个
 *      templates 路由若自己少写一次 guard，就是一个无鉴权的写盘入口。
 *
 * ── 测试基建 ────────────────────────────────────────────────────────────
 * 用真 fs（临时目录）而不是 mock：本文件的核心断言全部关于**文件系统的真实
 * 行为**（原子写的可见性、临时文件残留、ENOENT 与损坏 JSON 的区分）——
 * 用替身测出来的"通过"没有意义。
 *
 * 路由部分不启 http server，直接把 handler 拿出来调：本文件只关心
 * "围栏是否生效 + 状态码/字段是否正确"，不关心 HTTP 传输本身（那是
 * ui-routes.test.js 的职责，它有真 server 与真 relay）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_GOAL_LEN,
  MAX_NAME_LEN,
  MAX_OUTPUTS,
  MAX_TEMPLATES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  TEMPLATES_FILE_NAME,
  TEMPLATES_FORMAT_VERSION,
  atomicWriteJson,
  createTemplateStore,
  defaultTemplatesFile,
  normalizeTemplateInput,
} from '../lib/hub/templates.js'
import { registerUiRoutes } from '../lib/hub/ui-routes.js'

const UI = '/api/remote-agent/ui'

/* ══════════════════════════════════════════════════════════════════
 * 基建：临时目录 / 假 req / 假 res / 假 ctx
 * ══════════════════════════════════════════════════════════════════ */

/** 独立临时根（已 realpath：Windows 8.3 短名会让路径断言飘）。 */
function tmpRoot(t) {
  const dir = fs.realpathSync.native
    ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tpl-')))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tpl-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return dir
}

/** 收集日志的 logger（断言"降级必须留痕"用）。 */
function collector() {
  const lines = []
  const log = (level, msg, extra) => lines.push({ level, msg, extra })
  log.lines = lines
  return log
}

/**
 * 假 req：**必须是异步可迭代的** —— ui-routes 的 readJson 用
 * `for await (const chunk of req)` 收体，普通对象会直接抛。
 */
function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const payload = body === undefined
    ? undefined
    : (typeof body === 'string' ? body : JSON.stringify(body))
  const chunks = payload === undefined ? [] : [Buffer.from(payload, 'utf8')]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

/** 假 res：与真实 res 一样只提供 writeHead/end（writeJson 只用这两个）。 */
function fakeRes() {
  const out = { status: 0, headers: null, body: '', json: undefined }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(payload) {
      out.body = payload ?? ''
      try {
        out.json = JSON.parse(out.body)
      } catch {
        out.json = undefined
      }
    },
  }
}

/** 假 ctx：只提供 ui-routes 真正会碰的两个面（webServer + 无 connection）。 */
function makeCtx() {
  const routes = new Map()
  return {
    routes,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      webServer: {
        register({ path: p, handler }) {
          routes.set(p, handler)
          return () => routes.delete(p)
        },
      },
    },
  }
}

/** 建一个只注册 UI 路由的 harness（registry/pulls 用最小替身）。 */
function makeRouteEnv({ templatesFile, log = () => {} } = {}) {
  const c = makeCtx()
  const disposers = registerUiRoutes({
    ctx: c.ctx,
    registry: { list: () => [], listTasks: () => [], getTask: () => undefined, getNode: () => null, taskView: (x) => x },
    pulls: { activeCount: 0, pull: async () => ({}) },
    log,
    defaults: {},
    pullRoot: '',
    uiTemplatesFile: templatesFile,
  })
  return {
    c,
    disposers,
    call(pathname, req) {
      const handler = c.routes.get(pathname)
      assert.ok(handler, `路由未注册: ${pathname}`)
      const res = fakeRes()
      return Promise.resolve(handler(req, res)).then(() => res.out)
    },
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 1. 路径解析：默认落在 hub 状态目录下，且可配置
 * ══════════════════════════════════════════════════════════════════ */

test('defaultTemplatesFile：落在传入的 stateDir 下，文件名固定', () => {
  const dir = path.join(os.tmpdir(), 'dsh-tpl-state')
  assert.equal(defaultTemplatesFile(dir), path.join(path.resolve(dir), TEMPLATES_FILE_NAME))
  assert.equal(TEMPLATES_FILE_NAME, 'templates.json')
})

test('defaultTemplatesFile：未给 stateDir 时退回默认目录（不抛）', () => {
  const p = defaultTemplatesFile()
  assert.equal(path.basename(p), TEMPLATES_FILE_NAME)
  assert.ok(path.isAbsolute(p), '必须是绝对路径（相对路径会随 cwd 漂移）')
  // 空白串等同"未给"（normalizeConfig 会把未配置归一成 ''）
  assert.equal(defaultTemplatesFile('   '), p)
})

/* ══════════════════════════════════════════════════════════════════
 * 2. 默认空存储：文件不存在是**正常状态**，不是错误
 * ══════════════════════════════════════════════════════════════════ */

test('空存储：list 回空数组、degraded=false，且**不创建**文件', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, 'state', TEMPLATES_FILE_NAME)
  const store = createTemplateStore({ file })

  const r = await store.list()
  assert.deepEqual(r.templates, [])
  assert.equal(r.count, 0)
  assert.equal(r.degraded, false, '文件不存在是正常状态，不该报降级')
  assert.equal(r.reason, '')

  // ⚠ 关键：**不因为面板读过一次就在用户磁盘上留东西**。
  // 这条一旦退化成"读到不存在就写一个空文件"，用户的首次体验就变成
  // "我还没存任何模板，磁盘上却多了一个文件"。
  assert.equal(fs.existsSync(file), false, 'list 不得创建文件')
  assert.equal(fs.existsSync(path.dirname(file)), false, 'list 不得创建目录')
})

test('空存储：store.max 默认是 MAX_TEMPLATES（数量上限可被显式覆盖）', () => {
  const store = createTemplateStore({ file: path.join(os.tmpdir(), 'dsh-tpl-x', TEMPLATES_FILE_NAME) })
  assert.equal(store.max, MAX_TEMPLATES)
  assert.equal(MAX_TEMPLATES, 50)
  const small = createTemplateStore({ file: path.join(os.tmpdir(), 'dsh-tpl-y', TEMPLATES_FILE_NAME), max: 3 })
  assert.equal(small.max, 3)
})

test('createTemplateStore：缺 file 直接抛（配错路径不该静默落到别处）', () => {
  assert.throws(() => createTemplateStore({}), /file is required/)
  assert.throws(() => createTemplateStore({ file: '   ' }), /file is required/)
})

/* ══════════════════════════════════════════════════════════════════
 * 3. save → list → delete 往返
 * ══════════════════════════════════════════════════════════════════ */

test('往返：save 后 list 能读到（字段逐个保留），delete 后消失', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  const store = createTemplateStore({ file })

  const saved = await store.save({
    name: '夜间回归',
    goal: '跑一遍 npm test 并写出报告',
    mode: 'exec',
    workspace: 'D:\\proj',
    model: 'deepseek/deepseek-chat',
    outputs: ['report.md', '*.log'],
    timeoutMs: 1_800_000,
  })
  assert.equal(saved.ok, true, `save 应成功：${saved.error ?? ''} ${saved.message ?? ''}`)
  assert.equal(saved.updated, false)
  assert.equal(saved.count, 1)
  const id = saved.template.id
  assert.ok(/^tpl_[A-Za-z0-9]+$/.test(id), `id 形状不符：${id}`)

  const after = await store.list()
  assert.equal(after.count, 1)
  const t0 = after.templates[0]
  assert.equal(t0.id, id)
  assert.equal(t0.name, '夜间回归')
  assert.equal(t0.goal, '跑一遍 npm test 并写出报告')
  assert.equal(t0.mode, 'exec')
  assert.equal(t0.workspace, 'D:\\proj')
  // model 经协议层归一化成对象（与派发路径同一个定义）
  assert.deepEqual(t0.model, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.deepEqual(t0.outputs, ['report.md', '*.log'])
  assert.equal(t0.timeoutMs, 1_800_000)
  assert.ok(t0.createdAt > 0 && t0.updatedAt > 0)

  // 文件里带格式版本（将来迁移用），且是"对象 + templates 数组"形态
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.version, TEMPLATES_FORMAT_VERSION)
  assert.equal(raw.templates.length, 1)

  const del = await store.remove(id)
  assert.equal(del.ok, true)
  assert.equal(del.removed, 1)
  assert.equal(del.count, 0)
  assert.deepEqual((await store.list()).templates, [])
})

test('往返：带 id 的 save 是**就地更新**（保留 createdAt，刷新 updatedAt）', async (t) => {
  const root = tmpRoot(t)
  const store = createTemplateStore({ file: path.join(root, TEMPLATES_FILE_NAME) })

  const a = await store.save({ name: 'A', goal: 'g1' })
  const id = a.template.id
  const createdAt = a.template.createdAt

  // 时间戳在同毫秒内会相等，所以用 sleep 让 updatedAt 必然更大
  await new Promise((r) => setTimeout(r, 5))
  const b = await store.save({ id, name: 'A2', goal: 'g2' })
  assert.equal(b.ok, true)
  assert.equal(b.updated, true)
  assert.equal(b.template.id, id, '更新必须复用同一个 id')
  assert.equal(b.template.createdAt, createdAt, 'createdAt 必须保留（它记录的是"第一次存"）')
  assert.ok(b.template.updatedAt > createdAt, 'updatedAt 必须刷新')

  const list = await store.list()
  assert.equal(list.count, 1, '更新不该多出一条')
  assert.equal(list.templates[0].name, 'A2')
})

test('往返：id 指向不存在的模板 → template-unknown（**不静默新建**）', async (t) => {
  const root = tmpRoot(t)
  const store = createTemplateStore({ file: path.join(root, TEMPLATES_FILE_NAME) })
  await store.save({ name: 'A', goal: 'g' })

  const r = await store.save({ id: 'tpl_does_not_exist', name: 'B', goal: 'g' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'template-unknown')
  assert.equal(r.status, 404)
  // 静默新建的后果：面板上"选中的模板被别的会话删了"会变成凭空多一条同名模板
  assert.equal((await store.list()).count, 1, '不得新增')
})

test('往返：delete 不存在的 id → template-unknown；缺 id → 400', async (t) => {
  const root = tmpRoot(t)
  const store = createTemplateStore({ file: path.join(root, TEMPLATES_FILE_NAME) })
  await store.save({ name: 'A', goal: 'g' })

  const r1 = await store.remove('tpl_nope')
  assert.equal(r1.ok, false)
  assert.equal(r1.error, 'template-unknown')
  assert.equal(r1.status, 404)

  const r2 = await store.remove('')
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'template-id-required')
  assert.equal(r2.status, 400)

  assert.equal((await store.list()).count, 1, '失败的删除不得动到库')
})

/* ══════════════════════════════════════════════════════════════════
 * 4. 原子写：写临时文件 → rename，失败不留残骸
 * ══════════════════════════════════════════════════════════════════ */

test('原子写：落盘后目录里只有目标文件（无 .tmp- 残骸）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, 'templates.json')
  await atomicWriteJson(file, { version: 1, templates: [{ id: 'a' }] })

  assert.deepEqual(fs.readdirSync(root), ['templates.json'], '不得留下临时文件')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(raw, { version: 1, templates: [{ id: 'a' }] })
})

test('原子写：rename 失败时清理临时文件并抛出（不留半截状态）', async (t) => {
  const root = tmpRoot(t)
  // 目标路径是一个**目录** → rename(file → dir) 必然失败（Windows EPERM / POSIX EISDIR）
  const target = path.join(root, 'occupied')
  fs.mkdirSync(target, { recursive: true })

  await assert.rejects(() => atomicWriteJson(target, { a: 1 }))
  const leftovers = fs.readdirSync(root).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], `失败后不得留下临时文件，实际：${leftovers.join(', ')}`)
  assert.ok(fs.statSync(target).isDirectory(), '目标目录不该被改坏')
})

test('原子写：并发写 + 并发读，读到的永远是完整 JSON（不存在半截状态）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, 'templates.json')
  const store = createTemplateStore({ file })

  // 先把内容撑到足够大 —— 内容越短，非原子写被读到半截的概率越低，
  // 测试就越可能"假绿"。用长 goal 与多 glob 把文件撑到几十 KB。
  const big = (i) => ({
    name: `模板${i}`,
    goal: 'x'.repeat(2000),
    outputs: Array.from({ length: 20 }, (_, k) => `out-${i}-${k}-${'y'.repeat(150)}.log`),
  })

  let reads = 0
  let parseFailures = 0
  let stop = false
  const reader = (async () => {
    while (!stop) {
      try {
        const text = await fs.promises.readFile(file, 'utf8')
        reads += 1
        // 唯一断言：任何时刻读到的都必须是**完整可解析**的内容。
        // 直接 writeFile 目标的实现会在这里偶发地解析失败（半截 JSON）。
        // ⚠ 这里只计数、不 assert：断言抛在后台 IIFE 里会变成
        // unhandled rejection，而且循环会永远跑下去（node 不退出）。
        try {
          JSON.parse(text)
        } catch {
          parseFailures += 1
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err // 首次写之前文件还不存在
      }
      await new Promise((r) => setImmediate(r))
    }
  })()

  try {
    for (let i = 0; i < 12; i += 1) await store.save(big(i))
  } finally {
    // finally 是硬要求：中间任何一步失败都必须停掉读循环，否则测试挂死
    // （reader 永不结束 → node --test 永不退出）。
    stop = true
    await reader
  }

  assert.ok(reads > 0, '读循环应至少跑过一次（否则断言没生效）')
  assert.equal(parseFailures, 0, `读到了 ${parseFailures} 次半截 JSON —— 原子写被破坏`)
  const list = await store.list()
  assert.equal(list.count, 12, '12 次串行保存应得到 12 条')
})

test('原子写：并发读者在场时 rename 的瞬态 EPERM 被有界重试吸收（Windows 语义）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, 'templates.json')
  const store = createTemplateStore({ file })

  // 背景（实测，见 templates.js 的 atomicWriteJson 说明）：Windows 上目标文件
  // 正被另一个句柄读着时 `rename(tmp, target)` 会 EPERM。面板每次打开派发表单
  // 都会 GET /templates，恰好撞上一次保存 → 保存报错，用户无从知道重试就好。
  // 所以实现里加了有界重试，这里用一个**持续读者**把它钉住。
  await store.save({ name: '种子', goal: 'g' })

  let stop = false
  const reader = (async () => {
    while (!stop) {
      try {
        await fs.promises.readFile(file, 'utf8')
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err
      }
      await new Promise((r) => setImmediate(r))
    }
  })()

  const results = []
  try {
    for (let i = 0; i < 8; i += 1) results.push(await store.save({ name: `读者在场${i}`, goal: 'g' }))
  } finally {
    stop = true
    await reader
  }

  assert.ok(results.every((r) => r.ok), '有并发读者时保存也必须成功（重试要真的生效）')
  assert.equal((await store.list()).count, 9)
})

/* ══════════════════════════════════════════════════════════════════
 * 5. 并发写：串行化，不丢更新
 * ══════════════════════════════════════════════════════════════════ */

test('并发写：10 个并发 save 全部落盘（无 lost update）', async (t) => {
  const root = tmpRoot(t)
  const store = createTemplateStore({ file: path.join(root, TEMPLATES_FILE_NAME) })

  // 不 await 任何一个就全部发出 —— 模拟面板"连点十下保存"。
  // 若读-改-写没有串行化，它们会各自读到同一份旧列表再写回，后写的覆盖先写的。
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.save({ name: `并发${i}`, goal: `goal-${i}` })),
  )
  assert.ok(results.every((r) => r.ok), '并发保存应全部成功')

  const list = await store.list()
  assert.equal(list.count, 10, `10 条都要在，实际 ${list.count}（少了就是丢更新）`)
  const names = list.templates.map((t) => t.name).sort()
  assert.deepEqual(names, Array.from({ length: 10 }, (_, i) => `并发${i}`).sort())
  assert.equal(new Set(list.templates.map((t) => t.id)).size, 10, 'id 不得重复')
})

test('并发写：一次失败不卡死后续操作（队列不会被永久堵住）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  const store = createTemplateStore({ file })

  const ok = store.save({ name: 'A', goal: 'g' })
  // 同时发一个必然被拒的输入（未知字段）
  const bad = store.save({ name: 'B', goal: 'g', denyPaths: ['/etc'] })
  const [a, b] = await Promise.all([ok, bad])
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.error, 'template-unknown-field')

  // 队列必须还能用
  const c = await store.save({ name: 'C', goal: 'g' })
  assert.equal(c.ok, true, '失败之后的保存必须仍然能跑（否则队列被卡死）')
  assert.equal((await store.list()).count, 2)
})

/* ══════════════════════════════════════════════════════════════════
 * 6. 损坏 JSON 的降级
 * ══════════════════════════════════════════════════════════════════ */

test('降级：JSON 坏 → 空库 + degraded（不抛），且只告警一次', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  fs.writeFileSync(file, '{ 这不是 JSON ', 'utf8')
  const log = collector()
  const store = createTemplateStore({ file, log })

  const r = await store.list()
  assert.deepEqual(r.templates, [], '坏文件降级为空库')
  assert.equal(r.degraded, true)
  assert.equal(r.reason, 'invalid-json')

  // 反复读不该刷屏（面板会周期性拉列表，日志被刷满会淹掉真错误）
  await store.list()
  await store.list()
  const warns = log.lines.filter((l) => l.msg.includes('not valid JSON'))
  assert.equal(warns.length, 1, `同一原因只该告警一次，实际 ${warns.length} 次`)

  // **绝不抛**：模板库坏掉不该让面板的派发功能一起坏
  assert.equal(fs.existsSync(file), true, '降级不该删掉用户文件（人工还能救回来）')
})

test('降级：损坏文件在下一次 save 时被就地恢复（recovered=true）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  fs.writeFileSync(file, 'not json at all', 'utf8')
  const store = createTemplateStore({ file })

  const r = await store.save({ name: '恢复', goal: 'g' })
  assert.equal(r.ok, true)
  assert.equal(r.recovered, true, '应报告"这次写入把库恢复了"')

  const list = await store.list()
  assert.equal(list.degraded, false)
  assert.equal(list.count, 1)
  // 文件现在是合法 JSON（不再是原来那串垃圾）
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, TEMPLATES_FORMAT_VERSION)
})

test('降级：形状不对（对象里没有 templates 数组）→ bad-shape', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  fs.writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf8')
  const store = createTemplateStore({ file })

  const r = await store.list()
  assert.equal(r.degraded, true)
  assert.equal(r.reason, 'bad-shape')
  assert.deepEqual(r.templates, [])
})

test('降级：读失败（目标是目录）→ unreadable，不抛', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, 'as-a-dir')
  fs.mkdirSync(file, { recursive: true })
  const log = collector()
  const store = createTemplateStore({ file, log })

  const r = await store.list()
  assert.equal(r.degraded, true)
  assert.equal(r.reason, 'unreadable')
  assert.ok(log.lines.some((l) => l.msg.includes('unreadable')), '读失败必须留痕')
})

test('降级：坏条目被丢弃但**好条目保留**（不因一条坏记录丢掉整个库）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    templates: [
      { id: 'good1', name: '好模板', goal: 'g', mode: 'exec' },
      null,
      'not-an-object',
      { name: '缺 id', goal: 'g' },                    // 无 id → 无法寻址删除 → 丢
      { id: '../escape', name: 'x', goal: 'g' },       // id 形状非法 → 丢
      { id: 'good2', name: '另一条', goal: 'g2' },
    ],
  }), 'utf8')
  const store = createTemplateStore({ file })

  const r = await store.list()
  assert.equal(r.count, 2, `应保留 2 条好记录，实际 ${r.count}`)
  assert.deepEqual(r.templates.map((t) => t.id).sort(), ['good1', 'good2'])
})

test('降级：手工编辑的裸数组形态也被接受（写路径宽容）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  // 裸数组是"手写文件"的常见形态；拒绝它会让手工维护模板的人白忙一场
  fs.writeFileSync(file, JSON.stringify([
    { id: 'manual1', name: '手工', goal: 'g', mode: 'agent' },
  ]), 'utf8')
  const store = createTemplateStore({ file })

  const r = await store.list()
  assert.equal(r.degraded, false)
  assert.equal(r.count, 1)
  assert.equal(r.templates[0].name, '手工')
})

test('降级：手工加的未知键被**忽略**（读宽容），不毁掉整条记录', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  // 与写入路径**刻意不对称**：写路径拒绝未知字段，读路径忽略它。
  // 理由：读路径的失败模式是"一个手滑的键让整个库消失"，比"少一条模板"严重得多。
  fs.writeFileSync(file, JSON.stringify({
    templates: [{ id: 'k1', name: '带杂键', goal: 'g', denyPaths: ['/x'], futureField: 1 }],
  }), 'utf8')
  const store = createTemplateStore({ file })

  const r = await store.list()
  assert.equal(r.count, 1)
  assert.equal(r.templates[0].name, '带杂键')
  assert.equal('denyPaths' in r.templates[0], false, '未知键不得进入记录')
  assert.equal('futureField' in r.templates[0], false)
})

test('降级：可选字段坏值只丢该字段，**不丢整条记录**', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  fs.writeFileSync(file, JSON.stringify({
    templates: [
      // 手滑写坏的 model：不该让这条模板从面板上凭空消失
      { id: 'k1', name: '坏 model', goal: 'g', model: { apiKey: 'sk-x' } },
      // 超范围 timeout：同理
      { id: 'k2', name: '坏超时', goal: 'g', timeoutMs: 99 },
      // 坏的 outputs 元素
      { id: 'k3', name: '坏 outputs', goal: 'g', outputs: [1] },
      // workspace 超长
      { id: 'k4', name: '坏 workspace', goal: 'g', workspace: 'x'.repeat(600) },
    ],
  }), 'utf8')
  const store = createTemplateStore({ file })

  const r = await store.list()
  assert.equal(r.count, 4, `四条记录都应保留（坏字段只丢字段），实际 ${r.count}`)
  for (const t0 of r.templates) {
    assert.equal(t0.name.startsWith('坏'), true)
    // 每个坏字段都被丢掉，且**没有**留下残缺的替代值
    assert.equal('model' in t0, false, `${t0.id} 的坏 model 应被丢`)
    assert.equal('timeoutMs' in t0, false, `${t0.id} 的坏 timeoutMs 应被丢`)
    assert.equal('outputs' in t0, false, `${t0.id} 的坏 outputs 应被丢`)
    assert.equal('workspace' in t0, false, `${t0.id} 的坏 workspace 应被丢`)
  }
})

test('降级：必需字段坏 → 整条丢弃（没有 goal 的记录填不出表单）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  fs.writeFileSync(file, JSON.stringify({
    templates: [
      { id: 'ok', name: '好的', goal: 'g' },
      { id: 'nog', name: '缺 goal' },
      { id: 'badmode', name: '坏 mode', goal: 'g', mode: 'shell' },
      { id: 'longname', name: 'x'.repeat(200), goal: 'g' },
    ],
  }), 'utf8')
  const store = createTemplateStore({ file })

  const r = await store.list()
  assert.deepEqual(r.templates.map((t) => t.id), ['ok'], '只应保留完全合格的那条')
})

/* ══════════════════════════════════════════════════════════════════
 * 7. 白名单校验：拒绝未知字段 / 超长 / 超量 / 越界
 *
 * 这是**安全断言**：模板会被回填成 /dispatch 的请求体，若它能带任意字段，
 * 就等于绕过 validateTaskStart 那道收口。
 * ══════════════════════════════════════════════════════════════════ */

test('白名单：未知字段被**拒绝**（不是静默丢弃）', () => {
  for (const extra of [
    { denyPaths: ['/etc'] },
    { artifactRules: { final: ['**'] } },
    { node: 'other-node' },
    { origin: 'ui' },
    { taskId: 'x' },
    { __proto__: { polluted: 1 } },
  ]) {
    const r = normalizeTemplateInput({ name: 'n', goal: 'g', ...extra })
    // 注意 __proto__ 在对象字面量里是原型设置而非自有键，所以它不会命中
    // 未知字段检查 —— 它根本不会出现在 Object.keys 里。这里断言的是
    // "不管怎么塞，结果里都不会多出字段"。
    if (r.ok) {
      assert.deepEqual(
        Object.keys(r.value).sort(),
        ['goal', 'mode', 'name'],
        `合法输入也不得带出多余字段：${JSON.stringify(r.value)}`,
      )
    } else {
      assert.equal(r.error, 'template-unknown-field')
      assert.match(r.message, /不接受字段/)
    }
  }
  // 明确的未知字段一定被拒
  const r = normalizeTemplateInput({ name: 'n', goal: 'g', denyPaths: ['/etc'] })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'template-unknown-field')
})

test('白名单：name / goal 必填，且长度受限', () => {
  assert.equal(normalizeTemplateInput({ goal: 'g' }).error, 'template-name-required')
  assert.equal(normalizeTemplateInput({ name: '   ', goal: 'g' }).error, 'template-name-required')
  assert.equal(normalizeTemplateInput({ name: 'n' }).error, 'template-goal-required')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: '  ' }).error, 'template-goal-required')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 123 }).error, 'template-goal-required')

  assert.equal(normalizeTemplateInput({ name: 'x'.repeat(MAX_NAME_LEN), goal: 'g' }).ok, true)
  assert.equal(normalizeTemplateInput({ name: 'x'.repeat(MAX_NAME_LEN + 1), goal: 'g' }).error, 'template-name-too-long')

  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'x'.repeat(MAX_GOAL_LEN) }).ok, true)
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'x'.repeat(MAX_GOAL_LEN + 1) }).error, 'template-goal-too-long')

  // 非对象一律拒
  for (const bad of [null, undefined, 'x', 42, ['a'], true]) {
    assert.equal(normalizeTemplateInput(bad).ok, false, `非对象应被拒：${String(bad)}`)
  }
})

test('白名单：mode 只认 agent/exec（写错就报错，不静默回落）', () => {
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g' }).value.mode, 'agent', '缺省是 agent')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', mode: 'exec' }).value.mode, 'exec')
  for (const bad of ['shell', 'EXEC', 'Agent', '', 1, null, {}]) {
    const r = normalizeTemplateInput({ name: 'n', goal: 'g', mode: bad })
    assert.equal(r.ok, false, `mode=${JSON.stringify(bad)} 应被拒`)
    assert.equal(r.error, 'template-mode-invalid')
  }
})

test('白名单：workspace 超长被拒；空串等同"没有预设"', () => {
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', workspace: 'x'.repeat(500) }).ok, true)
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', workspace: 'x'.repeat(501) }).error, 'template-workspace-too-long')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', workspace: 123 }).error, 'template-workspace-invalid')
  // 空串 → 字段被省略（而不是存一个空 workspace，那会被当成"预设了空目录"）
  assert.equal('workspace' in normalizeTemplateInput({ name: 'n', goal: 'g', workspace: '  ' }).value, false)
})

test('白名单：model 走协议层归一化，非法形状被拒', () => {
  const ok = normalizeTemplateInput({ name: 'n', goal: 'g', model: 'openai/gpt-4o' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value.model, { provider: 'openai', model: 'gpt-4o' })

  const obj = normalizeTemplateInput({ name: 'n', goal: 'g', model: { model: 'gpt-4o', reasoningEffort: 'high' } })
  assert.deepEqual(obj.value.model, { model: 'gpt-4o', reasoningEffort: 'high' })

  // 只给 provider 不是有效选择（归一化后没有 model）—— 存下去会让用户以为
  // "这条模板带了模型"，实际派发时静默回落默认
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', model: { provider: 'openai' } }).error, 'template-model-invalid')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', model: { apiKey: 'sk-x' } }).error, 'template-model-invalid')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', model: 123 }).error, 'template-model-invalid')
  assert.equal(
    normalizeTemplateInput({ name: 'n', goal: 'g', model: { model: 'x'.repeat(200) } }).error,
    'template-model-invalid',
  )
  // 超长的字符串形态
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', model: 'x'.repeat(200) }).error, 'template-model-too-long')
})

test('白名单：outputs 数量/长度/类型都受限，且不做静默过滤', () => {
  const many = Array.from({ length: MAX_OUTPUTS }, (_, i) => `o${i}.log`)
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', outputs: many }).ok, true)
  assert.equal(
    normalizeTemplateInput({ name: 'n', goal: 'g', outputs: [...many, 'extra.log'] }).error,
    'template-outputs-too-many',
  )
  assert.equal(
    normalizeTemplateInput({ name: 'n', goal: 'g', outputs: ['x'.repeat(201)] }).error,
    'template-outputs-too-long',
  )
  // ⚠ 元素类型错**报错**而不是 filter 掉：模板是存档，静默丢元素等于
  // 把用户的意图改掉，之后每次用这条模板都少收一个产物
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', outputs: [1, null, {}] }).error, 'template-outputs-invalid')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', outputs: ['ok', '  '] }).error, 'template-outputs-invalid')
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', outputs: 'a,b' }).error, 'template-outputs-invalid')
})

test('白名单：timeoutMs 必须落在 [1000, 24h]', () => {
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', timeoutMs: MIN_TIMEOUT_MS }).ok, true)
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', timeoutMs: MAX_TIMEOUT_MS }).ok, true)
  for (const bad of [MIN_TIMEOUT_MS - 1, 0, -1, MAX_TIMEOUT_MS + 1, Number.NaN, Infinity, '60000', {}]) {
    const r = normalizeTemplateInput({ name: 'n', goal: 'g', timeoutMs: bad })
    assert.equal(r.ok, false, `timeoutMs=${String(bad)} 应被拒`)
    assert.ok(
      r.error === 'template-timeout-invalid' || r.error === 'template-timeout-out-of-range',
      `错误码应为 timeout 相关，实际 ${r.error}`,
    )
  }
  // 小数被截断成整数（毫秒没有小数语义）
  assert.equal(normalizeTemplateInput({ name: 'n', goal: 'g', timeoutMs: 1500.7 }).value.timeoutMs, 1500)
})

test('白名单：id 形状受限（不能自定义任意地址）', () => {
  assert.equal(normalizeTemplateInput({ id: 'tpl_abc123', name: 'n', goal: 'g' }).value.id, 'tpl_abc123')
  for (const bad of ['../etc', 'a b', 'a/b', 'x'.repeat(65), '', '  ', 42]) {
    const r = normalizeTemplateInput({ id: bad, name: 'n', goal: 'g' })
    assert.equal(r.ok, false, `id=${JSON.stringify(bad)} 应被拒`)
    assert.equal(r.error, 'template-id-invalid')
  }
})

test('白名单：数量上限 —— 到上限后新建被拒（409），更新仍可', async (t) => {
  const root = tmpRoot(t)
  const store = createTemplateStore({ file: path.join(root, TEMPLATES_FILE_NAME), max: 3 })

  const ids = []
  for (let i = 0; i < 3; i += 1) {
    const r = await store.save({ name: `T${i}`, goal: 'g' })
    assert.equal(r.ok, true, `第 ${i + 1} 条应成功`)
    ids.push(r.template.id)
  }

  const over = await store.save({ name: 'T4', goal: 'g' })
  assert.equal(over.ok, false)
  assert.equal(over.error, 'template-limit')
  assert.equal(over.status, 409)
  assert.equal((await store.list()).count, 3, '被拒的保存不得改变库')

  // 上限只挡"新建"：更新已有模板必须仍然可用（否则库满了就改不动了）
  const upd = await store.save({ id: ids[0], name: 'T0-改', goal: 'g' })
  assert.equal(upd.ok, true, `到上限后更新应仍可用：${upd.error ?? ''}`)
  assert.equal((await store.list()).count, 3)

  // 删掉一条后又能新建
  await store.remove(ids[1])
  assert.equal((await store.save({ name: 'T4', goal: 'g' })).ok, true)
})

test('白名单：文件里超量的记录被截到上限（读路径也要收口）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  // 手工塞 10 条，store 上限 4 → 只应读出 4 条（否则面板下拉框会被撑爆）
  fs.writeFileSync(file, JSON.stringify({
    templates: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, name: `手工${i}`, goal: 'g' })),
  }), 'utf8')
  const store = createTemplateStore({ file, max: 4 })

  const r = await store.list()
  assert.equal(r.count, 4, `应截到上限 4，实际 ${r.count}`)
})

/* ══════════════════════════════════════════════════════════════════
 * 8. UI 路由：围栏（跨源 403）+ 正常读写
 * ══════════════════════════════════════════════════════════════════ */

test('UI 路由：三条 templates 路由全部注册为 exact', (t) => {
  const root = tmpRoot(t)
  const env = makeRouteEnv({ templatesFile: path.join(root, TEMPLATES_FILE_NAME) })
  t.after(() => { for (const d of env.disposers) d() })

  for (const p of [`${UI}/templates`, `${UI}/templates/save`, `${UI}/templates/delete`]) {
    assert.ok(env.c.routes.has(p), `未注册: ${p}`)
  }
})

test('UI 路由：跨源请求一律 403（复用同一个 guard）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  const env = makeRouteEnv({ templatesFile: file })
  t.after(() => { for (const d of env.disposers) d() })

  // Origin 与 Host 不一致 → 403（sameOriginOk 兜底分支；测试 ctx 没有
  // connection 服务，所以走的就是 ui-routes.js 的兜底围栏）
  const cross = await env.call(`${UI}/templates`, fakeReq({
    headers: { host: '127.0.0.1:19387', origin: 'http://evil.example' },
  }))
  assert.equal(cross.status, 403)
  assert.equal(cross.json.error, 'forbidden')

  // sec-fetch-site: cross-site → 403
  const cross2 = await env.call(`${UI}/templates/save`, fakeReq({
    method: 'POST',
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
    body: { name: 'x', goal: 'g' },
  }))
  assert.equal(cross2.status, 403, '跨站保存必须被挡在围栏外')
  assert.equal(fs.existsSync(file), false, '被拒的请求不得落盘')

  // 同源（Origin 与 Host 一致）→ 放行
  const same = await env.call(`${UI}/templates`, fakeReq({
    headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
  }))
  assert.equal(same.status, 200)

  // 无 Origin（本机进程 / 测试）→ 放行
  const noOrigin = await env.call(`${UI}/templates`, fakeReq({ headers: { host: '127.0.0.1:19387' } }))
  assert.equal(noOrigin.status, 200)
})

test('UI 路由：list → save → delete 全链路（字段经投影后回给浏览器）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  const log = collector()
  const env = makeRouteEnv({ templatesFile: file, log })
  t.after(() => { for (const d of env.disposers) d() })

  // ① 空列表
  const l0 = await env.call(`${UI}/templates`, fakeReq())
  assert.equal(l0.status, 200)
  assert.equal(l0.json.ok, true)
  assert.deepEqual(l0.json.templates, [])
  assert.equal(l0.json.count, 0)
  assert.equal(l0.json.max, MAX_TEMPLATES)
  assert.equal(l0.json.degraded, false)
  assert.equal(l0.json.file, file, '面板要能显示模板存哪')

  // ② 保存
  const s = await env.call(`${UI}/templates/save`, fakeReq({
    method: 'POST',
    body: { name: '回归', goal: '跑测试', mode: 'exec', workspace: '/srv/app', timeoutMs: 60_000 },
  }))
  assert.equal(s.status, 200, `save 应 200：${s.body}`)
  assert.equal(s.json.ok, true)
  assert.equal(s.json.updated, false)
  const id = s.json.template.id
  assert.equal(s.json.template.name, '回归')

  // ③ 列表里能读到
  const l1 = await env.call(`${UI}/templates`, fakeReq())
  assert.equal(l1.json.count, 1)
  assert.equal(l1.json.templates[0].id, id)
  assert.equal(l1.json.templates[0].timeoutMs, 60_000)

  // ④ 删除
  const d = await env.call(`${UI}/templates/delete`, fakeReq({ method: 'POST', body: { id } }))
  assert.equal(d.status, 200)
  assert.equal(d.json.removed, 1)
  assert.equal(d.json.count, 0)
  assert.equal((await env.call(`${UI}/templates`, fakeReq())).json.count, 0)
})

test('UI 路由：出边界的模板对象**逐字段构造**（不 spread 磁盘内容）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  // 磁盘上塞一条"手工编辑过的、带敏感/未知字段"的记录。
  // 读路径会忽略未知键，但这里再叠一层：即使某个字段混进了记录，
  // 出边界也必须经 templateView 逐字段挑 —— 与 views.js 同一条硬规则。
  fs.writeFileSync(file, JSON.stringify({
    templates: [{
      id: 'leak1',
      name: '泄漏检查',
      goal: 'g',
      nodeToken: 'nt_secret123',
      workspace: '/srv/app',
      model: { model: 'gpt-4o', apiKey: 'sk-secret' },
      unknownField: 'x',
    }],
  }), 'utf8')
  const env = makeRouteEnv({ templatesFile: file })
  t.after(() => { for (const d of env.disposers) d() })

  const r = await env.call(`${UI}/templates`, fakeReq())
  assert.equal(r.status, 200)
  assert.equal(r.json.templates.length, 1, '一条坏 model 不该让整条记录消失')
  const t0 = r.json.templates[0]
  assert.deepEqual(
    Object.keys(t0).sort(),
    ['createdAt', 'goal', 'id', 'mode', 'name', 'updatedAt', 'workspace'].sort(),
    `字段集不符：${JSON.stringify(t0)}`,
  )
  // model 带未知键（apiKey）→ 只丢这个字段，记录本身保留
  assert.equal('model' in t0, false, '坏 model 应被丢掉（而不是带着 apiKey 出边界）')
  for (const bad of ['nt_secret123', 'sk-secret', 'unknownField', 'apiKey']) {
    assert.ok(!r.body.includes(bad), `响应体不应含 ${bad}`)
  }
})

test('UI 路由：模板里的可选字段**缺就省略**（不给 null/空串）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  const env = makeRouteEnv({ templatesFile: file })
  t.after(() => { for (const d of env.disposers) d() })

  await env.call(`${UI}/templates/save`, fakeReq({ method: 'POST', body: { name: '极简', goal: 'g' } }))
  const r = await env.call(`${UI}/templates`, fakeReq())
  const t0 = r.json.templates[0]
  // 面板据此判断"这条模板有没有预设 workspace"；空串会渲染成一个假的预设值
  assert.equal('workspace' in t0, false)
  assert.equal('outputs' in t0, false)
  assert.equal('model' in t0, false)
  assert.equal('timeoutMs' in t0, false)
  assert.equal(t0.mode, 'agent')
})

test('UI 路由：方法约束（GET 路由拒 POST，POST 路由拒 GET）', async (t) => {
  const root = tmpRoot(t)
  const env = makeRouteEnv({ templatesFile: path.join(root, TEMPLATES_FILE_NAME) })
  t.after(() => { for (const d of env.disposers) d() })

  const g = await env.call(`${UI}/templates`, fakeReq({ method: 'POST', body: {} }))
  assert.equal(g.status, 405)
  assert.equal(g.json.error, 'method')

  for (const p of [`${UI}/templates/save`, `${UI}/templates/delete`]) {
    const r = await env.call(p, fakeReq({ method: 'GET' }))
    assert.equal(r.status, 405, `GET ${p} 应 405`)
    assert.equal(r.json.error, 'method')
  }
})

test('UI 路由：坏 body / 非法输入 / 未知 id 的状态码', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  const env = makeRouteEnv({ templatesFile: file })
  t.after(() => { for (const d of env.disposers) d() })

  // 非 JSON
  const bad = await env.call(`${UI}/templates/save`, fakeReq({ method: 'POST', body: 'not-json' }))
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'bad-body')

  // JSON 但不是对象
  const arr = await env.call(`${UI}/templates/save`, fakeReq({ method: 'POST', body: '[1,2]' }))
  assert.equal(arr.status, 400)
  assert.equal(arr.json.error, 'bad-body')

  // 合法 JSON、字段非法 → 400 + 稳定 code（message 是人话，且不含路径）
  const unknown = await env.call(`${UI}/templates/save`, fakeReq({
    method: 'POST',
    body: { name: 'n', goal: 'g', denyPaths: ['/etc'] },
  }))
  assert.equal(unknown.status, 400)
  assert.equal(unknown.json.error, 'template-unknown-field')
  assert.ok(!unknown.body.includes('\\'), '错误消息不该带主机路径')

  // 未知 id → 404
  const gone = await env.call(`${UI}/templates/delete`, fakeReq({ method: 'POST', body: { id: 'tpl_nope' } }))
  assert.equal(gone.status, 404)
  assert.equal(gone.json.error, 'template-unknown')

  // 服务仍然可用（没被打挂）
  assert.equal((await env.call(`${UI}/templates`, fakeReq())).status, 200)
  assert.equal(fs.existsSync(file), false, '被拒的写入不得落盘')
})

test('UI 路由：模板库降级时 list 如实报 degraded（面板据此提示）', async (t) => {
  const root = tmpRoot(t)
  const file = path.join(root, TEMPLATES_FILE_NAME)
  fs.writeFileSync(file, '{broken', 'utf8')
  const log = collector()
  const env = makeRouteEnv({ templatesFile: file, log })
  t.after(() => { for (const d of env.disposers) d() })

  const r = await env.call(`${UI}/templates`, fakeReq())
  assert.equal(r.status, 200, '降级不是错误：面板仍要能打开')
  assert.equal(r.json.degraded, true)
  assert.equal(r.json.reason, 'invalid-json')
  assert.deepEqual(r.json.templates, [])

  // 保存能就地恢复
  const s = await env.call(`${UI}/templates/save`, fakeReq({ method: 'POST', body: { name: '新', goal: 'g' } }))
  assert.equal(s.status, 200)
  assert.equal(s.json.recovered, true)
  assert.equal((await env.call(`${UI}/templates`, fakeReq())).json.degraded, false)
})

test('UI 路由：未传 uiTemplatesFile 时退回 config.stateDir 下的默认文件名', async (t) => {
  const root = tmpRoot(t)
  const stateDir = path.join(root, 'hub-state')
  const c = makeCtx()
  const disposers = registerUiRoutes({
    ctx: c.ctx,
    registry: { list: () => [], listTasks: () => [], getTask: () => undefined, getNode: () => null, taskView: (x) => x },
    pulls: { activeCount: 0, pull: async () => ({}) },
    log: () => {},
    defaults: {},
    pullRoot: '',
    config: { role: 'hub', stateDir },
  })
  t.after(() => { for (const d of disposers) d() })

  const handler = c.routes.get(`${UI}/templates`)
  const res = fakeRes()
  await handler(fakeReq(), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.json.file, path.join(stateDir, TEMPLATES_FILE_NAME))

  // 真的存进去 → 落在 stateDir 下
  const save = c.routes.get(`${UI}/templates/save`)
  const res2 = fakeRes()
  await save(fakeReq({ method: 'POST', body: { name: 'x', goal: 'g' } }), res2)
  assert.equal(res2.out.status, 200)
  assert.ok(fs.existsSync(path.join(stateDir, TEMPLATES_FILE_NAME)), '应落在 config.stateDir 下')
})

/* ══════════════════════════════════════════════════════════════════
 * 9. 客户端契约（模板 UI 的三个控件真的接线了）
 *
 * 为什么要有这一组：API 存在而面板没接 = 假功能。这里只做**文本断言**
 * （不跑浏览器），钉的是"接线存在"，与 worker-panel.test.js 同一手法。
 * ══════════════════════════════════════════════════════════════════ */

const CLIENT_SRC = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('client：模板下拉 + 存为模板 + 删除三个控件都在派发表单里', () => {
  const code = stripComments(CLIENT_SRC)
  assert.match(code, /apiGet\('\/templates'\)/, '应拉模板列表')
  assert.match(code, /apiPost\('\/templates\/save'/, '应调用保存路由')
  assert.match(code, /apiPost\('\/templates\/delete'/, '应调用删除路由')
  assert.match(code, /function applyTemplate\(/, '应有一键填充函数')
  assert.match(code, /function saveTemplate\(/, '应有保存为模板函数')
  assert.match(code, /function deleteTemplate\(/, '应有删除模板函数')
  // 三个控件都在 dispatchForm 里（不在别的区块）
  const i = code.indexOf('const dispatchForm =')
  const seg = code.slice(i, i + 4200)
  assert.match(seg, /dra-tplrow/, '模板行应在派发表单内')
  assert.match(seg, /'存为模板'|'更新模板'/, '应有「存为模板」按钮')
  assert.match(seg, /'删除模板'/, '应有「删除」按钮')
  assert.match(seg, /onChange: function \(e\) \{ applyTemplate\(e\.target\.value\) \}/, '下拉选中即填充')
})

test('client：一键填充会**清空**可选字段（不能拿 A 模板的目录跑 B 模板）', () => {
  const code = stripComments(CLIENT_SRC)
  const i = code.indexOf('function applyTemplate(')
  const seg = code.slice(i, i + 2200)
  // 三条必须显式重置：否则从"带 workspace 的模板"切到"不带的模板"时，
  // 旧目录会留在表单里 —— 任务就跑到上一个模板的目录去了
  assert.match(seg, /n\.workspace = t\.workspace \|\| ''/, 'workspace 必须显式重置')
  assert.match(seg, /n\.outputs = \(t\.outputs \|\| \[\]\)\.join\(', '\)/, 'outputs 必须显式重置')
  assert.match(seg, /n\.timeoutMs = t\.timeoutMs \? String\(t\.timeoutMs\) : ''/, 'timeoutMs 必须显式重置')
  // model 是对象，必须拼成 provider/model 字符串（否则显示 [object Object]）
  assert.match(seg, /m\.provider \? \(m\.provider \+ '\/' \+ \(m\.model \|\| ''\)\)/, 'model 必须拼成可编辑字符串')
})

test('client：模板里的 timeoutMs 进了 /dispatch 的请求体', () => {
  const code = stripComments(CLIENT_SRC)
  const i = code.indexOf('function dispatch()')
  const seg = code.slice(i, i + 1400)
  assert.match(seg, /timeoutMs: timeoutMs/, '超时字段必须进请求体')
  assert.match(seg, /Number\.isFinite\(tmo\) && tmo > 0 \? tmo : undefined/, '空/非法值不传（让服务端用默认）')
})

test('client：模板状态不进 4 秒轮询（避免打断正在编辑的下拉框）', () => {
  const code = stripComments(CLIENT_SRC)
  // 模板只在自己的 useEffect（依赖 [setTpl]）里拉一次 + 保存后按需重拉
  const i = code.indexOf("apiGet('/templates')")
  assert.ok(i >= 0, '应有模板拉取')
  const seg = code.slice(i, i + 1600)
  assert.match(seg, /\}, \[setTpl\]\)/, '模板拉取的依赖数组只该有 setTpl（不含 tick）')
})
