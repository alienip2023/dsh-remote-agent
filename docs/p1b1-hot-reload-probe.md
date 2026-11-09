# P1b-1 热生效探针记录（P1b.10 第一项）

问题：主控给节点同步 key（或撤销 key）后，节点上正在运行的 DSH **需不需要重启**才生效？
设计稿 §P1b.4 把它列为「未核实」：ra 注释说「worker 启动时读一次 credentials」，`llm-deepseek-api-key` 的
`resolveApiKey` 却每次请求调 `credentials.resolve(ref)`，两者矛盾。

## 做法（实测，不是读注释）

`test/config-sync-hot-reload.test.js`：

1. 用 DSH 安装目录里**真实的** `@deepseek-ai/dsh-credentials-local` 的 `LocalCredentialProvider`
   （真实 `@deepseek-ai/cordis` Context，`watch: true, debounceMs: 100`）。
2. 文件在 provider 启动时**不存在**（= 节点还没有 `DEEPSEEK_API_KEY`）。
3. 用本包真实的 `handleConfigPush` 写 `.credentials.yaml`（临时文件 + chmod 0600 + rename 覆盖），
   **不重启 provider**，每 25ms 轮询 `credentials.resolve('DEEPSEEK_API_KEY')`。
4. 负控：同样的探针对 `watch:false` 的 provider，**看不到**新 key（说明探针会红）。

DSH 包来源：`DSH_NODE_MODULES`（缺省 `/tmp/dsh-asar/node_modules`，即已装 DSH Desktop 0.13.2 的 app.asar 解包目录）。
找不到时整组测试跳过（CI 不带 DSH 安装），所以**结论以本文件为准**，不是靠 CI 常绿。

## 结果（2026-11-09，macOS，Node v24.21.0）

| 场景 | 现象 | 生效耗时 |
|---|---|---|
| S1 provider 已启动、文件后来才被创建（首次同步） | 新 key 可 resolve | ≈ 130 ms |
| S2 已有文件、key 轮换（tmp+rename 覆盖） | 新值可 resolve | ≈ 130 ms |
| S3 撤销（ownedRefs 删除该 ref） | `resolve` 回到 `undefined` | ≈ 130 ms |
| 负控 watch:false | 600 ms 后仍是旧快照 | — |

三次 `handleConfigPush` 都回了 `shouldRestart:true`（插件指纹变化），但 provider 没有重启也生效了。

## 代码侧印证（只读，行号为 app.asar 解包目录）

- `dsh-credentials-local/lib/index.js:461-482`：chokidar 监听，`awaitWriteFinish` 稳定期 = `debounceMs`（100ms）；
  `:491` `resolve(ref)` 读内存快照；`:712-740` `refresh()` 读盘并替换快照。
- `dsh-llm-deepseek-api-key/lib/index.js:55-57`：每次请求 `credentials.resolve(ref)`。
- `dsh-llm-pi-ai/lib/index.js:2995`：同样每次请求 `credentials.resolve(ref)`。
- `dsh-llm-deepseek/lib/index.js:321-343`：插件 config 字段均 `.volatile()`（运行期可改）。

## 结论

1. **只换 key / 撤销 key：不需要重启**（节点上 deepseek-official 与 pi-ai 两条路径都逐请求解析凭据，provider 监听文件）。
2. **没有验证的部分**：
   - `cordis.patch.yml` 条目（模型清单、`thinking` 等）改了之后是否热生效。解包目录里 `dsh-app-boot`/`dsh/lib/profile-boot`
     没有监听 patch 文件的代码（`grep watch` 无命中），`Include` 只在启动时读文件。**按需要重启处理**。
   - 非 Linux 节点（P1b.10 第 7 项）。
   - 没有在真实节点 dshtest-1 上做（那需要先装本版 ra，属于放行后的步骤）。
3. **本片没有改重启策略**：`shouldRestart` 仍按「provider 指纹（含 keyDigest）或插件指纹变化」判定。
   若要收窄成「只有新增/删除 provider、改 baseURL、改插件 config 才重启，纯 key 轮换/撤销不重启」，
   需要主控决定（会改变线上节点既有行为）；证据已齐，见上表。
