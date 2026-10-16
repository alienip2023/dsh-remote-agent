# 真机验证：agent 模式全链路（2026-10-16）

> 对应 [KNOWN-ISSUES.md](../KNOWN-ISSUES.md) 第 8 节「仍未覆盖（需要两台真机）」的第一条：
> **agent 模式全链路** —— 副机需要真实 DSH 提供的 agent 服务（ctx 里的 `agentLoop`）。
> 本次是**第一次在真实双机环境**下跑通（并跑出问题）的记录。

## 结论速览

| 待验证项 | 结果 |
|---|---|
| 双机环境是否存在 | ✅ 存在（Tailscale 组网的两台真机） |
| 任务是否被接受 | ✅ 接受，`accepted=true`，状态机走完 queued → running → completed |
| 副机是否起独立 agent 会话 | ✅ 起了，`runner=in-process`，`sessionId=session-remote-<taskId>`，进度里出现 `agent-start` |
| 结果是否回传 | ⚠️ 回传了 handoff，但**内容是 LLM 传输错误**；根因在副机凭证，不在插件 |
| 失败时的完整报错 | ✅ 已捕获（见下），但**任务被标记成 completed** —— 这是一个真缺陷 |

**一句话**：agent 链路的**管道全通**（派单 → 独立会话 → handoff 回传 → hub 投影），
但**副机侧 LLM 调用失败被吞成了成功**。前者证明 KNOWN-ISSUES §8 的担忧（拿不到
`agentLoop`）在真机上**不成立**；后者是本次新发现的缺陷。

---

## 1. 环境

| 角色 | 主机名 | 系统 | Node | DSH | 插件版本 | 接入方式 |
|---|---|---|---|---|---|---|
| hub（主电脑） | `desktop-obojm0b` | Windows | v24.18.0 | **0.2.0-rc.2** | **0.3.0** | — |
| worker（副电脑） | `newland` | Windows | — | — | **0.1.0** | `transportMode: direct` |

- 组网：Tailscale 直连（`100.86.48.54` ↔ `100.72.146.73`，`active; direct`）。
- hub 监听 `0.0.0.0:19387`，副机 `hubUrl: ws://100.86.48.54:19387/api/remote-agent/node`。
- 副机工作区 `roots: ['D:\work']`，`token: ''`（空 token，按"仅限可信内网"语义放行，与文档一致）。
- 副机配置里 `inject: ['tools', 'agentLoop', 'sessions']` —— **这正是 agent 模式必需的服务**。

> ⚠ **两端插件版本不一致（hub 0.3.0 / worker 0.1.0）**。协议层没有报
> `protocol-mismatch`，说明 v1 协议帧仍然兼容，但这属于非受控变量，记录在此。

---

## 1.5 副机接入：配置向导

副机是用 `bin/dsh-remote-setup.js` 接入的（也支持 `bin/双击运行-配置向导.cmd` 图形入口）。
本次用非交互模式复验了生成逻辑，输出可直接并入副机 profile：

```bash
node bin/dsh-remote-setup.js --role worker \
  --hub-url ws://100.86.48.54:19387/api/remote-agent/node \
  --node-id wizard-test --roots 'D:\work' --out wizard-worker.yml
```

生成结果：

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: []                    # ← 副机必须清空，否则永远 PENDING（生成器已替你填好）
  config:
    role: worker
    nodeId: wizard-test
    transportMode: direct
    hubUrl: ws://100.86.48.54:19387/api/remote-agent/node
    roots:
      - D:\work
```

✅ 向导正确生成了 `inject: []` —— 这是副机侧的关键约束（worker 拿不到
`webServer`/`systemPrompt`，声明了会卡在 PENDING）。`id: remote-agent` 也与包内
`cordis.patch.yml` 同 id，不会造成 double-mount。

**hub 侧体检**（`--doctor`）在真实配置上跑出了三条可操作结论：

```
dsh-remote-agent 体检（role=hub）
✓ Node 版本 24.18.0
✗ nodeToken 已配置（副机入网口令）
    ↳ 不配置时直连端点不校验任何凭证 —— 仅限 Tailscale/同机等完全可信网络；公网部署必须配。
✗ 本机有公网地址但 token 为空
    ↳ 立即配置 nodeToken，或确认本机只暴露在可信内网
✓ uiPullRoot 已配置（面板拉取产物落地的目录）
✗ uiPullRoot 目录存在：D:\remote-artifacts
    ↳ 目录不存在 —— 先创建它
共 3 项需要处理。
```

> 这三条**都是真问题**，且正好印证了部署文档的取舍：
> ① 空 token 只在完全可信网络下安全（本机靠 Tailscale 组网，勉强符合，但
> `0.0.0.0:19387` 确实在监听所有网卡）；
> ② `uiPullRoot` 指向的 `D:\remote-artifacts` **不存在** —— 面板的"拉取成品"
> 按钮会因目录不可用而失败。
>
> ⚠ 顺带发现一处**源码注释与实现不一致**（不是缺陷，但会误导）：
> `bin/dsh-remote-setup.js` 的**文件头 JSDoc**（第 7 行）写的是
>
> ```
> node bin/dsh-remote-setup.js --doctor       # 体检当前配置，只报问题 + 怎么修
> ```
>
> 但实现（`runDoctor(positionals)`，第 144 行）**要求必须带配置文件路径**：
> 不带位置参数时只打印 `用法：--doctor <cordis配置文件.yml>` 并以退出码 1 结束。
>
> 外部文档是对的（`README.md:83`、`README.en.md:96`、`CHANGELOG.md:218`
> 都写成 `--doctor 你的配置.yml`），**只有源码自己的 JSDoc 漏了参数**。
> 建议把那行注释补成 `--doctor <配置.yml>`。

---
## 2. 链路验证：exec 模式（对照组）

先跑一条 exec 任务确认基础链路，排除"根本连不上"这种平凡解释：

```
remote_task { node: "newland", mode: "exec", goal: "hostname; node -v; echo probe-ok" }
→ 已派单 t-mvav14t3e9o19 → newland（status=queued）
  workspace: D:\work   runner: in-process
remote_status { taskId: "t-mvav14t3e9o19" }
→ status=completed  mode=exec  accepted=true  耗时=1002ms
  exit: code=0 timedOut=false
  进度尾巴: started → exec: hostname; node -v; echo probe-ok
```

✅ 基础链路完全正常：派单、接受、执行、终态、进度上报、handoff 全通。

---

## 3. 链路验证：agent 模式（本节重点）

### 3.1 派单

```
remote_task {
  node: "newland",
  mode: "agent",
  workspace: "D:\work",
  goal: "请总结你本机的工作区：列出当前工作区根目录下有哪些文件与子目录（最多 20 条），
         并说明这个工作区是做什么用的。把结论写成一段 100 字以内的中文摘要，直接作为你的回答返回。"
}
→ 已派单 t-mvav1chu4y21c → newland（status=queued）
  workspace: D:\work   runner: in-process
```

**任务被接受**：`accepted=true`，hub 返回 `runner: in-process` —— 说明副机侧
`selectRunner()` 选中了 `InProcessRunner`（而不是 headless 回退），
即 `ctx.get('agentLoop')` 与 `ctx.get('sessions')` 都**可用**。

### 3.2 副机起了独立 agent 会话

派单后立即查询，进度尾巴为：

```
- started
- agent-start
```

`agent-start` 是 `TaskEngine.runAgent()` 在调 `runner.run()` **之前**发的第一个
`task/progress` 帧，带 `runner: this.runner.kind`。它出现即证明：

1. 任务真的进了 `runAgent()` 分支（不是 `runExec()`）；
2. `InProcessRunner.run()` 被调用，会话创建流程已启动。

随后从副机落盘的任务记录里确认了**会话 id 真的被创建并回写**：

```
status=completed
mode=agent
sessionId=session-remote-t-mvav1chu4y21c   ← 独立会话真的建起来了
runner=in-process
exitCode=0
manifest={"total":0,"final":0,"intermediate":0,"other":0}
```

`sessionId` 形如 `session-remote-<taskId>`，来自 `agentLoop.createAgent()` 返回的
`agent.id`，经 `result.sessionId` 回写到 TaskStore。

> **这一条直接回答了 KNOWN-ISSUES §8 的担忧**：文档当时说"本机 spawn 的 worker
> 拿不到该服务（selectRunner 走 headless），agent 链路必须在两台都装了 DSH 的机器上
> 验证"。真机上 `selectRunner` **没有**走 headless，`InProcessRunner` 正常工作，
> 会话被真实创建。§8 的这条缺口**已关闭**。

### 3.3 结果回传 —— 以及失败时的完整报错

任务终态与交接卡：

```
remote_status { taskId: "t-mvav1chu4y21c" }
→ status=completed  mode=agent  accepted=true  耗时=15561ms
  exit: code=0 timedOut=false
  进度尾巴:
  - started
  - agent-start
  - error: {"turn":1,"step":1,"error":{"message":"DeepSeek Messages transport failed",
           "code":"TRANSPORT","name":"LlmError"},"agent":{"status":"running"}}
  交接卡已就绪

remote_handoff { taskId: "t-mvav1chu4y21c" }
→ 状态：completed
  模式：agent  运行器：in-process
  耗时：16s
  工作区：undefined
  ## 摘要
  [agent 错误] {"turn":1,"step":1,"error":{"message":"DeepSeek Messages transport failed",
                "code":"TRANSPORT","name":"LlmError"},"agent":{"status":"running"}}
  ## 产物清单（final 0 / intermediate 0）
```

**完整报错原文**（这是任务要求的"失败时的完整报错"）：

```json
{
  "turn": 1,
  "step": 1,
  "error": {
    "message": "DeepSeek Messages transport failed",
    "code": "TRANSPORT",
    "name": "LlmError"
  },
  "agent": { "status": "running" }
}
```

### 3.4 根因定位：副机 LLM 凭证缺失（不是插件缺陷）

在副机上派 exec 任务做诊断：

```
=== dns/egress ===
api.deepseek.com ERR: 远程服务器返回错误: (401) 未经授权。   ← 到得了，但没凭证
baidu.com        → 200                                      ← 出网正常
=== credentials keys (names only) ===
version:                                                    ← 凭证文件只有版本号，没有任何 key
=== env LLM keys ===
（空 —— 没有任何 DEEPSEEK/OPENAI/API_KEY 环境变量）
=== dsh profile ===
desktop
=== agent-default-model ===
provider: deepseek-account
model: deepseek-flash
```

**判定**：

- 出网正常（`baidu.com` 200），不是网络问题；
- `api.deepseek.com` 返回 **401** —— 请求到达了服务端，但**没有有效凭证**；
- 副机的 `.credentials.yaml` **只有 `version:` 一行**，环境变量里也没有任何 LLM key；
- 但副机 profile 的 `agent-default-model` 指向 `provider: deepseek-account`。

⇒ 副机的 `deepseek-account` provider **没有登录/没有凭证**，所以
`InProcessRunner` 一调 LLM 就拿到 `TRANSPORT / LlmError`。

**这是副机环境的配置问题，不是 dsh-remote-agent 的缺陷。** 链路的每一环
（派单、会话创建、错误捕获、handoff 回传）都按设计工作。

---

## 4. 本次新发现的缺陷：agent 侧 LLM 失败被标记为 completed

### 现象

副机的 LLM 调用**明确失败了**（`LlmError`），但：

| 观察点 | 实际值 | 期望 |
|---|---|---|
| 任务状态 | `completed` | `failed` |
| `exit.code` | `0` | 非 0 |
| `exit.timedOut` | `false` | — |
| `error` 字段（落盘） | **空** | 带 `LlmError` |
| handoff 摘要 | 一段 `[agent 错误] ...` 文本 | 明确的失败语义 |

### 根因（代码级）

`lib/node/runner.js` 的 `InProcessRunner.run()` 里，`agent/error` 事件只被
**记录成文本**，不影响返回值：

```js
// ctx.on('agent/error', ...) 内
liveText.push(`[agent 错误] ${msg}`)
if (typeof onEvent === 'function') onEvent({ kind: 'error', text: msg.slice(0, 2000) })
```

而返回值的 `ok` **只由 `timedOut` 决定**：

```js
return {
  ok: !timedOut,              // ← LLM 失败时 timedOut=false ⇒ ok=true
  exitCode: timedOut ? null : 0,
  timedOut,
  final: finalText,           // ← finalText 里混着 "[agent 错误] ..."
  stderr: '',
  ...
}
```

然后 `lib/node/task-engine.js` 的状态映射：

```js
const status = result.aborted ? ABORTED
  : result.timedOut ? INTERRUPTED
  : result.ok ? COMPLETED          // ← ok=true ⇒ COMPLETED
  : FAILED

const failure = result.aborted || result.timedOut || result.ok
  ? null                           // ← ok=true ⇒ failure=null（error 字段为空）
  : { code: 'task-failed', ... }
```

⇒ **一次彻底失败的 agent 调用，被投影成 `completed` + `exit.code=0` + `error=null`。**

### 对照证据：exec 侧的失败映射是**正确**的

同一次验证里，一条 exec 任务因为副机 PATH 上没有 `node` 而失败，映射完全正确：

```
remote_handoff { taskId: "t-mvavcgvbc902m" }
→ 状态：failed                    ← 正确落成 failed
  模式：exec  运行器：in-process
  ## 摘要
  任务未成功：node : The term 'node' is not recognized as the name of a cmdlet,
  function, script file, or operable program. ...
```

对比表：

| 场景 | 实际终态 | 是否正确 |
|---|---|---|
| exec 命令失败（`node` 不在 PATH） | `failed` + 摘要含错误 | ✅ 正确 |
| agent 调 LLM 失败（`LlmError`） | `completed` + `exit.code=0` + `error=null` | ❌ **错误** |

⇒ 这说明**不是整条状态映射链坏了**，而是 agent 路径**独有**的一个漏洞：
`runExec()` 走 `exec.js`，命令非 0 退出会让 `result.ok=false` → `FAILED`；
而 `InProcessRunner.run()` 的 `ok` 只由 `timedOut` 决定，agent 级错误不参与判定。
**修复范围因此很窄** —— 只需改 `runner.js` 的 `InProcessRunner` 返回值，不必动
`task-engine.js` 的状态映射（它已经在正确工作了）。

### 影响

这是最坏的一类失败形态：**调用方无从判断任务是否真的做成了**。
`remote_handoff` 的摘要里虽然有 `[agent 错误]` 字样，但：

- `remote_status` 的 `status=completed` 会让自动化流程直接认为成功；
- `exit.code=0` 会让基于退出码的判断失效；
- `error` 为空，`remote_manifest` 也会给出"没有产物"这种中性结论。

与仓库自己在 `lib/hub/tools.js` 里反复强调的原则相悖 —— 那里花了大段注释
避免"有副作用却报失败"，这里是镜像问题：**没做成却报成功**。

### 建议修法（未实施，仅记录）

在 `InProcessRunner.run()` 里把"捕获到 agent 级错误"提升为一等结果：

1. `agent/error` 回调里置一个 `sawAgentError = true`（并保留 `msg`）；
2. 返回时 `ok: !timedOut && !sawAgentError`，并给出 `exitCode: 1`；
3. 把 `msg` 放进 `stderr`（而不是只塞进 `final`），让 `task-engine` 现有的
   `failure = { code: 'task-failed', message: result.stderr }` 分支自然生效；
4. 补一条测试：mock `agent/error` → 断言任务终态为 `failed` 且 `error` 非空。

> 注意别把"agent 报了个非致命 warning"也判成失败 —— 需要区分错误级别。
> `agent/error` 事件本身语义就是错误，作为失败信号是安全的。

---

## 5. 顺带发现：hub 侧 `remote_nodes` 因热更新而失败（环境态，非缺陷）

验证开始时，`remote_nodes` 工具**整个调用失败**：

```
Error: tool "remote_nodes" returned invalid output:
       "value.nodes[0].resource" must be an object
```

根因不是代码，而是**运行中的 DSH 持有旧模块**：

| 项 | 时间 |
|---|---|
| DSH 桌面进程启动 | `2026-10-16 18:53:00` |
| `tools.js` 被修好（含数组递归修复） | `2026-10-16 18:58:49` |
| 该修复的提交 | `24cae76 修 dropNullForSchema 不递归（工具返回值被 schema 拒）` |

`dropNullForSchema` 的数组分支是 **18:58:49** 才补上的，而 hub 进程
**18:53:00** 就起来了 —— 进程内还是旧版 `tools.js`，所以 `nodes[].resource`
的 `null` 没被剥掉。仓库工作区的文件与安装副本的 sha256 **完全一致**，
确认磁盘上已经是修好的版本。

⇒ **结论：重启 DSH 桌面版即消失**，属"热更新后未重启"的环境态。
记录在此，是为了避免下一个人把它当成真缺陷去查。

（另：`remote_nodes` 失败不影响其他六个工具 —— `remote_task` / `remote_status` /
`remote_handoff` 全程正常，本次验证就是靠它们完成的。）

---

## 6. 复现步骤

```powershell
# 前提：两台都装 DSH 的真机，副机配好 worker 并拨入 hub

# 1) 确认副机在线（hub 侧）
remote_nodes                     # 若报 schema 错，先重启 DSH 桌面版
# 2) exec 对照组
remote_task { node: "newland", mode: "exec", goal: "hostname; node -v" }
remote_status { taskId: "<上一步返回>" }
# 3) agent 模式
remote_task { node: "newland", mode: "agent", workspace: "D:\work",
              goal: "总结你的工作区并给出 100 字摘要" }
remote_status { taskId: "<上一步返回>" }     # 看 progressTail 里有没有 agent-start
remote_handoff { taskId: "<上一步返回>" }    # 看摘要与产物清单

# 4) 副机侧核对会话是否真建起来
#    在副机上读 ~/.dsh-remote-agent/tasks/<taskId>.json
#    期望看到 sessionId=session-remote-<taskId>、runner=in-process
```

判定标准：

- 进度里出现 `agent-start` + 副机任务记录里有 `sessionId` ⇒ **独立会话已创建**；
- 摘要非 `[agent 错误]` 且产物清单符合预期 ⇒ **全链路成功**；
- 摘要含 `[agent 错误]` 但 `status=completed` ⇒ **命中 §4 缺陷**，先查副机凭证。

---

## 7. 待办

| # | 事项 | 优先级 |
|---|---|---|
| 1 | 修 §4：agent 级错误应把任务落成 `failed`（含测试） | 高 |
| 2 | 副机补 LLM 凭证后重跑，确认 agent 模式**成功**路径（本次只验到失败路径） | 高 |
| 3 | 统一两端插件版本（hub 0.3.0 / worker 0.1.0），排除版本偏斜 | 中 |
| 4 | 在副机登录后，复验 `remote_task(mode:'agent', model:{...})` 的模型选择链路 | 中 |
