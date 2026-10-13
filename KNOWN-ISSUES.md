# dsh-remote-agent 已知事项（v0.1）

记录已确认但**刻意不修**的项，附证据与理由。避免后续维护者重复调查。

---

## 1. `source.kind: 'plugin'` 不在框架 `MessageSourceMap` 类型里

**状态**：运行时可用，代码不改。

**背景**：`lib/node/runner.js` 投递任务书时显式传
`source: { kind: 'plugin', plugin: 'dsh-remote-agent' }`。
DSH 的 `MessageSourceMap`（`app.asar` 内 agent-loop 的 .d.ts）是**封闭接口**，
列出的键有 `user` / `model` / `tool` / `system-prompt` / `model-selection` /
`user-approval` / `ptc-mode` / `tool-registry` / `user-rpc` / `agent-message` /
`subagent-settled` / `skill-invocation` / `cordis-host-runner` / `goal` /
`schedule` / `compact-checkpoint` / `session-reference` / `user-question-reply`
—— **没有 `plugin` 键**。

**为什么仍然用它**：
1. **DSH 官方文档自己就这么写。** `app.asar` 内 agent-loop 的 API 文档给出：
   ```text
   handle.agent.followup({
     content: [{ type: 'text', text: 'Summarize this workspace.' }],
     source: { kind: 'user' },
   })
   handle.agent.steer({
     content: [{ type: 'text', text: 'Focus on the tests.' }],
     source: { kind: 'plugin', plugin: 'my-plugin' },
   })
   ```
   即"非人类生产者必须传自己的 source，不能继承人类权限"这条规则的官方示例，
   用的正是 `kind: 'plugin'`。
2. **运行时不做取值校验。** 全量检索 `app.asar`，`invalid source` 的 9 处命中
   全部与 `command/done` 的 `sourceEventSeq` 有关，与消息 source 无关；
   不存在 `normalizeSource` / `parseSource` / `isMessageSource` 之类的校验函数。
3. **省略 source 更危险。** `Agent.followup()` 在调用方省略 source 时**分配
   `{ kind: 'user' }`** —— 即把插件投递的任务书伪装成人类输入，继承人类权限。
   这是框架文档明确警告要避免的。

**残余风险**：若未来框架对 source 加运行时白名单校验，这里的投递会被拒。
届时改法：把 `PLUGIN_SOURCE` 换成白名单内的 `{ kind: 'skill-invocation', ... }`
或 `{ kind: 'cordis-host-runner' }`。已集中定义在 `runner.js` 顶部的
`PLUGIN_SOURCE` 常量，改一处即可。

**证据来源**：`D:\DeepSeek Harness\resources\app.asar`（框架本体）。

---

## 2. hub 层 `conn.socket.on('end')` 与冻结层修复重复

**状态**：已知冗余，推迟到 v0.1 之后清理。

冻结层 `lib/ws.js` 已在 `WSConnection` 内统一处理对端硬断（`socket.on('end')`
→ `finish(1006)` + destroy）。hub 的 `attachDirect` 里还留着一层等价的
`socket.on('end')` 兜底。实测两者并存**行为完全正确**（`node offline` 触发 1 次、
`socket closed` 触发 2 次、registry 最终状态正确），唯一可见差别是日志多打一条。

**清理动作**：移除 `lib/hub/node-registry.js` 的 `attachDirect` 中
`conn.socket.on('end')` 那一段及其注释，交由冻结层统一处理。

---

## 3. B2 的 Windows 8.3 短名向量未验证

本卷 `NtfsDisable8dot3NameCreation` 已开启，`dir /x` 输出 0 行含 `~`，
**无法构造真实短名**。代码层推理是 `exec.js` 的 `realpathSync` 会展开成长名，
但这条**不作为通过依据**。

**补验方法**：在一台启用 8.3 的卷上，用 `fsutil 8dot3name set 0` 打开，
对工作区建短名后重跑 `resolveWorkspace` 的越界用例。

---

## 4. 可视化界面（Web 面板）：已在本机验证可用

**状态**：正常，无需改动。此条记录一个**曾被误判为缺陷**的现象，避免后续维护者重复调查。

面板的浏览器半边（`lib/client.js`）依赖 `dsh.client` 声明投递，**已在 DSH 44.0.0 验证可用**。

### 投递方式：combo 路由（`rev` 必需）

框架把客户端资源分组为 **combo 路由键**，形如：

```text
plugins/??dsh-remote-agent/client.js&rev=<内容哈希>
```

- 该 URL 由框架写入**首页 HTML 的 manifest**，浏览器据此惰性加载 ——
  **不要手工构造或硬编码 `rev`**（它是 `client.js` 内容的哈希，改文件即变）。
- 框架文档原文（`app.asar` 内）：*"It groups resources into combo route keys
  (`/plugins/??...&rev=...`), with one bootstrap combo for the modules row and one or
  more application combos for the other rows"*。

### ⚠ 直接访问 `/plugins/dsh-remote-agent/client.js` 会 404 —— 这是正常的

不是投递失败，是 **URL 形式不对**：

| URL | 结果 |
|---|---|
| `plugins/??dsh-remote-agent/client.js&rev=<hash>` | **200**，内容含 `sidebar.panellist` |
| `/plugins/dsh-remote-agent/client.js` | 404（猜的格式） |
| `plugins/??dsh-remote-agent/client.js`（缺 `rev`） | 404 |

**踩坑记录**：v0.1 收尾时曾把这条 404 当成「client bundle 投递失败」的 blocker 上报，
并据此一度计划把面板标为不可用。实际是**用猜的 URL 测出来的假象** —— 正确格式是
combo 形式、`rev` 必需，且 URL 由首页 manifest 提供，不应手工拼。

### 依赖条件

- 需要 Web 载体（`package.json` 的 `dsh.client.platform: 'web'`）；
  **纯 headless profile 不加载浏览器半边**（这是设计如此，不是缺陷）。
- 面板的数据源是 Host 半边的 `/api/remote-agent/ui/*` 路由（见 `profiles/README.md` 第 4 节）。

---

## 5. v0.1 已知取舍（非缺陷）

- `spawnTerminal` 仅基础 PTY（远程前台进程组查询/信号未实现）
- execution world 不接 dsh 沙箱围栏（依赖远端账号自身权限）
- 产物只 pull `role:final`；`whitelist` / `underSize` / `all` 策略留待后续
- 不做离线消息缓冲（任务状态真身在副机，重连靠 `task/sync` 重建）
- 面板无独立鉴权：UI 路由自带同源围栏（跨站 403），但不做用户级授权
- 面板用 4 秒轮询而非推送（`slots` 不提供可见性回调）

