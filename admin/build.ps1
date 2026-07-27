# ConnectLive Admin — build script (Windows, .NET 8 SDK required)
# Produces dist/ConnectLiveAdmin.exe + dist/ConnectLiveAdmin.zip
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "==> Restoring..."
dotnet restore src/ConnectLiveAdmin.csproj

Write-Host "==> Publishing (single-file, self-contained, win-x64)..."
dotnet publish src/ConnectLiveAdmin.csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -o publish/admin

New-Item -ItemType Directory -Force -Path dist | Out-Null
Copy-Item publish/admin/ConnectLiveAdmin.exe dist/ -Force
Copy-Item src/admin.config.json dist/ -Force
Copy-Item INSTALL.md dist/README-INSTALL.txt -Force

if (Test-Path dist/ConnectLiveAdmin.zip) { Remove-Item dist/ConnectLiveAdmin.zip }
Compress-Archive -Path dist/ConnectLiveAdmin.exe, dist/admin.config.json, dist/README-INSTALL.txt `
    -DestinationPath dist/ConnectLiveAdmin.zip -Force

Write-Host ""
Write-Host "Built: dist/ConnectLiveAdmin.exe"
Write-Host "Zip  : dist/ConnectLiveAdmin.zip"
Write-Host ""
Write-Host "Optional: sign with your code-signing cert"
Write-Host '  signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 dist/ConnectLiveAdmin.exe'
