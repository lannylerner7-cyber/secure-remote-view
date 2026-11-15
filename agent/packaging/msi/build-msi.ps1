<#
  build-msi.ps1 — thin wrapper. The MSI is built by agent\build.ps1, which
  publishes the binaries, stages them into agent\dist\, and compiles the tracked
  packaging\msi\ConnectLive.wxs with the source project's reviewed ProductVersion.

  Usage:
    ./build-msi.ps1                       # MSI only
    ./build-msi.ps1 -Version 1.9.3        # explicit ProductVersion

  Requires Windows and the .NET 8 SDK. Pinned WiX 4.0.6 and extensions
  are restored by build.ps1; no global or unpinned WiX install is needed.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipSign,
    [string]$UpdatePublicKeyPath,
    [switch]$CreateUpdateBundle
)

$ErrorActionPreference = "Stop"
$agentRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # agent/

$buildArguments = @{ SkipInno = $true; SkipSign = $SkipSign; CreateUpdateBundle = $CreateUpdateBundle }
if ($Version) { $buildArguments.Version = $Version }
if ($UpdatePublicKeyPath) { $buildArguments.UpdatePublicKeyPath = $UpdatePublicKeyPath }

& (Join-Path $agentRoot "build.ps1") @buildArguments
