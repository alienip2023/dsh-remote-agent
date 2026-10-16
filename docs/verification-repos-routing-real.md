# 真机验证：仓库感知调度 / 负载路由 / 审计日志（2026-10-16）

> 验证对象：`#13 仓库感知调度`（`8e1df74`）、`#14 负载感知自动路由`（`86269a2`）、
> `#19 hub 审计日志`（`966bed1`）。仓库 `HEAD` = `8e1df74655af1d0aeffd48233f3c8c4bc1329717`。
> 部署与验证指引见 [profiles/README.md](../profiles/README.md)、[SECURITY.md](../SECURITY.md)。

## 结论速览

| # | 待验证项 | 结果 |
|---|---|---|
| 13 | worker 接入后 ~10s 内出现 `node repos updated` | ✅ 实测 **54ms** |
| 13 | `remote_nodes` 输出里能看到 repos 名单 | ✅ 有 `repos` 字段 + 渲染行 |
| 13 | 凭证剥离：url 里不含 `secrettoken123` | ✅ 未泄漏（但见问题 3 的 scp 边界） |
| 13 | `repo:` 路由 + workspace 自动兜底 | ✅ 命中，workspace = 仓库本机路径 |
| 13 | 不存在的仓库名报错列出已知名单 | ✅ 列出了 `dsh-remote-agent、fixture-cred` |
| 13 | 周期刷新（新 clone 仓库进清单） | ✅ 实测 **4298ms**（interval=5000ms） |
| 14 | 两台空闲按 nodeId 字典序 | ✅ `node-a` |
| 14 | 一台忙时第二单落到另一台 | ✅ 落到 `node-b` |
| 14 | `agentMode:false` 让 agent 任务只选支持的那台 | ⚠️ **过滤逻辑正确，但 `agentMode` 无法通过 config 关闭（硬编码 `true`）** |
| 19 | `audit.jsonl` 真实生成 | ✅ 生成；**真实 hub 已有 496 行** |
| 19 | `task.dispatch` / `task.cancel` / `pull.end` 都在 | ✅ 四类事件齐全（含 `pull.start`） |
| 19 | goal 里的 token 形态字符串被打码成 `***` | ❌ **未打码**（见问题 1） |

**一句话**：三个特性的**主链路全部真实跑通**（仓库扫描/凭证剥离/`repo:` 路由/负载避让/审计四事件），
但发现 **3 个真问题**：审计打码只覆盖**键名**不覆盖**值**（任务书里的 token 原样落盘）、
`agentMode` 硬编码导致 `#14` 的"能力过滤"在实际部署里**永远不起作用**、
以及**测试把审计事件写进了用户真实 stateDir**。

---

## 1. 环境与拓扑

| 项 | 值 |
|---|---|
| 主机 | Windows，`DESKTOP-OBOJM0B` |
| Node | v24.18.0 |
| git | 2.54.0.windows.1 |
| 代码快照 | `git archive HEAD`（`8e1df74`）解到 `D:\verify-lab\repo`，与工作区隔离 |
| hub | `applyHub()` —— `NodeRegistry` + `PullManager` + 7 工具 + UI 路由 |
| worker | `applyWorker()` —— `TaskStore` + `ArtifactService` + `TaskEngine` + `NodeTransport` |
| 传输 | 真 HTTP server + 真 WebSocket upgrade 握手（`ws://127.0.0.1:<随机端口>/api/remote-agent/node`） |

装配全是**真实实现，无替身**。所有验证脚本在 `D:\verify-lab\` 下，可重跑。

### 1.1 造的两个仓库 fixture

```
D:\verify-lab\ws\
├── dsh-remote-agent\     ← git clone 本仓库一份（真实仓库）
├── fixture-cred\         ← 故意把 origin url 写成内嵌凭证
└── late-clone\           ← 第 5 步"周期刷新"时运行中新 clone 的
```

`fixture-cred` 的 `.git/config` 原文（测试前提）：

```ini
[remote "origin"]
	url = https://testuser:secrettoken123@corp.example/fake.git
	fetch = +refs/heads/*:refs/remotes/origin/*
```

已确认 `secrettoken123` 真的写进了磁盘 —— 否则"凭证剥离"这条验证没有意义。

---

## 2. #13 仓库感知调度

### ① 扫描与凭证剥离（单元级，最直接的证据）

直接调 `scanRepos(['D:\verify-lab\ws'])`：

```json
[
  { "name": "dsh-remote-agent",
    "url": "D:\\\\Deepseek Harness file\\\\dsh-remote-agent",
    "path": "D:\\verify-lab\\ws\\dsh-remote-agent" },
  { "name": "fixture-cred",
    "url": "https://corp.example/fake.git",
    "path": "D:\\verify-lab\\ws\\fixture-cred" }
]
```

**fixture 的 url 从 `https://testuser:secrettoken123@corp.example/fake.git`
变成了 `https://corp.example/fake.git`** —— user 与 password 都被剥掉。

`sanitizeRepoUrl` 逐例：

| 输入 | 输出 | 判定 |
|---|---|---|
| `https://testuser:secrettoken123@corp.example/fake.git` | `https://corp.example/fake.git` | ✅ 剥掉 |
| `https://user:tok@github.com/a/b.git` | `https://github.com/a/b.git` | ✅ 剥掉 |
| `https://github.com/a/b.git` | 原样 | ✅ |
| `git@github.com:a/b.git` | 原样 | ✅（scp 形态，见问题 3） |
| `D:\Deepseek Harness file\dsh-remote-agent` | 原样 | ✅ 本地路径 |

### ② hub 侧 `node repos updated` + `remote_nodes`

worker 上线后，hub 日志**实测 54ms** 出现（远小于 10s）：

```
[info] [remote-agent] node repos updated {"nodeId":"repos-worker","count":2}
```

> ⚠ 复现时注意：hub 日志消息带 `[remote-agent] ` 前缀，用精确相等匹配
> （`m === 'node repos updated'`）会**永远匹配不上**，必须用 `endsWith`。
> 这是本次踩到的第一个坑，记录在此以免下一个人重复。

`remote_nodes` 工具输出（JSON）：

```json
[{ "nodeId": "repos-worker", "online": true,
   "repos": ["dsh-remote-agent", "fixture-cred"],
   "reposAt": 1792152138357 }]
```

渲染文本（模型实际看到的样子）：

```
远程节点（1/1 在线）：

- repos-worker [online] windows/x64 host=DESKTOP-OBOJM0B agentMode=true tasks=0
  roots: D:\verify-lab\ws
  caps: fs, exec, artifact, agent
  repos: dsh-remote-agent, fixture-cred（remote_task 可用 repo:"名字" 按仓库路由）
```

### ③ 凭证剥离（hub 侧实测）

hub 进程内 `rec.repos` 的完整序列化：

```
hub 侧 fixture 条目: {"name":"fixture-cred","url":"https://corp.example/fake.git","path":"D:\\verify-lab\\ws\\fixture-cred"}
hub 侧全部 repos 序列化后含 secrettoken123 ? false
hub 侧全部 repos 序列化后含 testuser ?        false
→ ✓ 通过：凭证未离开副机
```

**这是安全承诺的实测确认**：hub 侧从传输到投影到工具输出，`secrettoken123`
与 `testuser` 都不出现。

### ④ `repo:` 路由

```
4a) repo:"fixture-cred" 省略 workspace
    node=repos-worker  accepted=true  workspace=D:\verify-lab\ws\fixture-cred
    期望 workspace = D:\verify-lab\ws\fixture-cred
    → ✓ workspace 自动兜到仓库本机路径

4b) repo:"corp.example/fake"（url 片段）
    → node=repos-worker  workspace=D:\verify-lab\ws\fixture-cred

4c) repo:"does-not-exist-xyz"
    → ✓ 报错: 没有在线节点持有仓库 "does-not-exist-xyz"；当前已上报的仓库：dsh-remote-agent、fixture-cred
```

三种写法（仓库名 / url 片段 / 路径片段）都收，与 `pickNodeByRepo` 的注释一致。
**不存在的仓库名确实列出了已上报名单** —— 任务要求这一条满足。

补充验证（多节点 + 匹配优先级 + 离线过滤）：

```
两节点都空闲           → alpha
alpha 忙 1 条          → beta          ← 负载感知生效
beta 离线后            → alpha         ← 离线节点不参与
两台都离线             → null
查 "my-app"（n1 有 my-app-extra，n2 有 my-app） → n2   ← 精确匹配优先于包含
```

### ⑤ 周期刷新

```
✓ 已 clone 新仓库到 D:\verify-lab\ws\late-clone
扫描前 hub 侧仓库: ["dsh-remote-agent","fixture-cred"]
✓ 新仓库已出现在 hub 清单（耗时 4298ms，interval=5000ms）
扫描后 hub 侧仓库: ["dsh-remote-agent","fixture-cred","late-clone"]
hub 侧 "node repos updated" 日志条数: 2
```

**周期刷新已验证**（任务书说第 5 步不方便可跳过 —— 实际跑通了）。
`reposIntervalMs: 5000` 生效，4298ms 后新仓库进清单。

---

## 3. #14 负载感知自动路由

### ① 两台空闲 → nodeId 字典序

```
✓ 两个 worker 上线: node-a, node-b
第一条 → node=node-a  ✓ 命中字典序
第二条 → node=node-a  ✓ 一致
```

### ② 一台忙 → 第二单落到另一台

```
长任务 → node=node-a taskId=t-mvax4eogclaj
此刻在跑任务数: node-a=2  node-b=0
第二单（不指定 node）→ node=node-b  ✓ 正确避开了忙碌的 node-a
```

（`node-a` 显示 2 条是因为它自己那条长任务 + 上一步的收尾任务尚未翻终态；
关键是 `node-b=0` 时新任务**确实落到了 node-b**。）

agent 模式下同样成立：

```
① agent 模式 + node-a 忙 → node=node-b  accepted=true  runner=headless
   → ✓ agent 任务避开了忙碌的 node-a，落到 node-b
② 两台都空闲时 agent 模式 → node=node-a  (期望 node-a) → ✓ 字典序
```

### ③ `agentMode:false` —— 过滤逻辑对，但配置关不掉

任务书要求"把一台配置成不支持 agent（`agentMode:false`），确认 agent 任务只选支持的那台"。

**实测：`agentMode` 无法通过 config 关闭。**

```
node-a hello.agentMode = true
node-b hello.agentMode = true
尝试：重启 node-b 并传 agentMode:false
重启后 node-b hello.agentMode = true  (期望 false)
✗ agentMode 无法通过 config 关闭（硬编码 true）
```

根因（代码级）：

```
lib/node/index.js:324:      agentMode: true,     ← buildNodeHello 里硬编码
lib/node/index.js:877:      agentMode: true,     ← statusSnapshot 里也硬编码
```

全仓 grep 确认：`agentMode` 在 `lib/` 下**只有这两处赋值，都是字面量 `true`**，
没有任何配置读取。`profiles/worker.cordis.yml` 也没有这个字段。

**过滤逻辑本身是正确的** —— 手工构造节点直接验证：

```
=== 场景：node-a(agentMode=true) / node-b(agentMode=false) ===
exec  模式自动选 → node-a   （exec 无能力要求）
agent 模式自动选 → node-a   （只有它支持 agent）

=== 场景：node-a(false) / node-b(true) ===
agent 模式自动选 → node-b

=== 场景：两台都不支持 agent ===
agent 模式自动选 → null      （期望 null）
exec  模式自动选 → node-a    （exec 无要求，仍能选）
```

⇒ **`pickAutoNode` 的能力过滤实现无误，但因为 `agentMode` 恒为 `true`，
这段过滤在真实部署里永远走不到"排除"分支**。`CHANGELOG.md` 写的
"`mode:"agent"` 只考虑支持 agent 后端（agentMode）的节点"目前是**空承诺**。

> 注意：真实场景下"副机支不支持 agent"其实由 `runner.kind` 决定
> （`in-process` vs `headless`），而 `hello.agentMode` 与之无关联。
> 本次实验里副机 `runner=headless`（无 DSH 上下文，走 headless 回退），
> 但 `agentMode` 仍报 `true`。所以这个字段目前**既不可配、也不反映真实能力**。

---

## 4. #19 hub 审计日志

### ① 文件生成（惰性创建）

```
hub 日志: {"file":"D:\\verify-lab\\run\\hub-state\\audit.jsonl","enabled":true}
```

注意：`createAuditLog` **不在启动时创建文件**，而是首次 `record()` 才落盘
（已单独确认：创建后 `audit.jsonl 存在? false`，`record + dispose` 后才 `true`）。
所以"hub 起来但没派过任务"时看不到文件是**正常**的，不是 bug。

**真实生产 hub 也已在写**：

```
C:\Users\MR\.dsh-remote-agent\audit.jsonl   127054 bytes   496 行
事件分布:  task.dispatch 240 / pull.end 112 / pull.start 112 / task.cancel 32
首行: {"ts":"2026-10-16T11:08:57.129Z","event":"task.dispatch",...,"nodeId":"test-worker",...}
末行: {"ts":"2026-10-16T11:52:04.723Z","event":"pull.end",...,"relPath":"f.txt","ok":true,"bytes":6}
```

### ② 四类事件齐全

派发 + 取消 + 拉取一轮后的完整文件（6 行）：

```json
{"ts":"...","event":"task.dispatch","taskId":"t-mvax4s9p106t4","nodeId":"audit-worker","mode":"exec","workspace":"","goal":"echo hi; # api_key=sk-abc123","outputsCount":1,"timeoutMs":3600000}
{"ts":"...","event":"task.dispatch","taskId":"t-mvax4salp7o9",...,"goal":"Set-Content -LiteralPath 'D:\\verify-lab\\run\\ws-a\\out.txt' ..."}
{"ts":"...","event":"task.dispatch","taskId":"t-mvax4sl5pivi",...,"goal":"Start-Sleep -Seconds 30; echo long","outputsCount":0,"timeoutMs":3600000}
{"ts":"...","event":"task.cancel","taskId":"t-mvax4sl5pivi","nodeId":"audit-worker","delivered":true}
{"ts":"...","event":"pull.start","taskId":"t-mvax4salp7o9","nodeId":"audit-worker","relPath":"out.txt","dest":"D:\\verify-lab\\run\\dest"}
{"ts":"...","event":"pull.end","taskId":"t-mvax4salp7o9","nodeId":"audit-worker","relPath":"out.txt","ok":true,"bytes":16}
```

```
- task.dispatch: 3 次 ✓
- task.cancel:   1 次 ✓
- pull.start:    1 次 ✓
- pull.end:      1 次 ✓
```

**任务要求的三类事件（`task.dispatch` / `task.cancel` / `pull.end`）都在**，
外加 `pull.start`。

### ③ 打码 —— 这里发现真问题

任务书要求："故意在任务 goal 里放一个长得像 token 的字符串（如 `api_key=sk-abc123`），
确认落盘内容被打码成 `***`。"

**实测：未打码。**

```
goal = "echo hi; # api_key=sk-abc123"

落盘内容含 "sk-abc123" ?          true
落盘内容含 "api_key=sk-abc123" ?  true
落盘内容含 "***" ?                false

命中的 task.dispatch 行 goal 字段原文:
  "echo hi; # api_key=sk-abc123"
→ ✗ 未打码：token 形态字符串原样落盘
```

根因（代码级）：`lib/hub/hub-util.js:10` 的打码正则只用来匹配**键名**：

```js
export const REDACT_KEY_RE = /(token|secret|password|passwd|credential|apikey|api_key|authorization)/i
```

而 `sanitizeExtra`（`hub-util.js:43`）的用法是：

```js
for (const [k, v] of Object.entries(extra)) {
  if (REDACT_KEY_RE.test(k)) { out[k] = '***'; continue }   // ← 只看 k（键名）
  ...
  if (typeof v === 'string') out[k] = clip(v)               // ← 值只做长度截断
```

逐例确认口径：

| 输入 | 输出 | 说明 |
|---|---|---|
| `{ token: 'sk-abc123' }` | `{"token":"***"}` | ✅ 键名命中 → 打码 |
| `{ api_key: 'sk-abc123' }` | `{"api_key":"***"}` | ✅ |
| `{ goal: 'echo hi; # api_key=sk-abc123' }` | 原样 | ❌ 值里有凭证也不打码 |
| `{ workspace: 'D:\\x\\sk-abc123-token' }` | 原样 | ❌ |
| `{ nodeId: 'sk-abc123' }` | 原样 | ❌ |

**影响**：`task.dispatch` 的 `goal` 字段就是**任务书原文**（`node-registry.js:485`
传的是 `spec.goal`）。用户在任务书里写 `curl -H "Authorization: Bearer sk-..."`
或 `mysql -p<password>` 这类命令是**极常见的**，这些凭证会以明文写进
`audit.jsonl` 并**长期留存**（8MB × 3 份轮转）。

对照文档承诺：

- `SECURITY.md:188-189`：*"字段过统一打码层：token/password/apiKey 类键值写 `***`…
  ——凭证与整段任务书**绝不整段落盘**"*
- `CHANGELOG.md:45`：*"字段统一打码截断（token 类键值写 `***`、超长 400 字符截断）"*

严格读，"token 类**键值**"可以解释成"键名匹配的才打码"，所以实现**不算违背字面承诺**；
但"凭证绝不整段落盘"这句**在语义上被打破**了 —— goal 里的凭证确实整段落盘了。
建议在文档里明确"打码只按**键名**，任务书正文不做凭证扫描"，或补一层值级扫描
（`sk-[A-Za-z0-9]{16,}`、`Bearer <token>`、`://user:pass@` 之类）。

### ④ 轮转与故障隔离（补充验证）

```
=== ① 轮转（maxBytes=400, maxFiles=3） ===
目录内容: audit.jsonl(284B), audit.jsonl.1(426B), audit.jsonl.2(426B)
→ 最多 3 份，符合 maxFiles=3   ✓

=== ② pull.end 失败路径 ===
审计事件序列:
  pull.start {taskId:"tf",nodeId:"n1",relPath:"a.bin",dest:"..."}
  pull.end   {taskId:"tf",nodeId:"n1",relPath:"a.bin",ok:false,error:"internal"}
→ ✓ 失败路径也记（ok=false + error 码）

=== ③ 审计写入器抛错时任务链路是否受影响 ===
→ pull() 未因审计抛错而崩 ✓
→ 审计 record 抛错时 pull 仍成功: ✓   ← "绝不影响任务链路"成立
```

### ⑤ 测试污染用户真实 stateDir（真问题）

验证过程中发现**真实 hub 的 `audit.jsonl` 里混进了测试数据**：

```
audit 里出现过的 nodeId:  ui-worker: 272   test-worker: 224
```

这两个 nodeId 来自 `test/hub-worker-e2e.test.js`（`nodeId: 'test-worker'`）与
`test/ui-routes.test.js`（`ui-worker`）—— **不是真实副机**。

根因：这两个测试建 hubConfig 时**没有传 `stateDir`**：

```
test/hub-worker-e2e.test.js:239: const hubConfig = { role: 'hub', systemPrompt: false }
test/ui-routes.test.js:274:      const hubConfig = { role: 'hub', systemPrompt: false, relay: {...} }
```

于是 `normalizeConfig` 落到 `defaultHubStateDir()`：

```js
function defaultHubStateDir() {
  return path.join(os.homedir(), '.dsh-remote-agent')   // ← 用户真实状态目录
}
```

**实测复现**：

```
测试前行数: 496
$ node --test test/hub-worker-e2e.test.js
测试后行数: 510
新增: 14 行
=== 新增的行 ===
{"ts":"...","event":"task.dispatch","taskId":"t-mvax5mw45yt5","nodeId":"test-worker","mode":"exec","workspace":"C:\\Users\\MR\\AppData\\Local\\Temp\\dsh-hubworker-e8JBSw\\ws","goal":"Set-Content -LiteralPath '报告.txt' ..."}
...
```

**跑一次测试就往用户真实状态目录写 14 行审计事件。** 影响：

1. 污染真实审计证据链（`test-worker` / `ui-worker` 这类条目会被误认为真实活动）；
2. 测试间不隔离（并行跑测试会交错写同一文件）；
3. 长期跑 CI/本地测试会不断撑大该文件，触发轮转、**把真实审计记录挤掉**。

**修法建议**（不在此处实施）：给这两处 hubConfig 加
`stateDir: path.join(root, 'hub-state')`，与 `workerConfig.stateDir` 一样落在
临时目录里。另建议加一条测试断言"applyHub 未传 stateDir 时审计落在临时目录"，
或在测试环境（`NODE_TEST_CONTEXT`）下强制审计默认关闭。

---

## 5. 发现的问题汇总

| # | 严重度 | 问题 | 位置 | 复现 |
|---|---|---|---|---|
| 1 | **中** | 审计打码只按**键名**，任务书正文里的 token 明文落盘 | `lib/hub/hub-util.js:10,43` | `node task3-audit.mjs`（见 §4③） |
| 2 | **中** | `agentMode` 硬编码 `true`，`#14` 的能力过滤在真实部署里永不生效 | `lib/node/index.js:324,877` | `node task2-load.mjs`（见 §3③） |
| 3 | **中** | 测试未传 `stateDir` → 审计事件写进用户真实 `~/.dsh-remote-agent/` | `test/hub-worker-e2e.test.js:239`、`test/ui-routes.test.js:274` | `node --test test/hub-worker-e2e.test.js` 后对比行数（见 §4⑤） |
| 4 | 低 | scp 形态 url 的用户名位置放 token 不会被剥（`token123@github.com:...` 原样上报） | `lib/node/repos.js:38-48` | `node task1b-routing.mjs`（见下） |
| 5 | 低 | hub 日志消息带 `[remote-agent] ` 前缀，文档/脚本若用精确匹配会静默失效 | 测试/脚本侧 | 见 §2② |

### 问题 4 的实测证据

`sanitizeRepoUrl` 只在 `new URL()` **解析成功**时才剥 userinfo。scp 形态
（`user@host:path`，非标准 URL）走 `catch` 分支原样返回：

```
"git@github.com:a/b.git"            -> "git@github.com:a/b.git"       ✅ 公开用户名，无害
"token123@github.com:a/b.git"       -> "token123@github.com:a/b.git"  ⚠️ 用户名位置放 token → 不剥
"https://oauth2:glpat-XXXX@gitlab.com/a/b.git" -> "https://gitlab.com/a/b.git"  ✅ 剥掉
"ssh://git@github.com/a/b.git"      -> "ssh://github.com/a/b.git"     ✅ 剥掉
"https://user@github.com/a/b.git"   -> "https://github.com/a/b.git"   ✅ 剥掉
```

代码注释说 scp 形态"`@` 前是公开用户名，不是凭证"—— 对标准 `git@` 成立，
但**用户名位置完全可以放 token**（有些自建 Git 服务就是这么用的）。
另外 `ssh://git@...` 会把 `git@` 一起剥掉（虽然无害，但说明这个分支
不是按"只剥密码"的精确口径在做事）。属低危边界，建议在注释里点明这一取舍。

---

## 6. 复现步骤

全部脚本在 `D:\verify-lab\`，自装配 hub + worker，**不需要真机双机**：

```powershell
# 前提：Node 22+、git 在 PATH
cd D:\verify-lab

node step1-scan.mjs        # 扫描 + 凭证剥离（单元级）
node task1-repos.mjs       # #13 全流程（②③④⑤ 四步）
node task1b-routing.mjs    # #13 边界（多节点/精确匹配/离线/scp url）
node task2-load.mjs        # #14 字典序 + 负载避让 + agentMode 配置
node task2b-filter.mjs     # #14 能力过滤逻辑（直接构造节点）
node task2c-agentroute.mjs # #14 agent 模式实际路由决策
node task3-audit.mjs       # #19 文件生成 + 四事件 + 打码
node task3b-redact.mjs     # #19 打码口径精确刻画
node task3c-lazy.mjs       # #19 惰性创建
node task3d-rotate.mjs     # #19 轮转 + 失败路径 + 故障隔离
```

判定标准：

- `task1-repos.mjs` 的 ③ 打印 `→ ✓ 通过：凭证未离开副机`；
- `task2-load.mjs` 的 ①② 打印 `✓`，③ 会打印 `✗ agentMode 无法通过 config 关闭`（**预期就是这个**）；
- `task3-audit.mjs` 的 ⑥ 会打印 `✗ 未打码`（**预期就是这个**）。

---

## 7. 临时部署拆除

所有脚本末尾按 `worker → hub → http server` 顺序释放，每次都打印：

```
✓ 临时部署已拆除
```

- 实验全程在 `D:\verify-lab\run\` 下，hub/worker 的 `stateDir` 都指向该临时目录；
- **未触碰** `~/.dsh-remote-agent/` 与 DSH profile 的 `cordis.patch.yml`
  （唯一的例外是问题 3 —— 那是**测试自身**的行为，不是本次实验脚本造成的）；
- 已确认无残留 node 进程。

---

## 8. 边界与未覆盖

| 项 | 状态 |
|---|---|
| `reposIntervalMs: 0` 关闭上报 | ❌ 未覆盖（代码路径明确，未实测） |
| 仓库数 > 50（`MAX_REPOS` 截断） | ❌ 未覆盖 |
| 扫描深度 > 3（`MAX_DEPTH`） | ❌ 未覆盖 |
| worktree / submodule 的 `.git` 是文件 | ❌ 未覆盖（代码注释声明留 v2，只认目录） |
| 真实双机跨 Tailscale 的 repo 上报 | ❌ 未覆盖（本次进程内双 worker） |
| `audit: false` 显式关闭 | ❌ 未覆盖 |
| 审计 8MB 轮转的真实触发 | ⚠️ 用 `maxBytes: 400` 缩小验证了逻辑，未跑满 8MB |
| 面板节点列表的 repos 列渲染 | ❌ 未覆盖（只验了 `remote_nodes` 工具输出） |
| 真实 DSH 桌面版里的三个特性 | ❌ 未覆盖（本次是进程内装配；DSH 侧需重启加载新代码） |
