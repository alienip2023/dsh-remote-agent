# 派发自动化评估：预授权令牌 vs 文档明示边界

**状态**：评估结论（2026-10-15），未实施任何代码改动。
**触发**：生态评估报告 P1-7 —— "当前派发受 DSH 会话围栏限制需人肉，
评估提供预授权令牌机制或文档明示该边界为设计使然"。

---

## 0. 结论（先行）

| 方案 | 决定 | 一句话理由 |
|---|---|---|
| **B. 文档明示边界** | **现在做** | 围栏是 pinned 的安全属性（doc-drift 11/12/13），当前无实证的自动化需求；先把边界写清楚，让用户知道脚本该走哪条路 |
| **A2. 短时令牌（桌面端铸造、脚本兑换）** | **预设计，不实施** | 设计正确、与仓内一次性 enroll token 同构；等出现真实需求再作为 minor 落地，本文第 4 节给出完整设计草图 |
| **A1. 静态 automationToken** | **明确拒绝** | 在公网可暴露的 hub 上放一个无过期、可移植的 bearer secret，泄露面与 `sshpass -p` 同级；没有场景需要"永久有效" |

**给用户的答案（一句话）**：派发任务的脚本化入口今天**故意不存在**——
hub 的 webserver 整台被 DSH 会话围栏保护（实测除 `/healthz` 外一律 401），
这是安全设计生效的证据。需要自动化时，驱动 DSH 自身的会话
（`remote_task` 工具）是唯一受支持的路径；纯 HTTP 脚本无路可走是**设计使然，
不是缺陷**（KNOWN-ISSUES §8 第 3 条同结论）。

---

## 1. 问题定义

**派发自动化** = 不经人手、不看桌面面板，由脚本/CI/定时器向副机下达任务。
典型场景： nightly 构建后自动派测试任务、看板系统联动、批量数据整理。

**要评估的能力**：`POST /api/remote-agent/ui/dispatch` 对**非桌面会话**
调用方开放。注意这不是"读数据"——dispatch 是**下命令**：`mode: exec`
直接在副机跑 shell（SECURITY.md 明示"不限制副机能执行的命令"），
所以这道的后面是副机上的任意代码执行。

## 2. 现状事实链（全部可复现）

| # | 事实 | 证据 |
|---|---|---|
| 1 | UI 路由**刻意复用** DSH 框架围栏，不另造鉴权 | `lib/hub/ui-routes.js` makeGuard 注释：`requestRejection` 的官方用途就是 "apply ... to **another** Web route" |
| 2 | 围栏**失败关闭**：抛错 → 403，绝不放行 | 同文件 catch 分支；doc-drift 断言 12 锚定 |
| 3 | 无 connection 服务时退回 sameOriginOk：无 Origin 放行 / 跨站 403 | `lib/hub/ui-routes.js` sameOriginOk |
| 4 | **真实 DSH 运行时**：除 `/healthz` 外整台 401（桌面渲染器外） | KNOWN-ISSUES §8 第 3 条，DSH 0.2.0-rc.2 实测；`scripts/e2e-live-check.mjs` 文件头同记录 |
| 5 | 因此 e2e-live-check 的派发步骤只能人肉 | 同上线索 + KNOWN-ISSUES §8「这一步需要人的原因」 |
| 6 | 副机入网口（`/api/remote-agent/node`）对外开放，但 nodeToken 只让你**成为节点**（接收任务），不能派发 | `lib/hub/node-registry.js` attachDirect；profiles/README.md 路径二 |
| 7 | 今天唯一的脚本化派发路径 = 驱动 DSH 自身会话（remote_task 工具） | README 用法节；工具经 DSH agent loop，围栏内 |

**推论**：围栏挡住的不是"坏人"（那有 nodeToken/roots 管），而是
"非桌面会话的调用方"——包括脚本。而 hub 属主本来就能从桌面派任何任务，
所以围栏的真实语义是**「下令权绑定在桌面会话上」**，不是"下令权需要密码"。

## 3. 已存在的替代缓解（为什么现在不做也不堵）

1. **驱动 DSH 会话**：`remote_task` 是受支持的派发 API，自动化脚本可以
   操作 DSH 的会话/工具层（DSH 自身能力，不归本插件管）。
2. **relay 的一次性 enroll token 已是同构先例**：短 TTL、用过即焚、
   只存中继内存（`lib/relay.js` mintToken）——证明本仓有能力做好
   "预授权"这回事，缺的不是技术，是需求信号。
3. **面板 pair-info 的 loopback 披露边界**：连"生成配对码"都只敢在
   回环给全码（doc-drift 45）——插件对凭证披露的整体口径是收紧的，
   单独给派发开一个Bearer大门与这个口径相冲。

## 4. A2 设计草图（预设计，供未来 minor 直接施工）

> 原则：**铸造必须经过桌面会话，兑换只给派发族路由，窗口短，可审计。**

### 4.1 形态

```
桌面面板/会话 ──POST /ui/automation-token（会话围栏内）──► hub 内存
   返回 { token: 'dt_...', expiresInMs: 900000, maxUses: 1 }   （默认 15 分钟 / 单次）
脚本 ──POST /ui/dispatch  Header: x-dsh-remote-automation: dt_...──► 派发成功
```

### 4.2 约束（缺一不可，全部进 doc-drift）

| 约束 | 原因 |
|---|---|
| 铸造路由在会话围栏内（不豁免） | 铸造权 = 桌面在座；豁免它就等于 A1 |
| 兑换只放行 `dispatch` / `cancel` 两条 | **绝不放行** `pair-info`（披露凭证）、`pull`（写盘）、`config`（配置视图）、四个只读路由 |
| token 只存内存，不落盘；TTL 默认 15min；默认单次 | 与 relay oneTime token 同策略（`lib/relay.js:118`），进程重启即失效 |
| 比较用 timingSafeEqual，失败关闭 | 复用 relay.js safeEqual 模式；围栏抛错 → 403 |
| 每次兑换写审计日志（nodeId + goal 长度 + token 指纹） | 可观测；不记 goal 正文（可能含秘密） |
| `hub` 公网暴露时 SECURITY.md 明示：等同把下令权交出去 | 与 direct 模式 TLS 要求同一口径 |

### 4.3 施工清单（≈1–1.5 人日，含测试与文档）

1. `lib/hub/ui-routes.js`：automation-token 铸造路由 + guard 的 token 分支
   （scope 白名单硬编码，不读配置——**不给自己留"以后放宽"的开关**）；
2. `lib/client.js`：面板加「生成自动化令牌」按钮（与副机接入卡片同风格）；
3. 测试：铸造→兑换 happy path、过期拒、超用拒、错 token 401、
   pair-info 持 token 仍 401、guard 抛错失败关闭；
4. doc-drift：scope 白名单断言（pair-info 永不在内）+ 铸造路由在围栏内；
5. SECURITY.md 新增「自动化令牌」节；KNOWN-ISSUES §8 第 3 条补链接。

### 4.4 工作量评估

| 部分 | 量 |
|---|---|
| 路由 + guard + 内存 TTL 表 | ~120 行 |
| 面板按钮 | ~40 行（复用 pair-info 模式） |
| 测试 + doc-drift | ~150 行 |
| 文档（SECURITY/profiles/CHANGELOG） | ~80 行 |

真正的成本不是代码是**评审负担**：这是本插件第一次在会话围栏上开洞，
每一行都要按"开洞"标准审。

## 5. A1 为什么明确拒绝

`automationToken` 静态配置看起来只多一行 config，但它是：

1. **公网面上的便携静态 secret** —— direct 模式的 hub 本就在公网，
   bearer token 进 shell history / CI log / 代理访问日志的成本远比
   桌面会话 cookie 低（cookie 不落地、随会话消亡）；
2. **无过期、可无限次用** —— 泄露即永久交出下令权，而 dispatch 的
   后面是副机 shell；
3. **与仓内口径相冲** —— relay 的一次性 token、pair-info 的 loopback
   披露、icacls 0600，每个凭证决策都是"缩短暴露窗口"方向，A1 是唯一
   反方向的；
4. **没有场景需要永久有效** —— 定时任务用 A2 每次铸造即可（或接受
   "定时任务先调 DSH 会话"）。

## 6. 文档明示边界（B）的落点

已写入 / 待写入：

- 本文档（决策记录 + A2 预设计）；
- KNOWN-ISSUES §8 第 3 条：补链接到本文；
- README 安全节 / profiles/README 排障表：各加一行"脚本派发？
  设计使然，见 docs/dispatch-automation-eval.md"；
- 若未来实施 A2：CHANGELOG 记 minor，SECURITY.md 开节，本文档状态
  改为"已实施"并指向实现。

## 7. 风险与复审触发条件

出现以下任一信号时复审本结论（直接按 §4 施工 A2）：

- 有用户/Issues 明确要求脚本化派发（≥2 次独立请求）；
- 出现"定时任务 + 副机"的真实场景描述（而非设想）；
- DSH 自身提供了 headless 会话能力，使"驱动 DSH 会话"路径变轻
  （此时 B 的缓解 #1 更强，可能继续不做）。
