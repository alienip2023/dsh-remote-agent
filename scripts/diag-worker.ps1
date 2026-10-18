# dsh-remote-agent worker diagnostic
#
# Read-only: changes nothing. Paste into PowerShell on the WORKER machine:
#     powershell -ExecutionPolicy Bypass -File .\diag-worker.ps1

$ErrorActionPreference = 'SilentlyContinue'
$profiles = Join-Path $env:USERPROFILE '.dsh\profiles'

function Line { param($t) Write-Host $t }

Write-Host ''
Write-Host '=========================================='
Write-Host ' dsh-remote-agent WORKER DIAGNOSTIC'
Write-Host '=========================================='
Write-Host ''

# ---- 1. profile dirs ----
Write-Host '[1] DSH profile directories'
if (Test-Path $profiles) {
    Get-ChildItem $profiles -Directory | ForEach-Object {
        $patch = Join-Path $_.FullName 'cordis.patch.yml'
        if (Test-Path $patch) {
            $f = Get-Item $patch
            Line ("    {0}  patch={1}B  mtime={2}" -f $_.Name, $f.Length, $f.LastWriteTime.ToString('MM-dd HH:mm:ss'))
        } else {
            Line ("    {0}  (no cordis.patch.yml)" -f $_.Name)
        }
    }
    if ($env:DSH_PROFILE) {
        Line ("    env DSH_PROFILE = " + $env:DSH_PROFILE)
    } else {
        Line '    env DSH_PROFILE = (not set -> code defaults to "desktop")'
    }
} else {
    Line '    ERROR: no profile directory'
}
Write-Host ''

# ---- 2. remote-agent config per profile ----
Write-Host '[2] remote-agent config in each profile'
if (Test-Path $profiles) {
    Get-ChildItem $profiles -Directory | ForEach-Object {
        $patch = Join-Path $_.FullName 'cordis.patch.yml'
        if (-not (Test-Path $patch)) { return }
        $c = Get-Content $patch -Raw
        if ($c -notmatch 'remote-agent') { return }

        $roleM   = [regex]::Match($c, '(?m)^\s*role:\s*(\S+)')
        $injectM = [regex]::Match($c, '(?m)^\s*inject:\s*(.+)$')
        $hubM    = [regex]::Match($c, '(?m)^\s*hubUrl:\s*(\S+)')
        $wsM     = [regex]::Match($c, '(?ms)- id:\s*webserver.*?host:\s*(\S+)')
        $tokM    = [regex]::Match($c, '(?m)^\s*nodeToken:\s*(\S+)')

        Line ('  --- ' + $_.Name + ' ---')
        if ($roleM.Success)   { Line ('      role      = ' + $roleM.Groups[1].Value) }   else { Line '      role      = (NOT SET -> package default)' }
        if ($injectM.Success) { Line ('      inject    = ' + $injectM.Groups[1].Value.Trim()) } else { Line '      inject    = (not set)' }
        if ($hubM.Success)    { Line ('      hubUrl    = ' + $hubM.Groups[1].Value) }    else { Line '      hubUrl    = (not set)' }
        if ($wsM.Success)     { Line ('      webserver = host=' + $wsM.Groups[1].Value) } else { Line '      webserver = (no webserver section)' }
        if ($tokM.Success)    { Line '      nodeToken = (set)' } else { Line '      nodeToken = (not set)' }
    }
} else {
    Line '    (skipped)'
}
Write-Host ''

# ---- 3. installed plugin version ----
Write-Host '[3] installed dsh-remote-agent version'
$found = $false
if (Test-Path $profiles) {
    Get-ChildItem $profiles -Directory | ForEach-Object {
        $nm = Join-Path $_.FullName 'node_modules\dsh-remote-agent'
        $pj = Join-Path $nm 'package.json'
        if (Test-Path $pj) {
            $script:found = $true
            $v = (Get-Content $pj -Raw | ConvertFrom-Json).version
            $hasEnvCheck = Test-Path (Join-Path $nm 'lib\env-check.js')
            $hasShare    = Test-Path (Join-Path $nm 'lib\node\share-service.js')
            $pkgPatch    = Join-Path $nm 'cordis.patch.yml'
            $pkgRole = ''
            $hasWs = $false
            if (Test-Path $pkgPatch) {
                $pc = Get-Content $pkgPatch -Raw
                $m = [regex]::Match($pc, '(?m)^\s*role:\s*(\S+)')
                if ($m.Success) { $pkgRole = $m.Groups[1].Value }
                $hasWs = $pc -match '(?m)^- id:\s*webserver'
            }
            Line ('  ' + $_.Name + ': version ' + $v)
            Line ('    has lib/env-check.js (0.9+)     : ' + $hasEnvCheck)
            Line ('    has lib/node/share-service.js   : ' + $hasShare)
            if ($pkgRole -ne '') { Line ('    package default role            : ' + $pkgRole) } else { Line '    package default role            : (not found)' }
            Line ('    package has webserver binding   : ' + $hasWs)
            if (-not $hasEnvCheck) {
                Line '    WARNING: this is pre-0.9, no "works out of the box"'
            }
        }
    }
}
if (-not $script:found) {
    Line '  ERROR: dsh-remote-agent not found under any profile'
}
Write-Host ''

# ---- 4. panel endpoints ----
Write-Host '[4] panel endpoint probe (is the plugin loaded at all?)'
$ports = @()
$dshPids = (Get-Process 'DeepSeek Harness').Id
if ($dshPids) {
    $ports += (Get-NetTCPConnection -State Listen | Where-Object { $dshPids -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort })
}
$ports += 19387
$ports = $ports | Sort-Object -Unique
foreach ($port in $ports) {
    foreach ($path in @('/api/remote-agent/setup/state', '/api/remote-agent/status')) {
        $url = 'http://127.0.0.1:' + $port + $path
        try {
            $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3
            $body = $r.Content
            if ($body.Length -gt 240) { $body = $body.Substring(0, 240) + '...' }
            Line ('    [' + $port + '] ' + $path + ' -> HTTP ' + $r.StatusCode)
            Line ('           ' + $body)
        } catch {
            $code = $_.Exception.Response.StatusCode.value__
            if ($code) {
                Line ('    [' + $port + '] ' + $path + ' -> HTTP ' + $code)
            } else {
                Line ('    [' + $port + '] ' + $path + ' -> no listener')
            }
        }
    }
}
Write-Host ''

# ---- 5. recent backups ----
Write-Host '[5] recent config backups (was the file rewritten?)'
if (Test-Path $profiles) {
    Get-ChildItem $profiles -Recurse -File -Filter 'cordis.patch.yml*' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 8 |
        ForEach-Object {
            Line ('    ' + $_.LastWriteTime.ToString('MM-dd HH:mm:ss') + '  ' + $_.Length + 'B  ' + $_.Name)
        }
}
Write-Host ''

Write-Host '=========================================='
Write-Host ' END. Paste the whole output back.'
Write-Host '=========================================='
Write-Host ''
