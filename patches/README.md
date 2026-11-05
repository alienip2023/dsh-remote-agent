# dsh-remote-agent Fork Patches

每个 `.patch` 文件对应一个二开修复或功能补丁。
上游升级后执行以下命令重新应用所有补丁：

```bash
git fetch upstream
git rebase upstream/main
git apply patches/*.patch
```

如某个补丁已被上游合并，删除对应 `.patch` 文件即可。

## 补丁清单

| 文件 | 状态 | 说明 |
|------|------|------|
| 0001-fix-dsh-home-path.patch | 🟡 待上游合并 | fix: setup.js/setup-routes.js 读取 DSH_HOME 环境变量，修复 Windows 非系统盘路径问题 |

## 提 Issue 流程

发现上游 Bug 时，在当前会话说"提 Issue"，助手会从 memory 提炼根因和复现步骤生成 Issue 正文。
目标仓库：https://github.com/zbzbhs/dsh-remote-agent/issues
