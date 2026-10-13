# dsh-remote-agent

把另一台电脑变成你 DSH 的**远程 Agent 同事**。

副机拥有自己的 DSH 与独立 Agent 循环，任务在它本地持久运行；主电脑只拿到 **handoff 结果卡**与**产物清单**，成品要显式拉取才过河。

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
│  │  /work/**  中间产物留在这里              │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## 核心不变式

| 不变式 | 含义 |
|---|---|
| **凭证不离开副机** | 协议里不带模型 key；副机用自己的模型配置 |
| **断连不终止任务** | 任务在副机本地持久运行，中继挂了也跑完，重连后状态自动对账 |
| **清单先于字节** | 任务结束只回 manifest + handoff；成品要 `remote_pull` 才传输 |
| **只有 `role:final` 过河** | 日志/缓存/中间构建文件只在副机留存，仅上报元数据 |

## 快速开始

三种接入路径（双方都在 NAT 后 / 一方有公网 / cloudflared 隧道）见
**[profiles/README.md](profiles/README.md)** —— 那里有每条路径的配置片段与验证命令。

最小闭环：

```bash
# 主电脑：装本包（或把 profiles/hub.cordis.yml 并入 profile patch 层）
# 副电脑：装同一份包，config.role 设为 worker，填 roots 与 token
# 然后主电脑里问一句「有哪些远程节点」，agent 会调 remote_nodes
```

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

另有一个 Web 面板（侧栏「远程同事」→ 主面板），可视化地看节点、派任务、看结果卡、拉成品。

## 结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口（角色分发器：`role: hub` / `worker` / `both`） |
| `lib/hub/**` | 主机侧：节点注册表、7 个工具、subagent provider、UI 路由 |
| `lib/node/**` | 副机侧：拨入、任务引擎、产物服务、exec/agent 双后端 |
| `lib/client.js` | 浏览器半边（Web 面板） |
| `lib/relay.js` + `bin/dsh-remote-relay.js` | 中继（NAT 场景的会合点） |
| `profiles/**` | 部署档案与配置片段 |
| `scripts/**` | 中继初始化（systemd / 计划任务） |

零外部 npm 依赖 —— 只用 `node:` 内置模块。

## 测试

```bash
npm test          # = node --test test/*.test.js
```

注意：`node --test test/`（目录形式）在 Node 24 下会把目录当模块入口，必然失败。用上面这条。

## 已知事项

见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** —— 记录了刻意不修/待补验的项及理由（含 Windows 8.3 短名向量未验证、hub 层一处已知冗余）。

## 许可

MIT
