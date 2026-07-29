# ConnectLive Agent — build script (Windows, .NET 8 SDK required)
# Produces dist/ConnectLive.exe, dist/ConnectLiveWatcher.exe + dist/ConnectLiveAgent.zip
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "==> Restoring..."
dotnet restore src/ConnectLiveAgent.csproj
dotnet restore watcher/ConnectLiveWatcher.csproj

Write-Host "==> Publishing (single-file, self-contained, win-x64)..."
dotnet publish src/ConnectLiveAgent.csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o publish/agent

Write-Host "==> Publishing watcher service (single-file, self-contained, win-x64)..."
dotnet publish watcher/ConnectLiveWatcher.csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o publish/watcher

New-Item -ItemType Directory -Force -Path dist | Out-Null
Copy-Item publish/agent/ConnectLive.exe dist/ -Force
Copy-Item publish/watcher/ConnectLiveWatcher.exe dist/ -Force
Copy-Item assets/* dist/ -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item install.ps1 dist/ -Force
Copy-Item run-elevated.ps1 dist/ -Force
Copy-Item INSTALL.md dist/README-INSTALL.txt -Force

if (Test-Path dist/ConnectLiveAgent.zip) { Remove-Item dist/ConnectLiveAgent.zip }
Compress-Archive -Path dist/ConnectLive.exe, dist/ConnectLiveWatcher.exe, dist/install.ps1, dist/run-elevated.ps1, dist/README-INSTALL.txt -DestinationPath dist/ConnectLiveAgent.zip -Force

Write-Host ""
Write-Host "Built: dist/ConnectLive.exe"
Write-Host "Built: dist/ConnectLiveWatcher.exe"
Write-Host "Zip  : dist/ConnectLiveAgent.zip"
Write-Host ""
Write-Host "Next: sign with your code-signing cert, e.g."
Write-Host '  signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 dist/ConnectLive.exe'
