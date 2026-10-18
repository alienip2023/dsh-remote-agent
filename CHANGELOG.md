# 更新日志

本文件记录所有值得注意的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于 0.x**：在 1.0 之前，`lib/**` 是 DSH 直接加载的产物（无构建步骤），
> 所以每次变更都可能是**行为变更**。升级前请读本文件对应条目。

---

## [0.9.2] - 2026-10-18

> **紧急修复：0.9.0/0.9.1 会让新版 DSH 启动崩溃。**
> 如果你装了 0.9.x 并升级过 DSH（0.2.1-rc.2 及以后），**先升级到本版**。

### 🔴 严重事故：包内 patch 绑 `host: '0.0.0.0'` 导致 DSH 启动崩溃

**这是我的错。** 0.9.0 为了让"副机连得上"，在包内 patch 里加了：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: 19387
```

新版 `@deepseek-ai/dsh-host-webserver` 在 **schema 校验阶段**就硬拒绝通配地址：

```
webserver: host "0.0.0.0" is an unspecified (wildcard) address, which is not
supported: binding every interface would expose remote code execution to the
network; bind one concrete IPv4 or IPv6 address of a local interface instead
```

**后果链**：

```
webserver（required）激活失败
  → webServer 服务缺失
  → 至少 6 个插件排队等它
    （web-runtime / open-in-app / directory-picker / client-hmr / remote-agent …）
  → host 启动失败
```

实测在用户机器上产生 **10 份 crash 日志**（`crash-*.log`）。

**这比它想修的"副机连不上"严重得多：连 DSH 都起不来了。**

### 修复

**包内 patch 不再碰 `webserver` 的任何字段。** 理由：

1. `host` 必须是**具体某个本机接口地址**（Tailscale IP / 局域网 IP），
   而这个值因人而异 —— 包里写死任何具体 IP 都是错的。
2. 插件在 `apply()` 里**也不能**自己读网卡再拼配置：loader 的 patch 是
   启动前静态合并的，改不了自己所在那一行的 config。
3. 实际做法：**由用户在 profile 里配一次**，插件负责**检测并说清该怎么配**。

配套修正（四处面向用户的文案，它们此前都在建议 `0.0.0.0`）：

- `lib/env-check.js` 的 reachability 修法 → 改为"具体的本机 IP"，并明确警告
  不能用 0.0.0.0，教会用户 `tailscale ip -4` / `ipconfig` 查地址
- `lib/client.js` 的红色横幅 → 同上
- `lib/hub/index.js` 的可达性自检 hint 与 log fix → 同上
- `README.md` / `README.en.md` 的安装段 → 重写，把"必须绑具体 IP"讲清楚

### 断言方向反转（79 / 新增 79b）

**原来的断言 79 是错的** —— 它要求包内 patch **绑** `0.0.0.0`。现在反过来：

- **79**：包内 patch 的**生效行**不得出现 `- id: webserver` 或
  `host: '0.0.0.0'`，且必须把事故写进注释留档
- **79b**：所有面向用户的修法文案都不得建议 `host: 0.0.0.0`，
  且必须包含"不能用 0.0.0.0"的明确警告

79 只扫**非注释行** —— 注释里必须保留事故原文（含 `0.0.0.0` 示例），
那是给后来者的警示，不该被判违规。

### 现在"副机连不上"怎么办

包内 patch 不再代你配 `webserver`，所以**新装用户要自己填一次 host**。
但这件事不再是静默失败：

- 面板加载时**自动体检**，绑 loopback 会显示红色横幅
- 「环境体检」里的 reachability 项会告诉你**当前绑在哪**、**该改成什么**
- 提示里直接教怎么查自己的 IP

**填什么**：

```yaml
- id: webserver
  config:
    host: '100.x.x.x'    # ← 换成你自己的地址（推荐 Tailscale IP）
    port: 19387
```

查地址：`tailscale ip -4`（跨网，固定不变）或 `ipconfig`（同一局域网）。

### 其他

- 新增 `scripts/diag-worker.ps1` —— 副机诊断脚本（**只读**，不改任何文件），
  输出 profile 列表、`remote-agent` 配置、插件版本、面板端点探测、
  配置备份时间线。用于排查"每次重启都回到引导页"这类问题。

```
packaging   4 项
doc-drift   121/121
diag:inject 11 项
tests       949（948 pass / 0 fail / 1 skip）
lint        干净
```

## [0.9.1] - 2026-10-17

> **0.9.0 发布约 40 分钟后补发**。两个 High 都是真实功能失效
> （体检对新装用户全面误报、SMB 共享完全不可用），趁用户数还少尽快修正。

### 修复（High）：环境体检对默认安装全面误报，且五项检查静默跳过

`/env-check` 路由传的是**原始 `config.role`**，而 0.9.0 起默认安装的生效配置
就是 `role: 'auto'`（`Config` 的 `.default('auto')` + 包内 patch 显式写入）。
`envChecks` 的判据 `isHub = role === 'hub' || role === 'both'` 拿到未解析的
`'auto'` 判 false，于是：

- **reachability / port / firewall / tailscale / nodes 五项全部跳过**
  —— 而这五项正是体检存在的理由（副机连不上的静默失败）
- `inject` 按 worker 三件套判定 → hub 正确的 inject 反被判"缺服务"
- `role` 检查误报未配置

实测（修复前）：

    role=auto → { ok:false, failed:2, items:[role(FAIL), inject(FAIL)] }

**影响放大**：9.0 的"首次自动体检"让这份"双误报 + 零诊断"在**每个新装用户
首次打开面板时自动弹出**。

修复（双保险）：

1. 路由改传 `resolveRole(config) || 'hub'`（与 `setup-routes` 同一份实现）
2. `envChecks` **自己**也解析 —— 即使调用方传错 `'auto'` 也能推断
   （判据：配置里写了 role 就以配置为准交给 `resolveRole`；没这个字段才用
   调用方给的值。两个极端写法都会误报，已由 5 个场景用例覆盖）

实测（修复后）：

    role=auto → role ✓ / inject ✓ / reachability ✗（正确报出 loopback）/ nodes ✗

### 修复（High）：SMB「生成共享命令」100% 失败

面板的 `doPlan` **恒定发送 `dir: ''`** —— 面板里根本没有选择目录的 UI，
而副机侧 `if (dir === '') reply ok:false 'plan 需要 dir'` 按设计拒绝。
于是工作区共享的**唯一主动作完全不可用**（probe 与后端 RPC 正常，API 直调可绕）。

修复：

- 加目录选择 UI，数据源是 `node.roots`（`nodeView` 一直透出它，那是副机的
  安全边界、也正是该共享的目录），默认第一项
- 无 `roots` 时退回可手填的输入框 + 说明原因
- 换副机时重置候选与 plan/probe 结果（否则会显示别人的共享命令）
- `dir` 为空时禁用按钮（不给用户"点了才失败"）

### 修复（Medium）：CLI `--doctor` 与面板体检是两套并行实现

三处注释曾声称"命令行与面板共用 `lib/env-check.js` 的同一份逻辑" —— 那是失真的：
CLI 走 `setup.js` 的 `doctorChecks`（14 项静态），面板走 `envChecks`（8 项运行时态），
**检查项不相交**。CLI 有 Node 版本 / hubUrl / token 但**没有 loopback 诊断**
（本版本最重要的那条），面板有 reachability 但没有前者。

修复：两段都跑、结果合并。顺带修掉 CLI 把 role 写死成 `'hub'` 的同类 bug
（`grab('role') || 'hub'` 会让 auto-worker 被当 hub 体检）→ 改用 `resolveRole`。

实测新增输出：`✓ Web 服务绑在可达地址 —— 当前监听 http://0.0.0.0:19387`

### 修复（Medium）：模型下拉的「自定义…」永远展不开文本框

原实现靠 `fv.model === '__custom__'` 判定，但表单里存的是**真实模型名**或空串，
从来不是字面量 `'__custom__'`：

- 从"跟随默认"（model=''）选自定义 → 旧值仍为 '' → `isCustom=false` → 弹回
- 从任一有效选项选自定义 → 旧模型名被保留 → `isCustom=false` → 同样弹回

唯一能进 `isCustom` 的路径是"表单预填了清单外模型名"（先有鸡）。

修复：加独立布尔 state `modelCustom`，`isCustom = modelCustom || (model 非空
且不在清单里)`。

### 修复（Low ×5）

- **templates.js 注释残留旧重试参数**（~​1.3s / 封顶 200ms）与常量
  （16 次 / 500ms / ~6s）不符 → 改为引用常量名 + 指向事故史。
  **这条最容易埋雷**：后来者可能照注释把窗口"修"回去。
- **`net share` 文本解析对含空格路径截断**（`D:\Deepseek Harness file`
  → `D:\Deepseek`）→ 改用 `Get-SmbShare | ConvertTo-Json` 取结构化路径，
  `net share` 仅作回退。本项目自己的目录名就带空格，这个 bug 在本机即会触发。
- **`autoFix` 承诺了不存在的能力**（全仓库无 fix 路由 / 无 `--fix` 参数，
  面板也没修复按钮）→ 语义改为"修法机械、照抄即可"，文案全部改写，
  reachability 项直接给**可粘贴的 YAML 片段**。
- **README 两处数字漂移**：状态行仍写 0.8.1、断言数写 117（实际 118）→ 修正中英两版。
- **hub ingest 无终态守卫**：晚期 `TASK_END`/`TASK_SUMMARY` 可把已置
  `FAILED(node-unreachable)` 改写回真实终态（良性但破坏"终态即终态"心智模型）
  → 加 `TERMINAL_STATUS.has(t.status)` 守卫（同终态重发幂等放行）。

### 新增：装配级测试（10 条）

`test/assembly-wiring.test.js` —— 全部锚在**接线处**而非模块内部：

两个 High 的共同点是"**单测覆盖了模块本身，没人测模块被装配进系统时的形状**"。
`envChecks({role:'hub'})` 全绿证明不了路由传对了；`buildShareCommand` 全绿
证明不了面板真的发了 `dir`。

另加 doc-drift 断言 84/85 钉住这两条接线，并做了**负向验证**
（回退修复后断言正确报 DRIFT）。

```
packaging   4 项
doc-drift   120/120
diag:inject 11 项
tests       949（948 pass / 0 fail / 1 skip）
lint        干净
```

## [0.9.0] - 2026-10-17

### ⚠ 行为变更：exec 任务默认超时 1 小时 → 10 分钟

**升级前请读这一段。**

此前 `exec` 任务实际拿到的超时是 **60 分钟**（不论文档说什么）。
原因是三处缺陷叠加（详见下方「代码审查修复」的 H1）：

1. `tools.js` 里有个 TDZ 自引用 bug，让分模式默认值那条分支永远走不到
2. `hub/index.js` 用 `numOr(defaults.timeoutMs, 1h)` 兜底，把 `explicitTimeoutMs`
   压成恒 3600000 → 优先级 `args > 显式配置 > 分模式默认` 被压扁成「恒 1h」
3. 面板 dispatch 同样写死 `?? 3600000`

三处都修了，所以现在：

| 模式 | 默认超时 | 意味着 |
|---|---|---|
| `exec` | **10 分钟**（`EXEC_DEFAULT_TIMEOUT_MS`） | 失控命令最多跑 10 分钟就被杀，不再占机一小时 |
| `agent` | 1 小时（不变） | agent 任务本来就需要长窗口 |

**如果你有 exec 任务本来就要跑 10 分钟以上**，显式传 `timeoutMs`：

- 工具：`remote_task({ ..., timeoutMs: 1800000 })`（30 分钟）
- 面板：派发表单的「超时毫秒」字段
- 配置：`defaults.timeoutMs`（作用于所有任务，优先于分模式默认）

### 修复：代码审查（1 High + 3 Medium + 6 Low）

WorkBuddy 2026-10-17 对 `lib/` 全部 26 个源文件（约 19,900 行）做全量审查，
发现的缺陷逐条核实为真后修复。

#### H1（High）tools.js TDZ 自引用

```js
const v = validateTaskStart({ constraints: {
  timeoutMs: ... ?? (v.spec.mode === 'exec' ? ... : ...)
                         ^ v 正在初始化，进入 TDZ
```

`??` 链左侧全空时抛 `ReferenceError`。

**为什么 829 个测试全绿仍带此 bug**：e2e helper 恒传 `timeoutMs`（`??` 第一项
短路）、单测构造时 defaults 也总有值 —— 该分支**从未被求值**。这是典型的
「测试环境与生产装配层差异造成的盲区」。

生产没炸但更糟：`normalizeConfig` 的 1h 兜底让 TDZ 永不触发，却把分模式
默认压成死代码（见上方行为变更）。

修复：改用已在 `v` 之前求值的 `routeMode`。

#### M1（Medium）relay 第三条 hub 写路径漏背压

C1-1 的背压修复只加在 `broadcastHubs` / `broadcastHubsBinary` 两条路径上，
**node 上行帧 → 全 hub 广播是第三条**，漏网。而 `ws.js` 的 `overBudget` 只是
查询属性、不自动断连，所以这条路径的写缓冲**没有任何上限检查**。

实测过的后果形态：单个停滞对端把 relay `writableLength` 推到 339.8 MiB、
RSS 419 MiB。中继是 NAT 场景唯一会合点、单进程常驻，OOM 即全体断连。

#### M2（Medium）grep 单文件分支无大小护栏

目录扫描路径有 `GREP_FILE_MAX`（2MB）与 `GREP_TIME_MS`（10s）双护栏，
但 `st.isFile()` 分支**直接 `readFileSync` 全文**。触发形态：`remote_grep` 的
path 指向工作区内巨大文本文件（应用日志 / 数据库转储 / core dump）→
副机 OOM + 同步阻塞事件循环。**这是一条可达的 DoS 面**（agent 自主选择 grep 目标）。

#### M3（Medium）approveTask 节点不可达时删除任务

原实现 `this.tasks.delete(taskId)` —— 任务从 hub 视图**彻底消失**（不是失败、
不是挂起，是不存在），与该方法注释自称的「转 failed 终态」**直接矛盾**。

后果：`remote_status` / 面板都查不到；`awaitTerminal` 等不到终态只能靠超时
兜底（最长 1 小时+）；与 ui-routes 的 502 文案不符。

修复：保留记录 + 置 FAILED + `error.code='node-unreachable'` + 唤醒等待者。

#### Low 系列（修 6 条）

- **L1** 副机 transport 缺 RelayLink 的两条并发不变式：
  `connecting` 闸门（`start()` 被调两次会开两条 TCP 连接）、close 必须校验
  `this.conn === conn`（否则陈旧连接的 close 把活着的新连接引用清掉 → 副机永久失联）
- **L2** RESOURCE 分支 `rec` 未判空（影子节点竞态必抛 TypeError）
- **L3** runner 的 active 注册晚于 `await createAgent`（窗口期内 cancel 返回
  false，正是 #26-5 修过的形态复现）→ 改为先占位再 await
- **L4** `E2E_REOFFER_DEBOUNCE_MS` 死常量 → 真正按 250ms 时间窗去抖
  （⚠ 它是**实例字段**不是 static，必须经 `this.` 读）
- **L5/L6/L7 未修**（记录在案）：relay 模式 hub 去重被中继层兜住、WS 版本校验
  双方恒发 13、hub 空闲淘汰被副机 15s 心跳掩盖 —— 属一致性改进而非缺陷

#### 测试

新增 `test/code-review-regressions.test.js` **11 条**，覆盖 H1/M1/M2/M3/L1/L2/L4。
**H1 的测试刻意不走 e2e helper**（那正是盲区成因）。

### 文档：README 补「功能」章节

用户指出「README 好像没有功能相关的介绍」—— 核实后发现**比这更严重**：

- **版本号落后 4 个版本**（写 0.4.0，实际 0.8.x）
- **工具数量写错**（写「7 个」，实际 **12 个**：8 个 `remote_*` + 4 个 fs 工具），
  出现在架构图、目录表、工具速查三处
- 确实没有功能总览章节

新增「功能」六组：派任务 / 拿结果 / 翻文件 / 本地 IDE 打开（SMB）/ 自我诊断 /
断连跨网安全。英文版同步。

新增断言 83：**README 声明的工具数量必须等于代码里 `reg(` + `fsOp(` 的注册数**，
两边任一变化立刻失败（做过负向验证）。

### 关于 0.8.0 与 0.8.1（记录）

0.8.0 的 publish 第一次报「假成功」（tarball 未落地），当时判断它卡在 staging
并跳过发布了 0.8.1。事后查 registry 发现 **0.8.0 最终也发布成功了**
（07:43:45，比 0.8.1 晚 3 分钟）—— 那次 `unpublish` 同样假成功。

两个版本内容基本相同（都是 #26-4/#26-5 + EPERM 修复 + #27 完整版），
不影响使用。教训：**npm publish 的成功/失败判定必须用 `Cache-Control: no-cache`
读 registry 核实**，不能只看 exit code 或缓存副本。

### 文档：README 补「功能」章节 + 修正 4 个版本号的漂移

用户指出「README 好像没有功能相关的介绍」—— 核实后发现**比这更严重**：

#### 1. 版本号落后 4 个版本

```
README L33:  | **状态** | 0.4.0 —— 主机侧端到端可用 ... |
实际:        npm latest = 0.8.1
```

#### 2. 工具数量写错（7 → 12）

README 写「7 个 remote_* 工具」，实际是 **12 个**（8 个 `remote_*` +
4 个 fs 工具）。这个数字在 3 处出现（架构图、目录表、工具速查）。

#### 3. 确实没有「功能」章节

原结构是「五分钟上手 → 核心不变式 → 安装 → 用法」——「用法」里只有工具速查，
**没有一个"这个插件能干什么"的总览**。读者只能从零散段落里拼。

#### 修复

新增「功能」章节，分六组：

1. **把任务派给副机** —— 两种模式 / 两阶段审批 / dry-run / 仓库感知 /
   负载感知 / 模型下拉 / 分模式超时 / 并发上限
2. **拿结果但不搬整个工作区** —— handoff 卡 / 三分类 / 显式拉取 /
   断点续传 / 变更 diff
3. **直接翻副机的文件** —— 四个只读工具（不进任务队列）
4. **用本地 IDE 打开副机文件** —— SMB 共享（含安全警示）
5. **出问题能自己诊断** —— 环境体检 / 可达性自检 / 队列健康 /
   运行中分组 / 取消真打断 / 审计日志
6. **断连、跨网、安全** —— 断连不终止 / 两种传输 / E2E / 主机身份 /
   凭证不出副机 / 零依赖

另修：架构图工具数、状态行（0.4.0 → 0.8.1）、测试数表、
`lib/` 目录表（补 `env-check.js`、`role: auto`）。

英文版 `README.en.md` 同步（同样的 4 处漂移 + 完整 Features 章节）。

#### 加了一条断言防复发（83）

工具数量这种「数字漂移」是最容易积累的文档债务 —— 每次加工具都忘了改
README，而读者会拿它当事实。所以新增断言：**数代码里 `reg(` + `fsOp(`
的注册调用数，与 README 里的声明比对**，两边任一变化都会立刻失败。

做了负向验证：临时把 README 的 12 改成 7，断言正确报错并给出
「实际 12 个（reg=8 + fsOp=4）vs 声明 7 个」。

```
packaging   4 项
doc-drift   118/118（+1）
diag:inject 11 项
tests       938（937 pass / 0 fail / 1 skip）
lint        干净
```

### 功能：工作区共享（SMB）—— 用本地 IDE 打开副机的文件

用户需求：想用本地 IDE 直接打开副机的项目目录。

实现方式：把副机的工作区通过 Windows SMB 共享出去，主机
`net use X: \\副机\dsh-work-...` 映射成盘符。

#### ⚠ 这是本插件**唯一主动放宽安全边界**的功能

开启后：
- `roots` / `denyPaths` 全部失效（Windows 内核直读，插件拦不住）
- 「清单先于字节」失效（中间产物、日志、`.env`、`.git` 密钥全部可见）
- 新增凭证面（主机需要副机的 Windows 账号）

所以按用户要求做了三重防护：

1. **二次确认**（硬要求）—— `POST /share` 缺 `confirm: 'yes'` 直接 400，
   没有默认通过的分支；面板上必须勾选「我知道风险」按钮才可点
2. **只读 / 读写两选项**，默认**只读**（最小权限）；读写用 `-ChangeAccess`
   而非 `-FullAccess`（后者会把共享 ACL 也交出去，主机能改权限）
3. **不代执行** —— 只生成可复制的命令，执行由用户在管理员 PowerShell 里做

#### 为什么不代执行（重要设计决策）

`New-SmbShare` 需要管理员，而 DSH 通常以普通用户运行。Node 里提权的
失败表现（静默失败 / 被安全软件拦 / 权限半生效）比让用户手动跑一条命令
难排查得多。所以 `handleShareReq` 只做三件事：`probe`（探测管理员状态
与已有共享）、`plan`（生成共享 + 映射命令）、`unshare-plan`（生成卸载命令）。

#### 实现要点

- **协议**：新增 `SHARE_REQ` / `SHARE_RES` 帧，与 `fs/req` 同款 RPC 模式
- **E2E 强制**：`SHARE_REQ` 进 `E2E_REQUIRED_TYPES` —— 帧里含工作区
  **绝对路径**（暴露副机目录结构），不许明文过中继
- **独立 pending 表**：`sharePending` 与 `fsPending` 刻意分开 —— 混用会让
  超时归因变模糊（一条 share 超时被记成 fs-timeout，排查方向直接跑偏）
- **共享名稳定哈希**：同一目录反复开关共享名不变（不留孤儿共享），固定
  `dsh-work-` 前缀便于识别与清理（不会误删用户的其它共享）
- **共享目录过 roots 边界**：`plan` 的目录必须经 `resolveWorkspace`
  （realpath + roots 前缀 + denyPaths），与 fs 工具同一条规则

#### 文档

新增 [docs/workspace-share.md](docs/workspace-share.md)：完整风险披露、
三步用法（面板开启 → 副机管理员执行 → 主机映射）、关闭方法、常见问题
（连不上怎么查、为什么共享名是怪名字、能不能共享整个盘、与 relay 的关系）。

#### 测试

- `test/share-service.test.js` **17 条**：共享名稳定性、只读/读写映射
  （含"不得用 FullAccess"）、单引号转义防注入、探测不抛、跨平台安全
- `test/share-integration.test.js` **12 条**：帧已声明、E2E 强制、
  pending 表独立、断连 fail-fast、**二次确认是硬要求**、只读默认、
  面板勾选框、不代执行、目录过 roots 边界

doc-drift 新增 81（接线完整）、82（安全约束）。

```
packaging   4 项
doc-drift   117/117
diag:inject 11 项
tests       926（925 pass / 0 fail / 1 skip）
lint        干净
```

### 开箱即用：装完就能用，不用读文档

用户标准（2026-10-17）："我希望是小白可用的，是开箱即用的"。

此前有三道门槛，每一道都能让小白卡死：

1. **`role` 默认 `''`** → 两台机器都要操作一次，不是开箱即用
2. **`webserver` 没绑 `0.0.0.0`** → 副机永远连不上，且**完全静默**
3. **副机表单 4 个字段** → 不知道节点 ID / 工作区填什么

#### 核心设计：`role` 默认 `auto`，按 `hubUrl` 推断

- 默认 `hub`：副机装完会以 hub 身份启动 —— 注册一个 nodeToken 为空、
  不校验凭证的直连端点。**这是实打实的攻击面**（v0.7.0 之前的老问题）。
- 默认 `''`：两台机器都要操作一次，不是开箱即用。
- **默认 `auto`**：没配 `hubUrl` 就是主机（零操作），配了 `hubUrl` 就是副机
  （贴完配对码零操作）。**两者都开箱即用，且不给副机开不该开的端点。**

判据只有一条，但它是副机与主机最本质的区别：`hubUrl` 是副机独有字段，
hub 侧根本不读它。配对码展开后必然产出 `hubUrl`，所以"贴码 = 自动变副机"。

推断结果带 `inferred` 标记（`no-hubUrl` / `hubUrl`），面板可显示依据。
显式写 `hub`/`worker`/`both` 永远优先于推断 —— 用户写的不该被猜掉。

#### 包内 patch 让 hub 真能被访问

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: 19387
```

不覆盖这一行，hub 只监听 loopback → 副机永远连不上。这是"能不能用"的决定性一条。

**安全披露**（写进 patch 注释 + README + 面板 + 体检）：绑 `0.0.0.0` 意味着
**DSH 的整个 Web GUI 也能被局域网访问**，不只是本插件的节点端点。DSH 自带
Host/Origin 围栏 + cookie 鉴权，但暴露面确实变大了。用户可在 profile 里覆盖
回 `127.0.0.1`（此时请改用 relay 模式）。

优先级安全：`cordis.yml` 头注释说明应用顺序是 bundles → profile patch →
--patch overlays，所以**用户 profile 里的同名行会覆盖包内默认**。

#### 副机表单简化

- **工作区预填**（Windows `D:\work`，其他 `~/work`）—— 此前是空，小白不知道
  填什么：填相对路径被拒、填 `C:\` 太宽（安全边界）、填不存在的目录任务全报
  `workspace-denied`
- **节点 ID 折叠为高级选项** —— 默认取主机名，90% 用户不用改
- **目录自动创建** —— 写入配置时 `mkdirSync(recursive)` 建不存在的 roots
  （只建不改；相对路径跳过交给 resolveRoots 去拒；失败不阻塞写配置，
  结果进 `warnings` 随响应回给面板）

#### 首次自动体检

面板加载时**自动跑一次**体检（`autoChecked` ref 保证只跑一次，不进 4 秒轮询）。
此前要用户主动点「体检」按钮 —— 但小白不知道要点。

#### 文档修正

README 安装段重写。顺带修正一个**长期错误建议**：旧文档教用户写
`inject: []`，那是错的 —— 副机 agent 的 ctx 继承插件的依赖声明，
`inject: []` 会让 agent 没有任何 shell/文件工具，任务"跑完了但什么都没干"。
正确写法是 `['tools', 'agentLoop', 'sessions']`。doc-drift 断言 30 也跟着改。

#### 测试

`test/out-of-box.test.js` **15 条**：auto 推断的四种情形（没 hubUrl / 有 hubUrl /
空白 hubUrl / 显式 role 优先）、空 role 仍走引导、非法 role 不回退 hub、
包内 patch 绑 0.0.0.0 + 安全披露、表单预填/折叠、自动建目录、首次自动体检。

doc-drift 新增 79（auto + webserver 绑定）、80（表单简化 + 自动建目录 + 自动体检）。

```
packaging   4 项
doc-drift   115/115
diag:inject 11 项
tests       897（896 pass / 0 fail / 1 skip）
lint        干净
```

### 功能：环境体检（命令行为准，面板可见）

这个插件最贵的失败**全是静默的**：

- **webserver 绑 loopback** → 副机永远连不上，而主机侧毫无异常
  （hub healthz 200、面板能开、工具都在）
- **inject 缺服务** → hub 半死（路由活着但 8 个工具全丢）
- **roots 不存在** → 任务全被 `workspace-denied` 拒绝

用户只能猜"地址错了？token 错了？防火墙？"。

本版新增 `lib/env-check.js`，命令行与面板**共用同一份逻辑**：

- `envChecks()` 逐项检查：角色已配置 / inject 含必需服务 / **Web 服务绑在
  可达地址** / 端口可用 / 防火墙 / roots 存在 / Tailscale / 副机在线
- 每项都带 **detail（为什么）** 与 **fix（怎么修）** —— 不是干巴巴一个 ✗
- `autoFix` 标记"我们能自动改配置修好它"

三档处置（产品决策）：

| 档位 | 做法 | 例子 |
|---|---|---|
| A 自动修 | 只改我们自己的配置，不下载任何东西 | webserver 绑 0.0.0.0、role/inject/roots |
| B 提示 + 命令 | 给官方链接与命令，**不代下载** | Tailscale 未安装 |
| C 只诊断 | 报清楚，让人判断 | 端口占用、防火墙、模型凭证 |

**为什么不代下载**（边界）：零 npm 依赖 / 零构建是核心卖点。代用户下载第三方
软件会让本插件变成软件分发方 —— 装哪个版本、从哪下、校验和怎么保证、装失败
算谁的、供应链攻击面，全落在我们头上。所以档位 B 只给链接与命令。

配套：

- `applyHub` 新增**可达性自检**：调 `webServer.getOrigin()` 判定是否绑在
  loopback，是则 `log('warn')` 带修法。自检本身包 try/catch ——
  `getOrigin()` 在 listen 前会抛，**绝不能因为自检让 hub 起不来**
- 面板新增**红色横幅**（绑 loopback 时）+「体检」按钮 + 体检结果区
- 新增 `GET /api/remote-agent/ui/env-check` 路由

测试：`test/env-check.test.js` **24 条**（loopback 识别的 8 种写法 +
各检查项的通过与失败 + 修法必须具体 + warn 不计入 failed +
config 传 null 不抛 + 渲染每条 ✗ 都带修法）。
doc-drift 新增 77（三处齐备）、78（覆盖静默失败项 + 不代下载边界）。

写测试时抓到 3 个真问题：`config: null` 会 TypeError、Tailscale 文案漏了
"不代下载"说明、以及一个断言的正则转义层数写错。

## [0.8.0] - 2026-10-17

### 功能：#27 完整版 —— 模型清单自述 + 面板下拉

v0.7.0 只做了"自述 + 派发前拦截"，面板仍是自由文本 —— 当时的判断是
"in-process 后端没有稳定的清单 API（DSH 内部的 `model/list` 走 app-server
协议面，fiber 服务摸不到）"。**那个判断已经过时**：`ctx.llm` 现在直接暴露
`listProviders()` 与 `listModels(provider)`，这就是稳定服务面。

所以本版把最后一环补上，链路四段：

1. **副机探测**（`readAvailableModels`）：`ctx.llm.listProviders()` →
   逐个 `listModels(provider)`。单个 provider 失败 `continue`（不打断其它），
   全部失败返回 `null`（面板退回自由文本）。上限：8 provider / 每 provider
   24 模型 / 总 64 —— 不让 RESOURCE 帧膨胀。

2. **RESOURCE 帧带缓存**：探测是 async 而 interval 回调是同步的，所以用
   后台串行链刷新（启动探一次 + 每 10 分钟重探），帧里带**上一次的结果**。
   用串行链而不是 `void refresh()` 是为了防探测堆积（探测慢时每 30s 一次帧
   会越积越多）。探测失败保留旧值 —— 一次网络抖动不该让面板下拉消失。

3. **hub 摄入**（`registry-ingest`）：字段级清洗 + **独立封顶**
   （`MAX_NODE_MODELS`，不信任对端遵守了自己的上限）。
   `models: null` **保留旧值**（与 `defaultModel` 的 null 清空语义刻意不同）。

4. **视图 + 面板**：`registry.list()` → `nodeView()` 逐条投影（不 spread）
   → 面板 `<select>`：
   - 第一项"跟随副机默认（provider/model）"
   - 中间是各模型，多节点时带 `· 节点名` 后缀
   - 最后一项"自定义…"（展开回文本框）
   - **没有清单时退回文本框**（向后兼容旧副机）

**安全边界**：只上报 provider 键名 + model id + 显示名。
绝不上报 apiKeyEnv 的值、baseURL、任何凭证。`listProviders()` 只返回
已注册（有 adapter）的 route —— 天然满足"不泄露这台机器配了哪些渠道"，
只有真能用的才会出现。

测试：`test/model-list-dropdown.test.js` 13 条（四段链路逐段钉住 +
"上报字段恰好是 provider/id/name"的硬断言 + 单个 provider 失败不打断 +
null/[] 语义区分 + 面板有 select/自定义/多节点后缀）。
doc-drift 新增 75（链路四段）、76（安全边界）两条锚点。

### 修复：原子写 EPERM 立项修（第 5 次 CI 失败）

`atomicWriteJson` 的 rename 在 Windows 上被 EPERM 拦（目标正被另一个句柄
读着）。历次调整：6 次 × 10ms（总 210ms）→ 10 次封顶 200ms（总 ~1.3s），
run 39012045381 **仍失败**。

第 5 次失败时承认：这不是"抖动"，是"窗口太短"。失败用例是
「原子写：并发写 + 并发读」—— 多个 rename 互相争抢同一个目标，而 CI
runner 高峰期的磁盘延迟能到秒级。

三层修法：

- **总窗口拉到 ~6s**（16 次，封顶 500ms）—— 有界，正常路径第 1 次就成功
- **最后一次尝试前做 unlink 兜底**（删目标再 rename，绕开"目标存在且被锁"
  的 EPERM）
- **兜底只在第 16 次触发** —— 它破坏"任何时刻读到完整文件"的严格原子性
  （删除与 rename 之间读方看到 ENOENT），所以必须当最后手段而不是常规路径；
  触发点用 `RENAME_RETRIES - 1` 计算，不写死数字

安全性：读方（`readAll()` / `list()`）本来就容忍 ENOENT —— 首次写之前
文件不存在是正常状态（`readAll` 的 ENOENT 分支返回空库且 `degraded: false`）。
所以兜底造成的瞬时缺失落在既有容忍范围内，不会让读方看到半截 JSON。

测试：`test/atomic-write-eperm.test.js` 6 条（窗口 ≥5s / 兜底存在 /
触发点是最后一次 / readAll 容忍 ENOENT / 非 transient 立即抛 /
目录占住时干净失败）。

### 修复：队列残余风险的两处静默失效（#26-4 / #26-5）

2026-10-17 实测：副机 `maxConcurrent=2` 被两条卡住的 exec 占满后，后续任务
全部排队。排查时暴露两个让问题**不可见、不可控**的缺陷 —— 都是"没有报错、
行为看起来正常"的静默失效型。

- **#26-4 面板"运行中"分组**：此前面板只有一个数字（`running: 2`），
  用户看不到**是哪两条、在跑什么、跑了多久**。现在任务列表按状态分组，
  运行中（含 queued / pending_approval）置顶，每条显示 `已跑 N`
  （由 `startedAt` 与当前时间算差）—— 这是判断"是不是卡住了"的唯一线索。
  其余任务归入"已完成 / 已结束"，保持原顺序。

- **#26-5 agent 取消真打断**：`InProcessRunner.run` 等 agent 停稳用的是
  `Promise.race([agent.whenIdle(), timeoutPromise])` —— **取消信号不在里面**。
  而 `cancel()` 做的是 `agent.cancel()` + `controller.abort()`：abort 只是
  置了个标志，没有任何人在 await 它；DSH 的 agent 循环也不监听外部
  AbortSignal。后果：hub 发 `task/cancel` → `remote_cancel` 返回
  `requested: true` → 任务**一直 running 到 agent 自己跑完** → 最终落成
  **completed**（不是 aborted）。用户以为取消成功，实际白跑一遍还烧了额度。

  修法：把 abort 做成可 race 的 promise（触发即 resolve），并让返回值的
  `ok` 排除 `aborted`（`ok: !timedOut && !aborted`）。两个语义细节同时钉住：
  超时触发的 abort **不**改写成 aborted（超时 ≠ 用户取消，下游据此外报不同
  错误码）；`finally` 里 `handle.dispose()` 收掉 agent，避免取消后泄漏。

测试：`test/agent-cancel-abort.test.js` 8 条（race 含 abortPromise / ok 排除
aborted / 超时不误标 / cancel 双动作 / finally dispose / engine 映射顺序）；
doc-drift 新增 73、74 两条锚点。

## [0.7.0] - 2026-10-17

### 功能：模型自述 + headless 指定模型派发前拦截（提案 #27）

副机此前"只有它自己知道有哪些模型"—— 面板让用户自由填 provider/model，
填错要等任务跑到副机才失败。本版先解决可靠可达的两半：

- **副机自述**：`RESOURCE` 帧随车上报 `runnerKind`（in-process/headless）
  与 `defaultModel`（来自 DSH `agentDefaultModel.currentSelection()`，
  **只报 provider 键名 + model id，不碰任何凭证**；取不到一律 null，
  尽力而为不影响遥测帧）。hub 摄入清洗后 `remote_nodes` 透出并在节点行
  渲染（"后端 in-process · 默认模型 official/deepseek-chat"）。
- **派发前拦截**：`remote_task` 在 `mode=agent` + 显式 `model` + 目标节点
  为 headless 后端时**立即报错**（旧链路要等任务跑到副机才失败，浪费
  一轮往返 + 烧一个 taskId）。dryRun 与真实派发同一条校验路径。
- **dryRun 回显模型**：预览里给解析后的 `{provider, model}` 与
  `modelSource`（用户指定 / 副机默认 / 未指定）—— 派之前就知道用
  什么模型。

**范围收敛（如实说明）**：完整的"可用模型清单 + 面板下拉"本版不做 ——
in-process 后端没有稳定的清单 API（DSH 内部的 `model/list` 走
app-server 协议面，fiber 服务摸不到；探测 llm-pi-ai 内部结构太脆弱）。
等 DSH 把清单暴露成稳定服务 API 后补（面板届时渲染下拉，第一项
"跟随副机默认"，数据链路本版已铺好）。

测试：`test/model-selfreport.test.js` 3 条 + e2e 2 条（自述贯通 /
headless 拦截 / dryRun 回显）+ 修一处脆弱断言（applySync 窗口锚定义处）。

---

## [0.6.0] - 2026-10-17

### 修复：单条慢命令锁死整台副机（提案 #26，实测事故防线）

实测事故：两条慢 exec 占满 `maxConcurrent=2` 后，后续任务**全部 queued 且一条
都不执行**；重启副机后重派同样命令再次锁死。根因是 `maxConcurrent=2` 与
exec 默认超时 1 小时的组合 —— 一条卡住的命令 = 整台副机一小时不可用。

**行为变更（默认值）**：

- **exec / agent 默认超时分开**：exec 10 分钟（绝大多数命令 1 分钟内结束，
  10 分钟足够暴露"命令本身有问题"）、agent 保持 1 小时。工具层与副机兜底
  **同源常量**（`task-engine.js` 导出，`tools.js` 直接 import），显式
  `timeoutMs` 仍然优先。
- **maxConcurrent 默认 2 → 4**：2 太脆 —— 两条慢任务就能锁死整台机器；
  4 让"两条慢 + 两条快"正常共存。配置项保留，按内存调整。

**可见性：队列健康遥测（#26-3）**：

- 副机 `TaskEngine.queueStats()` 每 30s 随资源遥测帧搭车上报：
  `{queued, running, maxConcurrent, oldestQueuedMs, starved}`。
  `starved` = 有排队 + 并发占满 + 最久排队超 2 分钟。
- `remote_nodes` 透出 `queue` 字段；starved 节点渲染 ⚠ 堵死告警并给出
  下一步动作（remote_status 逐条查 / remote_cancel 释放并发槽）——
  用户不再只知道"卡了"，还知道"卡在哪、等多久、怎么办"。
- 旧副机不上报 queue（向后兼容），remote_nodes 相应行缺席。

**如实说明**：exec 的取消链路核查结论是**真杀进程树**（Windows
`taskkill /T /F`、POSIX `kill(-pgid)`，abort → killTree 已实装）——
"remote_cancel 无效"的残余风险在 agent 会话卡在不检查 signal 的 await
与快照同步扫描（`snapshotWorkspace`），留待 #26 后续批次。

测试：引擎侧 3 条（常量同源文本断言 / maxConcurrent 默认 / queueStats 判定
矩阵）+ e2e 资源遥测用例扩展（queue 贯通 + starved 渲染）。全量 825 tests。

---

## [0.5.0] - 2026-10-17

### 功能：远程文件工具集（提案 #25）

四个**只读**文件工具，装完即有 —— AI 可以直接读副机上的文件，**不用配
网盘、不用挂载、不用 SMB**：

- `remote_ls`：列目录（单层分页，目录优先，条目带类型/大小/修改时间）
- `remote_read`：读文件 —— 文本 ≤8MB 按行分段（`offset`/`limit` 翻页，
  单次响应 ≤256KB，超长行截断）；二进制只回 sha256 + 大小 + 头部 hex 预览
- `remote_grep`：副机本地全文搜索（纯 JS 逐文件扫，**不 spawn 外部 grep**，
  Windows 没有）；上限 2000 文件 / 单文件 2MB / 命中 ≤200 / 总时长 10s，
  达到上限如实报告 `truncated`
- `remote_tree`：目录树摘要（深度 1-6 默认 3，条目 ≤2000）—— 扫描在副机
  跑完只回结构，50GB 目录也不搬数据

架构与安全：

- 独立协议帧 `fs/req`（hub→node）↔ `fs/res`（node→hub），带 `replyTo` 关联
  与 15s 超时；副机断连即清理全部等待者。**不进任务队列、不占并发槽** ——
  一条慢命令锁死队列的形态在这里结构性不存在
- 安全模型与任务链路同一条底线：路径 `realpathSync.native`（展开 8.3 短名
  与符号链接）后与 `roots` 前缀比对；`denyPaths` 在枚举与读取两层生效
  （被禁条目连名字都不上报）；符号链接只列条目不解引用；整个模块没有写动词
- `fs/req` 加入 E2E 必需加密帧集：relay 模式下文件路径与内容对中继不可见

测试：`test/fs-service.test.js` 14 条单测 + hub⇄worker e2e 2 条（真实通道
四工具贯通 + relay 窃听器验证文件内容/文件名不可见）+ 工具收口与 inject
契约断言同步（8 → 12 个工具）。

---

## [0.4.0] - 2026-10-17

### 验证：`agent` 链路两台真机确认通过

此前 §8 的"待两台真机确认"项闭环：在两台都装了 DSH 的真机上，
`agent` 模式全链路（派发 → 副机独立 Agent 循环 → handoff 回传）验证通过，
两处根因修复（source 类型 `20919b5`、模型选择 `367daef`）从进程内测试
覆盖升级为真机确认。README 状态行同步。仍未覆盖：relay 模式跨 NAT 真机。

### 功能：中继链路端到端加密（提案 #1）

relay 模式下 hub⇄副机的业务帧默认端到端加密：中继只看得到路由信封
（`t`/`id`/`to`/`from`），goal、handoff 与产物分块全在密文里。密钥协商用
一次性 X25519 + HKDF-SHA256；hub 用持久 ed25519 身份签握手回执（签名绑定
双方临时公钥 + nonce，中继偷换公钥/重放即失败，验证锚是 P2-11 钉住的
hub 指纹）；每帧 AES-256-GCM，AAD 绑定方向/类型/id/序号，序号严格递增
挡重放。会话建立后副机**拒绝一切明文业务帧**——挡住中继运营者拿
enrollToken 冒充 hub 注入任务的唯一防线。

兼容性：中继**零改动**（密文藏在既有帧格式里，旧中继照转）；旧副机/旧
hub 混跑按未知帧互相忽略；握手 5 秒无 ack 自动按明文兼容旧中继继续
（副机大声警告）。已知局限见 SECURITY.md「中继链路端到端加密」：
主动降级（中继扣握手帧）与 enrollToken 冒充节点。

实现：`lib/e2e.js`（新）+ hub/node 两侧收发路径接线；`relayE2E: false`
可整体关闭。测试：`test/e2e.test.js` 12 条单测（黄金向量/篡改/AAD/序号/
二进制）+ `test/hub-worker-e2e.test.js` 5 条集成（窃听器不可见、二进制
字节一致、伪造拒绝、丢会话自愈、direct 生效）。

### 功能：任务变更 diff 视图（提案 #21）

任务收尾时副机为工作区里 add/modify/delete 的**文本文件**生成 unified diff，
随 handoff 上报 —— 远程场景下没法随手 `git diff`，这张卡就是"到底改了什么"
的证据链。零依赖（不 spawn git、不引 npm 包）：公共前后缀修剪 + DP LCS，
中段超 600 行不硬算（统计式降级，宁可粗也不 O(n²) 爆内存）。

边界刻意收窄：前像在任务开始时快照捕获（≤256KB/文件、64 文件、总量 4MB、
二进制不捕获，超限文件的 diff 缺席但 changed 元数据仍在）；输出封顶
12 文件 / 单文件 16KB / 总量 96KB。消费路径：`remote_handoff` 卡片直接带
diff 文本（`## 变更 diff` 段），面板任务详情新增「变更 diff」块（先展示
6 块）。安全披露见 SECURITY.md 新节 —— diff 是**文件内容**，不再只是元数据；
`denyPaths` 对快照与 diff 同样生效。测试：diff 单测 10 条 + engine e2e 3 条
+ views 投影 3 条。

### 功能：exec 输出行心跳（提案 #15）

`mode:"exec"` 的长任务此前 running 期间没有任何进度帧（只有 started 与
结束帧），面板与 remote_status 都"看起来卡死"。现在 exec 运行期每 2 秒
发一条 `task/progress`（`phase:"output"`），**只在 stdout/stderr 行数有变化
时发**（静止时不刷屏），面板「进行步骤」尾部展示 8 条。只对 exec 做 ——
agent 模式的工具事件本身就是步骤流，避免刷爆 20 条 progressTail。
e2e 1 条（首帧必发、行数不变不发、stop 后静默）。

### 修复：真机验证揪出的四项（docs/verification-repos-routing-real.md）

- **审计值级打码**：此前打码只看键名，任务书正文里内嵌的凭证
  （`Bearer sk-…`、`password=…`、`://user:pass@`、sk-/ghp- 前缀 token）
  会明文落进 audit.jsonl 并长期留存。现在字符串值过第二道凭证形态扫描
  （高精度口径：普通正文不受影响）。
- **`agentMode` 可配置**：副机 hello 里的 `agentMode` 曾硬编码 `true`，
  让 #14 的"agent 模式只选支持 agent 的节点"成为空承诺。现在 worker
  配置 `agentMode: false` 即可关掉（默认 true 不变）。
- **测试不再污染用户真实状态目录**：hub-worker-e2e / ui-routes 两处测试
  的 hubConfig 漏传 `stateDir`，审计事件写进了真实的 `~/.dsh-remote-agent/`
  （跑一次测试写 14 行）。已补上临时目录。
- **scp 形态 url 剥用户名**：`token123@host:path` 的用户名位置可能是
  token（自建 Git 服务常见），不再赌它是公开用户名，`user@` 一并剥掉
  （url 只用于展示与匹配，剥掉无害）。

### 功能：exec 任务两阶段审批（提案 #2）—— ⚠ 行为变更

**`mode:"exec"` 的缺省行为变了**：现在默认 `approval:"manual"` —— hub 收到
派单后**挂起不派**（副机完全不知道这条任务存在），直到在面板「远程同事」
的待审批卡上点「批准并派发」才真正下发；挂起超过 `limits.approvalTimeoutMs`
（默认 30 分钟）**自动拒绝**（fail-closed：等不到人就是不跑，绝不默认放行）。
想要旧行为显式传 `approval:"auto"`。`mode:"agent"` 缺省不变（auto）。

配套：任务新增 `pending_approval`（非终态）与 `rejected`（终态）两个状态；
面板派发表单派 exec 任务同样走审批；对挂起任务调用 remote_cancel 等价于
拒绝（不会向副机发无意义的取消帧）；审计新增 `approval.pending/granted/rejected`
事件；审批路由 `/ui/approve`、`/ui/reject`（404/409/502 语义）。
挂起任务占 maxTasksPerNode 活跃额度（防审批队列无界堆积）。
单元 + e2e 共 15 条。

### 功能：派发 dry-run 预览（提案 #23）

`remote_task` 新增 `dryRun: true`：走与正式派发**完全相同**的路由（显式
node / repo 仓库路由 / 负载自动选）与校验（validateTaskStart），返回"会派
到哪个节点、哪个工作区（含副机默认工作区回填）、什么模式"，不落库、不派
帧、不烧 taskId。预览报错即真实派发会报的错。e2e 1 条（含"不产生任务"
负向断言）。

### 功能：仓库感知调度（提案 #13）

`remote_task` 新增 `repo:` 参数：传仓库名 / 远端 url 片段 / 本机路径片段，
任务派给**持有该仓库**的节点（多个时按负载自动选，名字精确匹配优先于包含
匹配）；省略 `workspace` 时自动用仓库在本机的路径。副机接入后自动扫描
roots 下的 git 仓库（零子进程，只读 `.git/config`）并上报——**凭证在副机
本地剥掉**（url 里的 user:token 不出机器），每 10 分钟刷新，
`reposIntervalMs: 0` 可关。旧 hub 收到新帧按未知帧忽略（混跑安全），
副机未升级时 `repo:` 会得到明确报错并列出当前已上报的仓库。新增
`lib/node/repos.js`、`NodeRegistry.pickNodeByRepo` / `findRepoOn` /
`knownRepoNames`，测试 23 条。`remote_nodes` 与面板节点列表新增 repos 字段。

### 功能：负载感知自动路由（提案 #14）

`remote_task` 省略 `node` 时的行为变更：多节点在线**不再报错**，改为自动选
——在跑任务数 → CPU → 内存占比 → nodeId 字典序逐级比较（逐级而非加权，
确定可解释）；`mode:"agent"` 只考虑支持 agent 后端（agentMode）的节点。
显式指定 `node` 的行为不变。新增 `NodeRegistry.pickAutoNode`，测试 10 条。

### 功能：hub 审计日志（提案 #19）

hub 在 `<stateDir>/audit.jsonl` 记录派发 / 取消 / 拉取证据链
（`task.dispatch` / `task.cancel` / `pull.start` / `pull.end`）。
字段统一打码截断（token 类键值写 `***`、超长 400 字符截断）；默认开启，
8MB × 3 份轮转封顶；`config.audit: false` 显式关闭。写入失败只限频告警，
绝不影响任务链路。新增 `lib/hub/audit-log.js`，测试 9 条。

---

## [0.3.0] - 2026-10-16

### 工程：P1-4 拆分 node-registry.js（1465 行 → 四个职责文件）

纯代码搬移，零行为改动，对外 `import { NodeRegistry, RelayLink, createPluginLogger } from './node-registry.js'` 的旧路径仍可用：

- `relay-link.js` —— RelayLink（中继链路：重连/退避/节点目录），KNOWN-ISSUES 与 CHANGELOG 早已记着这条拆分建议
- `hub-util.js` —— 插件日志器 + errText/numOr/safeDispose（单一真身，registry 与 relay-link 共享；numOr 曾因本地拷贝约束漏抄出 ReferenceError）
- `registry-ingest.js` —— 上行帧处理与 task/sync 对账（mixin：`withIngest`）
- `registry-handshake.js` —— direct/relay 接入、hello、hub 身份证明（mixin：`withHandshake`）
- `node-registry.js` 只剩核心注册表（任务视图/下发/等待器/心跳/生命周期），约 640 行

门禁锚点同步：doc-drift 断言 15c/42/62/66、自检变异目标、task-view-accumulation 文本断言均跟随新文件；KNOWN-ISSUES 该条已标注解决。

### 功能：产物断点续传

`remote_pull` 拉大产物途中断线 / 超时，此前已收字节全部丢弃、重试从 0 重传。
现在**传输中断类失败**（空闲超时 / 节点掉线 / 不可达 / 调用方 abort）把半成品
晋升为稳定命名的 `.dsh-remote-agent-resume-<key>.part` + meta 旁车（全文期望
sha256、已收前缀 sha256、字节数）；下次 pull 同一文件时校验通过就从中段续传
（pull 帧带 `startOffset`，副机从该偏移起流），**内容级失败**（hash 不符 / 乱序 /
写失败 / 超限 / 显式取消 / hub 关闭）仍整体重来。续传前缀经双重防护：meta 里的
前缀 sha 与磁盘字节重算比对（篡改/部分写/截短一律弃用从头），全文 sha 在收尾
三重校验（与既有契约一致）。崩溃残留（磁盘比 meta 长）信 meta 前缀并截断。
`partialTtlMs` 默认保留 7 天，0 = 禁用续传。协议帧结构零改动（chunk/done 帧与
既有字段全同，`startOffset` 是 pull 载荷的可选字段），新旧混跑行为不变；同一
(dest, relPath) 并发 pull 被明确拒绝。

### 功能：副机资源遥测（CPU/内存/负载 上报到 hub）

副机每 30s 采一次本机资源，经 `node/resource` 帧上报（`resourceIntervalMs` 可调，0 = 关）。CPU 用两次采样增量算利用率（`os.cpus()` 累计值直接读出来是开机平均，没有参考价值），首次采样无基线 → cpuPct 为 null。hub 侧存进节点记录，`remote_nodes` 与面板节点行透出；离线节点保留最后一份遥测（带 at 时间戳，消费方自行判断新鲜度）。

尽力而为的遥测：字段缺失/类型不对就落 null，畸形帧不影响节点记录与任务链路。

### 修复：task/sync 自动清理分支 ReferenceError（eslint no-undef 首功）

`applySync` 的自动清理分支用了 `lib/hub/index.js` 的私有 `numOr`，而
`node-registry.js` 是 hub 目录的依赖叶子（index → registry 单向依赖），
本文件并未定义它 —— 分支一走到就 `ReferenceError`，task/sync 全量重建
视图随之中断。此前测试只做文本断言，从没真正执行过这条路径；修复后补
行为级回归（retainMs=1ms 触发清理 + 刚结束任务保留的保留期对照）。

### 工程：eslint 严格档进 CI

新增 `eslint.config.js`（flat config）与 `npm run lint`；devDependencies
引入 eslint 10 —— **运行时仍零依赖**（devDeps 不进 git 安装，`npm run check`
保持「不装依赖也能跑」，CI 里 lint 是独立 job）。规则集 = 推荐集 + 一批
高信号一致性规则（eqeqeq / no-var / prefer-const / no-shadow /
require-atomic-updates 等），首跑清零 256 处存量违规。测试侧放宽两处
框架惯例：node:test 上下文参数 `t`、docblock 零宽空格转义。

### 性能：task-store 热路径异步化（状态同步 + 日志/进度批量写回）

`appendLog` / `appendProgress` 此前每行都全量重写整个任务记录文件
（含最多 500 行 × 200k 字符的日志尾巴，单文件可达 2MB），同步 fs
直接阻塞副机事件循环。改为：

- 状态转移 / 创建 / 关闭前 → **同步落盘**（耐久性语义：终态记录若只躺在
  批量窗口里，崩溃后 reconcile 会把未落盘的 completed 判成 interrupted
  重跑 —— 任务执行两次）；
- 日志 / 进度 → 200ms 合并窗口批量写回，窗口内 N 次更新只写一次盘；
  写失败留脏重试，不抛；
- teardown 在所有写人组件停止后接入 `store.close()` 强制落盘。

行为对使用者不可见（任务状态机、manifest、reconcile 语义不变），
9 条语义测试锁定（批量窗口 / 崩溃模拟 / 留脏重试等）。

### 文档：relay 跨 NAT 降级链 + VPS 部署模板

- **profiles/README.md 新增「怎么选路径：降级链」**：三条接入路径组织成
  条件式降级链（direct → 中继 VPS / cloudflared → 链路全断时副机本地
  续跑 + 重连 task/sync 对账），附「该降级了的判据」现象表与切换成本
  （副机侧只改三个字段）。
- **新增 `deploy/relay-vps/` 部署模板**（已进 `package.json` 的 `files`）：
  systemd unit（含加固段）、凭证 env 模板、Caddyfile 与 nginx 两套
  TLS 前置模板（公网中继从"明文 ws:// 裸奔"变成可抄的 `wss://` 方案），
  外加一份五分钟 runbook。
- **SECURITY.md 修正与补强**：传输加密表的「公网中继」行指向部署模板；
  威胁模型补两条事实 —— 协议无端到端加密（中继可见明文业务帧，选
  VPS 提供商等同于交出链路）、中继挂≠任务挂（可用性边界非安全边界）；
  修正一处文档失真（一次性 token 实际只存在中继进程内存，不落盘）。
- doc-drift 新增 7 条断言（84 → 91），变异负向控制 3/3 全抓。

### 决策：派发自动化维持「桌面会话」边界（评估记录，无代码改动）

`docs/dispatch-automation-eval.md`：hub 的 webserver 整台被 DSH 会话围栏
保护（实测除 `/healthz` 外一律 401），脚本无法代替桌面派发任务。
三个结论：**边界设计使然**（现在）；**短时令牌方案预设计未实施**
（桌面铸造 15 分钟单次令牌、只放行 dispatch/cancel、绝不开 pair-info，
与 relay 一次性 enroll token 同构）；**静态 bearer token 明确拒绝**
（公网面上的无过期便携 secret，与全仓"缩短暴露窗口"的凭证口径相冲）。
复审触发条件已写入文档。KNOWN-ISSUES §8 第 3 条补链接；doc-drift
新增 2 条断言（91 → 93）。

### 安全：hub 身份认证 —— 副机也会验主机，假 hub / 假中继冒充被当场拒绝（P2-11）

协议此前只有单向认证：副机拿 token 向 hub 证明自己，但 hub 从不向副机证明
"我就是那个 hub"—— 假 hub 回一帧 welcome 副机就上线，假中继更可以直接
冒充 hub 下发 `mode: exec`（副机任意代码执行）任务。本次补上反向认证：

- **hub 持久身份**：首次启动生成 ed25519 密钥对，落盘
  `<stateDir>/hub-identity.json`（0600，损坏就地重建 —— 已钉住旧指纹的副机
  会大声失败，fail-closed）。direct 模式身份证明进 `welcome` 帧，relay 模式
  节点上线后追发 `hub/identity` 帧（封堵"hub 握手期静默"的冒充窗口）。
- **副机钉住**：配置 `pinnedHubFingerprint` 显式钉住；未配置则首连自动钉住
  （TOFU，`<stateDir>/hub-pin.json`）。验证链五环：指纹自洽 → 匹配 pin →
  验签 → nonce 回显（防重放）→ ±5 分钟时间窗；任一不过 = 拒绝上线 +
  **停止重连** + 大声报错（pin 保留，人工确认后才重钉）。
- **relay 宽限窗口**：上线后 15 秒内等 hub 身份帧；有 pin 超时 = 拒绝
  （疑遭剥帧），无 pin 超时 = 旧版兼容继续；窗口内到达的任务一律回
  `hub-identity-pending`，不会被拿去执行。
- **零终端分发**：配对码新增 `hubFingerprint` 字段，向导出码自动携带 ——
  副机粘码即完成"连接配置 + 指纹钉住"。
- 向导 / README / profiles/README / SECURITY.md 同步；doc-drift 新增 6 条
  断言（93 → 99）+ 自检复制清单补 `lib/identity.js` + 2 条变异负向用例；
  全量 613 tests 612 pass（含 hub 身份原语黄金向量 6 组负向控制）。

---

## [0.2.0] — 2026-10-15

「小白也能用」版本：从"能跑"到"零终端也能装"。新增配对码、配置向导
（写盘 / doctor / 双击入口）、Web 面板 GUI 化、模型选择、真实运行时
自检工具。**无破坏性变更**（`pair` 纯新增字段，协议版本不变）。

### 新增：向导写盘 + Windows 双击入口 —— 零终端部署闭环

- **向导写盘**（`lib/setup.js`）：自动探测 `~/.dsh/profiles/<profile>/cordis.patch.yml`
  （`cordis.yml` 是空壳，实测确认），备份 → 托管块合并 → 校验，失败自动回滚。
  托管块幂等（跑两次零变化）；检测到**手写** remote-agent 条目默认拒绝并点名
  `--force`（同 id 重复 = 插件挂载两次 = 启动失败）。交互式回车即写，
  非交互 `--write / --force / --profile`。
- **双击入口**（`bin/双击运行-配置向导.cmd`）：零终端第一道墙。
  内容 ASCII（cmd 按 OEM 码页解析批处理）、CRLF 行尾，字节级断言钉住
  （doc-drift 48）；参数透传 `%*`，快捷方式可带参。`.gitattributes` 钉 CRLF。
- **零终端路线图**（README）：双击 → 回车 → 面板「副机接入」复制配对码 →
  副机向导粘贴自动写盘 → 重启，全程不碰 YAML 不开终端手敲命令。
- 测试：write-config 15 条；全量 501+；doc-drift 79/79。

### 新增：Web 面板 GUI 化 —— 副机接入按钮 + 派单模型输入

零终端小白的图形入口（面板是 hub 侧唯一 GUI）：

- **「副机接入」卡片**（`lib/client.js`）：一键生成配对码并复制 `pair:`
  配置行 + 复制防火墙放行命令 —— 主机侧全程鼠标，免终端免向导。
  端口不用配置：面板本身就由 hub 的 webserver 服务，浏览器地址栏端口
  即节点拨入端口。
- **token 披露边界**（`GET /api/remote-agent/ui/pair-info`）：含 token 的
  完整配对码**只对本机回环请求**生成 —— 面板可能被 lanBind 暴露到局域网，
  局域网内能打开面板 ≠ 应该拿到主机凭证。非回环得到不含 token 的码 +
  一条人话提示。与 /config 的"凭证只回 set 布尔"同一精神。
- **dispatch 表单加「模型」输入**（可选）：留空用副机默认；填
  `deepseek-reasoner` 或 `provider/model` 均可，原始字符串交服务端
  normalizeModelSelection 归一 —— 与 remote_task 工具同一通道。
- 测试：ui-routes 3 条（形状/回环全码/非回环拒绝，非回环用伪造
  remoteAddress 直打 handler）；doc-drift 断言 45~47 钉住
  "loopback 策略不被放宽 / 面板入口真实存在 / model 真进请求体"。

### 新增：配对码（pair）—— 副机配置从三行抄写变成一行粘贴

副机部署最容易抄错的就是 `hubUrl` / `token` 两行（少半个斜杠、token 带尾部
空白，表现都是"副机永远不上线"且无报错）。配对码把连接信息压成一行
`dshra1://` + base64url(JSON)：

- **`lib/pairing.js`**（零依赖纯函数）：`encodePairCode` / `decodePairCode` /
  `expandPairConfig`。解析对终端复制形态全容错（换行/引号/空白），所有
  坏输入返回结构化中文错误**永不抛** —— worker 启动路径 pair 无效只降级
  记警告，副机 dsh 照常起来。
- **两条安全语义**：①配对码内含 token，等同凭证（文档明确传阅规矩）；
  ②`roots` 不进配对码 —— 副机的安全边界永远由副机配置声明，主机侧的串
  决定不了它。
- **显式配置优先**：`pair` 与 `hubUrl` 同时存在时 `hubUrl` 生效，方便临时
  换地址调试；展开成功后 `pair` 键从配置对象里删除（token 不存两份）。
- **三处接线**：worker `startWorker` 首行展开 pair；doctor 静态检查基于
  展开后的配置（坏 pair 单独一条 ✗ 带修法）；向导 hub 路径输出配对码、
  worker 路径可整行粘贴自动填充、非交互 `--role worker --pair dshra1://…`
  直接出配置、`--role hub --hub-ip …` 顺手生成配对码。
- 17 条回归（往返矩阵 / 容错矩阵 / 展开优先级 / doctor 与 YAML 接线 /
  applyWorker 降级路径）；doc-drift 断言 42~44 钉住"README 有入口、worker
  真的展开、向导真的生成"三件事。

### 新增：小白向导 + remote_task 支持指定副机模型

#### `bin/dsh-remote-setup.js` —— 配置向导（小白也能配好）

部署这个插件要写 YAML、算 IP、生成 token、记住 `inject: []` 的坑 ——
每一件都对小白不友好。向导把全过程收敛成三次回车：

- **交互式**（无参数运行）：问"主机还是副机"→ 自动枚举本机局域网 IP →
  自动生成 `nt_` 强随机 token → roots 输入时自动创建缺失目录 →
  输出两台机器可直接粘贴的 cordis YAML。**副机片段的 `inject: []`
  由生成器替用户填好**（部署失败头号坑：不填它该行永远 PENDING 且无报错）。
  主机路径还会打印防火墙放行命令；副机路径会先 TCP 探活主机端口。
- **非交互**：`--role hub|worker --hub-url --token --node-id --roots a,b --out 文件`
- **`--doctor <配置.yml>`**：逐项体检（Node 版本 / hubUrl 合法性 / token 与
  公网暴露 / roots 存在性 / nodeId 形状 / 端口可达性），每条 ✗ 都带
  "怎么修"。

纯逻辑在 `lib/setup.js`（14 条测试）；`lib/node/index.js` 的连接错误提示
改走同一份 `friendlyConnectError` 映射 —— 副机日志里的 `ECONNREFUSED`
现在旁边多一行"端口没人听 —— 检查 ①DSH 在跑 ②IP/端口 ③防火墙"。

#### `remote_task` 新增 `model` 参数 —— 主机可指定副机用的模型

    remote_task { goal, model: { model: "deepseek-reasoner" } }
    remote_task { goal, model: { provider: "openai", model: "gpt-4o" } }

- **只传选择，不传凭证**（核心不变式 1）：协议里流动的是 provider/model 名，
  模型 key 始终在副机。指定的模型在副机不存在时任务会以明确错误失败
  （错误经 367daef 修复后的 agent/error 监听进入 handoff）。
- **in-process 后端**：`buildAgentOptions(defaultSel, requested)` 合成
  "副机默认 × 主机指定"，主机字段优先、缺的借默认补齐（只给模型名时
  provider 借副机默认）。
- **headless 后端明确拒绝**（`modelUnsupported`）：`dsh headless` 把模型
  硬编码为副机默认选择、无 CLI flag（对照 app.asar 内 dsh-headless 源码
  核实）—— 静默忽略会让"以为指定了模型、实际跑的是默认"，排查方向
  直接跑偏，所以如实失败。
- **TaskStore.create 的字段白名单补 `model`**：此前 spec 里的 model 会在
  落盘时被丢掉 —— agent 任务重启后 reconcile 重跑时模型选择必须跟任务走。
- 三条入口接通：remote_task 工具、Web 面板 dispatch（body.model）、
  README 工具表与 systemPrompt 同步。subagent provider 不接（框架
  `capabilities.agentOptions=false`，请求里没有自然载体）。

### 修复：健壮性两处（评审遗留）

- **transport 握手超时**：upgrade 后 welcome/accepted 不来必须在 10s 内
  毁连接走重连 —— 此前"TCP 连着但永远上不了线"的哑状态没有任何报错。
  （带陈旧连接守卫与三处定时器清理；mock timers 行为级回归。）
- **pull-manager**：① 分块帧缺 offset 按畸形帧失败（hash-mismatch），
  不再静默跳过校验继续写盘；② 空闲超时重臂用**本条 pull 自己的**
  timeoutMs —— 此前第一个分块后回退到 limits 值，自定义短超时静默失效。

### 文档

- README 新增「五分钟上手」；状态行更正（agent 后端两根因已修、待实机确认）。
- KNOWN-ISSUES §1 标注已修（`kind: 'plugin'` → `cordis-host-runner`），
  保留推理记录 —— 它预言的残余风险后来真的发生了。
- check-doc-drift 65 → 71 条（新增向导承诺断言：README 入口 / bin 声明 /
  生成器填 inject / doctor 带修法 / 错误人话翻译 / model 参数）。

### 新增（同轮，之前提交）

- **transport 握手超时**、**pull-manager offset 必填与重臂预算**
  （commit 0d3f56b，9 条 mock-timers 行为回归）。
- **remote_task 的 model 参数端到端**（commit 9dc0f23，15 条分层回归）。

### 修复（第二轮：独立评审 + 中优先级）

一次外部独立评审（2026-10-15）报出 3 个高优先级 + 若干中优先级问题。
三条高危**逐条核实后确认属实**，已修；中优先级按用户选择修了 5 组。

#### 高 · headless 后端任务书进 shell = 命令注入（`lib/node/runner.js`）

`spawn(dshBin, args, { shell: this.platform === WINDOWS })` 且 `goal` 直接进
argv。Windows 下 `shell:true` 走 `cmd.exe /c` 且**不做转义**，而 `goal` 是
多行 Markdown 任务书、内容来自远端（不可信）。任务书里的 `&`、`|`、引号或
换行会截断/拆开命令行 —— 轻则调用损坏，重则执行夹带的第二条命令。

**修法（两层）**：① `shell: false`（`dshBin` 已是绝对路径，不需要 shell）；
② `goal` 从 **stdin** 传（`headless --json -`，`-` = 读 stdin，已用
`dsh headless --help` 核实），即使将来有人把 `shell:true` 加回来也不在命令行上。

> **核实修正**：评审把它与"agent 假完成"关联，但实测副机走的是
> `runner: in-process`，那个 bug 的真因是 `PLUGIN_SOURCE` 类型非法
> （见下面 0.1.0 的"agent 模式假完成"）。所以这是**独立的真缺陷**。

#### 高 · WebSocket 分片重组无总量上限（`lib/ws.js`）

单帧有 8 MiB 上限，但 `fragBytes` **只累加不检查**，而 RFC 6455 允许拆任意多片。
一条连接连发 N 个 4 MiB 分片即可在 `Buffer.concat` 之前撑爆内存。直连端点在
`nodeToken` 留空时无鉴权，所以是"一条连接打爆 hub 内存"的路径。

**修法**：累加后、concat 前加总量守卫（上限 = 单帧上限 × 4 = 32 MiB），
超限 `fail('fragment-too-large')`。

#### 高 · 中继背压只覆盖 node 方向（`lib/relay.js`）

`forwardToNode` / `forwardBinaryToNode` 有背压，而 `broadcastHubs` /
`broadcastHubsBinary` 直接 `h.send()`。一个不读 socket 的 hub 连接会让中继
写缓冲无限增长 —— 正是本文件自己注释里的 OOM 场景，换了个方向。

**修法**：新增 `applyHubBackpressure(h)`（同策略：超限即断连 + 计 stats + 记日志），
两个广播函数都接上；遍历改用快照 `[...hubs]`。

#### 中 · relay token 走 URL query → 进各级日志

`transport.js` 与 `node-registry.js` 都把 token 塞进 URL query，而 URL 会进
中继 access log、反向代理日志、CDN 日志。中继侧本来就 header 优先
（`searchParams.get('token') ?? headers['x-relay-token']`），`ws.js` 的 `connect()`
也支持自定义 header —— 所以客户端改成走 header 即可，服务端不用动。

**修法**：direct 用 `x-dsh-token`（原有）、relay 用 `x-relay-token`（新增），
两者都不再进 URL。顺带修正了两种模式此前的不对称。

#### 中 · 临时诊断无限增长 + 泄漏任务信息（`lib/node/runner.js`）

定位 agent 问题的诊断写死 `<temp>/dsh-remote-agent-runner.log` 且无上限，
记录里含 taskId、goal 长度、cwd、错误正文。

**修法**：改为 **opt-in**（`DSH_REMOTE_AGENT_TRACE=1`）+ **有上限**
（超 2 MiB 轮转）。注意 `agent/error` 的上报（`liveText.push` + `onEvent`）
是**功能性**的、不受开关影响 —— 它把错误带进 handoff 摘要。

#### 中 · pull-manager 忽略 writeSync 返回值

`fs.writeSync` 可能部分写。虽然最终 sha256 校验会兜住（不会把坏文件当成品），
但代价是**白传一整份产物**才失败。改为循环写直到写完，异常即明确失败。

#### 中 · 中继死连接治理

两个洞：① `HELLO_NODE` **无 `boundId` 守卫** —— 同一连接二次 hello 换 nodeId
会留下永不清除的幽灵条目，反复 hello 可在单连接上堆任意多条目、占满 `maxNodes`
配额；② **无心跳/空闲淘汰** —— NAT 静默死亡（家庭路由 5–30 分钟、断电、
中间设备丢连接）不会触发 `close`，死条目永久占配额，中继缓慢"饱和而死"。

**修法**：① 一条连接只能 hello 一次（`already-helloed`）；② 新增
`sweepIdleConnections()`：空闲 3 分钟发 WS ping 探测（`ws.js` 会自动回 pong），
再一个周期无响应才判定死亡并清理 —— 用 ping 而不是直接按"多久没帧"断，
否则会误杀任务间隙的正常空闲节点。定时器 `unref()`，`close()` 里清理。

#### 中 · `TaskStore.prune()` 从未被调用

定义了但无调用方 → 终态任务记录的**内存缓存与磁盘文件无限累积**
（每条最多含 200KB 日志尾巴）。改为副机启动时清一次（保留期 7 天），
失败只记 warning、不挡启动。

### 待办

- POSIX 分支仍未真机验证（只有 CI 覆盖）。
- Windows 8.3 短名绕过向量未验证（见 KNOWN-ISSUES §7.1）。
- `node-registry.js` 1275 行集多职责于一身，建议把 `RelayLink` 拆出去。
- `task-store` 热路径同步 I/O（每条日志/进度都全量重写记录）。

---

## [0.1.0] — 2026-10-15

首个可用版本。主机侧（hub）端到端可用；副机侧 `exec` 后端可用。

### 新增

- **7 个工具**：`remote_nodes` / `remote_task` / `remote_status` /
  `remote_handoff` / `remote_manifest` / `remote_pull` / `remote_cancel`。
- **Web 面板**（侧栏「远程同事」）：节点列表、派发任务、任务状态、
  结果摘要、工作区变更、成品清单、日志尾巴；主机设置只读展示。
- **两种传输**：`direct`（副机主动连主机，需主机地址可达）与
  `relay`（经中继 VPS 会合，双方都在 NAT 后时用）。
- **两种执行后端**：`in-process`（副机在自己的 DSH 进程里起独立 agent 会话）
  与 `headless`（spawn 独立 `dsh headless` 进程，回退用）。
- **产物按需回流**：任务结束只回 `manifest` + `handoff`；只有 `role:final`
  的成品可以 `remote_pull` 拉取，`intermediate`（日志/缓存/中间构建文件）
  只上报元数据、留在副机。
- **`subagent` provider**：主机侧的 agent 可以把任务委派给远程节点。
- 中继服务（`bin/dsh-remote-relay.js`）+ 初始化脚本（systemd / 计划任务）。

### 设计不变式

| 不变式 | 含义 |
|---|---|
| **凭证不离开副机** | 协议里不带模型 key；副机用自己的模型配置 |
| **断连不终止任务** | 任务在副机本地持久运行，中继挂了也跑完，重连后自动对账 |
| **清单先于字节** | 任务结束只回 manifest + handoff；成品要显式 `remote_pull` |
| **只有 `role:final` 过河** | 中间产物只在副机留存 |

### 修复（开发期，均已验证）

这一节记录的是**在 0.1.0 发布前**踩到并修掉的问题。保留它们是因为每一条
都对应一个容易复发的陷阱，改动相关代码前值得先读。

#### 工具返回值出边界：两条独立的失败路径

**症状**：工具调用报 `returned invalid output`，但**副作用已经发生**
（任务已派出、文件已拉回）。这是最坏的一类失败 —— 调用方既拿不到结果，
也无法判断副作用是否发生，可能重派导致重复执行。

**路径 1 · `value is not lossless JSON`**

DSH 用 `walkJsonValue(value, true)` 检查工具返回值，返回 `undefined` 即判失败。
拒绝条件：

- `typeof value !== 'object'` 且非 null/boolean/string/number
  → **undefined / 函数 / Symbol**
- 数字 `!Number.isFinite(v) || Object.is(v, -0)` → **NaN / Infinity / -0**
- 原型不是 `Object.prototype` 也不是 `null` → **类实例**
- 循环引用
- 数组原型不对，或数组上挂了额外属性

我们踩到的是**类实例**：副机回传的 `accepted` 对象带类原型。

**路径 2 · `"value.x" must be a Y`**

DSH 还会跑 `validateJsonSchemaValue(outputSchema, value)`。`null` 是合法 JSON，
但对声明为 `{ type: 'number' }` / `{ type: 'object' }` 的字段，null **不是**该类型。

触发场景很常见：查一个**刚创建、还没开始执行**的任务
（`startedAt` / `endedAt` / `durationMs` 都还没有）。

**修法**：在**唯一的工具注册入口**（`reg()`）统一收口，而不是逐个工具改 ——
7 个工具返回值形态各异，逐个改容易漏；而 DSH 的拒绝条件对所有工具一样。

```js
const reg = (definition) => {
  const original = definition?.execute
  const schema = definition?.output?.schema
  definition = { ...definition, async execute(...args) {
    const value = await original.apply(this, args)
    return toPlainJson(dropNullForSchema(value, schema))   // 顺序不能反
  }}
  disposers.push(ctx.tools.register(definition))
}
```

- `dropNullForSchema` 读 schema，删掉「值为 null 但 schema 声明非 null 类型」的
  **可选字段**。不动 `required` 字段（删了会从"类型错"变成"缺字段错"，同样失败）。
- `toPlainJson` 净化成纯 JSON（类实例 → 普通对象、undefined → 丢弃、
  NaN/Infinity/-0 → 0、循环引用截断）。
- **顺序**：`dropNullForSchema` 必须在前 —— 它把 null 转成"缺失"，
  而 `toPlainJson` 会丢弃 undefined。

源头同时修了 `views.js`：时间字段用 `0` 兜底、`manifestCounts` 用 `{}`。
新增 `test/tool-output-plain.test.js`（19 条）锁住这两层。

#### UI 路由注册后 8–13ms 被 unload，面板 404

**症状**：面板一直显示 `读取失败: HTTP 404`，而 Host 侧路由实测 401
（路由不在 exact 表）。**启动日志里什么都没有**，排查代价极大。

三个叠加的原因：

1. **`registered` 闩锁**（真正的杀手）：`withServices` 里有一个
   `let registered = false; if (registered) return`。fiber 被 unload 后重新 load
   时，闩锁拦住了重新注册 → **路由被删且永不回来**。
2. **运行时 `ctx.inject` / `ctx.plugin` 都不可靠**：
   - `ctx.inject(deps, cb)` 返回 **thenable fiber**，文档要求 `await` 才算
     "加载完成"；而插件的 `apply` 是**同步**的 → 父 fiber 同步返回后框架
     清理尚未 settle 的子 fiber。
   - `ctx.plugin({inject, apply})` 更糟：子插件的 `apply` **根本没被调用**。
3. **`tools.js` 的 17 处 `type: ['x', 'null']`**：DSH 的 JSON Schema 校验
   **不接受 type 数组**（`type must be a single type string`）→
   `registerRemoteTools` 抛 `JsonSchemaError`。此前被 `ctx.effect` 的容错吞掉，
   改成直接注册后才暴露。

**修法**：

- 去掉闩锁。
- **inject 声明在 loader 行上**（`cordis.patch.yml` 的 `inject: [...]`）——
  框架会推迟本行激活直到服务就绪，只 apply 一次、无子 fiber 抖动。
  这是唯一被验证可用的形态。
- `applyHub` 内部**不用 `ctx.effect`**，改「立即注册 + 收集 disposer」
  （`__reg`），不依赖 fiber 生命周期。
- 17 处 `type: ['x','null']` → `type: 'x'`。
- `ctx.subagents` 改 `ctx.get('subagents')` —— cordis 对未声明 inject 的服务
  **属性访问会抛错**，不是返回 undefined。

**副作用（部署必读）**：副机 profile **必须**覆盖 `inject: []` ——
副机没有 `webServer`/`tools`/`systemPrompt`，不清空的话该行永远停在
PENDING、永不激活。见 `profiles/worker.cordis.yml`。

#### 其他

- `resolvePowerShell` 采用 0 字节的 `WindowsApps\pwsh.exe` → spawn 抛
  `EFTYPE`。加 `isUsableExecutable()`（存在 + 非零字节）。
- relay 错误帧全被丢弃：`RELAY_FRAME.ERROR` 未定义 → 加 `ERROR: 'error'`。
- relay 二进制下行用 `conn.send(text)` → UTF-8 有损；改 `sendBinary`。
- `new URL(req.url)` 未 try/catch → 畸形请求会杀掉进程；加 `safeParseUrl`。
- 任务取消映射到 `failed` 而非 `aborted`；失败路径漏了 `error`。
- `RelayLink.start()` 非幂等 → 孤儿连接泄漏；加 re-entry gate +
  stale-connection 守卫（29 条行为测试）。
- `artifactRules` 内层形状未校验（`{final:"dist/**"}` 字符串会按字符展开规则）
  → `normalizeArtifactRules`。
- `lib/index.js` 的 `export default apply` 让 loader 的 `unwrapExports`
  把命名空间折叠成函数 → `Config` 不可见、配置表单不显示。移除默认导出。

#### agent 模式假完成：消息 source 类型非法（DSH 静默拒绝）

**症状**：副机上 `mode: agent` 的任务在 ~20–40ms 内被标成 completed，
`liveText` 为空、`fromLogParts: 0`、产物 0 —— **且没有任何错误信息**。
`mode: exec` 完全正常。

**根因**：`PLUGIN_SOURCE` 用了 DSH **不认识**的 source 类型：

```js
const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'dsh-remote-agent' })
```

DSH 的 `MessageSourceMap` 是一张**封闭的联合类型表**，17 种合法 kind
（`user` / `model` / `tool` / `system-prompt` / `model-selection` /
`user-approval` / `ptc-mode` / `tool-registry` / `user-rpc` / `agent-message` /
`subagent-settled` / `skill-invocation` / **`cordis-host-runner`** / `goal` /
`schedule` / `compact-checkpoint` / `session-reference` / `user-question-reply`）。

**里面没有 `plugin`。** 传非法 kind 时 `followup` 表面成功（消息进 inbox、
驱动被唤醒），但 turn 一启动就抛错 —— 而 DSH 的 `kick()` 是：

```js
async kick() {
  try { while (await this.turn()) }
  catch (_error) {}                      // <-- 静默吞掉
  finally { if (this.phase.kind === 'running') this.setPhase({ kind: 'idle', ... }) }
}
```

错误被吞、phase 转 idle → `whenIdle()` 立即返回 → 任务标 completed、产物 0。

**修法**：① 改用 `{ kind: 'cordis-host-runner' }`（DSH 为"cordis 宿主里的
runner 主动驱动 agent"准备的 kind）；② **加 `agent/error` 监听** —— 因为
`kick()` 吞错，这条事件是**唯一的错误出口**，漏了它任何 turn 内部错误都
完全不可见；③ 错误对象做深度序列化（第一版只取 `err?.message`，记到的是
`[object Object]`）。

**这条是怎么找到的**：加 7 个流程探针定位到"whenIdle 20ms 返回、零输出"，
然后用 **`cordis_inspect_query`**（`Service.listService` 查 `sessions` /
`agentLoop`）拿到 DSH 的**权威类型定义**，对比发现 `plugin` 不在表里。

**教训**：往 DSH 的封闭联合类型里塞自造值**不会立刻报错**，而是在某个被
`catch {}` 包住的深层位置静默失效。改这类常量前应先用 `cordis_inspect_query`
拿权威定义，而不是靠猜。

#### 工具返回值出边界：两条独立的失败路径

**症状**：工具调用报 `returned invalid output`，但**副作用已经发生**
（任务已派出、文件已拉回）。这是最坏的一类失败 —— 调用方既拿不到结果，
也无法判断副作用是否发生，可能重派导致重复执行。

**路径 1 · `value is not lossless JSON`**

DSH 用 `walkJsonValue(value, true)` 检查返回值，返回 `undefined` 即判失败。
拒绝：类实例（原型不是 `Object.prototype`）、`undefined`、`NaN`/`Infinity`/`-0`、
循环引用、数组带额外属性。我们踩到的是**类实例**（副机回传的 `accepted` 带类原型）。

**路径 2 · `"value.x" must be a Y`**

DSH 还会跑 `validateJsonSchemaValue(outputSchema, value)`。`null` 是合法 JSON，
但对声明为 number/object 的字段不是该类型。触发场景很常见：查一个**刚创建、
还没开始执行**的任务（`startedAt`/`endedAt`/`durationMs` 都还没有）。

**修法**：在**唯一的工具注册入口**（`reg()`）统一收口 ——
`toPlainJson(dropNullForSchema(value, schema))`。7 个工具返回值形态各异，
逐个改容易漏；而 DSH 的拒绝条件对所有工具一样。顺序不能反
（`dropNullForSchema` 把 null 转成"缺失"，`toPlainJson` 会丢弃 undefined）。
源头同时修了 `views.js`（时间字段用 0 兜底、`manifestCounts` 用 `{}`）。

**测试**：`test/tool-output-plain.test.js`（19 条）。它还**抓到了实现里的一个
bug**：第一版 `toPlainJson` 把 `null` 也当 `undefined` 吞掉了（会让值为 null
的字段静默消失）。

### 已知问题

见 **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)**。要点：

- **副机 agent 后端的"假完成"已修**（`PLUGIN_SOURCE` 类型非法，见上）。
  修复版已在副机实测验证；但**"修复后 agent 能否真正产出"尚未端到端确认** ——
  待下一次实机验证。
- **headless 后端修复后尚未实机验证**（它需要副机没有 `agentLoop` 服务才会走到）。
  本次只做了静态断言 + 判别力验证，`dsh headless -`（stdin）路径未经真机跑通。
- Windows 8.3 短名绕过向量未验证。
- `lib/hub/index.js` 一处已知冗余（`ctx.effect` 的 `once()` 包装）。
- 平台分支的实测覆盖不均：Windows 全量验证，POSIX 分支只跑过 CI。

---

## 版本号约定

- **0.x**：`lib/**` 是加载产物，任何变更都可能是行为变更。升级前读本文件。
- 破坏性变更（配置字段重命名/移除、协议版本号变化）→ 升 minor 并在
  本文件顶部用 `### 破坏性变更` 标注。
- 协议版本号在 `lib/protocol.js` 的 `PROTOCOL_VERSION`。**主副机版本不一致时
  以协议版本号为准**，不要求包版本一致。
