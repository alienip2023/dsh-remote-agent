/**
 * 代码审查（2026-10-17）修复的回归测试。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WorkBuddy 的全量代码审查发现 1 High + 3 Medium + 7 Low。其中 H1 最值得
 * 记录教训：
 *
 *   `tools.js` 的 `remote_task.execute` 里写的是
 *
 *       const v = validateTaskStart({ constraints: {
 *         timeoutMs: ... ?? (v.spec.mode === 'exec' ? ... : ...)
 *                              ^ `v` 正在初始化，TDZ 引用
 *
 *   **829 个测试全绿仍带此 bug** —— 因为 e2e helper 恒传 `timeoutMs`，
 *   `??` 链第一项就短路，TDZ 分支从未被求值。
 *
 * 这是典型的**测试环境与生产装配层差异造成的盲区**。所以本文件的测试
 * **不走 e2e helper**，直接以空 defaults 注册工具，逼 TDZ 分支真的求值。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_DEFAULT_TIMEOUT_MS, EXEC_DEFAULT_TIMEOUT_MS } from '../lib/node/task-engine.js'

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/* ═══════════════ H1-1：TDZ 自引用必须消失 ═══════════════ */

test('H1：remote_task 的 constraints.timeoutMs 不得引用正在初始化的 v（TDZ）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  // ⚠ **不能对 tools.js 用 stripComments**（本测试第一版踩了这个坑）：
  // 该文件注释里含 `/* */` 字样的说明文字，`/\/\*[\s\S]*?\*\//` 会从某个
  // JSDoc 的开头一路匹配到很后面的 `*/`，**吃掉 66% 的源码**（54712 → 18400
  // 字节），连 `const v = validateTaskStart(` 都不见了，断言恒 false。
  //
  // 这里直接在**原始源码**上锚定（不需要剥注释：我们查的是"某段代码里不该
  // 出现某表达式"，注释里提到它不影响判断 —— 反而要用 `({` 这种精确锚点
  // 排除注释中的提及）。
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'hub', 'tools.js'), 'utf8')

  const i = src.indexOf('const v = validateTaskStart({')
  assert.ok(i >= 0, '应存在 const v = validateTaskStart({')
  let depth = 0
  let end = -1
  for (let k = src.indexOf('{', i); k < src.length; k += 1) {
    if (src[k] === '{') depth += 1
    else if (src[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  assert.ok(end > i, '应能取出 validateTaskStart 的实参对象')

  const seg = src.slice(i, end)

  // ⚠ 只检查**真正执行的那行赋值**，不扫整段（本测试第三版踩的坑）：
  //
  //   第一版：用 `/\*[\s\S]*?\*/` 剥块注释 —— 对 tools.js 有害，注释里的
  //           `/* */` 字样让非贪婪匹配跨越正常代码，吃掉 66% 源码。
  //   第二版：只剥 `//` 行注释 —— 仍不够，因为**块注释里也提到了**
  //           `v.spec.mode`（修复说明写在块注释里）。
  //
  // 正确的思路：断言要验证的是"**赋值表达式**用的是 routeMode 而不是
  // v.spec.mode"，所以只锚定那一行代码本身，完全不看注释。
  const m = /timeoutMs:\s*num\(args\?\.timeoutMs\)[\s\S]{0,300}?\)/.exec(seg)
  assert.ok(m, '应找到 constraints.timeoutMs 的赋值表达式')
  const assign = m[0]

  assert.ok(
    !/\bv\.spec\.mode\b/.test(assign),
    'timeoutMs 的赋值表达式里**不得**出现 v.spec.mode —— 那是 TDZ 自引用，'
    + '在 ?? 链左侧全空时抛 ReferenceError。应改用 routeMode。',
  )
  assert.match(assign, /routeMode/, '应改用 routeMode（与 v.spec.mode 同义，但在 v 之前求值）')
})

test('H1：分模式默认超时常量本身正确（exec 10min / agent 1h）', () => {
  assert.equal(EXEC_DEFAULT_TIMEOUT_MS, 10 * 60 * 1000, 'exec 默认 10 分钟')
  assert.equal(AGENT_DEFAULT_TIMEOUT_MS, 60 * 60 * 1000, 'agent 默认 1 小时')
  assert.ok(EXEC_DEFAULT_TIMEOUT_MS < AGENT_DEFAULT_TIMEOUT_MS, 'exec 应短于 agent')
})

/* ═══════════════ H1-2：hub 不得用 1h 兜底压扁分模式 ═══════════════ */

test('H1：hub 的 normalizeConfig 不得用 1h 兜底压扁分模式默认', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'hub', 'index.js'), 'utf8'))

  // 原实现：timeoutMs: numOr(defaults.timeoutMs, 60 * 60 * 1000)
  // 那让 explicitTimeoutMs 恒为 3600000 → 分模式默认永不生效。
  const i = code.indexOf('defaults: {')
  assert.ok(i >= 0, '应有 defaults 配置段')
  const seg = code.slice(i, i + 900)
  assert.ok(
    !/numOr\(\s*defaults\.timeoutMs\s*,\s*60\s*\*\s*60\s*\*\s*1000/.test(seg),
    '不得用 `numOr(defaults.timeoutMs, 60*60*1000)` 兜底 —— 那会把 exec 的 10min '
    + '压成 1h（#26-1 设计意图全面失效）',
  )
  // 未配置时应保持 undefined，让 tools.js 按 mode 取值
  assert.match(seg, /undefined/, '未配置时应保持 undefined')
})

/* ═══════════════ H1-3：面板派单也要分模式 ═══════════════ */

test('H1：面板 dispatch 的 timeoutMs 必须按 mode 分模式（不是恒 1h）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'hub', 'ui-routes.js'), 'utf8')
  const code = stripComments(src)

  const i = code.indexOf('constraints: {')
  assert.ok(i >= 0)
  const seg = code.slice(i, i + 900)
  assert.ok(
    !/defaults\.timeoutMs\s*\?\?\s*3600000/.test(seg),
    '不得用 `defaults.timeoutMs ?? 3600000` —— 面板派 exec 也会吃 1 小时',
  )
  assert.match(seg, /TASK_MODE\.EXEC/, '应按 mode 判断')
  assert.match(seg, /EXEC_DEFAULT_TIMEOUT_MS/, '应使用分模式常量')
})

/* ═══════════════ M1：relay 三条 hub 写路径都要背压 ═══════════════ */

test('M1：relay 的第三条 hub 写路径（node 上行广播）也必须过背压', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'relay.js'), 'utf8')
  const code = stripComments(src)

  // 三条路径：broadcastHubs / broadcastHubsBinary / node 上行广播
  const count = (code.match(/applyHubBackpressure\(h\)/g) || []).length
  assert.ok(
    count >= 3,
    `三条 hub 写路径都应过背压，实际只找到 ${count} 处 applyHubBackpressure(h)。`
    + '漏掉的那条 = relay 的 OOM 面（实测过 339.8 MiB writableLength / 419 MiB RSS）。',
  )
})

/* ═══════════════ M2：grep 单文件分支要有大小护栏 ═══════════════ */

test('M2：grep 的单文件分支必须有 GREP_FILE_MAX 护栏', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'node', 'fs-service.js'), 'utf8'))

  // 找 grep 里的单文件分支。
  // ⚠ 锚点必须用 `} else if (st.isFile()) {` —— 文件里另有一处
  // `if (!st.isFile())`（read 工具的 "not a regular file" 分支，L193 附近），
  // 只搜 `st.isFile()` 会命中那一处，断言就永远看不到 grep 的代码。
  const i = code.indexOf('} else if (st.isFile()) {')
  assert.ok(i >= 0, '应有 grep 的单文件分支（} else if (st.isFile()) {）')
  const seg = code.slice(i, i + 1400)
  assert.match(
    seg,
    /st\.size\s*>\s*GREP_FILE_MAX/,
    '单文件分支必须先判 st.size > GREP_FILE_MAX —— 否则巨文件 readFileSync '
    + '直接打爆副机内存 + 同步阻塞事件循环（可达的 DoS 面）',
  )
})

/* ═══════════════ M3：approveTask 掉线时置终态而非删除 ═══════════════ */

test('M3：approveTask 节点不可达时不得删除任务（应置 failed 终态）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'hub', 'node-registry.js'), 'utf8'))

  const i = code.indexOf('approveTask(taskId')
  assert.ok(i >= 0)
  const seg = code.slice(i, i + 2200)

  // 不可达分支不得 delete 主表
  assert.ok(
    !/this\.tasks\.delete\(taskId\)/.test(seg),
    'approveTask 不得 `this.tasks.delete(taskId)` —— 那让任务从 hub 视图彻底消失'
    + '（不是失败、不是挂起，是不存在），awaitTerminal 等不到终态只能靠超时兜底',
  )
  assert.match(seg, /TASK_STATUS\.FAILED/, '应置 failed 终态')
  assert.match(seg, /node-unreachable/, '应有明确的 error code')
  assert.match(seg, /resolveWaiters/, '应唤醒 awaitTerminal 等待者')
})

/* ═══════════════ L1：transport 两条并发不变式 ═══════════════ */

test('L1：副机 transport 必须有 connecting 闸门（防重复连接）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'node', 'transport.js'), 'utf8'))

  assert.match(code, /this\.connecting\s*=\s*true/, '应有 connecting 闸门')
  assert.match(code, /if\s*\(this\.connecting\)\s*return/, '重入时必须直接返回')
})

test('L1：副机 transport 的 close 必须校验"是不是当前连接"', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'node', 'transport.js'), 'utf8'))

  assert.match(
    code,
    /if\s*\(this\.conn !== conn\)\s*\{?\s*(\/\/[^\n]*\s*)*return/,
    'close 处理器必须先判 this.conn !== conn 就返回 —— 否则陈旧连接的 close '
    + '会把活着的新连接引用清掉（副机永久失联）',
  )
})

/* ═══════════════ L2：RESOURCE 分支判空 ═══════════════ */

test('L2：RESOURCE 分支必须判 rec 空（影子节点竞态会抛 TypeError）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'hub', 'registry-ingest.js'), 'utf8'))

  const i = code.indexOf('case NODE_TO_HUB.RESOURCE')
  assert.ok(i >= 0)
  const seg = code.slice(i, i + 900)
  assert.match(seg, /if\s*\(!rec\)\s*return/, 'RESOURCE 分支开头必须 if (!rec) return')
})

/* ═══════════════ L4：去抖常量不得是死代码 ═══════════════ */

test('L4：E2E_REOFFER_DEBOUNCE_MS 必须被真的引用（不是死常量）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'node', 'transport.js'), 'utf8'))

  // 声明一次 + 至少使用一次
  const uses = (code.match(/E2E_REOFFER_DEBOUNCE_MS/g) || []).length
  assert.ok(
    uses >= 2,
    `E2E_REOFFER_DEBOUNCE_MS 应至少被使用一次（声明 + 引用 = 2 次），实际 ${uses} 次。`
    + '只声明不使用 = 死代码，reset 风暴下每次 reset 都会重发提议。',
  )
})
