# ConnectLive Agent developer build (Windows, .NET 8 SDK required)
# Produces the raw Agent executable without requiring Inno Setup or WiX.
param(
    [switch]$SkipSign
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

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

Write-Host "==> Restoring Agent developer project..."
dotnet restore src/ConnectLiveAgent.csproj
if ($LASTEXITCODE -ne 0) { throw "Agent restore failed (exit $LASTEXITCODE)." }

Write-Host "==> Publishing raw Agent (single-file, self-contained, win-x64)..."
dotnet publish src/ConnectLiveAgent.csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -o publish/agent
if ($LASTEXITCODE -ne 0) { throw "Agent publish failed (exit $LASTEXITCODE). See the compiler error above." }

$published = Join-Path $root "publish\agent\ConnectLive.exe"
if (-not (Test-Path $published)) {
    $found = @(Get-ChildItem -Path (Join-Path $root "publish\agent") -Filter *.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $actual = if ($found.Count -gt 0) { $found -join ', ' } else { '(none)' }
    throw "Expected ConnectLive.exe but publish produced: $actual. Check <AssemblyName> in src\ConnectLiveAgent.csproj."
}

New-Item -ItemType Directory -Force -Path dist | Out-Null
Copy-Item $published dist/ConnectLive.exe -Force
Invoke-ConnectLiveSign -Paths @("dist/ConnectLive.exe") -Skip:$SkipSign

$hash = (Get-FileHash -Algorithm SHA256 -Path dist/ConnectLive.exe).Hash.ToLower()
Write-Host ""
Write-Host "Built: dist\ConnectLive.exe"
Write-Host "SHA256: $hash"