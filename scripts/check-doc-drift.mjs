/**
 * 文档 vs 实现 字段级比对（可复用收尾检查）。
 *
 * 由来：t12 期间出现过两次「文档写完后实现又改了」造成的漂移（t9 改了
 * ui-routes.js 的 pullRoot 语义与新增 guard 围栏，而文档没跟上）。手工比对
 * 每次都要重新读一遍代码，容易漏。这个脚本把比对固化成 13 项断言，
 * 任何改了 client.js / ui-routes.js 的改动落地后都能一键重跑。
 *
 * 用法：
 *   node scripts/check-doc-drift.mjs          # 只报告
 *   node scripts/check-doc-drift.mjs --json   # 机器可读
 *
 * 退出码：0 = 无漂移；1 = 有漂移（打印逐项结果）。
 *
 * 注意：它比对的是**关键契约**（字段名、默认值、路由、错误码），
 * 不是文档措辞。措辞差异不报，只有"文档说的与实现不符"才报。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const uiRoutes = read('lib/hub/ui-routes.js')
// views.js 是投影共享层（工具路径与 UI 路径共用一份白名单）。
// handoffView/changedView/taskView 等在它里面，不在 ui-routes.js。
const views = read('lib/hub/views.js')
const hubTools = read('lib/hub/tools.js')
const hubIndex = read('lib/hub/index.js')
const client = read('lib/client.js')
const readme = read('profiles/README.md')
const known = read('KNOWN-ISSUES.md')
const pkg = JSON.parse(read('package.json'))

const results = []
const check = (id, label, ok, detail) => results.push({ id, label, ok: Boolean(ok), detail })

/**
 * 取一个具名函数的完整函数体（花括号匹配）。
 *
 * 为什么不能用固定长度窗口：早先断言 15b 用 `slice(idx, idx + 900)`，
 * 而 `handoffView` 函数体有 2260 字符 —— 窗口只覆盖 40%，函数尾部的
 * 注入会被漏掉（假阴性）。固定窗口对"函数体长度会随改动变化"这件事
 * 天然脆弱，必须按花括号配对取完整体。
 */
function bodyOf(src, fnName) {
  const start = src.indexOf(`function ${fnName}`)
  if (start === -1) return ''
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

/**
 * 剥掉块注释与行注释，只留代码。
 *
 * 为什么需要：t9 在注释里写了反例说明「为什么不能 `{ handoff: t.handoff }` 直接回」。
 * 不剥注释时，这句反例会被"裸直出"断言当成真代码命中 —— 造成**假阳性**
 * （干净代码报告漂移）。假阳性比漏报更糟：它会让人开始无视这个脚本。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/* ── 1. /overview 字段 + capabilities 三项 ── */
check('1', '/overview 返回 nodes/counts/capabilities',
  /nodes,/.test(uiRoutes) && /counts:/.test(uiRoutes) && /capabilities:/.test(uiRoutes),
  'ui-routes.js overview handler')
check('2', 'capabilities 含 pull/pullRoot/dispatch 三项',
  /pull:\s*typeof pullRoot/.test(uiRoutes) && /pullRoot:/.test(uiRoutes) && /dispatch:\s*true/.test(uiRoutes),
  'ui-routes.js capabilities')

/* ── 3. pullRoot 未配置回 null（配置层是空串） ── */
check('3', 'API 层 pullRoot 未配置回 null',
  /pullRoot:\s*typeof pullRoot === 'string' && pullRoot !== '' \? pullRoot : null/.test(uiRoutes),
  'ui-routes.js:412 附近')
check('4', '配置层 uiPullRoot 默认空串',
  /uiPullRoot:\s*typeof c\.uiPullRoot === 'string' && c\.uiPullRoot !== '' \? c\.uiPullRoot : ''/.test(hubIndex),
  'hub/index.js:47 附近')
check('5', '文档说明了两层空值差异（配置层 \'\' vs API 层 null）',
  /空值|空串|null/.test(readme) && /uiPullRoot/.test(readme),
  'profiles/README.md 配置节')

/* ── 6. 7 条路由路径 ── */
const UI_PREFIX = '/api/remote-agent/ui'
for (const seg of ['overview', 'nodes', 'tasks', 'task', 'dispatch', 'cancel', 'pull', 'config']) {
  check(`6.${seg}`, `路由 ${UI_PREFIX}/${seg} 已注册`,
    uiRoutes.includes(`\${UI_API_PREFIX}/${seg}`) || uiRoutes.includes(`${UI_PREFIX}/${seg}`),
    'ui-routes.js route 注册')
}
check('7', 'UI_API_PREFIX 常量值正确', uiRoutes.includes(`'${UI_PREFIX}'`), 'ui-routes.js:23 附近')

// /config 是只读的配置视图。断言两条不变量：
//   ① 凭证只以 `*Set` 布尔形式出现（绝不能有明文 token 回给浏览器）
//   ② 客户端读的字段名与 Host 返回的一致（不一致会让面板显示空白但不报错）
check('7a', '/config 只回凭证的 set 布尔，不回明文',
  /nodeTokenSet:/.test(uiRoutes) && /relayTokenSet:/.test(uiRoutes) && !/nodeToken:\s*typeof config\.nodeToken/.test(uiRoutes),
  'ui-routes.js configView')
check('7b', 'client 读 nodeTokenSet（与 Host 字段对齐）',
  /cfg\.nodeTokenSet/.test(client), 'client.js 设置区')

/* ── 8. 方法约束 ── */
check('8', 'GET 路由拒绝非 GET', /method !== 'GET'/.test(uiRoutes), 'ui-routes.js 各 GET route')
check('9', 'POST 路由拒绝非 POST', /method !== 'POST'/.test(uiRoutes), 'ui-routes.js 各 POST route')

/* ── 10. 错误码 ── */
for (const [code, where] of [
  ['pull-disabled', '未配置 uiPullRoot 时 pull 拒绝'],
  ['dest-outside-pull-root', 'dest 越界'],
  ['pull-root-unusable', 'pullRoot 不可用'],
  ['goal-required', 'dispatch 缺 goal'],
  ['node-unknown', 'dispatch 未知节点'],
  ['taskId-and-paths-required', 'pull 缺参数'],
]) {
  check(`10.${code}`, `错误码 ${code}（${where}）`, uiRoutes.includes(`'${code}'`) || uiRoutes.includes(`"${code}"`), 'ui-routes.js')
}

/* ── 11. 请求围栏（t9 新增，t12 曾漏写文档） ── */
check('11', '存在请求围栏 makeGuard',
  /makeGuard/.test(uiRoutes) && /requestRejection/.test(uiRoutes),
  'ui-routes.js guard')
// 围栏必须**真的失败关闭**，不只是"文件里出现过 403 这个词"。
// 早先用 `/403/.test(uiRoutes) && /requestRejection/.test(uiRoutes)` —— 那只是
// "两个词存在即通过"。实测把 catch 里的 `rejection = 403` 改成 `undefined`
// （安全语义反转成"失败放行"）仍然通过 = 假阴性。文件里有 7 处 403、2 处
// `rejection = 403`，所以必须**锚定 catch 分支那一处**。
check('12', '围栏失败关闭（不静默放行）',
  /failing closed[\s\S]{0,200}?\n\s*rejection = 403\b/.test(uiRoutes)
  // 调用点：必须「guard 为假即返回」，但**允许中间夹诊断日志**。
  // 早先写成 `if \(!guard\(req, res, pathname\)\) return` 的单行精确匹配 ——
  // 后来给拒绝路径加了一行 log（`if (...) { log(...); return }`），语义没变
  // （仍是失败关闭）却让断言变红。断言该锚定**语义**而非字面形态：
  // 现在要求「guard 之后、handler 调用之前必须出现 return」，
  // 即无论中间夹什么，拒绝路径都不得继续执行 handler。
  && (() => {
    const i = uiRoutes.indexOf('if (!guard(req, res, pathname))')
    if (i < 0) return false
    const rest = uiRoutes.slice(i, i + 400)
    const retIdx = rest.indexOf('return')
    const handlerIdx = rest.indexOf('await handler(req, res)')
    return retIdx > 0 && (handlerIdx < 0 || retIdx < handlerIdx)
  })(),
  'ui-routes.js guard catch 分支（行首赋值）+ 调用点（失败即 return，允许夹日志）')
check('13', '文档提到路由自带同源/鉴权围栏',
  /围栏/.test(readme),
  'profiles/README.md 第 4 节')

/* ── 14. handoff 投影 ──
 *
 * ⚠ 投影函数已从 ui-routes.js 提取到 lib/hub/views.js（共享层，见该文件说明）。
 * 断言相应改为读 views，并**新增两条**：投影必须真的被两条消费路径调用 ——
 * 这正是重构前漏掉的那半条加固（remote_handoff 曾裸直出 t.handoff）。
 */
check('14', 'handoffView 定义在共享层 views.js',
  /export function handoffView/.test(views),
  'lib/hub/views.js')
check('14b', 'UI 路径调用 handoffView',
  /handoff:\s*handoffView\(/.test(uiRoutes),
  'ui-routes.js 调用点')
// 关键回归：工具路径也必须走投影。
// 工具返回值会进入会话日志，被后续每个请求带上 —— 比 UI 那条路径更该加固。
check('14c', '工具路径（remote_handoff）调用 handoffView，不裸直出',
  /handoff:\s*handoffView\(/.test(hubTools) && !/handoff:\s*t\.handoff\s*[,}]/.test(stripComments(hubTools)),
  'lib/hub/tools.js')
// 同理：registry.taskView（remote_status 用它）必须走共享投影，
// 不能逐字段裸拷贝副机上报的 exit/changed/summary/error。
check('14d', 'registry.taskView 走共享投影（remote_status 不裸拷贝）',
  /taskProjection\(/.test(read('lib/hub/node-registry.js')),
  'lib/hub/node-registry.js')

// 直出形态是代码里的 `handoff: t.handoff`，不是注释里的反例说明。
// 两处踩过的坑：(a) `\b` 在 `)` 前也成立，把 `handoff: handoffView(t.handoff)`
// 误判为直出；(b) 不剥注释时，t9 写的「为什么不能 `{ handoff: t.handoff }` 直接回」
// 这句注释会被当成真代码。所以先剥注释，再匹配。
const uiRoutesCode = stripComments(uiRoutes)
check('15', 'handoff 无裸直出（handoff: t.handoff）',
  !/handoff:\s*t\.handoff\s*[,}]/.test(uiRoutesCode),
  'ui-routes.js 代码区（已剥注释）')
check('15b', 'handoffView 移除了 logs 与 workspace 键',
  (() => {
    // 用花括号匹配取完整函数体，且**两个键都要查**。
    // 早先的写法有两个问题：(a) 900 字符固定窗口只覆盖函数体 40%；
    // (b) 标签说查 logs 与 workspace，正则却只查了 logs。
    const body = bodyOf(views, 'handoffView')
    return body !== '' && !/^\s*logs:/m.test(body) && !/^\s*workspace:/m.test(body)
  })(),
  'lib/hub/views.js handoffView 函数体（花括号匹配，查 logs 与 workspace）')

/* ── 15c. 已清理的冗余监听器不得被补回来 ──
 *
 * KNOWN-ISSUES 第 2 节记录过：hub 的 attachDirect 曾有一层 `conn.socket.on('end')`
 * 兜底，在冻结层（ws.js）修好硬 FIN 处理之后变成冗余，唯一副作用是对端干净 FIN 时
 * 'node socket closed' 日志打两条。清理已完成。
 *
 * 为什么要断言：这段兜底**看起来像是必要的防御**，后来者很容易"好心"补回来。
 * 而它的旧注释（"只监听 close 会让死节点永远在线"）在冻结层修好后已经不成立，
 * 属误导性注释。这条断言保证：要么代码里没有它，要么文档必须同步说明为什么有。
 */
const registrySrc = read('lib/hub/node-registry.js')
const registryCode = stripComments(registrySrc)
// ⚠ 正则形态踩过坑：第一版写 `conn\.socket\??\.on\??\(`，而 `\??` 是贪婪的 ——
// 它会把 `socket?.on?.('end'` 里的 `?` 吃掉，剩下的 `?.on` 无法匹配紧跟的 `\.on`，
// 于是**只认得 `conn.socket.on('end')` 这种不带可选链的写法**，对真实代码
// （`conn.socket?.on?.('end'`）反而漏报。实测：注入回旧实现后断言仍报 OK —— 守了个空。
// 现在改成「conn.socket 到 ('end' 之间只允许可选链符号与空白」，覆盖所有写法。
const SOCKET_END_RE = /conn\.socket[^;\n]{0,24}\(\s*['"`]end['"`]/
check('15c', 'hub 不再补 socket "end" 兜底（冻结层已统一处理）',
  !SOCKET_END_RE.test(registryCode),
  'lib/hub/node-registry.js attachDirect（已剥注释）')
check('15d', 'KNOWN-ISSUES 第 2 节标记为已清理（与实现同步）',
  /##\s*2\.[^\n]*已清理/.test(known),
  'KNOWN-ISSUES.md 第 2 节标题')
// 第 6 节记录测试方法论（等价性判定 / 假绿 / 还原比注入危险 / Windows 编码坑）。
// 它是写给后续维护者的经验，删掉不会让任何测试变红 —— 所以在这里钉住。
check('15e', 'KNOWN-ISSUES 第 6 节记录测试方法论',
  /##\s*6\.[^\n]*测试方法论/.test(known) && /与原实现等价/.test(known) && /U\+FFFD/.test(known),
  'KNOWN-ISSUES.md 第 6 节')
// 第 7 节记录加固轮审计的剩余盲区（真机未覆盖的分支 / 设计取舍 / 自我纠正）。
// 它同样是"删掉不会让测试变红"的经验文档，需要显式守卫。
check('15f', 'KNOWN-ISSUES 第 7 节记录审计结论',
  /##\s*7\.[^\n]*审计结论/.test(known) && /pwsh/.test(known) && /RELAY_QUEUE_BUDGET/.test(known),
  'KNOWN-ISSUES.md 第 7 节')
// 6.3b：变异脚本被 kill 时「还原」步骤一并被跳过 —— 这是真实事故（整个仓库被改坏，
// 且导致 captain 拿坏状态去质疑他人交付物）。它比 6.3 更硬，必须钉住。
check('15g', 'KNOWN-ISSUES 6.3b 记录「kill 致还原被跳过」+ 结构性防御',
  /###\s*6\.3b/.test(known) && /try\/finally/.test(known) && /ALLOW_MUTATE_WORKTREE/.test(known),
  'KNOWN-ISSUES.md 第 6.3b 节')

/* ── 16. client.js 契约 ── */check('16', 'PANEL_KEY 是单符号常量', /PANEL_KEY\s*=\s*'dsh-remote-agent'/.test(client), 'client.js')
check('17', 'sidebar.panellist 用 id: PANEL_KEY', /id:\s*PANEL_KEY/.test(client), 'client.js')
check('18', 'main 用 key: PANEL_KEY', /key:\s*PANEL_KEY/.test(client), 'client.js')
check('19', 'client 侧 API 前缀与 Host 一致',
  client.includes(`'${UI_PREFIX}'`), 'client.js var API')
check('20', '轮询间隔 4 秒（文档已声明）',
  /setInterval\(load,\s*4000\)/.test(client) && /4\s*秒/.test(readme),
  'client.js + README')
check('21', '主题 token 带兜底 currentColor（t11 误报后的加固）',
  /state-idle-primary,currentColor/.test(client), 'client.js')

/* ── 22. 配置字段存在且文档覆盖 ── */
check('22', 'uiEnabled 配置存在且默认 true',
  /uiEnabled:\s*c\.uiEnabled !== false/.test(hubIndex), 'hub/index.js:46 附近')
check('23', '文档提到 uiEnabled 与 uiPullRoot',
  /uiEnabled/.test(readme) && /uiPullRoot/.test(readme), 'profiles/README.md')

/* ── 24. package.json 的 client 声明 ── */
check('24', 'dsh.client.platform 为 web',
  pkg.dsh?.client?.platform === 'web', 'package.json')
check('25', 'exports["./client"] 指向 lib/client.js',
  pkg.exports?.['./client'] === './lib/client.js', 'package.json')
check('26', 'KNOWN-ISSUES 记录了 combo 路由与 404 正常性',
  /combo/.test(known) && /404/.test(known), 'KNOWN-ISSUES.md 第 4 节')

/* ── 27. 文档声明的 DSH 版本 ──
 *
 * 这个版本号**必须**与实际验证过的 DSH 一致 —— 早先这里写的是 "44.0.0"，
 * 而实测环境是 0.2.0-rc.2。断言当时也跟着写错，等于没防。
 * 现在锚定到真实版本；升 DSH 时两边一起改。
 */
check('27', 'KNOWN-ISSUES 声明了验证的 DSH 版本（0.2.0-rc.2）',
  /0\.2\.0-rc\.2/.test(known), 'KNOWN-ISSUES.md')

/* ── 28. 长期维护项目的基本设施 ──
 *
 * 这些文件不参与运行，但缺了会让项目难以被他人接手。
 * 断言存在性即可 —— 内容质量靠人工评审，没法自动判断。
 */
const MAINT_FILES = [
  ['CHANGELOG.md', '记录每个修复的根因，0.x 期间升级前必读'],
  ['CONTRIBUTING.md', '贡献指南（含会静默失败的陷阱）'],
  ['SECURITY.md', '安全策略与部署检查清单'],
  ['.editorconfig', '统一编辑器行为（行尾/编码/缩进）'],
  ['.github/workflows/ci.yml', 'CI：打包自洽 + 文档漂移 + 测试'],
  ['.github/PULL_REQUEST_TEMPLATE.md', 'PR 模板'],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', 'Bug 报告模板'],
  ['.github/ISSUE_TEMPLATE/feature_request.yml', '功能请求模板'],
]
for (const [i, [file, why]] of MAINT_FILES.entries()) {
  check(`28.${i + 1}`, `维护设施存在：${file}`,
    fs.existsSync(path.join(ROOT, file)), why)
}

/* ── 29~31. 副机配置必须写明 inject: [] ──
 *
 * 部署必读：包内 patch 给 remote-agent 行声明了
 * inject: ['webServer','tools','systemPrompt']（hub 需要），而副机没有这些服务。
 * 不清空的话该行永远停在 PENDING、永不激活 —— 副机永远不拨入，
 * 且没有任何报错（实测踩到）。
 */
{
  const workerProfile = read('profiles/worker.cordis.yml')
  const readme = read('README.md')
  check('29', 'profiles/worker.cordis.yml 里有 inject: []',
    /^\s*inject:\s*\[\]\s*$/m.test(workerProfile),
    'profiles/worker.cordis.yml（副机不清空 inject 会永远 PENDING）')
  check('30', 'README 说明了副机为什么要写 inject: []',
    /inject:\s*\[\]/.test(readme) && /PENDING/.test(readme),
    'README.md（副机配置一节）')
  check('31', '包内 cordis.patch.yml 声明了 hub 需要的 inject',
    /inject:\s*\[[^\]]*webServer[^\]]*\]/.test(read('cordis.patch.yml')),
    'cordis.patch.yml')
}

/* ── 32~35. 工具返回值收口层 ──
 *
 * DSH 对工具返回值有两条独立校验（序列化 + schema），两条失败都会让
 * 「已成功的调用」报失败 —— 有副作用却报失败，是最坏的失败形态。
 * 收口层在 reg() 里，必须同时应用 dropNullForSchema 与 toPlainJson，且顺序固定。
 */
{
  const t = read('lib/hub/tools.js')
  check('32', 'tools.js 定义了 dropNullForSchema',
    /function dropNullForSchema/.test(t), 'lib/hub/tools.js')
  check('33', 'tools.js 定义了 toPlainJson',
    /function toPlainJson/.test(t), 'lib/hub/tools.js')
  check('34', 'reg() 里两者都应用且顺序正确（dropNull 在内层）',
    (() => {
      const i = t.indexOf('const reg = (definition) => {')
      if (i < 0) return false
      // 边界用花括号配对 —— 不能用 `\n  }`，reg 内部有更深缩进的 `}` 会截断 body。
      let depth = 0
      let end = -1
      for (let k = t.indexOf('{', i); k < t.length; k += 1) {
        if (t[k] === '{') depth += 1
        else if (t[k] === '}') {
          depth -= 1
          if (depth === 0) { end = k + 1; break }
        }
      }
      if (end < 0) return false
      const body = t.slice(i, end)
      // ⚠ 顺序检查不能比较字符串位置：源码里写的是
      //     return toPlainJson(dropNullForSchema(value, schema))
      // `toPlainJson(` 在**源码位置上更靠前**，但执行顺序是**从内到外** ——
      // 先 dropNullForSchema，再 toPlainJson。所以必须断言**嵌套关系**。
      // （第一版用了 indexOf 比较位置，恒为 false，是假断言。）
      return /toPlainJson\(\s*dropNullForSchema\(value,\s*schema\)\s*\)/.test(body)
    })(),
    'lib/hub/tools.js 的 reg()（dropNullForSchema 必须在 toPlainJson 内层）')
  check('35', '有工具返回值出边界的回归测试',
    fs.existsSync(path.join(ROOT, 'test', 'tool-output-plain.test.js')),
    'test/tool-output-plain.test.js')
}

/* ── 36~40. 小白向导（lib/setup.js + bin/dsh-remote-setup.js） ──
 *
 * 向导的存在意义是"小白不看细节也能配好"，所以它的关键承诺必须钉住：
 *   - README 有五分钟上手入口（否则向导等于不存在）
 *   - 生成器替用户填好 inject: []（部署失败头号坑）
 *   - doctor 每条失败检查都带修法（只报问题不给修法等于没查）
 *   - worker 的连接错误有"人话翻译"（小白看到 ECONNREFUSED 会直接放弃）
 *   - package.json 声明了 bin 入口（否则 npm 包里找不到命令）
 */
{
  const rootReadme = read('README.md')
  const setupLib = read('lib/setup.js')
  const nodeIndex = read('lib/node/index.js')
  check('36', 'README 有「五分钟上手」且提到向导与 --doctor',
    /五分钟上手/.test(rootReadme) && /--doctor/.test(rootReadme) && /dsh-remote-setup/.test(rootReadme),
    'README.md 五分钟上手一节')
  check('37', 'package.json 声明了 dsh-remote-setup 的 bin 入口且文件存在',
    pkg.bin?.['dsh-remote-setup'] === './bin/dsh-remote-setup.js'
      && fs.existsSync(path.join(ROOT, 'bin', 'dsh-remote-setup.js')),
    'package.json bin + bin/dsh-remote-setup.js')
  check('38', '生成器替用户填好 inject: []（worker 片段必须自带）',
    /inject:\s*\[\]/.test(setupLib),
    'lib/setup.js buildWorkerYaml')
  check('39', 'doctor 检查结果带修法（chk 的 fix 字段被 renderDoctor 输出）',
    /怎么修/.test(setupLib) && /fix: ok \? '' : fix/.test(setupLib),
    'lib/setup.js chk/renderDoctor')
  check('40', 'worker 连接错误走 friendlyConnectError 人话翻译',
    /friendlyConnectError/.test(nodeIndex),
    'lib/node/index.js error 监听')
  check('41', 'README 工具表声明了 model 参数',
    /model/.test(rootReadme) && /normalizeModelSelection/.test(read('lib/protocol.js')),
    'README.md remote_task 参数表 + lib/protocol.js')
}

/* ── 42~44. 配对码（lib/pairing.js） ──
 *
 * 配对码的核心承诺必须钉住：
 *   - README 有用法入口（否则这个功能等于不存在）
 *   - worker 启动路径真的展开 pair（只在 lib/pairing.js 里定义而没接线 = 假功能）
 *   - 向导真的生成配对码（encodePairCode 必须被 bin 引用）
 *   - "显式配置优先" 与 "roots 不进配对码" 两条安全语义要在文档里说清
 */
{
  const pairing = read('lib/pairing.js')
  const nodeIndex = read('lib/node/index.js')
  const setupBin = read('bin/dsh-remote-setup.js')
  const rootReadme = read('README.md')
  check('42', 'README 说明了配对码（dshra1://）与显式配置优先/roots 不进码的安全语义',
    /dshra1:\/\//.test(rootReadme) && /显式配置优先/.test(rootReadme) && /roots.*不在配对码|roots 不在配对码/.test(rootReadme),
    'README.md 副机配置一节')
  check('43', 'worker 启动路径真的展开 pair（expandPairConfig 被接线）',
    /expandPairConfig/.test(nodeIndex) && /export function expandPairConfig/.test(pairing),
    'lib/node/index.js startWorker + lib/pairing.js')
  check('44', '向导生成/解析配对码（encodePairCode 与 decodePairCode 均被 bin 引用）',
    /encodePairCode/.test(setupBin) && /decodePairCode/.test(setupBin),
    'bin/dsh-remote-setup.js')
  check('44b', '配对码解析失败永不抛（结构化 error，worker 只降级）',
    /export function decodePairCode/.test(pairing) && /return \{ ok: false, error/.test(pairing),
    'lib/pairing.js decodePairCode')
}

/* ── 45~47. 面板 GUI 化（pair-info + dispatch 模型输入） ──
 *
 * 零终端小白的图形入口承诺必须钉住：
 *   - /pair-info 路由存在且 token 披露边界（loopback-only 全码）不被"好心"放宽
 *   - 面板真的有"副机接入"入口与 pair 复制按钮（API 存在而面板没接 = 假功能）
 *   - dispatch 表单的模型输入真的进请求体
 */
{
  const client = read('lib/client.js')
  const rootReadme = read('README.md')
  check('45', '/pair-info 路由存在，token 披露仅限回环（策略不被放宽）',
    /pair-info/.test(uiRoutes) && /loopback/.test(uiRoutes) && /remoteAddress/.test(uiRoutes),
    'lib/hub/ui-routes.js pair-info（loopback 判定 + remoteAddress 读取）')
  check('46', '面板有副机接入入口与 pair 复制按钮（GUI 落点真实存在）',
    /副机接入/.test(client) && /复制 pair 配置行/.test(client) && /loadPair/.test(client),
    'lib/client.js 副机接入卡片')
  check('47', 'dispatch 表单的模型输入进请求体，README 说明面板两条入口',
    /model:\s*fv\.model/.test(client) && /副机接入/.test(rootReadme) && /模型/.test(rootReadme),
    'lib/client.js dispatch + README.md')
}

/* ── 48. Windows 双击入口 ──
 *
 * 零终端用户的第一道墙是"开终端"。启动器文件有两条硬规矩：
 *   内容必须 ASCII（cmd.exe 按 OEM 码页解析批处理，非 ASCII 必乱码），
 *   行尾必须 CRLF（LF-only 的批处理有解析边缘案例）。
 * 文件名可以是中文（NTFS 是 Unicode），用字节级断言钉住这两条。
 */
{
  const cmdPath = path.join(ROOT, 'bin', '双击运行-配置向导.cmd')
  const ok48 = (() => {
    if (!fs.existsSync(cmdPath)) return false
    const buf = fs.readFileSync(cmdPath)
    if (buf.some((b) => b > 127)) return false // 内容 ASCII
    if (!buf.includes(Buffer.from('@echo off\r\n'))) return false // CRLF
    return buf.includes(Buffer.from('dsh-remote-setup.js')) // 确实启动向导
  })()
  check('48', 'Windows 双击入口存在且 ASCII/CRLF 规范，README 有双击路径',
    ok48 && /双击/.test(read('README.md')),
    'bin/双击运行-配置向导.cmd + README.md')
}

/* ── 49. 真实运行时自检工具与 KNOWN-ISSUES 验证记录 ──
 *
 * 打活 hub 的自检脚本（独立 OS 进程 worker → 真实 DSH 桌面 hub）是
 * "发布前跑一遍"的入口，必须存在；KNOWN-ISSUES 第 8 节记录实测边界
 * （哪些验了/哪些要人肉/哪些要两台真机），删了会让"待实机确认"的
 * 状态重新变成没人说得清的黑箱。
 */
check('49', '真实运行时自检脚本存在，KNOWN-ISSUES 第 8 节记录验证边界',
  fs.existsSync(path.join(ROOT, 'scripts', 'e2e-live-check.mjs'))
  && /e2e-live-check/.test(known) && /##\s*8\./.test(known),
  'scripts/e2e-live-check.mjs + KNOWN-ISSUES.md 第 8 节')

/* ── 输出 ── */
const failed = results.filter((r) => !r.ok)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
} else {
  console.log('=== 文档 vs 实现 字段级比对 ===\n')
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'DRIFT'}  [${r.id}] ${r.label}${r.ok ? '' : `  <- ${r.detail}`}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} 一致`)
  if (failed.length > 0) {
    console.log(`\n⚠ ${failed.length} 处漂移（文档与实现不符）：`)
    for (const f of failed) console.log(`  [${f.id}] ${f.label} —— 依据：${f.detail}`)
  }
}
process.exit(failed.length === 0 ? 0 : 1)
