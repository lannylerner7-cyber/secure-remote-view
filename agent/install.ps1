# ConnectLive installer / uninstaller
# Usage (elevated PowerShell):
#   .\install.ps1 install   # copies binaries, registers ConnectLiveWatcher service
#   .\install.ps1 uninstall # stops + removes the service and program files
#
# Layout after install:
#   C:\Program Files\ConnectLive\ConnectLiveWatcher.exe   (LocalSystem service)
#   C:\Program Files\ConnectLive\ConnectLiveAgent.exe     (user-session worker)
#   %ProgramData%\ConnectLive\                            (DPAPI creds, consent.flag)
#
# The Watcher runs as SYSTEM and spawns the Agent into the interactive user
# session via CreateProcessAsUser — that's what lets screen capture and
# SendInput work despite the service itself being in Session 0.

param(
  [Parameter(Position=0)][ValidateSet("install","uninstall")] [string]$Action = "install"
)

$ErrorActionPreference = "Stop"
$InstallDir  = "$env:ProgramFiles\ConnectLive"
$DataDir     = "$env:ProgramData\ConnectLive"
$ServiceName = "ConnectLiveWatcher"

function Require-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must be run from an elevated (Administrator) PowerShell."
  }
}

function Do-Install {
  Require-Admin
  $watcher = Join-Path $PSScriptRoot "watcher\bin\Release\net8.0-windows\win-x64\publish\ConnectLiveWatcher.exe"
  $worker  = Join-Path $PSScriptRoot "src\bin\Release\net8.0-windows\win-x64\publish\ConnectLiveAgent.exe"
  if (-not (Test-Path $watcher)) { throw "Watcher not built: $watcher (run: dotnet publish watcher\ConnectLiveWatcher.csproj -c Release)" }
  if (-not (Test-Path $worker))  { throw "Agent not built: $worker (run: dotnet publish src\ConnectLiveAgent.csproj -c Release)" }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  New-Item -ItemType Directory -Force -Path $DataDir    | Out-Null

  Copy-Item $watcher (Join-Path $InstallDir "ConnectLiveWatcher.exe") -Force
  Copy-Item $worker  (Join-Path $InstallDir "ConnectLiveAgent.exe")   -Force

  # Stop + remove any existing service so we can reinstall cleanly.
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
  }

  $exe = Join-Path $InstallDir "ConnectLiveWatcher.exe"
  sc.exe create $ServiceName binPath= "`"$exe`"" start= auto obj= "LocalSystem" DisplayName= "ConnectLive Watcher" | Out-Null
  sc.exe description $ServiceName "Maintains ConnectLive agent presence and spawns the interactive worker for remote support sessions." | Out-Null
  sc.exe failure     $ServiceName reset= 60 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  Start-Service $ServiceName

  Write-Host "ConnectLive installed. Service '$ServiceName' is running." -ForegroundColor Green
}

function Do-Uninstall {
  Require-Admin
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
  }
  # Kill any running worker before removing the folder.
  Get-Process ConnectLiveAgent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Host "ConnectLive uninstalled. Data at $DataDir left in place (delete manually if desired)." -ForegroundColor Yellow
}

switch ($Action) {
  "install"   { Do-Install }
  "uninstall" { Do-Uninstall }
}
