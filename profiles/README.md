# dsh-remote-agent 部署路径（profiles）

本目录是**部署档案**：主电脑（hub）与副电脑（worker）各自装什么、config 怎么填、怎么验证连通。
三种路径按「谁有公网」划分，选一条走通即可，不要混着来。
主电脑还有一个**浏览器面板**（可视化界面），配置见第 4 节。

> 约定
> - 主电脑 = 你正在用的这台（跑 DSH + hub 插件），下称 **hub**。
> - 副电脑 = 被当成远程同事的那台（跑 DSH + worker 插件），下称 **node**。
> - 中继 = 只做寻址与转发的管子（`bin/dsh-remote-relay.js`），不存任务、不碰产物字节。
> - 三条路径里 **worker 侧只改 `transportMode` 与地址/token**；hub 侧只在「用不用中继」上不同。
> - 任何路径都**不要让模型凭证离开副机**：协议里不带 key，产物默认只回 manifest。
>
> ⚠ **配置行的 id 必须是 `remote-agent`**（与包内 `cordis.patch.yml` 插入的那一行同 id）。
> loader 按 id 覆盖：同 id 是"改这一行的 config"，不同 id 会变成**两行** → 插件被挂载两次
> → 路由/工具重复注册 → 启动失败（double-mount）。
> `profiles/hub.cordis.yml` 与 `profiles/worker.cordis.yml` 都是**覆盖片段**（顶层 `- id:` 项），
> 不是 `- insert:` 新插入项。

---

## 怎么选路径：降级链

三条路径不是平行三选一，是一条**条件式降级链**：能直连就不额外养服务，
直连不通再往下走。判断该不该降级的依据是**可观测现象**，不是猜。

```
两端能直连吗？（同 LAN / 一方有公网可映射 / 已有 Tailscale、WireGuard 虚拟内网）
├─ 能 ──────────────► 路径二 direct（零额外组件）
└─ 不能 ────────────► 愿意养一台公网 VPS 吗？
                      ├─ 愿意 ──► 路径一 中继 VPS（流量不过第三方；
                      │           部署模板 deploy/relay-vps/）
                      └─ 不愿意，但可信 Cloudflare ──► 路径三 cloudflared
                         （零维护，流量过第三方边缘）

任何链路都断了怎么办？── 最深的降级：任务不中断
副机本地持久跑完，hub 恢复后 remote_nodes 重新出现，task/sync 自动补齐
（这是设计使然，不是 bug；中继挂了也同理）
```

**该降级了的判据**（按代价从低到高排查）：

| 现象 | 含义 | 动作 |
|---|---|---|
| 副机日志反复 `reconnecting`，`curl` 地址不通 | 直连被 NAT / 防火墙挡 | 降级到中继或隧道 |
| 换手机热点仍不通 | 不是局域网的错，是入站被阻断 | 同上 |
| `hubs:0` / `nodes:0` | 有一端根本没拨进来 | 查该端 url/token，**降级解决不了** |
| 中继 `healthz` 打不开 | 中继自己挂了 | 任务不受影响；修中继，或临时切 direct/隧道 |

**切换成本**（所以敢降级）：副机侧只改三个字段 —— `transportMode`、地址
（`hubUrl` / `relayUrl`）、`token`；`roots` / `stateDir` / 已落盘的任务记录
**都不用动**。hub 侧只差一个 `relay:` 段的去留。

---

## 0. 共同前提（三条路径都要做）

### 主电脑（hub）装什么

```bash
# 1. Node.js >= 22（22.19+ 或 24+）
node --version

# 2. 把 dsh-remote-agent 装进当前 profile（bundle 形态）
#    在 DSH 里执行：
#    plugin_manager action=install_bundle target="<绝对路径>/dsh-remote-agent"
#    或手工把 dsh-remote-agent/profiles/hub.cordis.yml 的 insert 段并入 profile patch 层

# 3. 确认 7 个工具已注册（remote_nodes / remote_task / remote_status /
#    remote_handoff / remote_manifest / remote_pull / remote_cancel）
#    用 cordis_inspect_query platform=host provider=Tool method=listTools 核对
```

主电脑需要：`profiles/hub.cordis.yml`、一个产物落地目录（`remote_pull` 的 `dest` 指向它）。

### 副电脑（node）装什么

```bash
node --version              # 同样 >= 22
# 同一份 dsh-remote-agent 目录（可用 rsync / 压缩包 / 私有 registry 分发）
# 在副机 profile patch 层并入 dsh-remote-agent/profiles/worker.cordis.yml 的 insert 段
```

副电脑需要：`profiles/worker.cordis.yml`、`roots` 里声明的工作区目录（**必须真实存在**）、
以及一个 `token`（入网凭证）。

### 验证连通的最小三步

```bash
# ① 服务端活着
#    中继（relay）：http://<中继地址>:8890/healthz
#    hub 直连（direct）：http://<hub地址>:8890/api/remote-agent/healthz
curl -fsS http://127.0.0.1:8890/healthz

# ② 副机侧：进程起来了、在重试连接（副机 dsh 不会因为连不上而崩）
#    worker 日志里应出现 online / reconnecting 事件

# ③ 主电脑侧：在 DSH 里问
#    remote_nodes  →  列表里出现副机 nodeId，online=true
#    remote_task {node:"<nodeId>", goal:"echo hello", mode:"exec"}
#    remote_status {taskId:"..."}  → status=completed
```

`nodes:1`（中继 healthz）或 hub healthz 里 `online:1`，且 `remote_nodes` 里 `online:true` = 链路通。
任何一个不满足，先看第 6 节的排障表。

---

## 1. 路径一：双方都无公网 → 中继 VPS（v0.1 默认，MVP 验证路径）

**适用**：家里/公司两台机器都在 NAT 后面，谁也连不上谁。一台有公网 IP 的小 VPS 当管子。

```
  ┌────────────┐        ┌──────────────┐        ┌────────────┐
  │ 主电脑 hub  │ ─────► │  中继 VPS     │ ◄───── │ 副电脑 node │
  │ (NAT 内)   │  ws    │ :8890/relay  │  ws    │ (NAT 内)   │
  └────────────┘        └──────────────┘        └────────────┘
        两端都主动往外连，中继只按 nodeId 转发
```

### 中继 VPS 上装什么

```bash
# 1. 把仓库拷到 VPS，进包根
# 2. 一条命令初始化（幂等；systemd 可用就装 unit，否则打印 nohup 命令）
sudo ./scripts/relay-init.sh                       # 默认 8890 / 0.0.0.0
#    换端口：  sudo RELAY_PORT=9000 ./scripts/relay-init.sh
#    只看动作：DRY_RUN=1 ./scripts/relay-init.sh
#    轮换凭证：sudo FORCE_ROTATE=1 ./scripts/relay-init.sh

# 3. 拿明文 token（只打一次，别重定向进文件）
node bin/dsh-remote-relay.js --print-tokens --data-dir /var/lib/dsh-remote-relay
#    → RELAY_TOKENS hub=rt_... enroll=en_... source=file

# 4. 验证
curl -fsS http://127.0.0.1:8890/healthz
journalctl -u dsh-remote-relay -f      # 看 RELAY_READY 与事件 JSON 行
```

`relay-init.sh` 幂等：重复跑不会轮换 token，也不会覆盖已有的 `/etc/dsh-remote-relay/env`。
凭证同时落在 `/etc/dsh-remote-relay/env`（0600）与 `<data-dir>/tokens.json`（0600）。

**云厂商安全组 / 防火墙**：放行 `tcp/8890`。若只给这两台机器用，把来源限到它们的出口 IP，
别对 `0.0.0.0/0` 开。

### 主电脑（hub）config 怎么填

```yaml
# dsh-remote-agent/profiles/hub.cordis.yml（节选）
# 覆盖片段：id 与包内 patch 插入行同 id，用于改那一行的 config
- id: remote-agent
  name: dsh-remote-agent
  config:
    role: hub
    nodePath: /api/remote-agent/node   # direct 用；relay 模式下也注册，无害
    nodeToken: ''                      # relay 模式由中继鉴权，这里留空
    systemPrompt: true
    relay:                             # ← 路径一的关键：启用中继链路
      url: ws://RELAY_VPS_IP:8890/relay
      token: rt_xxx                    # ← --print-tokens 的 hub 那一半
    limits:
      heartbeatMs: 15000
      ackTimeoutMs: 60000
      pullTimeoutMs: 1800000
    defaults:
      timeoutMs: 3600000
```

### 副电脑（node）config 怎么填

```yaml
# dsh-remote-agent/profiles/worker.cordis.yml（节选）
# 覆盖片段：id 与包内 patch 插入行同 id
- id: remote-agent
  name: dsh-remote-agent
  config:
    role: worker
    nodeId: slave-pc                       # 唯一；^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
    transportMode: relay
    relayUrl: ws://RELAY_VPS_IP:8890/relay # ← 和中继一致
    token: en_xxx                          # ← --print-tokens 的 enroll 那一半
    stateDir: ~/.dsh-remote-agent          # 任务状态真身在这台机器
    roots: ['D:\work']                     # 白名单工作区，必须真实存在
```

> 想「发一台机器出去」而不想让它长期持有同一个凭证：用中继的管理接口铸一次性 token
> （`POST /api/relay/token?token=<hub token>`，默认 15 分钟有效），把那个 `en_...` 给副机。
> 用完即焚，重放会 403。

### 怎么验证连通

```bash
# VPS 上
curl -fsS http://127.0.0.1:8890/healthz
# → {"ok":true,"protocol":1,"nodes":0,"hubs":0,"stats":{...}}

# 副机起来后（VPS 上再看一次）
curl -fsS "http://127.0.0.1:8890/api/relay/nodes?token=rt_xxx"
# → {"nodes":[{"nodeId":"slave-pc","os":"windows","since":...,"lastSeen":...}]}

# 主电脑 DSH 里
remote_nodes                      # online:true
remote_task {node:"slave-pc", goal:"写个 hello.txt 到工作区", mode:"agent"}
remote_status {taskId:"<上面的 taskId>"}
remote_handoff {taskId:"..."}     # 拿卡片
remote_pull  {taskId:"...", paths:["hello.txt"], dest:"D:\\pulled"}
```

**典型失败信号**：中继 `healthz` 里 `nodes:0` 但副机说 online → 两端 token 不是同一套
（拿 `RELAY_READY` 里的 `hub=` / `enroll=` 指纹对一下，别对明文）；`hubs:0` → hub 侧
`relay.url` 写错或 `relay.token` 不对。

---

## 2. 路径二：一方有公网 → direct 直连

**适用**：主电脑有公网 IP / 端口映射（或副机有，方向反过来）。不装中继，hub 自己就是服务器。

```
  ┌──────────────┐  ws://hub-public:8890/api/remote-agent/node
  │ 主电脑 hub    │ ◄──────────────────────────── 副电脑 node
  │ 0.0.0.0:8890 │        （node 主动拨入，hub 不主动连）
  └──────────────┘
```

### 主电脑（hub）装什么

只装 hub 插件（同第 0 节），**不用装中继**。要点：

- hub 用 DSH 自带的 webServer 监听端口，把这个端口映射到公网（路由器端口转发 / 云安全组）。
- 公网暴露时**必须**设 `nodeToken`，否则任何知道地址的人都能拨进来。
- 健康检查是 `/api/remote-agent/healthz`，不是 `/healthz`。

```yaml
# dsh-remote-agent/profiles/hub.cordis.yml（节选）
config:
  role: hub
  nodePath: /api/remote-agent/node      # 副机拨入的 upgrade 路径
  nodeToken: CHANGE_ME_STRONG           # ← direct 模式必填；副机的 token 必须一致
  systemPrompt: true
  # 不用中继：整段 relay 注释掉/删掉
  # relay:
  #   url: ws://127.0.0.1:8890/relay
  #   token: ''
```

### 副电脑（node）config 怎么填

```yaml
# dsh-remote-agent/profiles/worker.cordis.yml（节选）
config:
  role: worker
  nodeId: slave-pc
  transportMode: direct
  hubUrl: ws://HUB_PUBLIC_HOST:8890/api/remote-agent/node   # ← 路径带 /api/remote-agent/node
  token: CHANGE_ME_STRONG                                   # ← 与 hub 的 nodeToken 一致
  roots: ['D:\work']
  stateDir: ~/.dsh-remote-agent
```

### 怎么验证连通

```bash
# 主电脑本机
curl -fsS http://127.0.0.1:8890/api/remote-agent/healthz
# → {"ok":true,"plugin":"dsh-remote-agent","role":"hub","protocol":1,"nodes":0,"online":0,...}

# 从外网（用手机热点试最准）
curl -fsS http://HUB_PUBLIC_HOST:8890/api/remote-agent/healthz

# 副机
# 启动 dsh，日志里应出现 welcome（带 protocol/nodeId），不是 unauthorized
```

**典型失败信号**：副机日志 `unauthorized` → `token` 与 `nodeToken` 不一致；
连接超时 → 端口没映射出去 / 运营商封了入站 / Windows 防火墙没放行；
`protocol-mismatch` → 两端包版本不同，升级到同一份。

> 安全提醒：direct 模式是把控制面直接开到公网。**至少**要做到
> ① `nodeToken` 用强随机（`node bin/dsh-remote-relay.js --print-tokens` 生成的那串就够）
> ② 端口只对副机出口 IP 开放（云安全组 / 防火墙白名单）
> ③ 定期轮换 token

---

## 3. 路径三：cloudflared 隧道 → direct 模式把 hub 的本地端口暴露出去

**适用**：主电脑无公网、也不想维护 VPS，但允许用 Cloudflare 免费隧道。
**本质仍是 direct 模式** —— 只是把「hub 的本地端口」通过 cloudflared 变成公网可达的域名。

```
  ┌────────────────┐   wss://relay.example.com  ┌─────────────┐   http://127.0.0.1:8890
  │ 副电脑 node     │ ─────────────────────────► │ cloudflared │ ────────────────► 主电脑 hub
  │ (任意网络)      │   Cloudflare 边缘           │  隧道       │   （本机回环）
  └────────────────┘                             └─────────────┘
```

### 主电脑（hub）装什么

1. hub 插件（同第 0 节），**不配 `relay` 段**（走 direct 分支），`nodeToken` 必须设。
2. `cloudflared`（Cloudflare 官方单文件二进制，零 npm 依赖）：

```bash
# 安装（选一种）
#   Windows: winget install --id Cloudflare.cloudflared
#   macOS:   brew install cloudflared
#   Linux:   下 .deb 或官方二进制放进 PATH

# 快速试（随机临时域名，重启即换，只适合冒烟）
cloudflared tunnel --url http://127.0.0.1:8890
#   输出里会有 https://random-words.trycloudflare.com —— 把主机名记下来

# 长期用（固定域名，需要自己的域名托管在 Cloudflare）
cloudflared tunnel login
cloudflared tunnel create dsh-hub
cloudflared tunnel route dns dsh-hub relay.example.com
cloudflared tunnel run --url http://127.0.0.1:8890 dsh-hub
```

### 主电脑 config 怎么填

```yaml
# dsh-remote-agent/profiles/hub.cordis.yml（节选）
config:
  role: hub
  nodePath: /api/remote-agent/node
  nodeToken: CHANGE_ME_STRONG     # ← 公网可达，必须校验
  systemPrompt: true
  # 不配 relay 段：入口交给 cloudflared，hub 只监听本机（DSH webServer 默认）
```

### 副电脑（node）config 怎么填

```yaml
# dsh-remote-agent/profiles/worker.cordis.yml（节选）
config:
  role: worker
  nodeId: slave-pc
  transportMode: direct
  hubUrl: wss://relay.example.com/api/remote-agent/node   # ← 注意是 wss://，不是 ws://
  token: CHANGE_ME_STRONG
  roots: ['D:\work']
  stateDir: ~/.dsh-remote-agent
```

### 怎么验证连通

```bash
# 1) 隧道本身通不通（在任意一台机器上）
curl -fsS https://relay.example.com/api/remote-agent/healthz
# → {"ok":true,...}   （cloudflared 把 HTTPS 转成对 127.0.0.1:8890 的 HTTP）

# 2) WebSocket 升级通不通（关键：隧道必须允许 Upgrade）
node -e "const ws=new WebSocket('wss://relay.example.com/api/remote-agent/node');ws.onopen=()=>{console.log('upgrade-ok');process.exit(0)};ws.onerror=e=>{console.log('upgrade-fail',e.message||'');process.exit(1)};setTimeout(()=>{console.log('upgrade-timeout');process.exit(2)},8000)"
#    期望 upgrade-ok（403 也算通：说明请求到达了 hub，只是 token 校验没过）

# 3) 主电脑 DSH 里 remote_nodes 出现副机，online:true
```

**典型失败信号**：
- `curl /api/remote-agent/healthz` 通但 WebSocket 连不上 → 隧道没透传 Upgrade 头，升级 cloudflared；
  用 named tunnel 时确认 `originRequest` 配置没有误伤。
- 副机日志 `unauthorized` → `nodeToken` 不一致。
- 用 `trycloudflare.com` 临时域名时每次重启都变，副机 `hubUrl` 要跟着改；
  **正式用请上 named tunnel + 自己的域名**。

---

## 4. 可视化界面（Web 面板）

hub 插件自带一个浏览器面板，不用敲工具名就能看节点、派任务、看结果、拉成品。
**只有主电脑（hub）侧有面板**；副机（worker）不需要任何 UI 配置。

### 面板在哪

主电脑 DSH 的**侧栏图标**里会多一个「远程同事」（两个屏幕 + 一条连线）的图标。
点它 → 在**主面板**区域打开面板。

实现上是标准的两插槽配对（`lib/client.js`）：

- `sidebar.panellist` 注册图标，id = `dsh-remote-agent`
- `main` 注册面板，**key 必须等于同一个 id** —— 两边对不上就是"点了图标没反应"

### 能做什么

| 区域 | 内容 |
|---|---|
| 顶部计数卡 | 在线节点 / 进行中 / 任务总数，右侧「刷新」 |
| 节点列表 | 每个节点的 nodeId、os、是否 agent 模式、任务数、最后活跃时间；行首圆点指示在线状态（在线为绿点，离线为中性灰点，随主题取色） |
| 派发任务 | 任务目标、选节点、模式（agent / exec）、工作区、期望产出 glob → 「派发」 |
| 任务列表 | 按最近活动排序，带状态徽标（running / queued / completed / failed…） |
| 任务详情 | 点开某条任务后展开：结果摘要、错误、工作区变更、成品清单（role:final）、日志尾部 |
| 操作 | 「拉取全部成品」（见下方安全边界）、「取消任务」 |

数据走 hub 注册的 `/api/remote-agent/ui/*` 路由（overview / nodes / tasks / task / dispatch /
cancel / pull），面板挂载后每 4 秒自动刷新一次。这些路由**自带同源/鉴权围栏**：跨站请求
（`sec-fetch-site: cross-site`，或 `Origin` 与 `Host` 不一致）一律 403；无 `Origin` 的本机
调用（如 `curl`）放行。

> 面板的具体排版与按钮文案可能随版本微调，**以实际界面为准**；上面列的是当前实现的能力集合。

### 需要什么配置

两个字段，都在 hub 侧（`lib/hub/index.js` 的 `normalizeConfig`）：

| 字段 | 默认值 | 作用 |
|---|---|---|
| `uiEnabled` | `true` | 控制整组 UI 路由是否注册。设 `false` = 面板取不到数据（图标仍在，但面板报读取失败） |
| `uiPullRoot` | `''`（空） | **面板唯一允许写盘的目标根目录**。留空 = 面板的拉取按钮**禁用** |

> 两个"空值"别混淆：**配置里的默认是空串 `''`**（`normalizeConfig` 归一的结果）；
> 而 `/overview` 的 `capabilities.pullRoot` 在未配置时回 **`null`**（让面板能区分
> "没配"和"配了个空值"，避免渲染出残缺文案）。两者指的是同一件事。

### ⚠ `uiPullRoot` 是安全边界，不是可选项

这是整份文档里最需要记住的一条：

- **不配置 `uiPullRoot`，面板的「拉取全部成品」按钮就是灰的**（`disabled`），
  鼠标悬停提示「未配置 uiPullRoot，拉取已禁用」。后端的 `pull` 动作也会直接返回
  `403 pull-disabled`，不写任何字节。
- 配置之后，**产物只能落到这个目录内**。面板不接受绝对路径：它只让你传一个相对子目录，
  hub 侧先做字符串层校验（挡 `../`），再做 `realpath` 归一后复查（挡符号链接），
  两道都通过才落盘。越界返回 `403 dest-outside-pull-root`。
- 所以：**面板对 hub 本机磁盘是只读的，`pull` 是唯一的写盘入口**（派任务 / 取消任务虽然也是
  POST，但只是向副机发帧，不落盘）。想彻底禁止 Web 写盘就别配 `uiPullRoot`
  （或者干脆 `uiEnabled: false` 关掉整组路由）；要放开就明确指定一个你愿意被写的目录。
- 命令行的 `remote_pull` 工具**不受 `uiPullRoot` 限制**（它有自己的 `dest` 参数），
  这条约束只针对浏览器面板。

### 可直接复制的 config 片段

主电脑 profile 的 patch 层（`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`）：

```yaml
# id 必须是 remote-agent（与包内 cordis.patch.yml 同 id），否则会 double-mount
- id: remote-agent
  name: dsh-remote-agent
  config:
    role: hub
    # ── 可视化界面 ──────────────────────────────────────────
    uiEnabled: true                     # 默认就是 true；设 false 可关掉整组面板路由
    uiPullRoot: 'D:\remote-artifacts'   # ← 面板唯一允许写盘的目录（必须是绝对路径）
```

只想看不想让它写盘（**默认就是这个状态**，也是 v0.1 的推荐起步方式）：

```yaml
- id: remote-agent
  name: dsh-remote-agent
  config:
    role: hub
    uiEnabled: true
    # uiPullRoot 刻意不配（profiles/hub.cordis.yml 里默认就是注释掉的）：
    # 面板可看节点/任务/结果卡，但拉取按钮禁用、后端返回 403 pull-disabled
```

> `profiles/hub.cordis.yml` 里的 `uiPullRoot` **默认是注释状态** —— 写盘必须由你
> 显式指定一个愿意被写的目录，不给"忘了改就默认能写"的机会。

### 怎么验证面板可用

```bash
# ① UI 路由活着（主电脑本机）
curl -fsS http://127.0.0.1:8890/api/remote-agent/ui/overview
# 配了 uiPullRoot：
# → {"ok":true,"nodes":[...],"counts":{...},"capabilities":{"pull":true,"pullRoot":"D:\\remote-artifacts","dispatch":true}}
# 没配 uiPullRoot（默认）：
# → {"ok":true,...,"capabilities":{"pull":false,"pullRoot":null,"dispatch":true}}
#   注意 capabilities.pull 就是面板拉取按钮的开关：false = 按钮禁用；此时 pullRoot 回 null

# ② 没配 uiPullRoot 时，pull 应被拒
curl -sS -X POST http://127.0.0.1:8890/api/remote-agent/ui/pull \
  -H 'content-type: application/json' -d '{"taskId":"x","paths":["a.txt"]}'
# → 403 {"error":"pull-disabled","message":"未配置 uiPullRoot，UI 拉取已禁用"}

# ③ 浏览器里：侧栏出现「远程同事」图标，点开能看到节点与任务列表
```

面板读不到数据时，先看 `overview` 路由是否 404（`uiEnabled: false` 或插件没加载），
再看 `capabilities.pull` 是否符合预期。

---

## 5. 三条路径对照

| | 路径一：中继 VPS | 路径二：direct 直连 | 路径三：cloudflared |
|---|---|---|---|
| 需要公网 IP | 中继 VPS 需要 | 其中一端需要 | 不需要 |
| 额外组件 | `dsh-remote-relay` | 无 | `cloudflared` |
| hub config | `relay: {url, token}` | `nodeToken`（不配 relay） | `nodeToken`（不配 relay） |
| node config | `transportMode: relay` + `relayUrl` + `token(enroll)` | `transportMode: direct` + `hubUrl` + `token` | 同 direct，`hubUrl` 用 `wss://` |
| 健康检查 | `/healthz` | `/api/remote-agent/healthz` | `/api/remote-agent/healthz` |
| 凭证位置 | 中继机器（`/etc/dsh-remote-relay/env`） | hub 机器 | hub 机器 |
| 最适合 | 两台都在 NAT 后，v0.1 MVP 验证 | 有自己的服务器/公网 | 无公网但能用 Cloudflare |
| 主要风险 | VPS 被扫端口 | 控制面直接暴露公网 | 依赖第三方隧道 |

**v0.1 建议**：先用路径一跑通 MVP（最少变量、可复现），再按需要切路径二或三。
切换时只改 `transportMode` 与地址/token 三项，副机 `roots`/`stateDir` 不用动。

---

## 6. 排障速查

| 现象 | 先看哪里 |
|---|---|
| healthz 打不开 | 服务没起 / 端口写错 / 防火墙；`journalctl -u dsh-remote-relay` 或 `Get-Content relay.log` |
| 中继 healthz 里 `nodes:0` | 副机没起 / 副机 token 不对 / 副机 `relayUrl` 写错 |
| 中继 healthz 里 `hubs:0` | hub 侧 `relay.url` / `relay.token` 不对，或 hub 插件没加载 |
| 副机日志反复 `reconnecting` | 网络不可达（先 `curl` 中继/hub 地址）；副机**不会**因此崩，任务照常本地跑 |
| `remote_nodes` 里 `online:false` | 曾经连上过又断了；看中继日志的 `node offline` 与副机日志 |
| `duplicate-node` | 同一个 `nodeId` 起了两个实例；停掉一个或改 `nodeId` |
| `protocol-mismatch` | 两端 `dsh-remote-agent` 版本不一致，升级到同一份 |
| pull 报 `artifact-denied` | 目标文件是 `intermediate`（日志/临时/中间产物），只回元数据，不传输字节 |
| 面板拉取按钮是灰的 | 没配 `uiPullRoot`（这是设计如此，不是 bug）；见第 4 节 |
| 面板「读取失败」 | `uiEnabled: false`、插件没加载、或 `/api/remote-agent/ui/overview` 返回非 200 |
| 侧栏图标点了没反应 | `sidebar.panellist` 的 id 与 `main` 的 key 不一致（须同为 `dsh-remote-agent`） |
| 副机 dsh 启动卡住 | 不应该发生：worker 侧不得有顶层网络 await。若出现请当 bug 报（记录日志与复现步骤） |

**日志里只看指纹**：`RELAY_READY url=ws://... hub=<12位指纹> enroll=<12位指纹>`。
要核对两端 token 是不是同一套，**比指纹**，不要把明文贴进任何工单或聊天记录。
`relay-init.sh` / `relay-init.ps1` 的结尾汇总也只打指纹；明文只有 `--print-tokens` 才输出。
