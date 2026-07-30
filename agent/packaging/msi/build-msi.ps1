<#
  build-msi.ps1 — thin wrapper. The MSI is built by agent\build.ps1, which
  publishes the binaries, stages them into agent\dist\, and compiles the tracked
  packaging\msi\ConnectLive.wxs with a moving ProductVersion.

  Usage:
    ./build-msi.ps1                       # MSI only
    ./build-msi.ps1 -Version 1.2.0.0      # explicit ProductVersion

  Prereqs (install once):
    dotnet tool install --global wix
    wix extension add -g WixToolset.Util.wixext
    wix extension add -g WixToolset.Firewall.wixext
#>
[CmdletBinding()]
param([string]$Version)

$ErrorActionPreference = "Stop"
$agentRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # agent/

$args = @{ SkipInno = $true }
if ($Version) { $args.Version = $Version }

& (Join-Path $agentRoot "build.ps1") @args
