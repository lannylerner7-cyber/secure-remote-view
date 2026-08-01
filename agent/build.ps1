# ConnectLive Agent -- build script (Windows, .NET 8 SDK required)
# Produces:
#   dist/ConnectLive.exe           (raw agent binary - input to the installers)
#   dist/ConnectLiveUpdater.exe    (raw service binary - input to the installers)
#   dist/ConnectLiveSetup.exe      (Inno Setup installer - interactive IT installs)
#   dist/ConnectLiveAgent.msi      (MSI - Intune / GPO / silent)
#   dist/ConnectLiveAgent.zip      (contains the installer(s) + README)
#
# Prerequisites (install once):
#   Inno Setup 6+  https://jrsoftware.org/isinfo.php   (iscc must be on PATH)
#   WiX v4         dotnet tool install --global wix
#                  wix extension add -g WixToolset.Util.wixext
#                  wix extension add -g WixToolset.Firewall.wixext
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   powershell -ExecutionPolicy Bypass -File build.ps1 -SkipMsi     # Inno only
#   powershell -ExecutionPolicy Bypass -File build.ps1 -SkipInno    # MSI only
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Version 1.2.0.0
#
# A missing toolchain is a HARD FAILURE unless the matching -Skip switch is
# passed. Silent "Skipping." warnings used to produce half-built runs.

param(
    [switch]$SkipInno,
    [switch]$SkipMsi,
    [switch]$SkipUpdater,   # Agent-only build: no Updater binary, no Updater component
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# -- 0. Version ----------------------------------------------------------------
# MSI ProductVersion must be 4 numeric fields. A moving version guarantees each
# build is a genuine major upgrade of the last, never a same-version collision.

if (-not $Version) {
    $now = Get-Date
    $Version = "1.0.{0}.{1}" -f $now.ToString("yyMMdd"), $now.ToString("HHmm")
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "-Version must be four numeric fields (e.g. 1.0.260730.1948). Got: $Version"
}
Write-Host "==> Build version: $Version"

# -- 1. Restore ----------------------------------------------------------------

Write-Host "==> Restoring..."
dotnet restore src/ConnectLiveAgent.csproj
if (-not $SkipUpdater) { dotnet restore updater/ConnectLiveUpdater.csproj }

# -- 2. Publish binaries -------------------------------------------------------

Write-Host "==> Publishing Agent (single-file, self-contained, win-x64)..."
dotnet publish src/ConnectLiveAgent.csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -o publish/agent

if (-not $SkipUpdater) {
    Write-Host "==> Publishing Updater service (single-file, self-contained, win-x64)..."
    dotnet publish updater/ConnectLiveUpdater.csproj `
        -c Release `
        -r win-x64 `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:EnableCompressionInSingleFile=true `
        -o publish/updater
} else {
    Write-Host "==> Skipping Updater (-SkipUpdater): Agent-only installer."
}

# -- 3. Stage binaries to dist\ ------------------------------------------------
# Both packaging/inno/ConnectLiveSetup.iss and packaging/msi/ConnectLive.wxs
# source their payload from dist\.

New-Item -ItemType Directory -Force -Path dist | Out-Null
Copy-Item publish/agent/ConnectLive.exe dist/ -Force

$required = @("dist/ConnectLive.exe")
if (-not $SkipUpdater) {
    Copy-Item publish/updater/ConnectLiveUpdater.exe dist/ -Force
    $required += "dist/ConnectLiveUpdater.exe"
} elseif (Test-Path dist/ConnectLiveUpdater.exe) {
    # A stale binary from a previous full build must not leak into an
    # Agent-only installer.
    Remove-Item dist/ConnectLiveUpdater.exe -Force
}

foreach ($path in $required) {
    if (-not (Test-Path $path)) { throw "Publish did not produce $path" }
    Write-Host "  Staged: $($path -replace '/','\')"
}

# Setup icon: Inno's SetupIconFile points at agent\assets\icon.ico. Only the
# .ico is staged -- logo.svg has no business in dist\.
if (Test-Path assets/icon.ico) {
    Copy-Item assets/icon.ico dist/ -Force
    Write-Host "  Staged: dist\icon.ico"
} else {
    Write-Warning "assets\icon.ico not found - installers will use the default icon."
}

# -- 4. Build Inno Setup installer ---------------------------------------------

if (-not $SkipInno) {
    Write-Host "==> Building Inno Setup installer..."
    if (-not (Get-Command iscc -ErrorAction SilentlyContinue)) {
        throw "iscc (Inno Setup 6) is not on PATH. Install it, or re-run with -SkipInno."
    }
    if (-not (Test-Path packaging/inno/ConnectLiveSetup.iss)) {
        throw "Missing packaging\inno\ConnectLiveSetup.iss - cannot build the Inno installer."
    }
    $innoArgs = @("packaging/inno/ConnectLiveSetup.iss", "/DAppVer=$Version")
    if ($SkipUpdater) { $innoArgs += "/DNoUpdater" }
    & iscc @innoArgs
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed (exit $LASTEXITCODE)" }
    Write-Host "  Built: dist\ConnectLiveSetup.exe"
}


# -- 5. Build MSI (WiX v4) -----------------------------------------------------
# packaging/msi/ConnectLive.wxs is the single source of truth. This script no
# longer regenerates it -- that used to silently overwrite the tracked file and
# let the two copies drift apart.

if (-not $SkipMsi) {
    Write-Host "==> Building MSI installer (WiX v4)..."
    if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
        throw "wix is not on PATH. Run: dotnet tool install --global wix, or re-run with -SkipMsi."
    }
    if (-not (Test-Path packaging/msi/ConnectLive.wxs)) {
        throw "Missing packaging\msi\ConnectLive.wxs - cannot build the MSI."
    }
    Push-Location packaging/msi
    try {
        wix build ConnectLive.wxs `
            -d Version=$Version `
            -ext WixToolset.Util.wixext `
            -ext WixToolset.Firewall.wixext `
            -arch x64 `
            -o (Join-Path $root "dist/ConnectLiveAgent.msi")
        if ($LASTEXITCODE -ne 0) { throw "WiX build failed (exit $LASTEXITCODE)" }
        Write-Host "  Built: dist\ConnectLiveAgent.msi  (ProductVersion $Version)"
    } finally { Pop-Location }
}

# -- 6. Package the installer(s) for distribution ------------------------------

Write-Host "==> Creating distribution ZIP..."
if (Test-Path dist/ConnectLiveAgent.zip) { Remove-Item dist/ConnectLiveAgent.zip }
if (Test-Path INSTALL.md) { Copy-Item INSTALL.md dist/README-INSTALL.txt -Force }

$zipItems = @()
if (Test-Path dist/ConnectLiveSetup.exe) { $zipItems += "dist/ConnectLiveSetup.exe" }
if (Test-Path dist/ConnectLiveAgent.msi) { $zipItems += "dist/ConnectLiveAgent.msi" }
if (Test-Path dist/README-INSTALL.txt)   { $zipItems += "dist/README-INSTALL.txt" }

if ($zipItems.Count -eq 0) { throw "No installer was built -- nothing to package." }
Compress-Archive -Path $zipItems -DestinationPath dist/ConnectLiveAgent.zip -Force
Write-Host "  Zip  : dist\ConnectLiveAgent.zip"

# -- 7. Summary ----------------------------------------------------------------

Write-Host ""
Write-Host "=== Build complete (version $Version) ==="
Write-Host ""
Write-Host "  Raw binaries (input to installer - do NOT ship directly):"
Write-Host "    dist\ConnectLive.exe"
if (Test-Path dist/ConnectLiveUpdater.exe) { Write-Host "    dist\ConnectLiveUpdater.exe  (optional installer component)" }
Write-Host ""
Write-Host "  Installers (ship ONE of these to IT staff):"
if (Test-Path dist/ConnectLiveSetup.exe) { Write-Host "    dist\ConnectLiveSetup.exe   <- interactive install" }
if (Test-Path dist/ConnectLiveAgent.msi) { Write-Host "    dist\ConnectLiveAgent.msi   <- silent / Intune / GPO" }
Write-Host ""
Write-Host "  Sign before wide rollout:"
Write-Host "    signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a dist\ConnectLiveSetup.exe"
Write-Host "    signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a dist\ConnectLiveAgent.msi"
