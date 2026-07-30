# ConnectLive installer / uninstaller
# Usage (elevated PowerShell):
#   .\install.ps1 install   # copies binaries, registers ConnectLiveWatcher service
#   .\install.ps1 uninstall # stops + removes the service and program files
#
# Layout after install:
#   C:\Program Files\ConnectLive\ConnectLiveService.exe   (LocalSystem service, registered as ConnectLiveWatcher)
#   C:\Program Files\ConnectLive\ConnectLive.exe     (user-session worker)
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
  # A packaged ZIP places both binaries beside this script. Source-tree
  # publish paths remain as a development fallback.
  $watcher = Join-Path $PSScriptRoot "ConnectLiveService.exe"
  $worker  = Join-Path $PSScriptRoot "ConnectLive.exe"
  if (-not (Test-Path $watcher)) { $watcher = Join-Path $PSScriptRoot "watcher\bin\Release\net8.0-windows\win-x64\publish\ConnectLiveService.exe" }
  if (-not (Test-Path $worker))  { $worker  = Join-Path $PSScriptRoot "src\bin\Release\net8.0-windows\win-x64\publish\ConnectLive.exe" }
  if (-not (Test-Path $watcher)) { throw "Service binary not built: $watcher (run: dotnet publish watcher\ConnectLiveWatcher.csproj -c Release)" }
  if (-not (Test-Path $worker))  { throw "Agent not built: $worker (run: dotnet publish src\ConnectLiveAgent.csproj -c Release)" }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  New-Item -ItemType Directory -Force -Path $DataDir    | Out-Null

  # Lock down %ProgramData%\ConnectLive so only SYSTEM + Admins can write the
  # shared device token; interactive users need read-only for consent.flag.
  try {
    $acl = Get-Acl $DataDir
    $acl.SetAccessRuleProtection($true, $false)   # disable inheritance, drop inherited ACEs
    $acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
    $rules = @(
      New-Object System.Security.AccessControl.FileSystemAccessRule(
        "NT AUTHORITY\SYSTEM", "FullControl",
        "ContainerInherit,ObjectInherit", "None", "Allow"),
      New-Object System.Security.AccessControl.FileSystemAccessRule(
        "BUILTIN\Administrators", "FullControl",
        "ContainerInherit,ObjectInherit", "None", "Allow"),
      New-Object System.Security.AccessControl.FileSystemAccessRule(
        "NT AUTHORITY\INTERACTIVE", "ReadAndExecute",
        "ContainerInherit,ObjectInherit", "None", "Allow")
    )
    foreach ($r in $rules) { $acl.AddAccessRule($r) }
    Set-Acl -Path $DataDir -AclObject $acl
  } catch {
    Write-Warning "Could not tighten ACL on $DataDir : $($_.Exception.Message)"
  }

  Copy-Item $watcher (Join-Path $InstallDir "ConnectLiveService.exe") -Force
  Copy-Item $worker  (Join-Path $InstallDir "ConnectLive.exe")   -Force

  # Stop + remove any existing service so we can reinstall cleanly.
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
  }

  $exe = Join-Path $InstallDir "ConnectLiveService.exe"
  sc.exe create $ServiceName binPath= "`"$exe`"" start= delayed-auto obj= "LocalSystem" DisplayName= "ConnectLive Watcher" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to register $ServiceName (sc.exe exit $LASTEXITCODE)." }
  sc.exe description $ServiceName "Maintains ConnectLive agent presence and spawns the interactive worker for remote support sessions." | Out-Null
  sc.exe failure     $ServiceName reset= 60 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  sc.exe sdset $ServiceName "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCLCSWRPWPDTLOCRRC;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)" | Out-Null
  Start-Service $ServiceName
  (Get-Service $ServiceName).WaitForStatus('Running', (New-TimeSpan -Seconds 15))
  if ((Get-Service $ServiceName).Status -ne 'Running') { throw "$ServiceName did not reach Running state." }

  Write-Host "ConnectLive installed. Service '$ServiceName' is running." -ForegroundColor Green
}

function Do-Uninstall {
  Require-Admin
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    sc.exe sdset $ServiceName "D:(A;;GA;;;SY)(A;;GA;;;BA)" | Out-Null
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
  }
  # Kill any running worker before removing the folder.
  Get-Process ConnectLive -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Host "ConnectLive uninstalled. Data at $DataDir left in place (delete manually if desired)." -ForegroundColor Yellow
}

switch ($Action) {
  "install"   { Do-Install }
  "uninstall" { Do-Uninstall }
}
