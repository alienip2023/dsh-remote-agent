/**
 * 任务视图累积的自锁回归（2026-10-15 实测踩到）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 症状
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 连续派几十条任务后，节点彻底不可用：
 *
 *     Error: node newland already holds 64 tasks (maxTasksPerNode=64)
 *
 * **连"派一条清理命令"都做不到** —— 自锁。唯一解法是人工去副机删文件。
 *
 * ── 两个根因 ────────────────────────────────────────────────────────────
 *
 * 1. **上限按历史累计算**：`rec.tasks.size` 含**终态**任务，而那些任务只在
 *    副机的 `task/sync` 不再上报时才被移除 —— 副机 TaskStore 默认保留 7 天。
 *    于是"限制并发"变成了"限制历史总量"。
 * 2. **没有主动清理**：视图只增不减，必然撞上限。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * - `createTask` 按**非终态**任务数判断上限
 * - `applySync` 顺手清「终态 + 超过 taskViewRetainMs」的视图
 * - `purgeTasks()` 提供立即清理（`remote_purge` 工具 + 面板「清理」按钮）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 剥注释（本项目注释常引用被讨论的代码，位置断言必须先剥）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const registry = read('lib/hub/node-registry.js')
// P1-4：applySync/applyView 已随帧摄入段拆到 registry-ingest.js，文本锚点跟着走
const registryIngest = read('lib/hub/registry-ingest.js')
const tools = read('lib/hub/tools.js')
const ui = read('lib/hub/ui-routes.js')
const client = read('lib/client.js')
const hubIndex = read('lib/hub/index.js')

/* ─────────────── 1. 上限必须按"在跑的任务"算 ─────────────── */

test('createTask：上限必须按非终态任务数判断（不能按 rec.tasks.size）', () => {
  const code = stripComments(registry)
  const i = code.indexOf('createTask({ nodeId, spec }) {')
  assert.ok(i >= 0, '应存在 createTask')
  // ⚠ 花括号配对必须从**方法体的第一个 `{`** 开始 —— 直接从 `i` 找会把
  // `createTask({ nodeId, spec })` 里的**参数对象**当成函数体起点，body 变空
  // （第一版就是这样，断言误报）。所以先跳过参数列表。
  const parenEnd = code.indexOf(')', i)
  const braceStart = code.indexOf('{', parenEnd)
  assert.ok(braceStart > 0, '找不到方法体的起始花括号')
  let depth = 0
  let end = -1
  for (let k = braceStart; k < code.length; k += 1) {
    if (code[k] === '{') depth += 1
    else if (code[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  assert.ok(end > 0, 'createTask 花括号配对失败')
  const body = code.slice(i, end)
  assert.ok(body.length > 300, `body 太短（${body.length}）—— 配对可能又错了`)

  // ⚠ 关键：不能直接比较 rec.tasks.size（它含终态）
  assert.ok(
    !/rec\.tasks\.size\s*>=/.test(body),
    '上限判断不能用 rec.tasks.size —— 它含终态任务，会让"限制并发"变成"限制历史总量"',
  )
  // 必须按状态过滤
  assert.match(body, /TERMINAL_STATUS\.has\(/, '应按终态过滤后再计数')
  assert.match(body, /activeCount/, '应有明确的 activeCount 概念')
  // 报错信息也要说清是 active
  assert.match(body, /active tasks/, '错误信息应说明是 active 而非累计')
})

test('createTask：错误信息要能区分"在跑的满了"与"历史多了"', () => {
  const code = stripComments(registry)
  const i = code.indexOf('createTask({ nodeId, spec }) {')
  const seg = code.slice(i, i + 2500)
  // 旧文案是 "already holds N tasks" —— 会让人以为要删历史
  assert.ok(
    !/already holds \$\{/.test(seg),
    '旧文案 "already holds N tasks" 会误导（应说 active）',
  )
})

/* ─────────────── 2. 自动清理 ─────────────── */

test('applySync：必须自动清理超过保留期的终态视图', () => {
  const code = stripComments(registryIngest)
  // ⚠ 必须锚**定义处**（\n + 4 空格缩进的方法签名）：裸 indexOf('applySync(')
  // 先命中的是帧分发里的调用点 `this.applySync(nodeId, d)`，从那里截固定
  // 长度窗口 —— 窗口只要大于"调用点到清理逻辑"的行距就能过，而这个距离会
  // 随 ingest 文件里其他 case 的增删而漂移（2026-10-17 加 RESOURCE 的
  // queue/defaultModel 上报就把 6000 字符窗口顶爆，断言假挂）。
  const i = code.indexOf('\n    applySync(nodeId, d) {')
  assert.ok(i >= 0, '应存在 applySync 定义')
  const seg = code.slice(i, i + 6000)
  assert.match(seg, /taskViewRetainMs/, '应用保留期配置')
  assert.match(seg, /TERMINAL_STATUS\.has\(t\.status\)/, '只清终态')
  // 必须真的删（两个表都要删，否则视图与索引不一致）
  assert.match(seg, /rec\.tasks\.delete\(taskId\)/, '要删节点侧')
  assert.match(seg, /this\.tasks\.delete\(taskId\)/, '要删全局侧')
})

test('保留期必须是有限正数且远短于副机的 7 天', () => {
  const code = stripComments(hubIndex)
  assert.match(code, /taskViewRetainMs:\s*numOr\([^,]+,\s*60\s*\*\s*60\s*\*\s*1000\)/, '默认 1 小时')
  // 副机 TaskStore 保留 7 天；hub 视图必须比它短，否则又累积
  const sevenDays = 7 * 24 * 60 * 60 * 1000
  const oneHour = 60 * 60 * 1000
  assert.ok(oneHour < sevenDays, 'hub 视图保留期应远短于副机的 7 天')
})

/* ─────────────── 3. 立即清理入口 ─────────────── */

test('registry：purgeTasks 存在且只清视图、不碰副机', () => {
  const code = stripComments(registry)
  const i = code.indexOf('purgeTasks(')
  assert.ok(i >= 0, '应存在 purgeTasks')
  const seg = code.slice(i, i + 2500)
  assert.match(seg, /TERMINAL_STATUS\.has\(/, '默认只清终态')
  assert.match(seg, /includeActive/, '应有 includeActive 开关')
  // 两个表都要清
  assert.match(seg, /this\.tasks\.delete\(taskId\)/, '要清全局索引')
  assert.match(seg, /rec\.tasks\.delete\(taskId\)/, '要清节点侧')
  // 不该有任何发给副机的帧（它只清视图）
  assert.ok(
    !/this\.send\(/.test(seg),
    'purgeTasks 不得给副机发任何帧 —— 副机是任务状态的权威',
  )
})

test('tools：remote_purge 已注册，且走 reg() 收口', () => {
  assert.match(tools, /name:\s*'remote_purge'/, '应有 remote_purge 工具')
  const i = tools.indexOf("name: 'remote_purge'")
  const start = tools.lastIndexOf('\n  reg({', i)
  assert.ok(start >= 0, 'remote_purge 应通过 reg({...}) 注册（否则返回值不被净化）')
})

test('ui-routes：有 purge 路由且方法限制为 POST', () => {
  assert.match(ui, /UI_API_PREFIX\}\/purge/, '应有 /purge 路由')
  const i = ui.indexOf('UI_API_PREFIX}/purge')
  const seg = ui.slice(i, i + 900)
  assert.match(seg, /req\.method !== 'POST'/, '应限制 POST')
  // 显式 node 时校验存在 —— 否则静默清 0 条
  assert.match(seg, /pickNode\(wanted\)/, '指定 node 时应校验存在')
})

test('client：面板有「清理」按钮且带确认', () => {
  assert.match(client, /apiPost\('\/purge'/, '面板应调用 /purge')
  const i = client.indexOf("apiPost('/purge'")
  // ⚠ 确认框在 apiPost **之前**，但中间隔着注释与 setNote —— 窗口要够大，
  // 而且必须剥注释后再找 `window.confirm(`（注释里也提到了它）。
  const before = stripComments(client.slice(Math.max(0, i - 1200), i))
  assert.match(before, /window\.confirm\(/, '清理应有确认（它会清掉已结束任务的视图）')
  // 按钮文案：剥注释后应能在 apiPost 附近找到「清理」
  const around = stripComments(client.slice(Math.max(0, i - 400), i + 400))
  assert.match(around, /'清理'/, '按钮文案应是「清理」')
})

/* ─────────────── 4. 文档同步 ─────────────── */

test('README / check-doc-drift 已同步第 8 个工具', () => {
  // 漂移检查里应该有 purge 的断言（若没有，说明文档面漏了）
  const drift = read('scripts/check-doc-drift.mjs')
  const hasPurge = /remote_purge|purgeTasks|\/purge/.test(drift)
  assert.ok(hasPurge, 'check-doc-drift 应锁住 purge 的存在（防文档漂移）')
})

/* ─────────────── 5. 自动清理分支的行为回归（eslint no-undef 抓到的真 bug） ─────────────── */

test('applySync 自动清理：终态超期视图被清，且分支内无未定义引用', async (t) => {
  // 回归背景：清理分支用了 lib/hub/index.js 的私有 numOr，本文件没定义 ——
  // 分支一走到就 ReferenceError（此前测试只做文本断言，从没真正执行过它）。
  // retainMs=1ms 让任何终态任务立刻超期；ackTimeoutMs=0 让在途宽限不挡清理。
  const { NodeRegistry } = await import('../lib/hub/node-registry.js')
  const registry = new NodeRegistry({
    log: () => {},
    limits: { taskViewRetainMs: 1, ackTimeoutMs: 0, helloTimeoutMs: 10_000 },
  })
  const conn = { send: () => {}, close: () => {} }
  const rec = registry.ingestHello({
    helloData: { nodeId: 'node-prune', protocol: 1, os: 'windows', nonce: '', time: Date.now() },
    conn,
    transport: 'direct',
    pending: undefined,
  })
  assert.ok(rec, 'hello 应登记成功')

  const old = Date.now() - 60_000
  registry.applySync('node-prune', {
    tasks: [{ taskId: 'task-old', status: 'completed', endedAt: old, mode: 'exec' }],
  })
  // 分支执行本身不抛（修复前这里 ReferenceError: numOr is not defined）
  assert.ok(!registry.tasks.has('task-old'), '超期终态任务视图应被清掉')
  assert.ok(!rec.tasks.has('task-old'), '节点视图里的同一条也应被清掉')

  // 对照组：刚结束的任务不被清（保留期语义，remote_status 还要能查到）
  registry.applySync('node-prune', {
    tasks: [{ taskId: 'task-fresh', status: 'completed', endedAt: Date.now(), mode: 'exec' }],
  })
  assert.ok(registry.tasks.has('task-fresh'), '刚结束的任务应保留到保留期之后')
})
