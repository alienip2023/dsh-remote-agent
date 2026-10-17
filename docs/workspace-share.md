# 工作区共享（SMB）—— 用本地 IDE 打开副机的文件

> **一句话**：把副机的一个工作区目录共享出去，主机映射成盘符 `X:`，就能用
> 本地 VS Code / 资源管理器直接打开副机的项目。

---

## ⚠️ 先读这段：这会绕过本插件的安全边界

本插件其他所有功能都遵守三条不变式：

| 不变式 | 正常情况 | **开启共享后** |
|---|---|---|
| `roots` 是安全边界 | 所有文件访问先 realpath 展开，再与 roots 前缀比对 | **失效** —— Windows 内核直接读写，插件拦不住 |
| `denyPaths` 生效 | 敏感路径在枚举与读取时被拒 | **失效** —— 同上 |
| 清单先于字节 | 只有 `role:final` 的产物能过河 | **失效** —— 中间产物、日志、`.env`、`.git` 里的密钥全部对主机可见 |
| 凭证不离开副机 | 协议里不带模型 key | **新增凭证面** —— 主机需要副机的 Windows 账号 |

**所以请只共享工作区目录，不要共享整个盘。**

共享是 **Windows SMB** —— 意味着：

- 走 SMB 协议（**不是**本插件的 E2E 加密通道）
- 仅建议在**可信局域网**或 **Tailscale** 上使用
- 跨公网直接用 = 把目录暴露给互联网，**不要这么做**

---

## 怎么用

### 1. 面板上开启

1. 打开「远程同事」面板 → 找到「工作区共享（SMB）」区
2. 选副机
3. 选权限：
   - **只读**（推荐）—— 主机能看、不能改
   - **读写** —— 主机能看能改（会多一次警告）
4. 勾选「我知道上面的风险，确认开启共享」
5. 点「生成共享命令」

### 2. 在**副机**上执行（需要管理员）

插件**不会**代你执行 —— 因为 `New-SmbShare` 需要管理员权限，而 DSH 通常
以普通用户运行。Node 里提权的失败表现（静默失败 / 被安全软件拦 / 权限
半生效）比让你手动跑一条命令难排查得多。

**在副机上开一个管理员 PowerShell**，粘贴面板给的命令：

```powershell
New-SmbShare -Name 'dsh-work-a1b2c3d4' -Path 'D:\work' -ReadAccess "$env:USERNAME"
```

- `-ReadAccess` = 只读
- `-ChangeAccess` = 读写
- 共享给当前用户（`$env:USERNAME`）

### 3. 在**主机**上映射

普通 PowerShell 即可：

```powershell
net use X: \\<副机IP>\dsh-work-a1b2c3d4 /persistent:yes
```

**副机 IP 怎么拿**：

- 同一局域网 → `ipconfig` 看局域网 IP
- 跨网（Tailscale）→ 副机上跑 `tailscale ip -4`

执行后资源管理器里出现 `X:` 盘，就是副机的 `D:\work`。

---

## 关闭共享

面板上生成卸载命令，在**副机**管理员 PowerShell 执行：

```powershell
Remove-SmbShare -Name 'dsh-work-a1b2c3d4' -Force
```

主机侧取消映射：

```powershell
net use X: /delete
```

---

## 常见问题

### 主机连不上 `\\副机IP\共享名`

按顺序查：

1. **副机防火墙** —— 放行 445 端口：
   ```powershell
   netsh advfirewall firewall add rule name="SMB" dir=in action=allow protocol=TCP localport=445
   ```
2. **两台机器能互通** —— `ping <副机IP>`
3. **凭证** —— 主机用副机的 Windows 账号密码（或在副机建一个专用共享账号）
4. **SMB 服务在跑** —— 副机上 `Get-Service LanmanServer` 应为 `Running`

### 共享名为什么是 `dsh-work-a1b2c3d4` 这种怪名字

共享名由工作区路径**稳定哈希**生成，这样：

- 同一个目录反复开关共享 → 共享名不变（不会留孤儿共享）
- 不同目录 → 不同共享名（可以同时共享多个）
- 固定 `dsh-work-` 前缀 → 便于识别与清理（不会误删你的其它共享）

### 能不能共享整个盘

**技术上可以**（`New-SmbShare -Path 'D:\'`），但**强烈不建议**：

- 整个盘包含用户配置、浏览器数据、SSH 私钥、`.env` 文件
- 主机一旦被入侵，副机整盘暴露

插件通过面板生成的命令只会用 `roots` 里的目录 —— 那是你配的安全边界。

### 为什么插件不自己执行 `New-SmbShare`

三个理由：

1. **需要管理员** —— DSH 通常不是管理员
2. **Node 提权不可靠** —— 弹 UAC 需要额外依赖，且被安全软件拦时表现为静默失败
3. **失败难排查** —— 手动跑一条命令失败时你能看到真实错误

---

## 与 relay 模式的关系

**互不影响**：

- relay 模式解决"两台机器都在 NAT 后怎么连上"
- SMB 共享解决"连上之后怎么用本地 IDE 打开文件"

但注意 **SMB 不走 relay** —— 它是 Windows 直连。所以：

- 跨网用 Tailscale + SMB → 可以（Tailscale 提供网络层）
- 只有 relay 没有 Tailscale → **SMB 用不了**（relay 只转发本插件的协议帧）
