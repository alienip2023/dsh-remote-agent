# dsh-remote-agent

把另一台电脑变成你 DSH 的**远程 Agent 同事**。

副机拥有自己的 DSH 与独立 Agent 循环，任务在它本地持久运行；主电脑只拿到
**handoff 结果卡**与**产物清单**，成品要显式拉取才过河。

```
┌─────────────── 主电脑（hub）────────────────┐
│  DSH · 模型 · 会话日志 · 全部凭证            │
│  ┌─ dsh-remote-agent ─────────────────────┐ │
│  │ 7 个 remote_* 工具 + Web 面板           │ │
│  └────────────────────────────────────────┘ │
└──────────────────▲──────────────────────────┘
                   │ 节点主动拨入（direct / relay）
┌──────────────────┴──────────────────────────┐
│  ┌─ 副电脑（worker）───────────────────────┐ │
│  │  独立 Agent 循环 · 独立模型上下文        │ │
│  │  D:\work\**  中间产物留在这里            │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

| | |
|---|---|
| **状态** | 0.1.0 —— 主机侧端到端可用；副机 `exec` 可用，`agent` 后端两个根因已修（source 类型 + 模型选择），**待实机端到端确认**（见 [KNOWN-ISSUES](KNOWN-ISSUES.md)）|
| **DSH** | 桌面版 / CLI，0.2.0-rc.2 验证 |
| **平台** | Windows（全量验证）· Linux / macOS（CI 覆盖）|
| **依赖** | **零外部 npm 依赖** —— 只用 `node:` 内置模块 |
| **Node** | `^22.19.0 \|\| >=24.0.0` |

---

## 五分钟上手

不读下面的任何细节，跟着向导走就能配好。**两台机器各跑一次向导**：

```bash
node bin/dsh-remote-setup.js
```

1. **主机上跑**：选「1=主机」→ 向导自动找本机局域网 IP、生成 `nt_` 强随机
   `nodeToken`、替你把两台机器的 YAML 都写出来（含**防火墙放行命令**）。
2. **副机上跑**：选「2=副机」→ 粘上主机地址与 token → 向导会**先探活主机
   端口**，然后生成副机配置。最坑的 `inject: []` 已替你填好（不填它副机
   会永远静默不上线）。
3. 两台重启 DSH，对主机说一句「**副机上有哪些节点在线？**」—— 在线即通。
4. 出问题就体检（读取配置文件逐项检查，每项 ✗ 都带怎么修）：

```bash
node bin/dsh-remote-setup.js --doctor 你的配置.yml
```

不想交互？一条命令直接生成：`--role worker --hub-url 192.168.1.10:19387
--token nt_xxx --roots D:\work --node-id slave-pc`。

---

## 核心不变式

这四条是这个包的设计前提，改动前请先读：

| 不变式 | 含义 |
|---|---|
| **凭证不离开副机** | 协议里不带模型 key；副机用自己的模型配置 |
| **断连不终止任务** | 任务在副机本地持久运行，中继挂了也跑完，重连后自动对账 |
| **清单先于字节** | 任务结束只回 manifest + handoff；成品要 `remote_pull` 才传输 |
| **只有 `role:final` 过河** | 日志/缓存/中间构建文件只在副机留存，仅上报元数据 |

---

## 安装

### 主机（hub）

```bash
dsh plugin add github:zbzbhs/dsh-remote-agent
```

或在 DSH 的插件对话框里填 `github:zbzbhs/dsh-remote-agent`。

装完在 `cordis.patch.yml` 里确认这一行存在（包内 patch 会自动插入）：

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: ['webServer', 'tools', 'systemPrompt']
  config:
    role: hub
```

### 副机（worker）

**同一份包**，但配置不同 —— 关键是**必须加 `inject: []`**：

```yaml
- id: remote-agent
  name: dsh-remote-agent
  inject: []                    # ← 副机必加，否则永不激活（见下方说明）
  config:
    role: worker
    nodeId: slave-pc
    transportMode: direct
    hubUrl: 'ws://<主机地址>:19387/api/remote-agent/node'
    token: '<与主机 nodeToken 相同，或留空>'
    roots: ['D:\work']          # ← 改成副机真实存在的目录
```

> **为什么副机要写 `inject: []`**
>
> 包内 `cordis.patch.yml` 给这一行声明了
> `inject: ['webServer','tools','systemPrompt']` —— 那是 **hub 需要的服务**。
> 副机 profile 里**没有**这些服务，不清空的话这一行会一直停在 **PENDING**
> **永远不激活**，副机也就永远不拨入。loader 按 id 覆盖，所以写 `inject: []`
> 就覆盖掉了包内的声明。

**接入路径**（双方都在 NAT 后 / 一方有公网 / 隧道）见
**[profiles/README.md](profiles/README.md)** —— 那里有每条路径的配置片段与验证命令。

---

## 用法

装好后**不需要记命令**，直接说话：

| 你说 | agent 调用 |
|---|---|
| 「副机上有哪些节点在线？」 | `remote_nodes` |
| 「让副机在 D:\work 里跑一下测试」 | `remote_task` |
| 「那个任务怎么样了？」 | `remote_status` |
| 「给我个汇总」 | `remote_handoff` |
| 「有哪些成品？」 | `remote_manifest` |
| 「把 report.pdf 拉过来」 | `remote_pull` |
| 「取消那个任务」 | `remote_cancel` |

另有一个 Web 面板（侧栏「远程同事」）：节点列表、派发任务、任务状态、
结果摘要、工作区变更、成品清单、日志尾巴。

### 工具速查

<details>
<summary><code>remote_task</code> 的参数</summary>

| 参数 | 说明 |
|---|---|
| `goal` | 任务目标。`mode=agent` 时是给副机 agent 的任务书；`mode=exec` 时是要执行的命令 |
| `node` | 目标节点 id。省略时要求恰好只有一个在线节点 |
| `workspace` | 副机上的绝对路径，必须在节点 `roots` 内。省略用默认 |
| `mode` | `agent`（副机起独立 agent 会话，默认）/ `exec`（直接跑命令）|
| `model` | 可选。副机用的模型（仅 `mode=agent` 生效）：`{model:"deepseek-chat"}` 或 `{provider:"openai",model:"gpt-4o"}`。只传选择不传凭证 —— 副机用自己的 provider 配置跑；headless 后端不支持 |
| `outputs` | 期望产出物的 glob（相对工作区），用于产物清单筛选 |
| `timeoutMs` | 副机侧超时，默认 1 小时 |
| `denyPaths` | 额外禁止访问的绝对路径 |
| `artifactRules` | 覆盖内置产物角色判定，例如 `{ intermediate: ["build/**"] }` |

**`exec` 模式在 Windows 副机上跑的是 PowerShell** —— 用 `;` 分隔命令，
不要用 `&`（会被拒）。需要 cmd 语法时显式 `cmd /c "..."`。

</details>

---

## 安全

**这个插件让主机能在另一台电脑上读写文件、执行命令。** 部署前请读
**[SECURITY.md](SECURITY.md)**，尤其这三条：

1. **`nodeToken` 默认不校验** —— 公网部署**必须**配。留空只适用于完全可信的私网
   （Tailscale / 同机 / 可信 LAN）。
2. **传输不自带 TLS** —— 公网直连必须在前面放 TLS 反代，用 `wss://`。
3. **`roots` 是真正的安全边界** —— 只给任务需要的目录，不要给整个盘或用户 home。

---

## 结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口（角色分发器：`role: hub` / `worker` / `both`） |
| `lib/hub/**` | 主机侧：节点注册表、7 个工具、subagent provider、UI 路由 |
| `lib/hub/views.js` | **投影共享层** —— 工具与 UI 用同一份字段白名单 |
| `lib/node/**` | 副机侧：拨入、任务引擎、产物服务、exec/agent 双后端 |
| `lib/client.js` | 浏览器半边（Web 面板） |
| `lib/protocol.js` | 线协议（帧类型、错误码、`PROTOCOL_VERSION`） |
| `lib/setup.js` + `bin/dsh-remote-setup.js` | 小白向导（配置生成 / doctor 体检 / 连接错误人话翻译） |
| `lib/relay.js` + `bin/dsh-remote-relay.js` | 中继（NAT 场景的会合点） |
| `profiles/**` | 部署档案与配置片段 |
| `scripts/**` | 中继初始化（systemd / 计划任务）+ 质量检查脚本 |

---

## 开发

```bash
npm install     # 只为验证 lockfile；本包零外部运行时依赖
npm run check   # 打包自洽性 + 文档漂移 + 全部测试
```

**没有构建步骤。** `lib/**` 里的 `.js` 就是 DSH 实际加载的产物（纯 ESM，无转译）。

改代码前请读 **[CONTRIBUTING.md](CONTRIBUTING.md)** —— 那里记了几个
**会静默失败**的陷阱（工具返回值出边界、cordis 生命周期、`ctx.get()` 的必要性）。

> `node --test test/`（目录形式）在 Node 24 下会把目录当模块入口，必然失败。
> 用 `npm test`。Windows 的 PowerShell 不展开 glob，也别直接传 `test/*.test.js`。

### 质量防线

| 层 | 命令 | 内容 |
|---|---|---|
| 打包自洽 | `npm run check:packaging` | `files`/`exports`/`bin`/`dsh.bundle.patch` 指向的路径必须存在 |
| 文档漂移 | `npm run check:docs` | 50 条断言，锁住文档与代码的关键约定 |
| 行为测试 | `npm test` | 400 条 |

---

## 已知问题

见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** —— 记录了**刻意不做**的项、
**待补验**的项、以及排查方法论。要点：

- 副机 `agent` 后端不工作（`exec` 正常）—— 待定位
- Windows 8.3 短名绕过向量未验证
- POSIX 分支的平台实测覆盖不足（只跑过 CI）

---

## 更新日志

见 **[CHANGELOG.md](CHANGELOG.md)** —— 含每个修复的**根因分析**。
0.x 期间 `lib/**` 是加载产物，任何变更都可能是行为变更，升级前请读。

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。
