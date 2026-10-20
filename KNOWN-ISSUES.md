# dsh-remote-agent 已知事项（v0.1）

记录已确认但**刻意不修**的项，附证据与理由。避免后续维护者重复调查。

---

## 1. `source.kind: 'plugin'` 不在框架 `MessageSourceMap` 类型里

**状态**：**已修（2026-10-15）** —— `PLUGIN_SOURCE` 改为白名单内的
`{ kind: 'cordis-host-runner' }`（见 commit 20919b5）。本节保留完整记录：
它当时预言的残余风险（"框架加白名单校验后投递会被拒"）随后真的发生了
—— 这正是 agent 模式"约 20ms 假完成、零输出、零报错"的第一个根因。
改动前后的推理过程有保留价值，故不删。

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

## 3. B2 的 Windows 8.3 短名向量：模拟回归已落地，真实卷复核仍缺

**2026-10-15 更新**：短名向量的代码路径已有**确定性模拟回归**锁定
（`test/exec.test.js`「8.3 短名形态（模拟启用 8.3 的卷）与 target 同归
realpath 口径」，变异负向控制验证过：把 roots 的 realpath 去掉后该测试与
junction 测试一同变红）。覆盖四个断言：roots 短名 × workspace 长名（GH
runner TEMP 假红的确切形态）、镜像方向、短名展开到根外必须拒绝、返回值
必须是长名形态。

仍缺的只有**真实短名**：本机 C: / D: 两个卷均**不生成** 8.3 短名
（实测构造 `DOT3PR~1` 后 `statSync` 得 ENOENT），且 `fsutil 8dot3name query`
与 `fsutil file setShortName` 均需管理员权限（拒绝访问）——开发机上无法构造。
真实短名与 junction 走同一条 `fs.realpathSync.native` 展开路径，模拟回归
已覆盖该路径的全部比对逻辑；真实卷复核降级为**低风险残留**。

**补验方法**（有管理员权限时）：`fsutil 8dot3name set 0` 打开生成 → 对
工作区建短名 → 重跑 `resolveWorkspace` 的越界用例与上述测试的 ①②③④。

---

## 4. 可视化界面（Web 面板）：已在本机验证可用

**状态**：正常，无需改动。此条记录一个**曾被误判为缺陷**的现象，避免后续维护者重复调查。

面板的浏览器半边（`lib/client.js`）依赖 `dsh.client` 声明投递，**已在 DSH 0.2.0-rc.2 验证可用**。

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

### 6.3b 变异脚本被 kill 时，还原步骤会**一并被跳过**（比 6.3 更硬的一层）

6.3 说的是"还原逻辑写错了"；实际发生过的是更糟的一种 —— **还原根本没执行到**。

真实事故（2026-10-13）：captain 在做「独立验证 t1 的变异测试声明」时，脚本结构是

```js
for (const m of mutations) {
  fs.writeFileSync(FILE, mutated)   // 注入
  runTest()                          // 跑测试（可能很慢）
  fs.writeFileSync(FILE, original)   // 还原
}
```

其中一处注入删掉了 `RelayLink.start()` 里的 `this.stopped = false`，而那轮
`runTest()` 因套件挂住而超时，captain 把进程 kill 掉 —— **`writeFileSync(original)`
这一行从此没有机会执行**。注入形态被永久留在工作区。

后果不是"测试结果不准"，而是**整个仓库被改坏**：`connectOnce()` 首行
`if (this.stopped) return` 恒真 → hub 永不连上中继 → `relay-link.test.js` 19/29
失败、`hub-worker-e2e` 由 8/8 退化为超时、`ui-routes` 由 21/21 退化为 1 例失败。
更糟的是：captain 随后**拿这个被自己改坏的状态去质疑 t1 的交付物**。

**结构性防御（二选一，不要靠纪律）**：

1. 把「注入 → 跑 → 还原」放进 `try/finally` —— 能挡住异常，**挡不住 SIGKILL**；
2. **只对副本操作，永不改工作区文件**：先复制到沙箱目录（`mkdtempSync`），
   注入只作用于副本。**从机制上消除这个风险类别。**

实践推荐第 2 种（relay-link-tester 在重做版里用的就是它）。若确有必须改工作区
的场景，加一道显式闸门，例如：

```js
if (!process.env.ALLOW_MUTATE_WORKTREE) throw new Error('拒绝直接改工作区；请对副本操作')
```

**一句话**：6.3 是"怎么验证得对"，6.3b 是"验证工具本身不能损坏被测物" —— 后者
优先级更高，因为前者的失败只是结论错，后者的失败会污染整个仓库。

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

---

## 7. 加固轮审计结论（剩余盲区，按优先级）

审计覆盖六个面。**结论：无 BLOCKER**；以下是如实记录的边界，供后续决策。

### 7.1 真机未覆盖的分支（t2 实测复核版）

> **本节已由 t2 逐条实测复核。** 三条原始表述中，第三条**结论错误**（relay 断连
> 实际已覆盖），第一、二条**范围描述不准**（把"真机未验"与"逻辑未验"混为一谈）。
> 下方为修正版，保留必要的谨慎。复核环境：Windows 11 26100、Node v24.18.0、
> PS 5.1.26100.9444、本机无 pwsh 7。原始命令与输出见任务 t2 的输出。

- **`resolvePowerShell()` 的前两条分支：选择逻辑已用真实解析路径验，真机仍未验。**

  本机事实（实测）：`resolveOnPath('pwsh.exe')` 与 `resolveOnPath('pwsh')`
  **均为空串**；`DSH_REMOTE_PWSH` **未设置**
  （`Object.hasOwn(process.env, …) === false`）；只有 PS 5.1.26100.9444；
  最终解析到 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
  —— 走的是第三条回退分支。

  本次补验的**不只是**"假 PATH 单元测试"：在临时目录里造出**真 PE 文件**的
  `pwsh.exe`（复制 PS 5.1 二进制后改名，`size = 495616`），
  经真实 `resolvePowerShell()` 路径实测六个分支：

  | 场景 | 期望 | 实测结果 |
  |---|---|---|
  | 常见安装位置存在 + PATH 上也有 pwsh | 取安装位置 | ✔ 取 `<PF>\PowerShell\7\pwsh.exe` |
  | 无安装位置；**同一目录内**同时有 `pwsh.exe` 与 `powershell.exe` | 取 pwsh 而非 5.1 | ✔ 取 `<PATH>\pwsh.exe`（`resolveOnPath` 对两者各自命中，最终选中 pwsh） |
  | 仅 `%LOCALAPPDATA%\Microsoft\WindowsApps` 绝对位置 | 取该位置 | ✔ 命中 |
  | PATH 上 pwsh 为 0 字节 + 其后有真 pwsh | 跳过 0 字节 | ✔ 跳过，回退到真候选 |
  | `DSH_REMOTE_PWSH` 显式指定（含首尾空白） | 原样采用 | ✔ 采用，`fromEnv: true` |
  | 六处全部缺失 | 字面量兜底 | ✔ 返回 `'powershell.exe'` |

  并经 `buildSpawn` 走完整 spawn 链路（`-NoProfile -NonInteractive
  -ExecutionPolicy Bypass -File <tmp>/run.ps1`），**两条 pwsh 分支各跑 5 次**：
  脚本真的执行、stdout 有输出、`exit 7` 如实传递为 `status === 7`
  —— 安装位置分支与 PATH 分支**均 5/5 一致**。

  ⚠ 复现这套探针时的一个坑：**不要伪造 `SystemRoot`**。把 `SystemRoot` 指向一个
  不存在的临时目录（`exec.test.js` 的 `isolateResolution` 就是这么做的，因为它
  只断言解析结果、不真的 spawn），解析仍然正确，但 spawn 出来会返回
  `4294901760`（`0xFFFF0000`）且 stdout/stderr 全空 —— 看起来像"退出码传递坏了"，
  实际是 PowerShell 自己起不来。这是**夹具假象，不是产品缺陷**：实测同一夹具下
  只把 `SystemRoot` 换回真实的 `C:\Windows`，立刻恢复 `status === 7` +
  `stdout === 'ok-marker'`。本次探针因此**刻意保留真实 `SystemRoot`**，
  只隔离 `ProgramFiles` / `ProgramFiles(x86)` / `LOCALAPPDATA` / `PATH`。

  **仍未验的部分**：真实 pwsh 7 二进制在真实安装路径下的行为 ——
  `-File` + BOM 的编码路径、`$PSHOME`、profile 加载、与 PS 5.1 的 `$LASTEXITCODE`
  语义差异。本机没有 pwsh 7，这部分无法在本环境验。补验步骤见本节末
  「补验方法 B」。

  **顺带查出一条未覆盖边界（非缺陷，但值得知道）**：`resolveOnPath()` 有
  「Windows 上 0 字节候选视为不存在」的守卫，但 `resolvePowerShell()` 的
  **绝对安装位置分支只有 `fs.existsSync()`，没有这道守卫**。实测：把 0 字节
  `pwsh.exe` 放在 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` 这个绝对位置 →
  `resolvePowerShell()` 采用它，`describePowerShell()` 报 `exists: true` /
  `family: 'pwsh-7'`，而 spawn 该路径抛 `EFTYPE`（errno -4028）—— 正是
  `lib/node/exec.js` 注释里说要消灭的那类「解析出来但用不了」。

  **但本机碰不到这个坑，且 `exec.js` 注释里的实测依据与本机行为不符**：
  本机 `%LOCALAPPDATA%\Microsoft\WindowsApps` 下 **23 个 App Execution Alias
  全部 `existsSync() === false`** —— `lstatSync` 可读（size 41–173）、
  `statSync` 抛 `EACCES`；PowerShell `Test-Path` 为 True、`Get-Item` 显示
  `Length=0, Attributes=Archive, ReparsePoint`；`fsutil reparsepoint query`
  确认 tag `0x8000001b`。即「别名 0 字节 → `existsSync` 返回 true → spawn
  `EFTYPE`」这条链在本机**第一环就不成立**（`existsSync` 是 false，
  该别名根本不会被选中）。符合注释描述的是 0 字节**普通文件**（非重解析点）：
  实测 `existsSync === true` + `size === 0` + spawn `EFTYPE`。
  结论：0 字节守卫对「普通 0 字节文件」有效且必要；对「真实别名」本机是靠
  `existsSync` 为 false 自然跳过 —— **两条路径不同，注释把两者合并叙述了**。
  换机器或换 Windows 版本（别名行为可能不同）时，绝对分支缺守卫这点仍会暴露。

- **POSIX/Linux 的 chmod 分支未实测（这一条原表述基本准确，但有两处要改准）。**

  实测确认 skip 的**确切条件与跳过内容**：条件为
  `process.platform === 'win32'`，位于用例
  「`restrictPermissions：posix 语义下目标模式真的生效`」开头，跳过的正是两条
  断言 —— `fs.statSync(file).mode & 0o777 === 0o600`（文件）与
  `fs.statSync(dir).mode & 0o777 === 0o700`（目录）。本机实测
  `fs.chmodSync(f, 0o600)` 不抛、读回 `mode & 0o777` 恒为 `0o666`
  （Windows 只映射只读位），故该断言在 Windows 上必然失败，**skip 是正确的**
  （`relay-config.test.js` 本机 36 例：35 pass / 1 skip / 0 fail）。

  **改准之一：`restrictPermissions` 的 Linux 行为不止是代码推理。** 本次用真实
  调用序列做了平台无关部分的可观测验证（对 `fs.chmodSync` 打桩记录
  `(target, mode)`）：
  - 创建路径：`chmod(dir, 0700)` → `chmod(tmp, 0600)` → `chmod(tokens.json, 0600)`
  - 读取路径：**只** `chmod(tokens.json, 0600)`，**不碰目录**
  - `chmodSync` 抛 `EPERM` 被 `catch` 吞掉，函数正常返回（不抛）

  实现用 `fs.chmodSync`（同步、**显式 mode**），因此**不受 umask 影响**。
  umask 只影响两处**创建时**的默认权限 —— `writeFileSync(tmp, …,
  { mode: 0o600 })` 与 `mkdirSync(dir, { recursive: true })` —— 而这两处随后
  都被显式 `chmodSync` 覆盖，所以最终权限与 umask 无关。
  真正未验的只剩最后一步：「POSIX 内核真的把 mode 落成了 0600/0700」
  （需要 Linux 文件系统，Windows 无 chmod 语义）。补验步骤见「补验方法 A」。

  **改准之二：那条目录断言的归因错了。** 用例里 `dir` 来自 `tmpdir(t)`
  （`fs.mkdtempSync`），而调用的是 `restrictPermissions(file)` —— **只传了文件**。
  所以 `dir` 为 0700 是 **`mkdtemp` 的默认模式**带来的，**不是**
  `restrictPermissions` 的目录分支。`restrictPermissions(dir, { isDir: true })`
  的 0700 分支另有用例覆盖（「任何平台都不抛，且对目标调用 chmod 0600 /
  目录 0700」，断言传参 `0o700`，该用例在 Windows 上也真跑）。
  这条断言在 Linux 上会通过，但它通过的原因与 `restrictPermissions` 无关 ——
  在 Linux 上补验时不要把它当成目录分支已验的证据。

- **hub 侧 `RelayLink` 的状态机没有测试（原表述「relay 模式的断连未复现」结论错误）。**

  实测复核：`relay-e2e.test.js` **确实覆盖了 relay 侧的断连**（24 例全绿），
  断连相关 4 条 ——「node 断开后 hub 收到 `node/offline`，注册表释放该节点」、
  「node 硬断（不发 close 帧）也清理」、「hub 断开不影响 node 与其余 hub」、
  「`kickNode` 主动断开节点」。且 `hub-worker-e2e.test.js` 走 **relay 模式** +
  真 `applyHub`（`NodeRegistry`）+ 真 `applyWorker`（**在干净 `HEAD` 树上**
  8 例全绿），含「副机掉线后 hub 只翻 online，任务投影保留」—— 即
  **`NodeRegistry` 走 relay 的路径已被端到端覆盖**。原表述里「`relay-e2e` 不
  import `NodeRegistry`」是事实，但由它推不出「relay 断连未覆盖」：覆盖来自
  `hub-worker-e2e` 与 `relay-e2e` 两条**不同**的路径，前者恰好就是
  `NodeRegistry` 那条。

  **真实缺口更窄**：是 **`RelayLink` 这个类本身** —— hub 作为中继客户端的那半边
  状态机：`start()` 幂等、`connectOnce()` 并发闸门、重连指数退避 + 抖动 + 60s
  封顶、`attempt` 成功后归零、`stop()` 幂等且不再重连、`requestNodeList()`
  对齐节点目录、`describe()` 不泄 token。

  说准确一点：`RelayLink` **不是零执行** —— `hub-worker-e2e` 的 7 条 relay 模式
  用例经 `applyHub` 真的实例化了它、调了 `start()`、连上了中继，所以「连上 →
  收帧 → 按 `from`/`to` 路由」这条 happy path 是被端到端跑过的。
  缺的是**状态机的分支与边界**：重连退避、`attempt` 归零、`start()`/`stop()`
  幂等、并发重入、`stop()` 后不再重连、节点目录对齐在重连时的行为。
  这些分支在 7 条端到端用例里都走不到（它们全程保持连接不抖）。

  **该缺口现已由 t1 关闭**：`test/relay-link.test.js`（29 例）覆盖上述全部分支，
  实测 **29/29 通过**；`hub-worker-e2e` 8/8、`relay-e2e` 24/24、`ui-routes` 21/21
  同时全绿。t1 在此过程中测出并修掉两个真缺陷：`start()` 不幂等 +
  `connectOnce()` 无重入闸门导致的**孤儿连接泄漏**，以及**陈旧连接的 `close`
  会清掉当前连接**（把「已连上的新连接」伪造成「掉线」）。

  ⚠ **一条过程记录（方法论，值得留下）**：t1 交付后，中途出现过一版
  **阻断级回归** —— `start()` 里的 `this.stopped = false` 被删掉（而同文件
  155–167 行的注释恰好在强调这一行**必须**存在），于是 `connectOnce()` 首行的
  `if (this.stopped) return` 恒真、**hub 永不连上中继**。

  **归因（已核实，勿再误传）**：这一行是 **captain** 在做「独立验证 t1 的变异
  测试声明」时删掉的，**不是 t1 的交付缺陷**。captain 的注入脚本设计为
  「注入 → 跑测试 → 还原」，但该次运行超时被 kill，`fs.writeFileSync(FILE,
  original)` 的还原语句没执行到 —— 于是注入形态被永久留在工作区。captain 随后
  又基于这个被自己改坏的状态去质疑 t1，是双重错误。

  t2 在做本节复核时独立抓到了这个中间态并给出证据链：
  - 最小复现：`start()` 后 `stopped` 仍为 `true`、1.5s 后 `ready === false`、
    `relay.hubs.size === 0`；
  - 套件层：`relay-link.test.js` 当时 **19/29 失败**，其中
    「`start 后连上中继`」直接报 `AssertionError: start 后 stopped=false
    true !== false`（**测试断言与实现互相矛盾**，排除环境因素）；
    `hub-worker-e2e` 由 8/8 退化为超时失败，`ui-routes` 由 21/21 退化为 1 例失败；
  - 归因：用「干净 `HEAD` 树 + 只换入这一个文件」钉死到该文件，
    干净树上这两个套件分别 8/8、21/21 全绿。
  captain 补回该行后全部恢复绿：`relay-link.test.js` **29/29、4.2 秒自然退出**，
  全量 **381 tests / 380 pass / 0 fail / 1 skip**（提交 `5c672e5`）。

  **留下的教训**（三条，都是这一件事暴露的）：
  1. **变异验证里「还原」比「注入」更危险** —— 注入失败会立刻报错，**还原不
     干净是静默的**。还原后必须做字节级校验（哈希 + 长度），不能只靠"我写了
     还原代码"。（同 §6.3）
  2. **注释写了「必须这样做」不等于代码真的做了** —— 这类矛盾只有真跑一遍才
     暴露。而反过来也成立：**不能因为注释在，就假设代码对**。
  3. **怀疑别人的交付物前，先确认自己的验证工具没改坏被测对象** —— captain
     在这件事上连错两次（先删了代码、再拿坏状态去质疑）。这也是 §6.4
     「工具本身会污染观测」的实例：验证者必须先自证其工具无副作用。

  **另：原表述引用的「加固轮的断连验证（4 场景 38 项断言）」在本仓库中没有
  可核实的对应物** —— 没有提交过的探针脚本，`git log` 里也没有。
  这类不可复现的数字不应作为论据写入文档。断连覆盖应引用可执行的用例名
  （上列 4 条 + `hub-worker-e2e` 那条）。

#### 补验方法 A：Linux 中继 VPS 部署后执行

> ⚠ **别用 `mktemp -d` 验目录权限**：`mkdtemp(3)` 本身就按 **0700** 创建目录
> （man-pages: *"The directory is then created with permissions 0700"*），
> 于是 `stat` 出来的 700 是 `mktemp` 给的，**不是** `restrictPermissions` 给的 ——
> 断言会假绿。要验目录分支，必须先把目录 chmod 成别的值（下面第 3、4 步用 `0755`），
> 或直接验"读取路径**不**碰目录"这个可区分的行为（第 6 步）。

```bash
cd /path/to/dsh-remote-agent

# 1) 那条 skip 现在必须真的执行并通过（不再是 "﹣"，而是 "✔"）
node --test --test-name-pattern='posix 语义下目标模式真的生效' test/relay-config.test.js

# 2) 手工复现文件断言（不依赖测试框架）
D=$(mktemp -d)
node --input-type=module -e '
import fs from "node:fs"
import { restrictPermissions } from "./lib/relay-config.js"
const f = process.argv[1] + "/cred.txt"
fs.writeFileSync(f, "secret", { mode: 0o644 })
console.log("before     :", (fs.statSync(f).mode & 0o777).toString(8))
restrictPermissions(f)
console.log("file after :", (fs.statSync(f).mode & 0o777).toString(8), "(期望 600)")
' "$D"

# 3) 目录分支：先把目录改成 0755，再调 restrictPermissions(dir,{isDir:true})
D1=$(mktemp -d); chmod 0755 "$D1"
node --input-type=module -e '
import fs from "node:fs"
import { restrictPermissions } from "./lib/relay-config.js"
const d = process.argv[1]
console.log("before:", (fs.statSync(d).mode & 0o777).toString(8), "(期望 755)")
restrictPermissions(d, { isDir: true })
console.log("after :", (fs.statSync(d).mode & 0o777).toString(8), "(期望 700)")
' "$D1"

# 4) 走真实 CLI：目录**故意先建成 0755**，才能证明是代码收窄的而非 mktemp 的
D2=$(mktemp -d); chmod 0755 "$D2"
node bin/dsh-remote-relay.js --port 0 --host 127.0.0.1 --data-dir "$D2" &
sleep 2; stat -c '%a %n' "$D2" "$D2/tokens.json"; kill %1
# 期望：700 <dir>（被代码收窄）/ 600 <dir>/tokens.json

# 5) 反证 umask 无关：umask 077 下重跑第 4 步，权限必须仍是 700 / 600
(umask 077
 D3=$(mktemp -d); chmod 0755 "$D3"
 node bin/dsh-remote-relay.js --port 0 --host 127.0.0.1 --data-dir "$D3" &
 sleep 2; stat -c '%a %n' "$D3" "$D3/tokens.json"; kill %1)

# 6) 可区分行为：读取路径**不**重收目录权限（t2 在 Windows 侧实测到的行为）
#    目录已是 0755 且 tokens.json 已存在 → 二次启动只收文件、不碰目录
D4=$(mktemp -d); chmod 0755 "$D4"
node bin/dsh-remote-relay.js --port 0 --data-dir "$D4" & sleep 2; kill %1   # 首次：建目录为 0700
chmod 0755 "$D4"                                                            # 人为放宽
node bin/dsh-remote-relay.js --port 0 --data-dir "$D4" & sleep 2; kill %1   # 二次：读已有凭证
stat -c '%a %n' "$D4"   # 期望仍是 755 —— 证明读取路径不调 restrictPermissions(dir)

# 7) EPERM 面：把 tokens.json 放到只读挂载/只读目录上，确认进程不因此崩
#    （实现把 chmodSync 包在 try/catch 里，预期：正常启动，仅权限未收窄）
```

#### 补验方法 B：在装有 pwsh 7 的 Windows 副机上执行

```powershell
cd <repo>
# 0) 基线：PATH 上是否有 pwsh、解析结果与 family
node --input-type=module -e "import('./lib/node/exec.js').then(m => console.log(JSON.stringify({ onPath: m.resolveOnPath('pwsh.exe'), resolved: m.resolvePowerShell(), desc: m.describePowerShell() }, null, 2)))"

# 1) 确认 pwsh 7 真版本
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'

# 2) 走真实 exec 链路：-File + BOM 的中文编码 + 退出码传递
node --input-type=module -e "
import { buildSpawn, PLATFORM } from './lib/node/exec.js'
import { spawnSync } from 'node:child_process'
const sp = buildSpawn(\"Write-Output '中文-ok'; exit 7\", { platform: PLATFORM.WINDOWS })
const r = spawnSync(sp.file, sp.args, { encoding: 'utf8', windowsHide: true })
console.log(JSON.stringify({ file: sp.file, status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() }, null, 2))
sp.cleanup()
"
# 期望：file 指向 pwsh.exe、status === 7、stdout 恰为 '中文-ok'（无 U+FFFD、无乱码）

# 3) PATH-only 分支：把安装目录临时移出 PATH 候选，只留 PATH 上的 pwsh（scoop/winget 链接）
#    期望：resolved 变成 PATH 上那个 pwsh.exe，第 2 步仍跑通

# 4) DSH_REMOTE_PWSH 覆盖面
$env:DSH_REMOTE_PWSH = 'C:\Program Files\PowerShell\7\pwsh.exe'
#    期望：describePowerShell().fromEnv === true，resolved 与之逐字相同

# 5) 反向对照：指向不存在的路径，确认报错清晰而非被静默换掉
$env:DSH_REMOTE_PWSH = 'C:\nope\pwsh.exe'
#    期望：fromEnv=true、exists=false，exec 任务以明确的 ENOENT 失败

# 6) 顺带验 7.1 第一条查出的边界：把 0 字节 pwsh.exe 放进绝对安装位置
#    期望（当前实现）：resolved 采用它、describe 报 exists=true / family=pwsh-7，
#    但 spawn 抛 EFTYPE —— 若已加守卫，则应继续向下回退
```

### 7.2 设计取舍（非缺陷，但要知道代价）

> 7.2 的**取舍判断**经 t2 复核仍成立；但其中两处**引用数字/论据**与仓库实况
> 不符，已在条目内就地标注。

- **`RELAY_QUEUE_BUDGET = 16 MiB` 的超限策略是「直接断连」**（`lib/relay.js`）。
  代价：一个正在传大产物的节点可能被整条断开，而不是被限流。取值依据是
  「远超正常控制帧、又小于大产物分块总缓冲」，但没有压测支撑。若实际出现
  「大产物传输频繁触发断连」，应改成暂停读取而非断连。
- **`authorizePull` 的跨路径空间判定是保守方向**：deny 指向另一棵树但基名巧合
  相同时会**误拒**（用户看到明确的 `artifact-denied`）。这是刻意取舍 ——
  宁可多拒一个合法产物，也不漏放一个被禁文件。
- **`node-registry.js` 1226 行**：连接层 + 注册表 + `RelayLink` + 心跳 + 等待器
  在一个文件里。属可维护性关注，非正确性风险（等待器的定时器清理经 t5 验证：
  4 场景断连后 `pending/nodes/tasks` 全 0 残留）。
  （行数已复核：`HEAD` 版 `1226`（按 `readFileSync(...).split('\n').length` 计）；
  t1 加上 `RelayLink` 护栏注释与并发闸门后工作区为 `1275`。原数字**正确**，无需改。
  注意别用 PowerShell `Get-Content` / `Measure-Object -Line` 数行 —— 本机对同一文件
  分别报 1198 / 1137，与 node 的字节级计数差 76–88 行，不可信。）

  **但同一句里的「t5 验证」论据不可复现**：`test/` 下**没有任何**对
  `pending.size` / `tasks.size` 的残留断言（全仓 grep 无命中），`git log` 里也没有
  那次探针脚本。`resilience.test.js` 文件头虽标注「t5（D7 relay 超时 / E3-1）」，
  但该文件只断言 `online` 翻转与 `timer` 清理，**不含**「4 场景断连后
  `pending/nodes/tasks` 全 0 残留」这一条。它与 7.1 第三条引用的「4 场景 38 项断言」
  同源，属同一批不可核实的数字。结论方向应无问题（`dispose()` 确实做
  `pending.clear()` / `tasks.clear()` / `nodes.clear()`；`HEAD` 版该函数在
  `node-registry.js:1178` 起，工作区版在 `1228` 起），
  但引用时请改用可执行的用例名或补一条真实断言。

  **【2026-10-16 更新】上条可维护性关注已解决（P1-4 拆分）**：`RelayLink` →
  `lib/hub/relay-link.js`，日志器/小工具 → `lib/hub/hub-util.js`，帧摄入
  （handleFrameFor/applySync 等）→ `lib/hub/registry-ingest.js`，接入/握手/hub
  身份 → `lib/hub/registry-handshake.js`。`node-registry.js` 只剩核心注册表
  （任务视图/下发/心跳/生命周期），约 640 行；拆分为纯代码搬移，对外形状
  （`import { NodeRegistry } from './node-registry.js'`）不变。上文的行数数字
  保留为**拆分前的历史记录**，不再反映现状。

### 7.3 一条审计过程中的自我纠正（方法论）

审计时我先用关键词计数扫 `ws.test.js`，得出「分片/ping-pong/掩码/超长帧**均未覆盖**」
的结论 —— **完全错误**。实际 `ws.test.js` 覆盖得很充分：分片（continuation）重组、
异常分片序列、interleaved-fragments、ping/pong 双向、掩码各长度档位、超长控制帧
被拒、二进制帧上限更宽，全都有用例。

根因是关键词正则与用例命名用词不一致（代码/用例写「分片」「掩码」，我的正则匹配
英文术语）。**这印证了第 6 节的教训：静态统计会误导，要读实际内容。**



## 8. 真实运行时验证（2026-10-15，打正在运行的 DSH 桌面版）

**为什么有这一节**：README 状态行长期挂着「agent 后端两个根因已修、待实机
端到端确认」。此前所有 e2e 都是**进程内**装配（真协议真传输，但同一个 node
进程），没有碰过真实 DSH 运行时。本节记录第一次真机验证的结论与边界。

### 已验证（自动，可重复）

用 `scripts/e2e-live-check.mjs` 把 worker 跑在**独立 OS 进程**里，拨入
**正在运行的 DSH 桌面版 hub**（本机实测，DSH 0.2.0-rc.2）：

1. **真实 upgrade 握手 + 协议 hello + registry 注册**：worker 拨入即
   `online`（空 token 的 hub 按"仅限可信内网"语义放行 —— 与文档一致）。
2. **registry 上下线实时性**：worker 在线时 `healthz` 报 `online:2`，
   进程退出后数秒内回落到 `online:1` —— 真实 webServer 路由下的
   在线状态检测是活的。
   （0.9.3 起计数只回给带正确 `x-dsh-token` 的请求；匿名只回 `{ ok: true }`，
   见 CHANGELOG 0.9.3 的 L4 条。）
3. **UI 围栏确认（安全结论，非缺陷）**：hub 的 webserver 除 `/healthz`
   外**整台 401**（`/`、`/index.html`、`/ui/config`、`/ui/overview` 全中）
   —— 没有桌面会话的请求一律被 `requestRejection` 拦掉。这意味着：
   - UI 路由不裸奔，设计如此、行为正确；
   - 但**自动化脚本无法代替桌面会话派发任务** —— 发布自检因此设计成
     「挂载 + 人肉派发 + 自动监视」（见下）。
     该边界的去留已评估并记录在 [docs/dispatch-automation-eval.md](docs/dispatch-automation-eval.md)：
     结论是**设计使然**，短时令牌方案已预设计（未实施），静态 bearer 明确拒绝。

### 待用户 30 秒验证（工具已就绪）

```bash
node scripts/e2e-live-check.mjs --hub-url ws://<hub>:19387/api/remote-agent/node
```

然后到 DSH 桌面对该节点派一个 exec 任务。工具监视副机 TaskStore 落盘记录
（状态机）与 roots 产物（sha256），自动判定。**这一步需要人的原因**：
hub webserver 被 DSH 会话围栏保护（见上第 3 条），不是脚本缺陷。

### 已真机验证（2026-10-16）

- **agent 模式全链路 ✅**：两台都装了 DSH 的真机上验证通过。此前两处根因修复
  （source 类型 20919b5、模型选择 367daef）从"仅进程内测试覆盖"升级为真机确认。

### 仍未覆盖（需要真机环境）

- **relay 模式真机**：进程内 e2e 已覆盖 happy path，跨 NAT 真机未验。
