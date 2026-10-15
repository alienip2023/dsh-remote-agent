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

---

## 本插件的安全设计

### 凭证不离开副机

协议里**不带模型 API key**。副机用自己的 DSH 配置与凭证 ——
主机只能派任务，拿不到副机的模型凭证。

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

如果你做了这两项的对抗性测试，欢迎按上面的方式报告结果。

---

## 不在范围内

以下**不算**本插件的漏洞（属于部署配置问题）：

- 主机 `nodeToken` 留空且暴露在公网 → 设计如此，见检查清单第 1 条
- `roots` 配得太宽（例如整个盘）→ 配置问题
- 明文 `ws://` 走公网 → 见检查清单第 2 条
- 副机执行了主机派来的破坏性命令 → 这是功能，不是漏洞
  （主副机互信是前提）

**但如果**你能证明：绕过 `roots` / `denyPaths` / `uiPullRoot` 的边界、
未授权注册成节点、或从响应体里取到未白名单的字段 —— **那是真漏洞，请报告。**
