# ConnectLive Admin — build script (Windows, .NET 8 SDK required)
# Produces dist/ConnectLiveAdmin.exe + dist/ConnectLiveAdmin.zip
param(
    [switch]$SkipSign
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# S25 - Authenticode signing (see docs/SIGNING.md). CodeSign.ps1 lives at
# repo\tools\ in the source tree and beside this script inside a standalone zip.
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

# Branding icon is optional — see admin/assets/README.md.
$zipItems = @("dist/ConnectLiveAdmin.exe", "dist/admin.config.json", "dist/README-INSTALL.txt")
if (Test-Path assets/icon.ico) {
    Copy-Item assets/icon.ico dist/ -Force
    $zipItems += "dist/icon.ico"
    Write-Host "  Icon : assets\icon.ico staged"
} else {
    Write-Warning "assets\icon.ico not found - building without admin branding icon."
}

# S25 - sign the console before it is zipped, so the archive ships signed.
Invoke-ConnectLiveSign -Paths @("dist/ConnectLiveAdmin.exe") -Skip:$SkipSign

if (Test-Path dist/ConnectLiveAdmin.zip) { Remove-Item dist/ConnectLiveAdmin.zip }
Compress-Archive -Path $zipItems -DestinationPath dist/ConnectLiveAdmin.zip -Force


Write-Host ""
Write-Host "Built: dist/ConnectLiveAdmin.exe"
Write-Host "Zip  : dist/ConnectLiveAdmin.zip"
Write-Host ""
if ($SkipSign) {
    Write-Host "Signing: SKIPPED (-SkipSign) - do not distribute this build."
} elseif ($env:CODESIGN_THUMBPRINT -or $env:CODESIGN_PFX -or $env:CODESIGN_SUBJECT) {
    Write-Host "Signing: Authenticode signed + timestamped (docs\SIGNING.md)."
} else {
    Write-Host "Signing: UNSIGNED - set CODESIGN_* env vars before release (docs\SIGNING.md)."
}

# -- Release manifest (S14) ----------------------------------------------------
# The console reads /api/public/agent/release?product=admin to show its update
# banner. Same rule as the agent: publish the checksum with the row.

Write-Host ""
Write-Host "=== Release manifest (S14) ==="
foreach ($a in @("dist/ConnectLiveAdmin.exe", "dist/ConnectLiveAdmin.zip")) {
    if (Test-Path $a) {
        $h = (Get-FileHash -Algorithm SHA256 -Path $a).Hash.ToLower()
        Write-Host ("  {0,-28} {1}" -f (Split-Path $a -Leaf), $h)
    }
}
$adminVersion = ([xml](Get-Content src/ConnectLiveAdmin.csproj)).Project.PropertyGroup.Version | Where-Object { $_ }
Write-Host ""
Write-Host "  Publish (after uploading the zip):"
Write-Host "    insert into public.releases"
Write-Host "      (product, channel, version, download_url, sha256, notes, mandatory, published, published_at)"
Write-Host "    values"
Write-Host "      ('admin', 'stable', '$adminVersion', '<download-url>', '<sha256-from-above>', '<notes>', false, true, now());"
