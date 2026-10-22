<#
  install-gpo.ps1 — Group Policy computer startup script.

  Link this script under:
    Computer Configuration → Policies → Windows Settings → Scripts (Startup/Shutdown)

  It idempotently installs ConnectLiveAgent.msi from the domain NETLOGON share
  the first time each machine boots, then no-ops on subsequent boots.
#>
$ErrorActionPreference = "Stop"

$msiUnc = "\\$env:USERDNSDOMAIN\NETLOGON\ConnectLive\ConnectLiveAgent.msi"

if (-not (Test-Path $msiUnc)) {
    Write-EventLog -LogName Application -Source Application -EventId 1000 `
        -EntryType Warning -Message "ConnectLive GPO install: MSI not found at $msiUnc" -ErrorAction SilentlyContinue
    exit 1
}

# Read the payload's actual ProductCode, NOT its fixed UpgradeCode.
# Avoid Win32_Product enumeration, which can trigger MSI consistency repairs.
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($msiUnc, 0)
$view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = 'ProductCode'")
$view.Execute()
$record = $view.Fetch()
if (-not $record) { throw "MSI ProductCode is missing." }
$productCode = $record.StringData(1)
$view.Close()
if ($productCode -notmatch '^\{[0-9A-Fa-f-]{36}\}$') { throw "Invalid MSI ProductCode." }
if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$productCode") { exit 0 }

# Enrollment is keyless — the Agent mints its own device token on first launch,
# so there is nothing to pass on the msiexec command line.
$process = Start-Process msiexec.exe -ArgumentList "/i `"$msiUnc`" /qn /norestart" -Wait -NoNewWindow -PassThru
exit $process.ExitCode
