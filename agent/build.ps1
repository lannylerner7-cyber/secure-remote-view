# ConnectLive Agent -- build script (Windows, .NET 8 SDK required)
# Produces:
#   dist/ConnectLive.exe           (raw agent binary - input to the installers)
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
#   powershell -ExecutionPolicy Bypass -File build.ps1 -SkipMsi       # Inno only
#   powershell -ExecutionPolicy Bypass -File build.ps1 -SkipInno      # MSI only
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Version 1.2.0.0
#
# A missing toolchain is a HARD FAILURE unless the matching -Skip switch is
# passed. Silent "Skipping." warnings used to produce half-built runs.

param(
    [switch]$SkipInno,
    [switch]$SkipMsi,
    [switch]$SkipSign,
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# S25 - Authenticode signing. Credentials come from CODESIGN_* environment
# variables; see docs/SIGNING.md. Unconfigured = unsigned build + warning,
# configured = failure to sign is fatal.
# CodeSign.ps1 lives at repo\tools\ in the source tree and next to this script
# (or in .\tools\) inside a standalone packaging zip. Probe all three.
$signHelper = @(
    (Join-Path $root "..\tools\CodeSign.ps1"),
    (Join-Path $root "tools\CodeSign.ps1"),
    (Join-Path $root "CodeSign.ps1")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($signHelper) {
    . $signHelper
} else {
    Write-Warning "CodeSign.ps1 not found - building UNSIGNED (see docs\SIGNING.md)."
    function Invoke-ConnectLiveSign { param([string[]]$Paths, [switch]$Skip) }
}

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

# -- 3. Stage binaries to dist\ ------------------------------------------------
# Both packaging/inno/ConnectLiveSetup.iss and packaging/msi/ConnectLive.wxs
# source their payload from dist\.

New-Item -ItemType Directory -Force -Path dist | Out-Null

# Publish emits whatever <AssemblyName> says. When the csproj and this script
# disagree, Copy-Item used to die with a bare "PathNotFound" that named the file
# we WANTED, never the one that was actually produced. Assert with a diagnostic.
function Assert-Published([string]$Dir, [string]$Exe, [string]$Project) {
    $full = Join-Path $Dir $Exe
    if (Test-Path $full) { return $full }
    $found = @(Get-ChildItem -Path $Dir -Filter *.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $actual = if ($found.Count -gt 0) { $found -join ', ' } else { '(none)' }
    throw "Expected '$Exe' in '$Dir' but publish produced: $actual.`n" +
          "Check <AssemblyName> in $Project - it must match the name this script, " +
          "packaging\inno\ConnectLiveSetup.iss and packaging\msi\ConnectLive.wxs use."
}

Copy-Item (Assert-Published "publish/agent" "ConnectLive.exe" "src\ConnectLiveAgent.csproj") dist/ -Force

$required = @("dist/ConnectLive.exe")

# Standalone build: the Agent is the only payload. Purge any helper-service
# binary left over from an older full build so it cannot leak into a package.
foreach ($stale in @("dist/ConnectLiveService.exe", "dist/ConnectLiveUpdater.exe", "publish/updater")) {
    if (Test-Path $stale) {
        Remove-Item $stale -Force -Recurse
        Write-Host "  Removed stale: $($stale -replace '/','\')"
    }
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

# -- 3b. Sign the agent binary (S25) -------------------------------------------
# The exe must be signed BEFORE the installers embed it, otherwise the payload
# extracted onto the endpoint is unsigned even when the installer is not.

Invoke-ConnectLiveSign -Paths @("dist/ConnectLive.exe") -Skip:$SkipSign

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

# -- 5b. Sign the installers (S25) ---------------------------------------------
# Signed after build, before zipping, so the archive carries signed installers.

Invoke-ConnectLiveSign -Paths @("dist/ConnectLiveSetup.exe", "dist/ConnectLiveAgent.msi") -Skip:$SkipSign

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
Write-Host ""
Write-Host "  Installers (ship ONE of these to IT staff):"
if (Test-Path dist/ConnectLiveSetup.exe) { Write-Host "    dist\ConnectLiveSetup.exe   <- interactive install" }
if (Test-Path dist/ConnectLiveAgent.msi) { Write-Host "    dist\ConnectLiveAgent.msi   <- silent / Intune / GPO" }
Write-Host ""
Write-Host "  Signing:"
if ($SkipSign) {
    Write-Host "    SKIPPED (-SkipSign) - do not distribute this build."
} elseif ($env:CODESIGN_THUMBPRINT -or $env:CODESIGN_PFX -or $env:CODESIGN_SUBJECT) {
    Write-Host "    Authenticode signed + timestamped (see docs\SIGNING.md)."
} else {
    Write-Host "    UNSIGNED - set CODESIGN_* env vars before a public release (docs\SIGNING.md)."
}

# -- 8. Release manifest (S14) --------------------------------------------------
# Self-update refuses any release row without a sha256, so the checksum below is
# mandatory, not decorative. Upload the artifact, then insert the row; the agent
# picks it up on its next hourly idle check via /api/public/agent/release.

Write-Host ""
Write-Host "=== Release manifest (S14) ==="
$artifacts = @("dist/ConnectLive.exe", "dist/ConnectLiveAgent.zip",
               "dist/ConnectLiveSetup.exe", "dist/ConnectLiveAgent.msi")
foreach ($a in $artifacts) {
    if (Test-Path $a) {
        $h = (Get-FileHash -Algorithm SHA256 -Path $a).Hash.ToLower()
        Write-Host ("  {0,-32} {1}" -f (Split-Path $a -Leaf), $h)
    }
}
Write-Host ""
Write-Host "  Publish (after uploading the artifact somewhere the agent can GET):"
Write-Host "    insert into public.releases"
Write-Host "      (product, channel, version, download_url, sha256, notes, mandatory, published, published_at)"
Write-Host "    values"
Write-Host "      ('agent', 'stable', '$Version', '<download-url>', '<sha256-from-above>', '<notes>', false, true, now());"
