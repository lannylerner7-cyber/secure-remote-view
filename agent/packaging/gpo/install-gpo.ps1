<#
  install-gpo.ps1 — Group Policy computer startup script.

  Link this script under:
    Computer Configuration → Policies → Windows Settings → Scripts (Startup/Shutdown)

  It idempotently installs ConnectLiveAgent.msi from the domain NETLOGON share
  the first time each machine boots, then no-ops on subsequent boots.
#>
$ErrorActionPreference = "Continue"

$productCode = "{7F2E6B9C-9A35-4A1B-8F2D-91B0A8F8C7D1}"
$msiUnc = "\\$env:USERDNSDOMAIN\NETLOGON\ConnectLive\ConnectLiveAgent.msi"

# Skip if already installed (matches MSI ProductCode).
$installed = Get-CimInstance -ClassName Win32_Product -Filter "IdentifyingNumber='$productCode'" -ErrorAction SilentlyContinue
if ($installed) { exit 0 }

if (-not (Test-Path $msiUnc)) {
    Write-EventLog -LogName Application -Source Application -EventId 1000 `
        -EntryType Warning -Message "ConnectLive GPO install: MSI not found at $msiUnc" -ErrorAction SilentlyContinue
    exit 1
}

# Enrollment is keyless — the Agent mints its own device token on first launch,
# so there is nothing to pass on the msiexec command line.
Start-Process msiexec.exe -ArgumentList "/i `"$msiUnc`" /qn /norestart" -Wait -NoNewWindow
