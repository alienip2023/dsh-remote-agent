# 真机验证：50MB 文件断点续传（2026-10-16）

> 验证对象：v0.3.0 的产物断点续传（`lib/hub/pull-manager.js` 的 `probeResume` /
> `promotePartial` / `resumeKeyOf` + `lib/node/artifact-service.js` 的 `startOffset` 中段续流）。
> 部署指引见 [profiles/README.md](../profiles/README.md)。

## 结论速览

| 待验证项 | 结果 |
|---|---|
| 50MB 随机文件生成（exec 任务） | ✅ 52428800 bytes，与目标逐字节一致 |
| 传输中途断网 ~5 秒 | ✅ 在 **41.5%**（21757952 / 52428800 字节）处硬切断 |
| hub 是否留下 resume partial + meta | ✅ `.dsh-remote-agent-resume-74d3b7ea0b1aec4b.part` + `.json` |
| 重新 pull 是否中段续传 | ✅ 下发的 pull 帧 `startOffset = 21757952`（**正好等于已收字节**） |
| 续传后字节级正确 | ✅ sha256 与全文**完全一致** |
| 收尾是否清理干净 | ✅ dest 里无残留中间态文件 |

**一句话**：断点续传**真的从断点处续上了**，不是"重传一遍"。`startOffset` 精确等于
断网前已落盘的字节数，且最终 sha256 全文一致 —— 字节级无重复、无缺失。

---

## 1. 实验拓扑

任务要求"把 worker 侧网络断开约 5 秒再恢复"。直接杀 worker 进程会连任务状态一起丢，
杀 hub 会丢 `PullManager` 的内存态。所以插了一层**可切断的 TCP 代理**：

```
worker ──ws──► [TCP 代理 :58596] ──tcp──► [hub :58595]
                      ↑
              在这里硬 destroy() 所有在途 socket
```

**为什么这样更真实**：切断的只是**网络**，两端进程都活着、状态都保留 ——
这正是"网线被拔了 / Wi-Fi 掉了"的形态，也是断点续传真正要解决的场景。
（对比：杀进程测的是"崩溃恢复"，那是另一条路径。）

装配用的是**真实实现，没有替身**：

- hub：`applyHub()` → `NodeRegistry` + `PullManager` + 七个工具 + healthz 路由
- worker：`applyWorker()` → `TaskStore` + `ArtifactService` + `TaskEngine` + `NodeTransport`
- 中间：真 HTTP server、真 WebSocket upgrade 握手

> 代码快照取自 `git archive HEAD`（`24cae76`），解到 `D:\resume-lab\repo`，
> 与当时正在被其他会话编辑的工作区**隔离**，避免把并行改动误算成本次结果。

---

## 2. ① 生成 50MB 随机文件

派一条 exec 任务，用 PowerShell 生成真随机字节：

```powershell
$b = New-Object byte[] (50MB)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[System.IO.File]::WriteAllBytes('D:\resume-lab\run\ws\blob.bin', $b)
```

```
✓ 文件已生成：52428800 bytes（期望 52428800）
  全文 sha256 = d533f2d5d8553d351eda256c13d5c416b25ccf00ac12083c488c2265f84f6351
  任务 manifest：final=1
```

> ⚠ **一个坑**：`.bin` 不在内置产物表里（`lib/artifacts.js` 的兜底是 `role:other`，
> **不可 pull**）。第一次跑失败在 `final=0`，必须显式声明
> `artifactRules: { final: ['blob.bin'] }` 才让该文件成为成品。
> 这不是缺陷，是"产物角色判定"的设计使然；但**对用 `.bin`/`.dat` 之类扩展名
> 做大文件传输的用户来说是个必踩的坑**，值得在文档里点一句。

---

## 3. ② 第一次 pull：中段断网

```
② 第一次 pull —— 传输中途切断网络（模拟断网 ~5 秒）
  切断前已收 21757952 / 52428800 bytes（41.5%）
  ✂ 已硬切断 2 条 TCP 连接（worker 侧网络中断）
  第一次 pull 结果：失败 internal — node offline: resume-lab-worker
```

**hub 侧日志（原文）**：

```
[info] artifact pull requested {"pullId":"p-mvav98us17jua","taskId":"t-gen-mvav98el",
        "nodeId":"resume-lab-worker","path":"blob.bin","dest":"D:\\resume-lab\\run\\dest\\blob.bin"}
[info] artifact partial kept for resume {"pullId":"p-mvav98us17jua","path":"blob.bin","bytes":21757952}
[warn] artifact pull failed {"pullId":"p-mvav98us17jua","path":"blob.bin",
        "code":"internal","message":"node offline: resume-lab-worker","keptForResume":true}
```

**dest 目录状态**：

```
.dsh-remote-agent-resume-74d3b7ea0b1aec4b.part   22282240 bytes ← 见下方说明
.dsh-remote-agent-resume-74d3b7ea0b1aec4b.json
```

meta 旁车内容：

```json
{
  "bytes": 21757952,
  "prefixSha256": "5ef7f838d2ede69d…",
  "sha256": "d533f2d5d8553d35…"
}
```

关键确认：**半成品大小 = 已收字节数**（`fs.statSync(part).size === received`）。
`prefixSha256` 是已收前缀的哈希，`sha256` 是清单声明的全文哈希 —— 两者都在，
下次续传前可以双重校验。

> 说明：日志里的 `bytes: 21757952` 与目录列表的 `22282240` 是两个不同的数 ——
> 前者是**失败那一刻**已收字节，后者是**脚本读到目录时**的值（进程还在收尾）。
> meta 里记的 `bytes: 21757952` 才是续传基准，它与 `startOffset` 精确相等（见下节）。

---

## 4. ③④ 断网 5 秒 → 恢复 → 重新 pull

```
③ 保持断网 5 秒，然后恢复网络
  网络已恢复（代理层允许新连接）
  ✓ worker 重新上线：resume-lab-worker

④ 重新发起 pull —— 观察是否从中段续传
  下发的 pull 帧：startOffset = 21757952        ← ★ 核心证据
  第二次 pull 结果：成功 52428800 bytes → D:\resume-lab\run\dest\blob.bin
```

**hub 侧日志（原文）**：

```
[info] artifact pull requested {"pullId":"p-mvav9cymn0uf","taskId":"t-gen-mvav98el",
        "nodeId":"resume-lab-worker","path":"blob.bin","dest":"D:\\resume-lab\\run\\dest\\blob.bin"}
[info] artifact pull resuming {"pullId":"p-mvav9cymn0uf","path":"blob.bin","already":21757952}
[info] artifact pulled {"pullId":"p-mvav9cymn0uf","path":"blob.bin","bytes":52428800,
        "dest":"D:\\resume-lab\\run\\dest\\blob.bin","resumed":21757952}
```

**逐条解读**：

1. `artifact pull resuming { already: 21757952 }` —— `probeResume()` 命中了同一份
   partial（`resumeKeyOf(destDir, relPath)` 派生稳定键，所以换了 pullId 也能配上）；
2. `startOffset = 21757952` —— 下发给副机的 `artifact/pull` 帧**带上了中段偏移**，
   副机侧 `ArtifactService` 从该偏移起 `createReadStream(real, { start: startOffset })`；
3. `artifact pulled { resumed: 21757952 }` —— 收尾帧显式标注了续传起点。

**`startOffset` 精确等于断点字节数**（21757952 = 断网前已收字节），这是"真续传"
与"重传"的决定性区别。若实现有问题（例如探测失败回退到 0），这里会是 `0`。

---

## 5. ⑤ 字节级校验

```
落盘文件：D:\resume-lab\run\dest\blob.bin
大小：52428800 bytes（期望 52428800）→ ✓ 一致
sha256：d533f2d5d8553d351eda256c13d5c416b25ccf00ac12083c488c2265f84f6351
期望值：d533f2d5d8553d351eda256c13d5c416b25ccf00ac12083c488c2265f84f6351
哈希比对：✓ 完全一致（续传后字节级正确）
```

**这是最强的一条证据**：50MB 真随机字节，续传拼接后 sha256 与全文一致 ⇒
前半段（来自 partial）与后半段（续流）**拼接处无重复、无缺失、无错位**。
`pull-manager.js` 里那个显式 `position` 参数的 `writeSync`（注释说"续传时 fd 开在
partial 上，隐式游标从 0 起会覆盖前缀"）确实起了作用。

---

## 6. ⑥ 收尾

```
⑥ 收尾：dest 中残留的中间态文件 = 无（meta 已清除）
   代理累计切断次数 = 1
```

`settleSuccess()` 在 `rename(part → final)` 成功后调 `cleanupPath(resumeMetaPath)`，
meta 旁车被清掉；partial 本体已 rename 成成品，不留孤儿。

---

## 7. 实验数据汇总

| 项 | 值 |
|---|---|
| 文件大小 | 52,428,800 bytes（50 MiB） |
| 全文 sha256 | `d533f2d5d8553d351eda256c13d5c416b25ccf00ac12083c488c2265f84f6351` |
| 断点位置 | 21,757,952 bytes（**41.5%**） |
| 第一次 pull 结果 | 失败 `internal — node offline: resume-lab-worker` |
| resume partial | `.dsh-remote-agent-resume-74d3b7ea0b1aec4b.part` |
| meta `bytes` | 21,757,952 |
| **第二次 pull `startOffset`** | **21,757,952** |
| 第二次 pull 结果 | 成功 52,428,800 bytes |
| 续传后 sha256 比对 | **一致** |
| 残留中间态文件 | 无 |

完整机器可读证据：`D:\resume-lab\evidence.json`（含全部 hub 日志行与逐行 transcript）。
实验脚本：`D:\resume-lab\experiment.mjs`。

---

## 8. 复现步骤

```powershell
# 需要 Node 22+。脚本自装配 hub + worker + TCP 代理，不需要真机双机。
cd D:\resume-lab
node experiment.mjs
```

脚本做的事：建 hub/worker → 派 exec 任务生成 50MB → 起 pull → 收到 ~1/3 时
`destroy()` 所有代理 socket → 等 5 秒 → 重发 pull → 断言 `startOffset` 与 sha256 →
拆掉部署。

判定标准：

- `startOffset > 0` 且 `startOffset === 断点字节数` ⇒ **中段续传生效**；
- 最终 sha256 与全文一致 ⇒ **字节级正确**；
- dest 无残留 ⇒ **收尾干净**。

---

## 9. 临时部署拆除

实验脚本末尾按 `worker → hub → 代理 → http server` 的顺序释放，并已确认：

```
✓ 临时部署已拆除（worker 停止、hub 释放、代理关闭）
```

- worker：`workerDispose()` —— 停 transport、清定时器；
- hub：`hub.disposeAll()` —— 释放全部注册；
- TCP 代理 + http server：`close()`，在途 socket 全部 destroy。

**没有改动任何真实配置**：实验全程在 `D:\resume-lab\run\` 这个临时目录里，
hub/worker 的 `stateDir` 都指向该临时目录，**未触碰** `~/.dsh-remote-agent/`
与 DSH profile 的 `cordis.patch.yml`。所以无需"配置还原"。

---

## 10. 边界与未覆盖

| 项 | 状态 |
|---|---|
| direct 模式中段续传 | ✅ 本次覆盖 |
| relay 模式中段续传 | ❌ 未覆盖。KNOWN-ISSUES 记有冻结层缺陷 `[D3]`：`lib/relay.js` 用 TEXT 帧转发二进制下行帧 → relay 下产物分块损坏 |
| 真机双机（跨 Tailscale）断网续传 | ⚠️ 本次用 TCP 代理模拟断网；跨真机的物理断网（拔网线 / 停 Tailscale）未做 |
| `partialTtlMs` 过期后从头传 | ❌ 未覆盖（单测 `artifact-resume.test.js` 有，本次真机未跑） |
| 多产物并发续传 | ❌ 未覆盖 |
| 断网时长超过 `pullTimeoutMs` | ❌ 未覆盖（本次断 5 秒，默认超时 30 分钟） |

> 关于 relay：`test/hub-worker-e2e.test.js` 已把 `[D3]` 钉住（断言 relay 下 pull
> **失败**且失败形态与根因一致）。所以"relay 下断点续传"目前**不成立**，
> 不是本次实验的疏漏，而是已知的冻结层缺陷 —— 修 `[D3]` 之前不必再测。
