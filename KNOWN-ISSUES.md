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

## 2. ~~hub 层 `conn.socket.on('end')` 与冻结层修复重复~~ —— 已清理

**状态**：**已清理**（v0.1 加固轮）。此处保留记录，供后续维护者理解为什么那层兜底**不该再补回来**。

背景：冻结层 `lib/ws.js` 在 `WSConnection` 构造时即挂 `socket.on('end')`
→ `finish(1006)` + destroy，已统一处理对端硬断。hub 的 `attachDirect` 里曾另有一层
等价的 `socket.on('end')` 兜底（在冻结层修好之前是必需的补丁）。两者并存时行为正确，
唯一可见差别是**对端干净 FIN 时日志里 `node socket closed` 打两条**。

清理动作（已完成）：移除 `lib/hub/node-registry.js` 的 `attachDirect` 中
`conn.socket.on('end')` 那段及其注释，并在原处留下一条警告注释 ——
**不要**再补这层兜底，否则会重现双日志。

行为等价性已实测（三场景：硬断 destroy / 干净 FIN `end()` / 裸 socket FIN）：
`online` 翻转恰好 1 次、`rec.conn` 清空、底层 socket `destroyed=true`、
断连不清 tasks、同 nodeId 可重连、dispose 无残留、offline 延迟不变。
另补测「hello 之前就 FIN」的 pending 清理面：`pendingAfter=0`、`pendingDoneFlag=true`，
前后一致。唯一差异即上述双日志 → 单日志。

relay 侧未动：`lib/relay.js` 的 close 处理器有 `rec.conn === conn` 守卫，
属另一条路径（relay-e2e 不 import `NodeRegistry`）。

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

---

## 6. 测试方法论：三条踩过的坑（写给后续维护者）

加固轮把四个未测面（投影层 / 平台原语 / 中继凭证 / 副机配置与 provider）从零
覆盖到 174 条测试，过程中反复踩到同一类问题，记在这里避免重犯。

### 6.1 「测试通过」≠「与原实现等价」

一次意外：captain 的注入脚本还原逻辑有 bug，删掉了 `isDenied` 的三层防御
（注释保留、代码行没了），只能依据注释与报告手工重建。t3 作者逐字节复核后确认
重建与原实现 **IDENTICAL** —— 但这是**运气**：注释描述的是"为什么"，
不是"代码长什么样"。**等价性只能靠文本 diff 判定**，不能靠"测试全过"。

更极端的例子：同一函数里的 `if (nd === '') continue`（第三层防御）是**行为不可
观测的死代码** —— 穷举 928 组输入逐层移除证明，所有触发它的输入都已被第一层或
紧随的 `segs.length === 0` 拦下。**任何测试都无法证明它存在**。它被刻意保留
（纵深防御），但注释里如实标注了不可观测，不拿测试当它存在的证据。

### 6.2 断言恒真 = 假绿（比没测更危险）

`isDenied` 的 `raw.trim() === ''` 守卫曾抓不到：只删这一行，28 条测试全过。
根因是 `normalizePath` **不做 trim**，所以 `'   '` 是唯一只有该层能拦的形态，
而原断言用的路径不含纯空白段 → 结果恒为 `false`，断言恒真。

修法：让被测输入**真的踩到那一层**（`/work/   /x` vs `['   ']`），并加**正向
对照**（同一路径用 `['work']` 必须命中），证明那个 `false` 是"条目被忽略"
而非"路径没被检查"。

### 6.3 变异验证里，「还原」比「注入」更危险

注入失败会立刻报错；**还原不干净是静默的** —— 它可能删掉代码而留下注释，
让文件看起来正常。还原后**必须做字节级校验**（比对哈希或 `git show` 字节），
不能只靠"我写了还原代码"。

### 6.4 工具本身会污染观测（Windows 专项）

- **PowerShell 的 `Set-Content` 按系统 ANSI(GBK) 落盘**，会把 JS 里的 UTF-8
  中文全写坏（实测 184 个 U+FFFD → `SyntaxError`）。
- **`git show HEAD:file > file` 同样如此**：读回来 940 个 U+FFFD，差点误报
  "提交被写坏"，实际是 `>` 重定向的假象。
- 结论：**读写一律走 node 的字节 API**（`fs.readFileSync` /
  `fs.writeFileSync(p, s, 'utf8')` / `execFileSync('git', ['cat-file','blob',...])`）。
  用 PowerShell 管道时，你无法区分"文件真的坏了"和"我的管道坏了"。

- 不做离线消息缓冲（任务状态真身在副机，重连靠 `task/sync` 重建）
- 面板无独立鉴权：UI 路由自带同源围栏（跨站 403），但不做用户级授权
- 面板用 4 秒轮询而非推送（`slots` 不提供可见性回调）

