# 安全策略

这个插件**在两台机器之间建立执行通道** —— 主机可以在这台机器之外的电脑上
读写文件、执行命令。所以它的安全边界值得认真对待，而不是"装个插件而已"。

---

## 报告漏洞

**不要开公开 issue。** 请用 GitHub 的
[Private vulnerability reporting](https://github.com/zbzbhs/dsh-remote-agent/security/advisories/new)，
或发邮件到仓库 owner 的 GitHub 邮箱。

请附：

- 受影响的版本（`node_modules/dsh-remote-agent/package.json` 的 `version`）
- 角色与传输方式（`config.role` / `transportMode`）
- 复现步骤（**不要**附带真实凭证或他人数据）
- 你判断的影响范围

我会在 **7 天内**确认收到，并在修复发布后致谢（除非你要求匿名）。

---

## 威胁模型

### 部署形态

```
主机（hub）  ──ws──▶  副机（worker）
  派任务                 在 roots 内执行
  收 handoff
  按需 pull 成品
```

**relay 形态**（双方都在 NAT 后，见 [profiles/README.md](profiles/README.md) 的降级链）：
hub 与 node 都主动拨入中继，中继按 nodeId 双向转发。

**信任假设**：

| 假设 | 说明 |
|---|---|
| 主机是可信的 | 主机能派任意任务给副机。**不要把副机接到你不信任的主机。** |
| 副机是可信的 | 副机上报的 handoff 会进主机的模型上下文。**不要把主机接到你不信任的副机。** |
| 传输通道可能被窃听 | `direct` 模式的默认配置是**明文 ws://**。见下面「传输加密」。 |
| 中继机器是可信的（用 relay 时） | 协议**无端到端加密**（只有传输层 token）：中继看得到明文业务帧。选 VPS 提供商等同于把链路交给他 —— 这正是「公网中继必须套 TLS、来源限 IP」的原因。 |
| 副机能识别"它钉住的 hub" | P2-11 起：hub 有持久 ed25519 身份，副机首连自动钉住指纹（TOFU）或用 `pinnedHubFingerprint` 显式钉住，此后**假 hub / 假中继冒充会被当场拒绝**。边界：TOFU 防不了"首次连接就被截和"—— 指纹随配对码分发时依赖传递渠道可信（当面 / 加密聊天）。 |

**可用性边界**（不是安全边界）：中继挂了任务照跑 —— 副机本地持久执行，
重连后 `task/sync` 对账。链路断不影响已派任务的完成，只影响"此刻能否派新的"。

**本插件不做的事**（有意为之）：

- 不隔离副机的文件系统 —— 安全边界是 `roots` 配置，不是沙箱。
- 不限制副机能执行的命令 —— `mode: exec` 直接跑 shell。
- 不校验副机的身份（默认 `nodeToken` 为空）—— 见下面「认证」。

---

## 部署检查清单

### 1. 认证：**默认不校验，公网必须配**

`direct` 模式下，主机侧的 `nodeToken` 为空时**不校验任何凭证** ——
任何能连到 `hubUrl` 的人都能注册成节点并接收任务。

```yaml
# 主机
- id: remote-agent
  config:
    role: hub
    nodeToken: 'nt_<用 newNodeToken() 生成，或自选强随机>'   # ← 必配
```

```yaml
# 副机
- id: remote-agent
  config:
    role: worker
    token: 'nt_<与主机相同>'                                 # ← 必配
```

**什么时候可以留空**：只在**完全可信的私网**里（例如 Tailscale 虚拟内网、
或者本机自测）。**任何情况下都不该在公网留空。**

> `relay` 模式有独立的 enroll token 机制，但主机的 `nodeToken` 仍应配置 ——
> 中继只负责会合，不替代节点认证。

### 2. 传输加密

| 场景 | 建议 |
|---|---|
| Tailscale / WireGuard 虚拟内网 | 明文 `ws://` 可接受（隧道已加密）|
| 同机 / 完全可信 LAN | 明文 `ws://` 可接受 |
| **公网直连** | **必须**在前面放 TLS 反向代理（nginx/caddy），用 `wss://` |
| 公网中继 | 中继应部署在 TLS 之后，用 `wss://`。可直接抄的模板：[deploy/relay-vps/](deploy/relay-vps/)（Caddyfile / nginx.conf，中继只听回环、公网只暴露 443）|

**本插件不自带 TLS。** 它假设"要么网络层已加密，要么你在可信网络里"。

### 3. `roots` 是真正的安全边界

副机只允许任务在 `roots` 列出的目录内动作。**留空会退回保守默认**
（用户 home 下的工作目录），**不要依赖这个默认值** —— 显式写清。

```yaml
config:
  roots:
    - 'D:\work'          # ← 只给任务需要的目录
    - 'D:\scratch'
```

**不要**把整个盘（`D:\`）或用户 home 加进去。

### 4. `uiPullRoot` 控制面板的写盘范围

Web 面板的「拉取」按钮是**唯一**由浏览器触发的写盘动作。

- 未配置（默认 `''`）→ 面板拉取**禁用**（返回 `403 pull-disabled`）。
- 配置了 → 只允许写到该目录内。路径校验是双道：先字符串层 `isInside`
  （挡 `../` 与反斜杠），再 `realpath` 复查（挡符号链接与 8.3 短名）。

**注意**：`realpath` 必须在 `mkdir` 之后 —— 所以一个越界目录可能被**创建**
出来（空目录，不是数据泄漏）。这是已知取舍。

### 5. 副机的 `denyPaths`

在 `roots` 之内再排除敏感子目录（例如 `roots: ['D:\work']` 但
`denyPaths: ['D:\work\secrets']`）。相对与绝对形式都支持。

### 6. 配对码（`pair`）等同凭证，按凭证传阅

配对码 `dshra1://…` 内含 `nodeToken`。**它能注册一台新副机 —— 谁拿到它，
谁就能接入你的主机。**规矩：

- 只通过**当面或加密聊天**传给副机；**不要贴公开群、截图、工单、日志**。
- 轮换：副机遗失/外泄时，改主机 `nodeToken` + 逐台换码即可全部失效
  （旧码里的旧 token 直接认证失败）。
- 面板「副机接入」生成的配对码有披露边界：**含 token 的完整码只回本机
  回环请求**（`/api/remote-agent/ui/pair-info` 判定 `remoteAddress`）——
  面板可能被 `lanBind` 暴露到局域网，能打开面板 ≠ 该拿到主机凭证。
  非回环请求只会拿到**不含 token** 的码（仅够可信内网直连）+ 一条提示。
- `roots` **不在**配对码里：副机能操作哪些目录是副机自己的安全边界，
  永远由副机配置声明 —— 主机侧的任何串都决定不了它。

### 7. hub 身份认证：副机也会验主机（默认开启）

协议此前只有单向认证：副机拿 token 向 hub 证明自己，但 hub 从不向副机证明
"我就是那个 hub"—— 假 hub 回一帧 welcome 副机就上线（token 是副机交出去
的东西，假 hub 根本不验），假中继更可以直接冒充 hub 下发 `mode: exec`
（副机任意代码执行）任务。P2-11 起补上了反向认证：

- **hub 侧**：首次启动生成持久 ed25519 身份密钥对，落盘
  `<stateDir>/hub-identity.json`（默认 `~/.dsh-remote-agent/`，0600；可用
  hub 配置项 `stateDir` 改目录）。direct 模式的身份证明放在 `welcome` 帧；
  relay 模式 hub 在节点上线后**追发**一帧 `hub/identity`。
- **副机侧**：配置 `pinnedHubFingerprint`（`hubfp1-` 开头共 29 字符）显式
  钉住；未配置时**首连自动钉住（TOFU）**，指纹写进
  `<stateDir>/hub-pin.json`（0600）。配对码自带指纹（向导生成的码自动带上
  `hubFingerprint` 字段）—— 副机粘一个码即完成"连接配置 + 指纹钉住"，
  零终端。
- **验证链**：指纹自洽（`sha256(报上来的公钥)` 必须等于报上来的指纹）→
  匹配 pin → ed25519 验签 → nonce 回显（防重放旧 welcome）→ 时间戳
  ±5 分钟窗口。任何一环不过：拒绝上线、**停止重连**、日志大声报错。
  钉住的指纹不会自动清除 —— 确认是主动换 hub 后删 `hub-pin.json`（或更新
  `pinnedHubFingerprint`）再重启副机即可重新钉住。
- **relay 宽限窗口**：relay 模式的"在线"信号来自中继，hub 身份帧是追发的。
  副机上线后 15 秒内等它：验过 → 正常干活；有 pin 但一直不来 → 拒绝
  （身份帧可能被中间人剥掉）；无 pin 且不来 → 按旧版兼容模式继续（记
  warn）。宽限窗口内到达的任务一律回 `hub-identity-pending`，不会被拿去执行。
- **换拨入地址不算换 hub**：pin 文件记录了当时的 endpoint。你自己改了
  `hubUrl` / `relayUrl`（本地配置行为，远程攻击者改不了）→ 副机提示 re-pin
  并重新 TOFU，不会逼你手删文件。

**剩余边界**（如实说）：① 能改副机本地配置或删 `hub-pin.json` 的人不在
威胁模型内（本地攻击者 = 游戏结束，任何方案都一样）；② 中继仍可见明文
业务帧，hub 身份不提供端到端加密；③ hub 身份文件被替换（磁盘损坏重建 /
被人动手脚）时，副机侧表现为指纹不匹配的大声失败 —— 不会静默接受新身份，
但恢复需要人工干预。

---

## 本插件的安全设计

### 审计日志（提案 #19）

hub 在 `<stateDir>/audit.jsonl` 追加记录**派发 / 取消 / 拉取**三类事件
（谁在何时让 hub 在哪台机器上跑了什么、哪些成品过了河落在哪）。
字段过统一打码层：token/password/apiKey 类键值写 `***`，超长值 400 字符截断
——凭证与整段任务书**绝不整段落盘**。默认开启，体积 8MB × 3 份轮转封顶；
`config.audit: false` 显式关闭。写入失败只限频告警，**绝不影响任务链路**。

### 凭证不离开副机

协议里**不带模型 API key**。副机用自己的 DSH 配置与凭证 ——
主机只能派任务，拿不到副机的模型凭证。

### 仓库清单上报：只报结构，不报凭证（提案 #13）

副机接入后自动扫描 `roots` 下的 git 仓库并上报到 hub：每仓库只含
**名字、远端 url、本机路径** 三个字段。两条硬边界：

- **url 里的凭证在副机本地剥掉**：`.git/config` 常见
  `https://user:token@host/...` 的推送凭证，上报前统一打码
  （见 `lib/node/repos.js` 的 `sanitizeRepoUrl`）——hub 与面板永远拿不到。
- **扫描零子进程**：只 `readdir` + 读 `.git/config` 文本，不 spawn git，
  扫描行为完全可从源码审计。

不想暴露目录结构时 `config.reposIntervalMs: 0` 关掉上报（`repo:` 路由
随之不可用，其余功能不受影响）。注意：仓库路径本身也是主机目录结构的
一部分 —— 若 `roots` 给了整盘，这条披露与 roots 自身的披露同样成立。

### 响应体逐字段白名单，绝不 spread

`lib/hub/views.js` 是工具与 UI 共用的投影层，**逐字段构造**。
反例是 `{...registry.list()[i]}` —— 那会让将来新增的内部字段
（`conn`、`hello` 全量、`pendingPulls`…）自动泄漏到浏览器。

`handoffView` 尤其重要：handoff 由**副机上报**，字段集不受主机控制。
它刻意**不含** `workspace`（绝对路径会回显主机目录结构）、`logs`
（可能带环境变量）、`sessionId`（副机内部标识）。

### UI 路由自带围栏

DSH 的 `/api` 鉴权围栏是 `kind: 'prefix'`，而本插件的路由是 `kind: 'exact'`。
`@deepseek-ai/dsh-host-webserver` 的 `match()` **exact 表优先** ——
所以本插件的路由**不在** DSH 的 token/cookie 围栏内。

因此 `lib/hub/ui-routes.js` **自带 guard**，且**失败关闭**：

- 带 `Origin` 且与 `Host` 不一致 → 403
- `sec-fetch-site: cross-site` → 403
- `ctx.connection.requestRejection` 抛错 → **仍拒绝**（不是放行）

`check-doc-drift.mjs` 有断言锁住"失败关闭"这条语义。

### 只有 `role:final` 过河

任务结束只回 `manifest` + `handoff`；`intermediate`（日志、缓存、
中间构建文件）只在副机留存，仅上报元数据。这限制了"主机意外拉走一堆
不该传的东西"的风险面。

### 中继的 token 处理

- **一次性 token 不落盘**：由中继管理接口（`POST /api/relay/token`）铸造，
  只存在中继进程内存里，用过（consumed）或过期（默认 15 分钟）即消失。
  重放会 403 —— 适合"发一台机器出去"的场景。
- **长期凭证在中继机器上**：`/etc/dsh-remote-relay/env`（0600，root:root）与
  `<data-dir>/tokens.json`（0600）。**都不要提交进版本库。**部署模板见
  [deploy/relay-vps/](deploy/relay-vps/)。
- 副机的 `token` 也可以留空，让它读 `<stateDir>/token` 文件 ——
  便于不把凭证写进 YAML。

---

## 已知的未验证项

见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md) 的 §7.1。要点：

- **Windows 8.3 短名绕过向量未验证**：`uiPullRoot` 的路径校验先做字符串层
  再 `realpath`。8.3 短名（如 `PROGRA~1`）能否绕过字符串层、以及 `realpath`
  是否总能解析它，**没有实测**。已加防御（双道校验），但缺对抗性验证。
- **POSIX 分支的平台实测覆盖不足**：Windows 全量验证，Linux/macOS 只跑过 CI。
- **P2-11 hub 身份链路的对抗性验证不足**：验签 / 钉住 / 重放 / 超窗有单元
  与变异负向测试，真实双进程 e2e 走通了完整身份链路；但"真中继剥帧 /
  真 MITM"场景没有实机红蓝对抗实测，relay 宽限窗口的超时分支只在测试
  时钟下验证过。

如果你做了这两项的对抗性测试，欢迎按上面的方式报告结果。

---

## 不在范围内

以下**不算**本插件的漏洞（属于部署配置问题）：

- 主机 `nodeToken` 留空且暴露在公网 → 设计如此，见检查清单第 1 条
- `roots` 配得太宽（例如整个盘）→ 配置问题
- 明文 `ws://` 走公网 → 见检查清单第 2 条
- 副机执行了主机派来的破坏性命令 → 这是功能，不是漏洞
  （主副机互信是前提）
- 能改副机本地配置（删 `hub-pin.json`、改 `pinnedHubFingerprint`）的人
  → 本地攻击者不在威胁模型内，见检查清单第 7 条的剩余边界

**但如果**你能证明：绕过 `roots` / `denyPaths` / `uiPullRoot` 的边界、
未授权注册成节点、或从响应体里取到未白名单的字段 —— **那是真漏洞，请报告。**
