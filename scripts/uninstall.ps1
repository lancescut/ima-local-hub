# ImaLocalHub Windows 卸载脚本（免管理员）
$ErrorActionPreference = 'Stop'
$Dst = "$env:LOCALAPPDATA\Programs\ImaLocalHub"; $Cfg = "$env:ProgramData\ImaLocalHub"; $Task = 'ImaLocalHub'
Write-Host '== ImaLocalHub 卸载 ==' -ForegroundColor DarkRed
cmd /c "schtasks /End /TN ImaLocalHub 2>nul"
cmd /c "schtasks /Delete /TN ImaLocalHub /F 2>nul"
$startup = [Environment]::GetFolderPath('Startup')
Remove-Item "$startup\ImaLocalHub.bat" -Force -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'ImaLocalHub\\hub.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.ExecutablePath -match 'ImaLocalHub' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item $Dst -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "已删除 $Dst"
Write-Host "配置保留在 $Cfg（含密钥与日志），可手动删除" -ForegroundColor Yellow
Write-Host '提示: 清理 Tailscale Funnel 可运行: tailscale funnel --https=8443 off'
Read-Host '按回车关闭'
