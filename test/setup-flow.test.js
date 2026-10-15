/**
 * 首次安装的引导（未配置 → 选角色 → 写配置）回归。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景：一个"猜一半错一半"的设计
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 插件**无法自己判断**这台机器是主机还是副机 —— 只有用户知道。而包内
 * `cordis.patch.yml` 必须有某个默认值，无论选哪个都会让一半装机场景是错的：
 *
 *   旧实现默认 `role: hub` → 副机装完以 **hub 身份**启动，注册一个
 *   `nodeToken` 为空、**不校验任何凭证**的直连端点；而且面板不会给任何提示
 *   （它以为自己配好了）。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 *   1. `role` 默认改成 `''`（未配置），且**不再回退 hub**（那会静默开无鉴权入口）
 *   2. 未配置时 `applyHub`/`applyWorker` 都不跑，只注册 `lib/setup-routes.js`
 *      那组引导路由
 *   3. 包内 `inject` 取**最小集** `['webServer']` —— 够注册引导路由
 *   4. 用户选完角色后，**inject 与 role 一起写入**（不会再出现"改了 role
 *      忘了改 inject"）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const indexSrc = read('lib/index.js')
const setupRoutes = read('lib/setup-routes.js')
const client = read('lib/client.js')
const patch = read('cordis.patch.yml')

/* ─────────────── 1. role 默认必须是"未配置" ─────────────── */

test('role 的 schema 允许空值且默认空（不再默认 hub）', () => {
  const code = stripComments(indexSrc)
  // 必须允许空字符串
  assert.match(code, /z\.const\(''\)/, "role 的 union 必须包含 z.const('')")
  // 默认值必须是空 —— 不能是 'hub'
  const m = /role:\s*z[\s\S]{0,400}?\.default\((['"])(.*?)\1\)/.exec(code)
  assert.ok(m, '应能解析出 role 的 default')
  assert.equal(m[2], '', `role 的默认值必须是空字符串（实际 ${JSON.stringify(m[2])}）—— 默认 hub 会让副机装完以 hub 身份启动`)
})

test('resolveRoleDetail：未配置返回 unconfigured，且**不回退 hub**', () => {
  const code = stripComments(indexSrc)
  const i = code.indexOf('export function resolveRoleDetail')
  assert.ok(i >= 0, '应存在 resolveRoleDetail')
  let depth = 0
  let end = -1
  for (let k = code.indexOf('{', i); k < code.length; k += 1) {
    if (code[k] === '{') depth += 1
    else if (code[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  const body = code.slice(i, end)
  // 空值 → unconfigured
  assert.match(body, /unconfigured:\s*true/, '空值应返回 unconfigured')
  assert.match(body, /role:\s*''/, "空值应返回 role: ''")
  // 非法值也不能回退 hub
  assert.ok(
    !/return \{ role: ROLE\.HUB, invalid/.test(body),
    '非法值不得回退 hub —— 那会静默开一个 nodeToken 为空、不校验凭证的直连端点',
  )
})

test('apply：引导路由**始终注册**，未配置时不跑 hub/worker', () => {
  const code = stripComments(indexSrc)
  // 引导路由必须无条件注册 —— 否则已配置的机器无法通过面板改角色。
  // 锚定：registerSetupRoutes 出现在 `if (unconfigured === true)` **之前**。
  const reg = code.indexOf('handles.setup = registerSetupRoutes(')
  const unc = code.indexOf('if (unconfigured === true)')
  assert.ok(reg >= 0, '应注册引导路由')
  assert.ok(unc >= 0, '应有 unconfigured 分支')
  assert.ok(
    reg < unc,
    '引导路由必须在 unconfigured 判断**之前**注册 —— 否则已配置的机器改不了角色',
  )
  // 未配置时仍要直接返回（不继续走 hub/worker）
  const seg = code.slice(unc, unc + 500)
  assert.match(seg, /return handles/, '未配置时应直接返回（不继续走 hub/worker）')
})

/* ─────────────── 2. 引导路由 ─────────────── */

test('setup-routes 提供 state / apply 两个端点', () => {
  assert.match(setupRoutes, /SETUP_API_PREFIX\}\/state/, '应有 state 端点')
  assert.match(setupRoutes, /SETUP_API_PREFIX\}\/apply/, '应有 apply 端点')
})

test('setup-routes 取 webServer 必须属性访问优先（ctx.get 默认 strict 会拿不到）', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // 这个坑实测踩过（2026-10-15），代价是整组引导路由静默不注册
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // cordis 的 `ctx.get(name, strict = true)` **默认只返回"提供者 fiber 当前
  // 活跃"的服务**（源码注释原文："strict — when true, only return
  // implementations whose providing fiber is currently active"）。
  //
  // 而 `registerSetupRoutes` 在 `apply()` 的**早期**被调用，那时 webServer
  // 的提供者 fiber 可能还没激活 → `ctx.get('webServer')` 返回 undefined
  // → 整组路由静默跳过 → `/api/remote-agent/setup/state` 落到 DSH 的
  // `/api` prefix 围栏 → 返回**纯文本** `unauthorized`（与"路径不存在"
  // **完全一样**的响应，实测极难排查：我一度以为路由注册成功但被围栏拦了）。
  //
  // 属性访问 `ctx.webServer` 走 `internal/get` waterfall + fiber store 查找，
  // 能拿到已就绪的服务 —— `applyHub` 用的就是这个形态。
  const code = stripComments(setupRoutes)
  const i = code.indexOf('export function registerSetupRoutes')
  assert.ok(i >= 0, '应存在 registerSetupRoutes')
  const seg = code.slice(i, i + 1800)

  assert.match(seg, /webServer\s*=\s*ctx\.webServer/, '必须优先用 ctx.webServer（属性访问）')
  assert.match(seg, /ctx\.get\('webServer',\s*false\)/, "兜底必须是 ctx.get('webServer', false)（非严格）")
})

test('ui-routes 的 guard 取 connection 也必须属性访问优先', () => {
  const uiRoutes = read('lib/hub/ui-routes.js')
  const code = stripComments(uiRoutes)
  const i = code.indexOf('function makeGuard(ctx, log)')
  assert.ok(i >= 0, '应存在 makeGuard')
  const seg = code.slice(i, i + 1100)
  assert.match(seg, /connection\s*=\s*ctx\.connection/, '必须优先用 ctx.connection')
  assert.match(seg, /ctx\.get\('connection',\s*false\)/, "兜底必须是 ctx.get('connection', false)")
})

test('setup 路由自带同源围栏（exact 绕过 /api prefix 围栏）', () => {
  const code = stripComments(setupRoutes)
  assert.match(code, /function makeGuard\(/, '应定义 guard')
  // fail-closed：围栏自身出错时拒绝
  const i = code.indexOf('function makeGuard(')
  const seg = code.slice(i, i + 1400)
  assert.match(seg, /rejection = 403/, '围栏抛错时应失败关闭')
  assert.match(seg, /requestRejection/, '应复用 connection 的官方围栏')
})

test('setup apply 逐字段构造 YAML（防配置注入）', () => {
  const code = stripComments(setupRoutes)
  const i = code.indexOf('const lines = [')
  assert.ok(i >= 0, '应逐行构造 YAML')
  const seg = code.slice(i, i + 2500)
  // 必须逐字段 push，不能把 body 直接序列化进去
  assert.match(seg, /lines\.push\(/, '应逐行 push')
  assert.ok(!/JSON\.stringify\(body/.test(seg), '不得把请求体直接序列化进 YAML（那是配置注入）')
  // role 必须白名单校验
  assert.match(code, /role !== 'hub' && role !== 'worker' && role !== 'both'/, 'role 必须白名单校验')
  // nodeId 必须正则校验
  assert.match(code, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,63\}\$/, 'nodeId 必须正则校验')
  // 单引号必须转义（YAML 单引号字符串里 '' 是转义）
  assert.match(seg, /replace\(\/'\/g, "''"\)/, 'YAML 单引号值必须转义')
})

test('setup apply 让 inject 跟着 role 走（不再出现改了 role 忘改 inject）', () => {
  const code = stripComments(setupRoutes)
  // worker → tools/agentLoop/sessions
  assert.match(code, /inject: \['tools', 'agentLoop', 'sessions'\]/, 'worker 应写 tools/agentLoop/sessions')
  // hub → webServer/tools/systemPrompt
  assert.match(code, /inject: \['webServer', 'tools', 'systemPrompt'\]/, 'hub 应写 webServer/tools/systemPrompt')
})

test('setup apply 走 writePatchBlock（备份 + 托管块 + 回滚）', () => {
  assert.match(setupRoutes, /import \{ writePatchBlock \} from '\.\/setup\.js'/, '应复用 setup.js 的安全写盘')
  const code = stripComments(setupRoutes)
  assert.match(code, /writePatchBlock\(\{ file, blockYaml/, '应调 writePatchBlock')
})

/* ─────────────── 3. 包内 inject 取最小集 ─────────────── */

test('包内 cordis.patch.yml：inject 只声明 webServer，role 为空', () => {
  // 未配置时只需要 webServer（够注册引导路由）。tools/systemPrompt 会让
  // 缺少它们的组合永远 PENDING —— 而"未配置"恰恰是最需要能激活的状态。
  assert.match(patch, /inject: \['webServer'\]/, "包内 inject 应是最小集 ['webServer']")
  assert.ok(
    !/inject: \['webServer', 'tools', 'systemPrompt'\]/.test(patch),
    '包内 inject 不得含 tools/systemPrompt —— 缺它们的组合会永远 PENDING，连引导都拿不到',
  )
  assert.match(patch, /role: ''/, "包内 role 默认应为空（未配置）")
})

/* ─────────────── 4. client 半的引导视图 ─────────────── */

test('client 有 setup 模式与对应端点常量', () => {
  assert.match(client, /SETUP_STATE_PATH = ['"]\/api\/remote-agent\/setup\/state['"]/, '应定义 SETUP_STATE_PATH')
  assert.match(client, /SETUP_APPLY_PATH = ['"]\/api\/remote-agent\/setup\/apply['"]/, '应定义 SETUP_APPLY_PATH')
  assert.match(client, /mode: 'setup'/, "应支持 mode: 'setup'")
})

test('client 的探测有三层回退：hub → worker → setup', () => {
  const code = stripComments(client)
  const i = code.indexOf("apiGet('/overview')")
  assert.ok(i >= 0, '应有 hub 探测')
  const seg = code.slice(i, i + 3200)
  // 三层都要出现，且顺序正确
  const hub = seg.indexOf("mode: 'hub'")
  const worker = seg.indexOf("mode: 'worker'")
  const setup = seg.indexOf("mode: 'setup'")
  assert.ok(hub >= 0 && worker >= 0 && setup >= 0, '三层回退都应存在')
  assert.ok(hub < worker, 'hub 判定应在 worker 之前')
  assert.ok(worker < setup, 'worker 判定应在 setup 之前')
})

test('client 有 SetupView 组件且能写入', () => {
  assert.match(client, /function SetupView\(/, '应定义 SetupView')
  const code = stripComments(client)
  const i = code.indexOf('function SetupView(')
  const seg = code.slice(i, i + 12000)
  // 三个选择都要有
  assert.ok(seg.includes('我是主机'), '应有「我是主机」')
  assert.ok(seg.includes('我是副机'), '应有「我是副机」')
  assert.ok(seg.includes('同机自测'), '应有「同机自测」')
  // 副机表单要填的字段
  assert.ok(seg.includes('配对码'), '副机表单应有配对码输入')
  assert.ok(seg.includes('工作区'), '副机表单应有工作区输入')
  // 提交走 SETUP_APPLY_PATH
  assert.match(seg, /fetch\(SETUP_APPLY_PATH/, '提交应走 SETUP_APPLY_PATH')
})

test('SetupView 会解析配对码（粘贴即填）', () => {
  const code = stripComments(client)
  const i = code.indexOf('function SetupView(')
  const seg = code.slice(i, i + 12000)
  assert.match(seg, /dshra1:\\\/\\\//, '应识别 dshra1:// 前缀')
  assert.match(seg, /window\.atob\(/, '应 base64 解码')
  // 解析后要填进表单
  assert.match(seg, /n\.hubUrl = d\.hubUrl/, '解析结果应填进 hubUrl')
})

test('SetupView 的结果页提示"重启生效"', () => {
  const code = stripComments(client)
  const i = code.indexOf('function SetupView(')
  const seg = code.slice(i, i + 12000)
  assert.match(seg, /重启 DSH/, '结果页必须提示重启 —— 配置改动不会热生效')
})

/* ─────────────── 5. 切换角色（已配置后改） ─────────────── */

test('setup state 如实报告 configured（面板据此区分引导/切换）', () => {
  const code = stripComments(setupRoutes)
  const i = code.indexOf('/state`')
  assert.ok(i >= 0, '应有 state 端点')
  const seg = code.slice(i, i + 900)
  assert.match(seg, /configured:\s*valid/, 'configured 应由 role 是否有效决定')
  // 判据必须与 lib/index.js 的 resolveRoleDetail 一致（三个合法值）
  assert.match(seg, /role === 'hub' \|\| role === 'worker' \|\| role === 'both'/, '判据应与 resolveRoleDetail 一致')
})

test('client：设置区有「切换角色」按钮', () => {
  const code = stripComments(client)
  assert.match(code, /'切换角色'/, '设置区应有「切换角色」按钮')
  // 点击后应打开 SetupView（不是另写一套写盘逻辑）
  const i = code.indexOf("'切换角色'")
  const seg = code.slice(Math.max(0, i - 600), i + 200)
  assert.match(seg, /setSwitchRole\(true\)/, '点击应打开切换视图')
})

test('client：切换模式复用 SetupView（写盘只有一份实现）', () => {
  const code = stripComments(client)
  // switching 时渲染 SetupView
  const i = code.indexOf('if (switchRole)')
  assert.ok(i >= 0, '应有 switchRole 渲染分支')
  const seg = code.slice(i, i + 1200)
  assert.match(seg, /h\(SetupView,/, '切换应复用 SetupView')
  assert.match(seg, /switching: true/, '应传 switching 标记')
  assert.match(seg, /onCancel/, '应传 onCancel（能退出切换）')
  // 不得出现第二份 fetch(SETUP_APPLY_PATH)
  const applyCount = (code.match(/fetch\(SETUP_APPLY_PATH/g) || []).length
  assert.equal(applyCount, 1, `写盘调用应只有一处（实际 ${applyCount}）—— 重复实现会走偏`)
})

test('SetupView 的 switching 模式回填当前值并显示当前角色', () => {
  const code = stripComments(client)
  const i = code.indexOf('function SetupView(')
  const seg = code.slice(i, i + 1400)
  assert.match(seg, /var switching = props\.switching === true/, '应识别 switching')
  assert.match(seg, /cur\.hubUrl \|\| ''/, '应回填当前 hubUrl')
  assert.match(seg, /cur\.roots/, '应回填当前 roots')
})

test('切换会同时改写 inject（用户不用手动改两处）', () => {
  // 这是切换功能存在的**核心理由**：role 与 inject 联动。
  // 如果切换只改 role 不改 inject，用户会踩"agent 拿不到工具"的坑。
  //
  // ⚠ 断言必须锚定**代码**而不是注释 —— 第一版锚定了一句中文注释，
  // 而 stripComments 正好把它删掉，断言恒假。
  const code = stripComments(setupRoutes)
  const i = code.indexOf('const lines = [')
  assert.ok(i >= 0, '应逐行构造 YAML')
  const seg = code.slice(i, i + 1200)
  // worker 与 hub 各写一份 inject
  assert.match(seg, /if \(role === 'worker'\)/, '应区分 worker')
  assert.match(seg, /lines\.push\("  inject: \['tools', 'agentLoop', 'sessions'\]"\)/, 'worker 的 inject 应被写入')
  assert.match(seg, /lines\.push\("  inject: \['webServer', 'tools', 'systemPrompt'\]"\)/, 'hub 的 inject 应被写入')
  // 且 inject 必须在 config 之前（YAML 里它们是同级字段，顺序不影响解析，
  // 但这里锚定"两份 inject 都在"，防止未来被简化成只写一份）
})
