# 副机部署实录：五个坑与排查方法

> 来源：2026-10-15~16 在一台 Windows 副机（`newland`）上从零接入 hub 的真实过程。
> 每个坑都是**多次重启换来的**，而且**换一台副机还会全踩一遍**。
>
> 这份文档的目的不是"记录我们修了什么"，而是让下一个人**不必重新踩**。

---

## 0. 先说结论：副机能跑起来需要四个条件同时成立

| 条件 | 不满足时的症状 |
|---|---|
| 1. `role: worker` + `inject` 含 `tools`/`agentLoop`/`sessions` | 任务能派进来但 **agent 拿不到任何工具**（连 shell 都没有） |
| 2. `agent-default-model` 指向**能用的** provider + 兼容的模型 | 任务秒失败，`TRANSPORT` / `UNSUPPORTED_REASONING_EFFORT` |
| 3. `roots` 至少一项且真实存在 | `task/end failed(workspace-denied)` |
| 4. 插件版本与 hub 匹配 | 行为诡异（旧版没有新修的路由/字段） |

**下面五个坑分别落在这四个条件上。**

---

## 坑 1：`inject: []` 让 agent 一个工具都拿不到

### 症状

任务**能派进来、agent 能推理、能调工具**，但：

```
agent 自己的输出：
  "the only tool I have is load_workspace_dependencies.
   There is no shell/exec, no file-write tool, and no read tool"
```

**`load_workspace_dependencies` 是 DSH 全局注入的**，所以它"能调工具"是假象 ——
真正需要的能力（shell / 读写文件）**一个都没有**。

### 根因

副机的 loader 行原本写 `inject: []`（我们**曾经这么建议过**，理由是"副机不需要
`webServer`/`tools`/`systemPrompt`，不清空会永远 PENDING"）。

**但 `inject` 不只影响插件自己** —— 它还决定 **agent 的 ctx 能看见什么服务**：

> agent 的 ctx 是 `createScope(loopCtx)`，**继承 minting plugin 的依赖 API**。
> 工具插件（`dsh-tool-bash` / `dsh-tool-fs` / …）在各自 `apply()` 里
> `ctx.tools.register(...)` 注册到**组合级注册表**，agent 的 turn 循环
> 通过继承的 `ctx.tools` 派发。

所以 `inject: []` → agent 的 ctx 里**没有 `tools`** → 工具集为空。

### 正确写法

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: ['tools', 'agentLoop', 'sessions']
  config:
    role: worker
    ...
```

**三个服务各自的用途**：

| 服务 | 为什么需要 |
|---|---|
| `tools` | agent 的 ctx 继承它 → shell / 文件工具可用 |
| `agentLoop` | 起 agent 会话（`createAgent`） |
| `sessions` | 拿 session |

### 排查方法

**不要看"任务成功没有"** —— 看 **agent 自己的输出**：

```
remote_status 的「进度尾巴」里，agent 说没有 shell/工具 → 就是这个坑
```

---

## 坑 2：provider 指向了挂掉的中转站

### 症状

```
error: {"message":"DeepSeek Messages transport failed","code":"TRANSPORT"}
```

**秒失败**（~1 秒），agent 一句话都没说。

### 根因

副机的 `llm-pi-ai.providers` 指向 `https://apidu.cn/v1` —— 该站返回
**503 `平台维护中 暂停服务`**。

### 正确做法：用官方端点

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      official:                                    # 自定义名字
        apiKeyEnv: DEEPSEEK_API_KEY
        api: openai-completions
        baseURL: https://api.deepseek.com/v1
        models:
          - id: deepseek-chat
          - id: deepseek-reasoner
```

### 排查方法：**先单独测 key，再改配置**

```powershell
# 直连官方端点，确认 key 可用（不要等到派任务才发现）
$key = (Get-Content "$env:USERPROFILE\.dsh\.credentials.yaml" -Raw |
        Select-String -Pattern 'DEEPSEEK_API_KEY\s*:\s*(\S+)').Matches[0].Groups[1].Value
Invoke-RestMethod -Uri 'https://api.deepseek.com/chat/completions' -Method Post `
  -Headers @{ Authorization = "Bearer $key"; 'Content-Type' = 'application/json' } `
  -Body '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

**返回内容 = key 好；401/503 = key 或端点有问题。** 先解决这个再动插件配置。

---

## 坑 3：`reasoningEffort` 与模型不兼容

### 症状

```
error: provider "official" model "deepseek-chat" does not support reasoning effort "high"
code: UNSUPPORTED_REASONING_EFFORT
```

### 根因

```yaml
agent-default-model:
  provider: official
  model: deepseek-chat        # 非推理模型
  reasoningEffort: high       # ← 但它不支持推理档位
```

`deepseek-chat` 是**对话模型**，没有推理档位。要么删掉 `reasoningEffort`，
要么换成 `deepseek-reasoner`（它支持）。

### 排查方法

**报错信息本身就说清了** —— 这个坑只是容易忽略（因为它出现在"前一个坑刚修好"之后）。

---

## 坑 4：GUI 会把手工改的配置覆盖回去

### 症状

**改了 `cordis.patch.yml`，重启后配置又变回去了。**

时间线证据：

```
20:43:07  cordis.patch.yml 被修改    ← GUI 写的
20:45:37  DSH 启动
```

### 根因

**DSH 的「设置 → 账户/模型」页会写回 `cordis.patch.yml`**。
你在 GUI 里选过 provider/model，它就记在那儿 —— **下次打开设置页或某些操作会重写**。

### 应对

| 做法 | 效果 |
|---|---|
| **在 GUI 里改**（而不是改文件） | 一劳永逸，GUI 写回的就是你要的 |
| **用面板的「切换角色」** | 它会**同时写 role + inject**，且带备份 |
| 改文件后**别再打开设置页** | 临时可用，但脆弱 |

**最稳的**：让自定义 provider 的**名字**与 GUI 里选的那个一致，这样
GUI 写回的值正好指向你的端点。

---

## 坑 5：插件版本落后于 hub

### 症状

- 行为诡异（缺新路由、字段对不上）
- 插件管理页显示「异常」
- **`node_modules` 里有 `<pkg>_tmp_<pid>_<n>` 残留**

### 根因与应对

**pnpm 事务需要原子交换包目录**。若交换期间有进程持有包内文件
（实测是 orb 悬浮球 helper），事务会半途而废，留下 `_tmp_` 残留。

**清理步骤**（必须**完全退出 DSH**）：

```powershell
# 1. 确认 DSH 已退出（含托盘图标）
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue

# 2. 删残留
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules" -Directory |
  Where-Object { $_.Name -match '_tmp_\d+_\d+$' } |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

# 3. 重装
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node "D:\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.cjs" add 'github:zbzbhs/dsh-remote-agent'
```

**判断版本是否落后**：对比 `node_modules/dsh-remote-agent/package.json` 的
`version` 与 GitHub 上 `main` 的。

---

## 附：副机排查的最短路径

**不要靠猜。按这个顺序，每步都有明确的通过/失败判据：**

```
1. 连接通不通？
   remote_nodes 看节点是否 online
   ↓ 不通 → 查 hubUrl / token / 防火墙

2. 任务能不能派进去？
   remote_task 派一条 exec 任务（最简单，不需要模型）
   ↓ 派不进 → 查 role: worker、节点在线状态

3. 模型通不通？
   派一条 agent 任务，看 remote_status 的进度尾巴
   ↓ 秒失败 + TRANSPORT → 坑 2
   ↓ UNSUPPORTED_REASONING_EFFORT → 坑 3

4. agent 有没有工具？
   看 agent 自己的输出（它会说"我只有 load_workspace_dependencies"）
   ↓ 没有 → 坑 1（inject）

5. 版本对不对？
   对比 package.json 的 version 与 GitHub main
   ↓ 落后 → 坑 5
```

**关键经验**：**第 1、2 步能独立验证，先跑通它们再碰模型问题**。
我们当初把"模型问题"和"工具问题"混在一起查，两边互相掩盖，多花了很多轮。

---

## 附：为什么 `inject` 必须与角色匹配

**这是一条容易反直觉的契约**，值得单独说：

| 角色 | `inject` 必须包含 | 漏了会怎样 |
|---|---|---|
| `hub` | `webServer` + `tools` + `systemPrompt` | **hub 半死**：路由活着但 8 个工具全丢，插件页显示「异常」 |
| `worker` | `tools` + `agentLoop` + `sessions` | **agent 无工具**：能推理但不能干活 |
| `''`（未配置）| `webServer`（够注册引导路由）| 面板拿不到引导 |

**hub 侧的失败形态特别隐蔽**：`applyHub` 里工具注册在路由注册**之后**，
所以现象是**一半活一半死** —— `/healthz` 返回 200 还带着实时计数，
但工具全没了。我们用 `grep` 在工具列表里搜 `remote_` 才确认。

**契约的自动化守卫**：`test/inject-contract.test.js`（6 条）——
既断言包内 `inject` 含三个服务，也断言 `applyHub` 实际访问的服务都在声明里。
