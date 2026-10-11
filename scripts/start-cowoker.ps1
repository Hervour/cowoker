$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Host "cowoker 已经在运行 (PID $($listener.OwningProcess))。"
  Start-Sleep -Seconds 3
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = "C:\Program Files\nodejs\node.exe"
}
if (-not (Test-Path -LiteralPath $node)) {
  Write-Host "找不到 node.exe，请先安装 Node.js。"
  Start-Sleep -Seconds 5
  exit 1
}

$distIndex = Join-Path $projectRoot "dist\index.js"
if (-not (Test-Path -LiteralPath $distIndex)) {
  Write-Host "找不到 dist\index.js，正在执行 npm run build..."
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npm) { $npm = "C:\Program Files\nodejs\npm.cmd" }
  & $npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "构建失败，请检查项目日志。"
    Start-Sleep -Seconds 8
    exit 1
  }
}

$stdout = Join-Path $projectRoot "data\cowoker.out.log"
$stderr = Join-Path $projectRoot "data\cowoker.err.log"
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot "data") | Out-Null
Start-Process -FilePath $node -ArgumentList "dist\index.js" -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

Start-Sleep -Seconds 4
$listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Host "cowoker 已启动 (PID $($listener.OwningProcess))。"
  Start-Sleep -Seconds 3
  exit 0
}

Write-Host "cowoker 启动失败，请查看：$stderr"
Start-Sleep -Seconds 8
exit 1

