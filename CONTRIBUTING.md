# 贡献指南

欢迎提 issue 与 PR。这个包的目标是**长期可用** —— 宁可少一个功能，
不要多一个说不清楚的行为。

---

## 快速上手

```bash
git clone https://github.com/zbzbhs/dsh-remote-agent.git
cd dsh-remote-agent

npm install     # 只为验证 lockfile；本包零外部运行时依赖
npm run check   # 打包自洽性 + 文档漂移 + 全部测试
```

**没有构建步骤。** `lib/**` 里的 `.js` 就是 DSH 实际加载的产物（纯 ESM，无转译）。
改完直接跑 `npm run check`。

---

## 提交前必须跑

```bash
npm run check
```

它包含三层：

| 层 | 命令 | 防什么 |
|---|---|---|
| 打包自洽 | `check:packaging` | `files`/`exports`/`bin`/`dsh.bundle.patch` 指向不存在的路径 |
| 文档漂移 | `check:docs` | 改了代码忘了改文档约定（50 条断言）|
| 行为测试 | `test` | 逻辑回归 |

**三层都要绿。** 单独跑测试不够 —— 见下面「文档漂移检查」一节。

---

## 代码约定

### 注释写「为什么」，不写「是什么」

```js
// ✗ 没用：读代码就知道
// 遍历节点列表

// ✓ 有用：记录了踩过的坑
// 这里必须用 ctx.get('subagents') 而不是 ctx.subagents —— cordis 对未声明
// inject 的服务**属性访问会抛错**（不是返回 undefined），实测在 headless
// profile 里让"优雅降级"变成了启动失败。
```

**本项目最值钱的资产是这些注释** —— 每一条都对应一次真实排查。
改动它们覆盖的代码前，先读注释。

### 工具返回值必须能安全出 DSH 边界

**这是最容易踩、后果最严重的坑。**

DSH 对工具返回值有两条独立校验，**两条失败都会让「已成功的调用」报失败**：

| 路径 | 报错 | 拒绝 |
|---|---|---|
| `walkJsonValue` | `value is not lossless JSON` | 类实例 / `undefined` / `NaN` / `Infinity` / `-0` / 循环引用 / 数组带额外属性 |
| `validateJsonSchemaValue` | `"value.x" must be a Y` | `null` 与 schema 声明类型不符 |

**你不需要手动处理** —— 在 `lib/hub/tools.js` 的 `reg()` 里已经统一收口：

```js
return toPlainJson(dropNullForSchema(value, schema))   // 顺序不能反
```

新增工具时**只要走 `reg({...})` 就自动被保护**。
`test/tool-output-plain.test.js` 有断言锁住这一点。

> **为什么顺序不能反**：`dropNullForSchema` 把「schema 不允许的 null」
> 转成「字段缺失」，而 `toPlainJson` 会丢弃 `undefined`。反过来就丢不掉了。

### 共享投影层（`lib/hub/views.js`）的契约

`views.js` 是**工具与 UI 共用的白名单投影**。改它要注意：

1. **逐字段构造，绝不 spread 输入。** 反例 `{...registry.list()[i]}` 会让将来
   新增的内部字段（`conn`、`hello` 全量、`pendingPulls`…）自动泄漏到浏览器。
2. **必须幂等。** 两条路径会**叠加**调用（`registry.taskView(t)` 内部先投一次，
   UI 路由拿到结果后再投一次）。所以 `summary` / `changedCount` / `manifestCounts`
   都做「原始形状优先，已投影形状兜底」。
3. **null 的取舍**：UI 侧接受 null（只是不渲染那一块），工具侧不接受
   （schema 要 object/number）。所以**共享层可以回 null，工具层负责收口**。
   不要为了工具改共享层的 null —— 会破坏 UI 契约。

### 异步与 cordis 生命周期

**在插件里注册长期存活的资源，只有一种被验证可用的形态**：

```yaml
# cordis.patch.yml —— inject 声明在 loader 行上
- insert:
    - id: remote-agent
      name: dsh-remote-agent
      inject: ['webServer', 'tools', 'systemPrompt']
```

**不要**用运行时 `ctx.inject(deps, cb)` 或 `ctx.plugin({inject, apply})` 来注册 ——
实测都会让注册在 8–13ms 后被 unload（详见 CHANGELOG）。

`apply` 保持**同步**。不要改成 `async` —— 实测 `await` 会让子插件的 `apply`
根本不被调用，且启动被拖慢到连 token 都拿不到。

### 服务访问必须用 `ctx.get()`

```js
// ✗ 会抛 "cannot get property X without inject"
const x = ctx.subagents

// ✓
const x = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
```

**未声明 inject 的服务，属性访问会抛错而不是返回 undefined** ——
所以可选链 `ctx?.foo` 挡不住它。可选服务一律用 `ctx.get()` 探测。

---

## 测试约定

### 新增行为必须带测试

`test/*.test.js`。命名用中文描述行为，例如：

```js
test('截断：超长 summary.text 精确截到 4000，且两种形状一致', () => { ... })
```

### 测试必须能真的失败

**这一条比"有测试"更重要。** 我们踩过几次「测试写了但断言恒真」：

- 断言写成 `/403/.test(src)`（文件里有 7 处 403，等于没测）
  → 必须**锚定到具体分支**，并用注入验证它真的会红。
- 断言写死实现形态（`if (!guard(...)) return` 单行精确匹配）
  → 后来给拒绝路径加了一行日志，语义没变但断言变红。
  **断言该锚定语义，不是字面形态。**

**验证方法**：改坏实现，看测试是否变红。变不红就是假测试。

### 变异/注入验证只能动沙箱副本

```js
// ✓ 正确：mkdtempSync 复制一份，断言工作区 hash 未变
const sb = fs.mkdtempSync(...)
// ✗ 危险：直接改工作区文件
```

**教训**：我们曾用脚本注入工作区源码来验证断言，脚本被 kill 时
「还原」那一步一并被跳过，**源码被留在损坏状态**。
现在一律：**先备份 → 沙箱副本上改 → 断言工作区 hash 不变**。

### 不要用 `node --test test/`

Node 24 下会把目录当模块入口，必然失败。用 `npm test`（内部是
`node --test test/*.test.js`，glob 由 shell 展开）。

> Windows 的 PowerShell **不展开 glob** —— 直接传 `test/*.test.js` 给 `node`
> 是错的。用 `npm test`，或用 `cmd /c`。

---

## 文档漂移检查（`scripts/check-doc-drift.mjs`）

50 条断言，锁住**文档与代码的关键约定**。它防的是"改了代码忘了改文档"这类
静默漂移 —— 比单元测试更容易被忽略。

**改了这些地方要同步改断言**：

| 改了什么 | 要检查的断言 |
|---|---|
| UI 路由前缀 | client 侧与 Host 侧前缀一致 |
| 投影调用点 | `handoffView` 必须被两条路径调用（工具 + UI）|
| 安全围栏 | guard 必须**失败关闭**（拒绝即 return，不得继续执行 handler）|
| 工具参数 | `remote_task` 的 schema 字段 |

**断言失效时不要放宽它** —— 那等于删掉防线。要么改实现，要么改断言的
**锚定方式**（从字面形态改到语义），并用注入验证新断言仍有判别力。

---

## 提交信息

用中文，第一行说**做了什么**，正文说**为什么**。

```
修复工具返回值出边界的两个致命问题（有副作用却报失败）

## 背景
实测发现：工具调用报 returned invalid output 时，任务其实已经派出去了。
这是最坏的一类失败 —— 有副作用却报失败，调用方可能重派导致重复执行。
...
```

**正文里写清**：症状、根因、修法、验证方式。
排查过程里的**错误判断也值得写**（例如"我第一版把 null 也吞了"）——
它能让后来者避免同样的弯路。

---

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows | ✅ 全量验证（主开发平台）|
| Linux | ✅ CI 覆盖 |
| macOS | ✅ CI 覆盖（单 Node 版本）|

**改平台相关代码时注意**：

- **路径分隔符**：副机侧有 `detectPlatform()` 分支，别假设 POSIX。
- **编码**：Windows PowerShell 的 `>` 重定向与 `Set-Content` 默认 **GBK/ANSI**，
  会把 UTF-8 源码写成乱码（实测把 184 个字符变成 U+FFFD）。
  **读写文件用 Node 的字节 API**，不要用 PowerShell 管道。
- **chmod 无意义**：Windows 上无 POSIX 权限语义，相关测试会 skip（不是失败）。

---

## 报告问题

请附：

1. **DSH 版本**（`resources/version` 或关于对话框）
2. **插件版本**（`node_modules/dsh-remote-agent/package.json` 的 `version`）
3. **角色**（`config.role`）与**传输方式**（`transportMode`）
4. **现象 + 复现步骤**
5. **日志**：
   - 主机侧：面板「日志尾部」区，或 `/api/remote-agent/healthz`
   - 副机侧：`%TEMP%\dsh-remote-agent-diag.log`（若有）
   - 启动日志：`<DSH_HOME>/logs/` 与 `%APPDATA%\@deepseek-ai\dsh-desktop\logs`

**安全相关的问题请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。**
