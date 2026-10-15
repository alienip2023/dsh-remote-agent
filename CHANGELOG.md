# 更新日志

本文件记录所有值得注意的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于 0.x**：在 1.0 之前，`lib/**` 是 DSH 直接加载的产物（无构建步骤），
> 所以每次变更都可能是**行为变更**。升级前请读本文件对应条目。

---

## [Unreleased]

### 待办

- **副机 agent 后端不工作**：`mode: agent` 的任务会在约 20ms 内"完成"，
  但实际没有产出（`exec` 后端完全正常）。已加 7 个诊断点
  （`%TEMP%\dsh-remote-agent-runner.log`）待定位。见 KNOWN-ISSUES。
- 清理 `lib/node/runner.js` 里的临时诊断（定位完成后）。

---

## [0.1.0] — 2026-10-15

首个可用版本。主机侧（hub）端到端可用；副机侧 `exec` 后端可用。

### 新增

- **7 个工具**：`remote_nodes` / `remote_task` / `remote_status` /
  `remote_handoff` / `remote_manifest` / `remote_pull` / `remote_cancel`。
- **Web 面板**（侧栏「远程同事」）：节点列表、派发任务、任务状态、
  结果摘要、工作区变更、成品清单、日志尾巴；主机设置只读展示。
- **两种传输**：`direct`（副机主动连主机，需主机地址可达）与
  `relay`（经中继 VPS 会合，双方都在 NAT 后时用）。
- **两种执行后端**：`in-process`（副机在自己的 DSH 进程里起独立 agent 会话）
  与 `headless`（spawn 独立 `dsh headless` 进程，回退用）。
- **产物按需回流**：任务结束只回 `manifest` + `handoff`；只有 `role:final`
  的成品可以 `remote_pull` 拉取，`intermediate`（日志/缓存/中间构建文件）
  只上报元数据、留在副机。
- **`subagent` provider**：主机侧的 agent 可以把任务委派给远程节点。
- 中继服务（`bin/dsh-remote-relay.js`）+ 初始化脚本（systemd / 计划任务）。

### 设计不变式

| 不变式 | 含义 |
|---|---|
| **凭证不离开副机** | 协议里不带模型 key；副机用自己的模型配置 |
| **断连不终止任务** | 任务在副机本地持久运行，中继挂了也跑完，重连后自动对账 |
| **清单先于字节** | 任务结束只回 manifest + handoff；成品要显式 `remote_pull` |
| **只有 `role:final` 过河** | 中间产物只在副机留存 |

### 修复（开发期，均已验证）

这一节记录的是**在 0.1.0 发布前**踩到并修掉的问题。保留它们是因为每一条
都对应一个容易复发的陷阱，改动相关代码前值得先读。

#### 工具返回值出边界：两条独立的失败路径

**症状**：工具调用报 `returned invalid output`，但**副作用已经发生**
（任务已派出、文件已拉回）。这是最坏的一类失败 —— 调用方既拿不到结果，
也无法判断副作用是否发生，可能重派导致重复执行。

**路径 1 · `value is not lossless JSON`**

DSH 用 `walkJsonValue(value, true)` 检查工具返回值，返回 `undefined` 即判失败。
拒绝条件：

- `typeof value !== 'object'` 且非 null/boolean/string/number
  → **undefined / 函数 / Symbol**
- 数字 `!Number.isFinite(v) || Object.is(v, -0)` → **NaN / Infinity / -0**
- 原型不是 `Object.prototype` 也不是 `null` → **类实例**
- 循环引用
- 数组原型不对，或数组上挂了额外属性

我们踩到的是**类实例**：副机回传的 `accepted` 对象带类原型。

**路径 2 · `"value.x" must be a Y`**

DSH 还会跑 `validateJsonSchemaValue(outputSchema, value)`。`null` 是合法 JSON，
但对声明为 `{ type: 'number' }` / `{ type: 'object' }` 的字段，null **不是**该类型。

触发场景很常见：查一个**刚创建、还没开始执行**的任务
（`startedAt` / `endedAt` / `durationMs` 都还没有）。

**修法**：在**唯一的工具注册入口**（`reg()`）统一收口，而不是逐个工具改 ——
7 个工具返回值形态各异，逐个改容易漏；而 DSH 的拒绝条件对所有工具一样。

```js
const reg = (definition) => {
  const original = definition?.execute
  const schema = definition?.output?.schema
  definition = { ...definition, async execute(...args) {
    const value = await original.apply(this, args)
    return toPlainJson(dropNullForSchema(value, schema))   // 顺序不能反
  }}
  disposers.push(ctx.tools.register(definition))
}
```

- `dropNullForSchema` 读 schema，删掉「值为 null 但 schema 声明非 null 类型」的
  **可选字段**。不动 `required` 字段（删了会从"类型错"变成"缺字段错"，同样失败）。
- `toPlainJson` 净化成纯 JSON（类实例 → 普通对象、undefined → 丢弃、
  NaN/Infinity/-0 → 0、循环引用截断）。
- **顺序**：`dropNullForSchema` 必须在前 —— 它把 null 转成"缺失"，
  而 `toPlainJson` 会丢弃 undefined。

源头同时修了 `views.js`：时间字段用 `0` 兜底、`manifestCounts` 用 `{}`。
新增 `test/tool-output-plain.test.js`（19 条）锁住这两层。

#### UI 路由注册后 8–13ms 被 unload，面板 404

**症状**：面板一直显示 `读取失败: HTTP 404`，而 Host 侧路由实测 401
（路由不在 exact 表）。**启动日志里什么都没有**，排查代价极大。

三个叠加的原因：

1. **`registered` 闩锁**（真正的杀手）：`withServices` 里有一个
   `let registered = false; if (registered) return`。fiber 被 unload 后重新 load
   时，闩锁拦住了重新注册 → **路由被删且永不回来**。
2. **运行时 `ctx.inject` / `ctx.plugin` 都不可靠**：
   - `ctx.inject(deps, cb)` 返回 **thenable fiber**，文档要求 `await` 才算
     "加载完成"；而插件的 `apply` 是**同步**的 → 父 fiber 同步返回后框架
     清理尚未 settle 的子 fiber。
   - `ctx.plugin({inject, apply})` 更糟：子插件的 `apply` **根本没被调用**。
3. **`tools.js` 的 17 处 `type: ['x', 'null']`**：DSH 的 JSON Schema 校验
   **不接受 type 数组**（`type must be a single type string`）→
   `registerRemoteTools` 抛 `JsonSchemaError`。此前被 `ctx.effect` 的容错吞掉，
   改成直接注册后才暴露。

**修法**：

- 去掉闩锁。
- **inject 声明在 loader 行上**（`cordis.patch.yml` 的 `inject: [...]`）——
  框架会推迟本行激活直到服务就绪，只 apply 一次、无子 fiber 抖动。
  这是唯一被验证可用的形态。
- `applyHub` 内部**不用 `ctx.effect`**，改「立即注册 + 收集 disposer」
  （`__reg`），不依赖 fiber 生命周期。
- 17 处 `type: ['x','null']` → `type: 'x'`。
- `ctx.subagents` 改 `ctx.get('subagents')` —— cordis 对未声明 inject 的服务
  **属性访问会抛错**，不是返回 undefined。

**副作用（部署必读）**：副机 profile **必须**覆盖 `inject: []` ——
副机没有 `webServer`/`tools`/`systemPrompt`，不清空的话该行永远停在
PENDING、永不激活。见 `profiles/worker.cordis.yml`。

#### 其他

- `resolvePowerShell` 采用 0 字节的 `WindowsApps\pwsh.exe` → spawn 抛
  `EFTYPE`。加 `isUsableExecutable()`（存在 + 非零字节）。
- relay 错误帧全被丢弃：`RELAY_FRAME.ERROR` 未定义 → 加 `ERROR: 'error'`。
- relay 二进制下行用 `conn.send(text)` → UTF-8 有损；改 `sendBinary`。
- `new URL(req.url)` 未 try/catch → 畸形请求会杀掉进程；加 `safeParseUrl`。
- 任务取消映射到 `failed` 而非 `aborted`；失败路径漏了 `error`。
- `RelayLink.start()` 非幂等 → 孤儿连接泄漏；加 re-entry gate +
  stale-connection 守卫（29 条行为测试）。
- `artifactRules` 内层形状未校验（`{final:"dist/**"}` 字符串会按字符展开规则）
  → `normalizeArtifactRules`。
- `lib/index.js` 的 `export default apply` 让 loader 的 `unwrapExports`
  把命名空间折叠成函数 → `Config` 不可见、配置表单不显示。移除默认导出。

### 已知问题

见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)**。要点：

- 副机 agent 后端不工作（`exec` 正常）—— 待定位。
- Windows 8.3 短名绕过向量未验证。
- `lib/hub/index.js` 一处已知冗余（`ctx.effect` 的 `once()` 包装）。
- 平台分支的实测覆盖不均：Windows 全量验证，POSIX 分支只跑过 CI。

---

## 版本号约定

- **0.x**：`lib/**` 是加载产物，任何变更都可能是行为变更。升级前读本文件。
- 破坏性变更（配置字段重命名/移除、协议版本号变化）→ 升 minor 并在
  本文件顶部用 `### 破坏性变更` 标注。
- 协议版本号在 `lib/protocol.js` 的 `PROTOCOL_VERSION`。**主副机版本不一致时
  以协议版本号为准**，不要求包版本一致。
