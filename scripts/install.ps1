# ImaLocalHub Windows 安装脚本（免管理员，双击即可）
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1 [-SourceDir 源目录]
param([string]$SourceDir = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$Dst = "$env:LOCALAPPDATA\Programs\ImaLocalHub"
$Cfg = "$env:ProgramData\ImaLocalHub"
$Task = 'ImaLocalHub'

Write-Host ''
Write-Host '  ═══════════════════════════════════════' -ForegroundColor DarkRed
Write-Host '       ImaLocalHub  安装' -ForegroundColor DarkRed
Write-Host '  ═══════════════════════════════════════' -ForegroundColor DarkRed
Write-Host ''

# --- 1. Node.js 检测（缺失则 winget 安装 LTS） ---
$nodeOk = $false
try { $v = & node --version 2>$null; if ($v -match 'v(\d+)' -and [int]$Matches[1] -ge 18) { $nodeOk = $true } } catch {}
if (-not $nodeOk) {
  Write-Host '[1/5] 未检测到 Node.js >= 18，尝试 winget 安装…' -ForegroundColor Yellow
  winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw 'Node.js 安装失败，请从 https://nodejs.org 手动安装 18+ 后重试' }
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + $env:Path
  Write-Host '      Node.js 安装完成'
} else { Write-Host "[1/5] Node.js $v 已就绪" }

# --- 2. 停止旧实例 ---
Write-Host '[2/5] 停止旧实例（如有）'
cmd /c "schtasks /End /TN ImaLocalHub 2>nul"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'ImaLocalHub\\hub.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# --- 3. 复制程序 ---
Write-Host "[3/5] 安装到 $Dst"
New-Item -ItemType Directory -Force -Path $Dst | Out-Null
robocopy $SourceDir $Dst /E /NFL /NDL /NJH /NJS /XD node_modules devdata test | Out-Null
if ($LASTEXITCODE -ge 8) { throw '文件复制失败' }

# --- 4. 配置目录 + 开机自启（三级降级：计划任务API → schtasks → 启动文件夹） ---
Write-Host '[4/5] 注册开机自启（当前用户）'
New-Item -ItemType Directory -Force -Path $Cfg, "$Cfg\logs" | Out-Null
Copy-Item "$PSScriptRoot\run-hub.bat" "$Dst\run-hub.bat" -Force
$bat = "$Dst\run-hub.bat"
$autoOk = $false
try {
  Register-ScheduledTask -TaskName $Task -Action (New-ScheduledTaskAction -Execute $bat) -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)) -Force -ErrorAction Stop | Out-Null
  $autoOk = $true; Write-Host '      方式: 计划任务（登录自启）'
} catch {
  cmd /c "schtasks /Create /TN $Task /TR $bat /SC ONLOGON /F 2>nul" | Out-Null
  if ($LASTEXITCODE -eq 0) { $autoOk = $true; Write-Host '      方式: schtasks 计划任务' }
}
if (-not $autoOk) {
  $startup = [Environment]::GetFolderPath('Startup')
  Copy-Item $bat "$startup\ImaLocalHub.bat" -Force
  Write-Host '      方式: 启动文件夹（登录自启）'
}
# 立即启动（分离进程，日志入文件）
$nodeBin = (Get-Command node).Source
Start-Process $nodeBin -ArgumentList "`"$Dst\hub.js`"" -WindowStyle Hidden -RedirectStandardOutput "$Cfg\logs\hub.out.log" -RedirectStandardError "$Cfg\logs\hub.err.log"

# --- 5. 打开管理页 ---
Write-Host '[5/5] 完成' -ForegroundColor Green
Start-Sleep 3
Start-Process 'http://127.0.0.1:18080'
Write-Host ''
Write-Host '  安装完成，浏览器将打开管理页。' -ForegroundColor Green
Write-Host "  卸载: powershell -ExecutionPolicy Bypass -File `"$Dst\scripts\uninstall.ps1`"" -ForegroundColor Gray
Write-Host ''
Read-Host '按回车关闭'
