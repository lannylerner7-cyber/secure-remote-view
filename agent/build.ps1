# ConnectLive Agent — build script (Windows, .NET 8 SDK required)
# Produces dist/ConnectLiveAgent.exe + dist/ConnectLiveAgent.zip
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "==> Restoring..."
dotnet restore src/ConnectLiveAgent.csproj

Write-Host "==> Publishing (single-file, self-contained, win-x64)..."
dotnet publish src/ConnectLiveAgent.csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o publish

New-Item -ItemType Directory -Force -Path dist | Out-Null
Copy-Item publish/ConnectLiveAgent.exe dist/ -Force
Copy-Item assets/* dist/ -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path dist/ConnectLiveAgent.zip) { Remove-Item dist/ConnectLiveAgent.zip }
Compress-Archive -Path dist/ConnectLiveAgent.exe, dist/README-INSTALL.txt -DestinationPath dist/ConnectLiveAgent.zip -ErrorAction SilentlyContinue
Compress-Archive -Path dist/ConnectLiveAgent.exe -DestinationPath dist/ConnectLiveAgent.zip -Force

Write-Host ""
Write-Host "Built: dist/ConnectLiveAgent.exe"
Write-Host "Zip  : dist/ConnectLiveAgent.zip"
Write-Host ""
Write-Host "Next: sign with your code-signing cert, e.g."
Write-Host '  signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 dist/ConnectLiveAgent.exe'
