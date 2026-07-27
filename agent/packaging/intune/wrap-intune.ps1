<#
  wrap-intune.ps1 — wraps the built MSI into a .intunewin package that
  Microsoft Intune can upload as a Win32 app.

  Prereqs:
    1. Build the MSI first:   ../msi/build-msi.ps1
    2. Download IntuneWinAppUtil.exe from Microsoft:
       https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool

  Usage:
    ./wrap-intune.ps1 -IntuneWinAppUtil C:\Tools\IntuneWinAppUtil.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$IntuneWinAppUtil
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # agent/
$dist = Join-Path $root "dist"
$msi  = Join-Path $dist "ConnectLiveAgent.msi"

if (-not (Test-Path $msi)) {
    throw "MSI not found at $msi. Run ../msi/build-msi.ps1 first."
}
if (-not (Test-Path $IntuneWinAppUtil)) {
    throw "IntuneWinAppUtil.exe not found at $IntuneWinAppUtil."
}

Write-Host "==> Wrapping MSI into .intunewin..."
& $IntuneWinAppUtil -c $dist -s ConnectLiveAgent.msi -o $dist -q

Write-Host "==> Done: $dist\ConnectLiveAgent.intunewin"
Write-Host "Upload it in the Intune admin center → Apps → Windows → Add → Win32 app."
Write-Host "Install command:    msiexec /i ConnectLiveAgent.msi /qn DEPLOYMENT_KEY=<paste-your-key>"
Write-Host "Uninstall command:  msiexec /x {UPGRADE-CODE-GUID} /qn"
Write-Host "See intune-app.json for the exact metadata to paste."
