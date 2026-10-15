# 更新日志

本文件记录所有值得注意的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于 0.x**：在 1.0 之前，`lib/**` 是 DSH 直接加载的产物（无构建步骤），
> 所以每次变更都可能是**行为变更**。升级前请读本文件对应条目。

---

## [Unreleased]

### 新增：Web 面板 GUI 化 —— 副机接入按钮 + 派单模型输入

零终端小白的图形入口（面板是 hub 侧唯一 GUI）：

- **「副机接入」卡片**（`lib/client.js`）：一键生成配对码并复制 `pair:`
  配置行 + 复制防火墙放行命令 —— 主机侧全程鼠标，免终端免向导。
  端口不用配置：面板本身就由 hub 的 webserver 服务，浏览器地址栏端口
  即节点拨入端口。
- **token 披露边界**（`GET /api/remote-agent/ui/pair-info`）：含 token 的
  完整配对码**只对本机回环请求**生成 —— 面板可能被 lanBind 暴露到局域网，
  局域网内能打开面板 ≠ 应该拿到主机凭证。非回环得到不含 token 的码 +
  一条人话提示。与 /config 的"凭证只回 set 布尔"同一精神。
- **dispatch 表单加「模型」输入**（可选）：留空用副机默认；填
  `deepseek-reasoner` 或 `provider/model` 均可，原始字符串交服务端
  normalizeModelSelection 归一 —— 与 remote_task 工具同一通道。
- 测试：ui-routes 3 条（形状/回环全码/非回环拒绝，非回环用伪造
  remoteAddress 直打 handler）；doc-drift 断言 45~47 钉住
  "loopback 策略不被放宽 / 面板入口真实存在 / model 真进请求体"。

### 新增：配对码（pair）—— 副机配置从三行抄写变成一行粘贴

副机部署最容易抄错的就是 `hubUrl` / `token` 两行（少半个斜杠、token 带尾部
空白，表现都是"副机永远不上线"且无报错）。配对码把连接信息压成一行
`dshra1://` + base64url(JSON)：

- **`lib/pairing.js`**（零依赖纯函数）：`encodePairCode` / `decodePairCode` /
  `expandPairConfig`。解析对终端复制形态全容错（换行/引号/空白），所有
  坏输入返回结构化中文错误**永不抛** —— worker 启动路径 pair 无效只降级
  记警告，副机 dsh 照常起来。
- **两条安全语义**：①配对码内含 token，等同凭证（文档明确传阅规矩）；
  ②`roots` 不进配对码 —— 副机的安全边界永远由副机配置声明，主机侧的串
  决定不了它。
- **显式配置优先**：`pair` 与 `hubUrl` 同时存在时 `hubUrl` 生效，方便临时
  换地址调试；展开成功后 `pair` 键从配置对象里删除（token 不存两份）。
- **三处接线**：worker `startWorker` 首行展开 pair；doctor 静态检查基于
  展开后的配置（坏 pair 单独一条 ✗ 带修法）；向导 hub 路径输出配对码、
  worker 路径可整行粘贴自动填充、非交互 `--role worker --pair dshra1://…`
  直接出配置、`--role hub --hub-ip …` 顺手生成配对码。
- 17 条回归（往返矩阵 / 容错矩阵 / 展开优先级 / doctor 与 YAML 接线 /
  applyWorker 降级路径）；doc-drift 断言 42~44 钉住"README 有入口、worker
  真的展开、向导真的生成"三件事。

### 新增：小白向导 + remote_task 支持指定副机模型

#### `bin/dsh-remote-setup.js` —— 配置向导（小白也能配好）

部署这个插件要写 YAML、算 IP、生成 token、记住 `inject: []` 的坑 ——
每一件都对小白不友好。向导把全过程收敛成三次回车：

- **交互式**（无参数运行）：问"主机还是副机"→ 自动枚举本机局域网 IP →
  自动生成 `nt_` 强随机 token → roots 输入时自动创建缺失目录 →
  输出两台机器可直接粘贴的 cordis YAML。**副机片段的 `inject: []`
  由生成器替用户填好**（部署失败头号坑：不填它该行永远 PENDING 且无报错）。
  主机路径还会打印防火墙放行命令；副机路径会先 TCP 探活主机端口。
- **非交互**：`--role hub|worker --hub-url --token --node-id --roots a,b --out 文件`
- **`--doctor <配置.yml>`**：逐项体检（Node 版本 / hubUrl 合法性 / token 与
  公网暴露 / roots 存在性 / nodeId 形状 / 端口可达性），每条 ✗ 都带
  "怎么修"。

纯逻辑在 `lib/setup.js`（14 条测试）；`lib/node/index.js` 的连接错误提示
改走同一份 `friendlyConnectError` 映射 —— 副机日志里的 `ECONNREFUSED`
现在旁边多一行"端口没人听 —— 检查 ①DSH 在跑 ②IP/端口 ③防火墙"。

#### `remote_task` 新增 `model` 参数 —— 主机可指定副机用的模型

    remote_task { goal, model: { model: "deepseek-reasoner" } }
    remote_task { goal, model: { provider: "openai", model: "gpt-4o" } }

- **只传选择，不传凭证**（核心不变式 1）：协议里流动的是 provider/model 名，
  模型 key 始终在副机。指定的模型在副机不存在时任务会以明确错误失败
  （错误经 367daef 修复后的 agent/error 监听进入 handoff）。
- **in-process 后端**：`buildAgentOptions(defaultSel, requested)` 合成
  "副机默认 × 主机指定"，主机字段优先、缺的借默认补齐（只给模型名时
  provider 借副机默认）。
- **headless 后端明确拒绝**（`modelUnsupported`）：`dsh headless` 把模型
  硬编码为副机默认选择、无 CLI flag（对照 app.asar 内 dsh-headless 源码
  核实）—— 静默忽略会让"以为指定了模型、实际跑的是默认"，排查方向
  直接跑偏，所以如实失败。
- **TaskStore.create 的字段白名单补 `model`**：此前 spec 里的 model 会在
  落盘时被丢掉 —— agent 任务重启后 reconcile 重跑时模型选择必须跟任务走。
- 三条入口接通：remote_task 工具、Web 面板 dispatch（body.model）、
  README 工具表与 systemPrompt 同步。subagent provider 不接（框架
  `capabilities.agentOptions=false`，请求里没有自然载体）。

### 修复：健壮性两处（评审遗留）

- **transport 握手超时**：upgrade 后 welcome/accepted 不来必须在 10s 内
  毁连接走重连 —— 此前"TCP 连着但永远上不了线"的哑状态没有任何报错。
  （带陈旧连接守卫与三处定时器清理；mock timers 行为级回归。）
- **pull-manager**：① 分块帧缺 offset 按畸形帧失败（hash-mismatch），
  不再静默跳过校验继续写盘；② 空闲超时重臂用**本条 pull 自己的**
  timeoutMs —— 此前第一个分块后回退到 limits 值，自定义短超时静默失效。

### 文档

- README 新增「五分钟上手」；状态行更正（agent 后端两根因已修、待实机确认）。
- KNOWN-ISSUES §1 标注已修（`kind: 'plugin'` → `cordis-host-runner`），
  保留推理记录 —— 它预言的残余风险后来真的发生了。
- check-doc-drift 65 → 71 条（新增向导承诺断言：README 入口 / bin 声明 /
  生成器填 inject / doctor 带修法 / 错误人话翻译 / model 参数）。

### 新增（同轮，之前提交）

- **transport 握手超时**、**pull-manager offset 必填与重臂预算**
  （commit 0d3f56b，9 条 mock-timers 行为回归）。
- **remote_task 的 model 参数端到端**（commit 9dc0f23，15 条分层回归）。

### 修复（第二轮：独立评审 + 中优先级）

一次外部独立评审（2026-10-15）报出 3 个高优先级 + 若干中优先级问题。
三条高危**逐条核实后确认属实**，已修；中优先级按用户选择修了 5 组。

#### 高 · headless 后端任务书进 shell = 命令注入（`lib/node/runner.js`）

`spawn(dshBin, args, { shell: this.platform === WINDOWS })` 且 `goal` 直接进
argv。Windows 下 `shell:true` 走 `cmd.exe /c` 且**不做转义**，而 `goal` 是
多行 Markdown 任务书、内容来自远端（不可信）。任务书里的 `&`、`|`、引号或
换行会截断/拆开命令行 —— 轻则调用损坏，重则执行夹带的第二条命令。

**修法（两层）**：① `shell: false`（`dshBin` 已是绝对路径，不需要 shell）；
② `goal` 从 **stdin** 传（`headless --json -`，`-` = 读 stdin，已用
`dsh headless --help` 核实），即使将来有人把 `shell:true` 加回来也不在命令行上。

> **核实修正**：评审把它与"agent 假完成"关联，但实测副机走的是
> `runner: in-process`，那个 bug 的真因是 `PLUGIN_SOURCE` 类型非法
> （见下面 0.1.0 的"agent 模式假完成"）。所以这是**独立的真缺陷**。

#### 高 · WebSocket 分片重组无总量上限（`lib/ws.js`）

单帧有 8 MiB 上限，但 `fragBytes` **只累加不检查**，而 RFC 6455 允许拆任意多片。
一条连接连发 N 个 4 MiB 分片即可在 `Buffer.concat` 之前撑爆内存。直连端点在
`nodeToken` 留空时无鉴权，所以是"一条连接打爆 hub 内存"的路径。

**修法**：累加后、concat 前加总量守卫（上限 = 单帧上限 × 4 = 32 MiB），
超限 `fail('fragment-too-large')`。

#### 高 · 中继背压只覆盖 node 方向（`lib/relay.js`）

`forwardToNode` / `forwardBinaryToNode` 有背压，而 `broadcastHubs` /
`broadcastHubsBinary` 直接 `h.send()`。一个不读 socket 的 hub 连接会让中继
写缓冲无限增长 —— 正是本文件自己注释里的 OOM 场景，换了个方向。

**修法**：新增 `applyHubBackpressure(h)`（同策略：超限即断连 + 计 stats + 记日志），
两个广播函数都接上；遍历改用快照 `[...hubs]`。

#### 中 · relay token 走 URL query → 进各级日志

`transport.js` 与 `node-registry.js` 都把 token 塞进 URL query，而 URL 会进
中继 access log、反向代理日志、CDN 日志。中继侧本来就 header 优先
（`searchParams.get('token') ?? headers['x-relay-token']`），`ws.js` 的 `connect()`
也支持自定义 header —— 所以客户端改成走 header 即可，服务端不用动。

**修法**：direct 用 `x-dsh-token`（原有）、relay 用 `x-relay-token`（新增），
两者都不再进 URL。顺带修正了两种模式此前的不对称。

#### 中 · 临时诊断无限增长 + 泄漏任务信息（`lib/node/runner.js`）

定位 agent 问题的诊断写死 `<temp>/dsh-remote-agent-runner.log` 且无上限，
记录里含 taskId、goal 长度、cwd、错误正文。

**修法**：改为 **opt-in**（`DSH_REMOTE_AGENT_TRACE=1`）+ **有上限**
（超 2 MiB 轮转）。注意 `agent/error` 的上报（`liveText.push` + `onEvent`）
是**功能性**的、不受开关影响 —— 它把错误带进 handoff 摘要。

#### 中 · pull-manager 忽略 writeSync 返回值

`fs.writeSync` 可能部分写。虽然最终 sha256 校验会兜住（不会把坏文件当成品），
但代价是**白传一整份产物**才失败。改为循环写直到写完，异常即明确失败。

#### 中 · 中继死连接治理

两个洞：① `HELLO_NODE` **无 `boundId` 守卫** —— 同一连接二次 hello 换 nodeId
会留下永不清除的幽灵条目，反复 hello 可在单连接上堆任意多条目、占满 `maxNodes`
配额；② **无心跳/空闲淘汰** —— NAT 静默死亡（家庭路由 5–30 分钟、断电、
中间设备丢连接）不会触发 `close`，死条目永久占配额，中继缓慢"饱和而死"。

**修法**：① 一条连接只能 hello 一次（`already-helloed`）；② 新增
`sweepIdleConnections()`：空闲 3 分钟发 WS ping 探测（`ws.js` 会自动回 pong），
再一个周期无响应才判定死亡并清理 —— 用 ping 而不是直接按"多久没帧"断，
否则会误杀任务间隙的正常空闲节点。定时器 `unref()`，`close()` 里清理。

#### 中 · `TaskStore.prune()` 从未被调用

定义了但无调用方 → 终态任务记录的**内存缓存与磁盘文件无限累积**
（每条最多含 200KB 日志尾巴）。改为副机启动时清一次（保留期 7 天），
失败只记 warning、不挡启动。

### 待办

- POSIX 分支仍未真机验证（只有 CI 覆盖）。
- Windows 8.3 短名绕过向量未验证（见 KNOWN-ISSUES §7.1）。
- `node-registry.js` 1275 行集多职责于一身，建议把 `RelayLink` 拆出去。
- `task-store` 热路径同步 I/O（每条日志/进度都全量重写记录）。

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

#### agent 模式假完成：消息 source 类型非法（DSH 静默拒绝）

**症状**：副机上 `mode: agent` 的任务在 ~20–40ms 内被标成 completed，
`liveText` 为空、`fromLogParts: 0`、产物 0 —— **且没有任何错误信息**。
`mode: exec` 完全正常。

**根因**：`PLUGIN_SOURCE` 用了 DSH **不认识**的 source 类型：

```js
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'dsh-remote-agent' })
```

DSH 的 `MessageSourceMap` 是一张**封闭的联合类型表**，17 种合法 kind
（`user` / `model` / `tool` / `system-prompt` / `model-selection` /
`user-approval` / `ptc-mode` / `tool-registry` / `user-rpc` / `agent-message` /
`subagent-settled` / `skill-invocation` / **`cordis-host-runner`** / `goal` /
`schedule` / `compact-checkpoint` / `session-reference` / `user-question-reply`）。

**里面没有 `plugin`。** 传非法 kind 时 `followup` 表面成功（消息进 inbox、
驱动被唤醒），但 turn 一启动就抛错 —— 而 DSH 的 `kick()` 是：

```js
async kick() {
  try { while (await this.turn()) }
  catch (_error) {}                      // <-- 静默吞掉
  finally { if (this.phase.kind === 'running') this.setPhase({ kind: 'idle', ... }) }
}
```

错误被吞、phase 转 idle → `whenIdle()` 立即返回 → 任务标 completed、产物 0。

**修法**：① 改用 `{ kind: 'cordis-host-runner' }`（DSH 为"cordis 宿主里的
runner 主动驱动 agent"准备的 kind）；② **加 `agent/error` 监听** —— 因为
`kick()` 吞错，这条事件是**唯一的错误出口**，漏了它任何 turn 内部错误都
完全不可见；③ 错误对象做深度序列化（第一版只取 `err?.message`，记到的是
`[object Object]`）。

**这条是怎么找到的**：加 7 个流程探针定位到"whenIdle 20ms 返回、零输出"，
然后用 **`cordis_inspect_query`**（`Service.listService` 查 `sessions` /
`agentLoop`）拿到 DSH 的**权威类型定义**，对比发现 `plugin` 不在表里。

**教训**：往 DSH 的封闭联合类型里塞自造值**不会立刻报错**，而是在某个被
`catch {}` 包住的深层位置静默失效。改这类常量前应先用 `cordis_inspect_query`
拿权威定义，而不是靠猜。

#### 工具返回值出边界：两条独立的失败路径

**症状**：工具调用报 `returned invalid output`，但**副作用已经发生**
（任务已派出、文件已拉回）。这是最坏的一类失败 —— 调用方既拿不到结果，
也无法判断副作用是否发生，可能重派导致重复执行。

**路径 1 · `value is not lossless JSON`**

DSH 用 `walkJsonValue(value, true)` 检查返回值，返回 `undefined` 即判失败。
拒绝：类实例（原型不是 `Object.prototype`）、`undefined`、`NaN`/`Infinity`/`-0`、
循环引用、数组带额外属性。我们踩到的是**类实例**（副机回传的 `accepted` 带类原型）。

**路径 2 · `"value.x" must be a Y`**

DSH 还会跑 `validateJsonSchemaValue(outputSchema, value)`。`null` 是合法 JSON，
但对声明为 number/object 的字段不是该类型。触发场景很常见：查一个**刚创建、
还没开始执行**的任务（`startedAt`/`endedAt`/`durationMs` 都还没有）。

**修法**：在**唯一的工具注册入口**（`reg()`）统一收口 ——
`toPlainJson(dropNullForSchema(value, schema))`。7 个工具返回值形态各异，
逐个改容易漏；而 DSH 的拒绝条件对所有工具一样。顺序不能反
（`dropNullForSchema` 把 null 转成"缺失"，`toPlainJson` 会丢弃 undefined）。
源头同时修了 `views.js`（时间字段用 0 兜底、`manifestCounts` 用 `{}`）。

**测试**：`test/tool-output-plain.test.js`（19 条）。它还**抓到了实现里的一个
bug**：第一版 `toPlainJson` 把 `null` 也当 `undefined` 吞掉了（会让值为 null
的字段静默消失）。

### 已知问题

见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)**。要点：

- **副机 agent 后端的"假完成"已修**（`PLUGIN_SOURCE` 类型非法，见上）。
  修复版已在副机实测验证；但**"修复后 agent 能否真正产出"尚未端到端确认** ——
  待下一次实机验证。
- **headless 后端修复后尚未实机验证**（它需要副机没有 `agentLoop` 服务才会走到）。
  本次只做了静态断言 + 判别力验证，`dsh headless -`（stdin）路径未经真机跑通。
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
