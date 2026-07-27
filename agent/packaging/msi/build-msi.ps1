<#
  build-msi.ps1 — publishes the Agent + Watcher as self-contained win-x64
  binaries, then packages them into a per-machine MSI via WiX v4.

  Prereqs (install once):
    dotnet tool install --global wix        # WiX v4 CLI (`wix build ...`)
    Ensure .NET 8 SDK is on PATH.

  Usage:
    ./build-msi.ps1                         # produces dist/ConnectLiveAgent.msi

  Later ops flow (customer side):
    msiexec /i ConnectLiveAgent.msi /qn DEPLOYMENT_KEY=xxxxx
#>
[CmdletBinding()]
param(
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # agent/
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Write-Host "==> Publishing Agent..."
dotnet publish (Join-Path $root "src/ConnectLiveAgent.csproj") `
    -c $Configuration -r $Runtime --self-contained true `
    -p:PublishSingleFile=false -p:IncludeNativeLibrariesForSelfExtract=true

Write-Host "==> Publishing Watcher..."
dotnet publish (Join-Path $root "watcher/ConnectLiveWatcher.csproj") `
    -c $Configuration -r $Runtime --self-contained true `
    -p:PublishSingleFile=false -p:IncludeNativeLibrariesForSelfExtract=true

Write-Host "==> Building MSI..."
Push-Location $PSScriptRoot
try {
    wix extension add -g WixToolset.Util.wixext
    wix extension add -g WixToolset.Firewall.wixext
    wix build ConnectLive.wxs `
        -ext WixToolset.Util.wixext `
        -ext WixToolset.Firewall.wixext `
        -arch x64 `
        -o (Join-Path $dist "ConnectLiveAgent.msi")
}
finally { Pop-Location }

Write-Host "==> Done: $dist\ConnectLiveAgent.msi"
Write-Host "Sign it before wide rollout:  signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a $dist\ConnectLiveAgent.msi"
