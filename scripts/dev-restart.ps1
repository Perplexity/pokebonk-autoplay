# Developer helper: stop the sandbox host (whatever listens on its port) and the sandbox browser (only Chrome
# processes started with this project's own profile folder; other browser windows are left alone).
param([int]$Port = 8080)
$c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($x in $c) { try { Stop-Process -Id $x.OwningProcess -Force -ErrorAction Stop; Write-Output "stopped host pid $($x.OwningProcess)" } catch {} }
Start-Sleep -Milliseconds 700
Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*pokebonk-autoplay*browser-profile*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Write-Output "sandbox stopped"
