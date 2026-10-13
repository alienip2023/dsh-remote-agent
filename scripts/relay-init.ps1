<#
.SYNOPSIS
  dsh-remote-agent 中继初始化（Windows，幂等）。

.DESCRIPTION
  做三件事：
    1. 生成/复用 token，写入配置目录（默认 %ProgramData%\dsh-remote-relay）
    2. 用 ACL 把 token 文件收窄到「当前用户 + Administrators + SYSTEM」
    3. 注册计划任务（开机自启）或打印启动命令

  幂等性：重复执行不会轮换 token、不会覆盖已有 token 文件（除非 -ForceRotate）。
  明文 token 只在生成时打印一次；日志与结尾汇总只给指纹。

  兼容 Windows PowerShell 5.1 与 PowerShell 7+（本文件必须存为 UTF-8 with BOM）。

.PARAMETER Port
  监听端口，默认 8890。

.PARAMETER HostAddress
  监听地址，默认 0.0.0.0。仅本机调试可传 127.0.0.1。

.PARAMETER ConfigDir
  配置目录，默认 $env:ProgramData\dsh-remote-relay。

.PARAMETER DataDir
  凭证数据目录（传给 relay CLI 的 --data-dir），默认等于 ConfigDir。

.PARAMETER RegisterTask
  注册计划任务 dsh-remote-relay（开机自启、失败重启）。默认只打印启动命令。

.PARAMETER ForceRotate
  强制轮换 token（已入网副机需重新配置）。

.PARAMETER DryRun
  只打印将要做的事，不落盘、不注册任务。

.EXAMPLE
  # 首次部署（管理员 PowerShell）
  .\scripts\relay-init.ps1 -Port 8890 -RegisterTask

.EXAMPLE
  # 只生成凭证并打印启动命令
  .\scripts\relay-init.ps1

.NOTES
  需要 Node.js 22+。零外部 npm 依赖，只用 node: 内置模块。
#>
[CmdletBinding()]
param(
  [int]$Port = 8890,
  [string]$HostAddress = '0.0.0.0',
  [string]$ConfigDir = (Join-Path $env:ProgramData 'dsh-remote-relay'),
  [string]$DataDir = '',
  [switch]$RegisterTask,
  [switch]$ForceRotate,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log {
  param([string]$Message)
  Write-Host "[relay-init] $Message"
}

function Write-WarnLine {
  param([string]$Message)
  Write-Host "[relay-init][warn] $Message" -ForegroundColor Yellow
}

function Fail {
  param([string]$Message)
  Write-Host "[relay-init][error] $Message" -ForegroundColor Red
  exit 1
}

# PS 5.1 没有 -Encoding utf8NoBOM；统一走 .NET 写无 BOM UTF-8。
function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function New-RelayToken {
  param([string]$Prefix)
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $b64 = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '').Replace('/', '')
  return "${Prefix}_$($b64.Substring(0, 32))"
}

function Get-TokenFingerprint {
  param([string]$Token)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Token))
  } finally { $sha.Dispose() }
  return ([BitConverter]::ToString($hash) -replace '-', '').ToLower().Substring(0, 12)
}

function Protect-Path {
  param([string]$Path, [switch]$IsDirectory)
  # 非管理员下 SeSecurityPrivilege 不可用，SetAccessRuleProtection 会抛；
  # 这时退回 icacls（不需要特权即可改写普通 ACL）。两者都失败只告警，不阻断。
  try {
    if ($IsDirectory) {
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)   # 断开继承
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $prop = [System.Security.AccessControl.PropagationFlags]::None
    foreach ($who in @($me, 'BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
      try {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
          $who, 'FullControl', $inherit, $prop, 'Allow')
        $acl.AddAccessRule($rule)
      } catch {
        # 账户不存在（如域环境下的 BUILTIN 别名）：跳过，不阻断主流程
      }
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    return
  } catch {
    # 落到 icacls 分支
  }

  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  if (-not (Test-Path -LiteralPath $icacls)) { Write-WarnLine '找不到 icacls，跳过 ACL 收窄'; return }
  $me2 = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $grant = if ($IsDirectory) { "$me2`:(OI)(CI)F" } else { "$me2`:F" }
  try {
    & $icacls $Path /inheritance:r /grant:r $grant | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-WarnLine "icacls 收窄 ACL 返回 $LASTEXITCODE（不影响运行）" }
  } catch {
    Write-WarnLine "收窄 ACL 失败（不影响运行）：$($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- 0. 参数与环境检查
if ($Port -lt 0 -or $Port -gt 65535) { Fail "端口非法：$Port（0-65535，0 表示随机端口）" }
if ([string]::IsNullOrWhiteSpace($HostAddress)) { Fail 'HostAddress 不能为空' }
if ($HostAddress -match '\s') { Fail "HostAddress 不能含空白字符：$HostAddress" }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = $ConfigDir }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail '找不到 node，请先安装 Node.js 22+ 并加入 PATH' }
$nodeExe = $nodeCmd.Source
# 不用 node -p 里的内层引号（PS 5.1 向原生程序传参时会吞掉双引号），直接取版本串自己切。
$nodeVersion = (& $nodeExe -p 'process.versions.node').Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) { Fail "需要 Node.js >= 22，当前 $nodeVersion" }

$scriptDir = Split-Path -Parent $PSCommandPath
$pkgDir = Split-Path -Parent $scriptDir
$relayBin = Join-Path $pkgDir 'bin\dsh-remote-relay.js'
if (-not (Test-Path -LiteralPath $relayBin)) { Fail "找不到 $relayBin" }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-WarnLine '当前不是管理员：注册计划任务与写 ProgramData 可能失败，建议用管理员 PowerShell 重跑。'
}

# ---------------------------------------------------------------- 1. 目录与 token
$tokenFile = Join-Path $ConfigDir 'tokens.json'
$envFile = Join-Path $ConfigDir 'relay.env.ps1'
$logFile = Join-Path $ConfigDir 'relay.log'
$errLogFile = Join-Path $ConfigDir 'relay.err.log'

if (-not (Test-Path -LiteralPath $ConfigDir)) {
  Write-Log "创建配置目录 $ConfigDir"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    Protect-Path -Path $ConfigDir -IsDirectory
  }
}

$hubToken = ''
$enrollToken = ''
$reused = $false

if ((Test-Path -LiteralPath $tokenFile) -and (-not $ForceRotate)) {
  try {
    $parsed = Get-Content -LiteralPath $tokenFile -Raw | ConvertFrom-Json
    $hubToken = [string]$parsed.hubToken
    $enrollToken = [string]$parsed.enrollToken
  } catch {
    Fail "凭证文件不是合法 JSON：$tokenFile（$($_.Exception.Message)）。修复或删除后重跑。"
  }
  if ([string]::IsNullOrWhiteSpace($hubToken) -or [string]::IsNullOrWhiteSpace($enrollToken)) {
    Fail "凭证文件缺少 hubToken / enrollToken：$tokenFile。删除它或用 -ForceRotate 重新生成。"
  }
  $reused = $true
  Write-Log "复用已有凭证 $tokenFile（-ForceRotate 可轮换）"
}

if (-not $reused) {
  $hubToken = New-RelayToken 'rt'
  $enrollToken = New-RelayToken 'en'
  Write-Log "写入新凭证 $tokenFile"
  if (-not $DryRun) {
    $payload = [ordered]@{
      version     = 1
      hubToken    = $hubToken
      enrollToken = $enrollToken
      createdAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    Write-Utf8NoBom -Path $tokenFile -Content ($payload | ConvertTo-Json -Depth 4)
    Protect-Path -Path $tokenFile

    $envLines = @(
      '# dsh-remote-relay 环境文件 —— 由 scripts/relay-init.ps1 生成，勿入版本库',
      "`$env:DSH_RELAY_PORT = '$Port'",
      "`$env:DSH_RELAY_HOST = '$HostAddress'",
      "`$env:DSH_RELAY_DATA_DIR = '$DataDir'",
      "`$env:DSH_RELAY_HUB_TOKEN = '$hubToken'",
      "`$env:DSH_RELAY_ENROLL_TOKEN = '$enrollToken'"
    )
    Write-Utf8NoBom -Path $envFile -Content (($envLines -join [Environment]::NewLine) + [Environment]::NewLine)
    Protect-Path -Path $envFile
  }
}

$hubFp = Get-TokenFingerprint -Token $hubToken
$enrollFp = Get-TokenFingerprint -Token $enrollToken

# ---------------------------------------------------------------- 2. 计划任务 / 启动命令
$taskName = 'dsh-remote-relay'
$argList = @($relayBin, '--port', "$Port", '--host', $HostAddress, '--data-dir', $DataDir)
$argString = ($argList | ForEach-Object {
  if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
}) -join ' '

if ($RegisterTask) {
  Write-Log "注册计划任务 $taskName（开机自启、失败重启）"
  if (-not $DryRun) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      Write-Log "已移除旧任务 $taskName"
    }
    $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $argString -WorkingDirectory $pkgDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description 'dsh-remote-agent relay（只做寻址与转发）' | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Log "已启动。查看状态：Get-ScheduledTask $taskName | Get-ScheduledTaskInfo"
    Write-Log "停止：Stop-ScheduledTask $taskName ；删除：Unregister-ScheduledTask $taskName"
  }
} else {
  Write-Log '未指定 -RegisterTask：打印手动启动命令（复制即用）'
  Write-Host ''
  Write-Host '# ---- 前台运行（首次排障推荐） ----'
  Write-Host "& '$nodeExe' $argString"
  Write-Host ''
  Write-Host '# ---- 后台运行 ----'
  Write-Host "Start-Process -FilePath '$nodeExe' -ArgumentList @('$relayBin','--port','$Port','--host','$HostAddress','--data-dir','$DataDir') -RedirectStandardOutput '$logFile' -RedirectStandardError '$errLogFile' -WindowStyle Hidden"
  Write-Host ''
  Write-Host '# ---- 停止 ----'
  Write-Host "Get-CimInstance Win32_Process -Filter ""Name='node.exe'"" | Where-Object { `$_.CommandLine -like '*dsh-remote-relay.js*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }"
  Write-Host ''
  Write-Host '# ---- 注册开机自启 ----'
  Write-Host "& '$PSCommandPath' -Port $Port -RegisterTask"
}

# ---------------------------------------------------------------- 3. 汇总（只打指纹）
Write-Host ''
Write-Log '完成'
Write-Host "  监听        : $HostAddress`:$Port"
Write-Host "  配置目录    : $ConfigDir"
Write-Host "  凭证文件    : $tokenFile（已收窄 ACL，仅指纹如下）"
Write-Host "  hub 指纹    : $hubFp"
Write-Host "  enroll 指纹 : $enrollFp"
Write-Host "  健康检查    : curl.exe -fsS http://127.0.0.1:$Port/healthz"
Write-Host "  明文 token  : & '$nodeExe' '$relayBin' --print-tokens --data-dir '$DataDir'"
Write-Host "  副机配置    : profiles/worker.cordis.yml -> relayUrl=ws://<本机IP>:$Port/relay"
Write-Host "  防火墙      : New-NetFirewallRule -DisplayName 'dsh-remote-relay' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -RemoteAddress LocalSubnet"
