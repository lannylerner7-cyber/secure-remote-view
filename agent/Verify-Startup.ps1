<#
Read-only verification on the paired user's Windows account. Does not install,
launch, stop, repair or revoke anything, and does not contact the backend.
Optional -OutputPath saves a non-secret JSON report; -RequireReady fails if
any local readiness check fails. A passing report is NOT reboot proof.
#>
[CmdletBinding()]
param(
    [string]$InstallDirectory,
    [string]$ExpectedVersion,
    [string]$OutputPath,
    [switch]$RequireReady
)
$ErrorActionPreference = "Stop"
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
    throw "Run this with 64-bit Windows PowerShell, as the Windows user who paired the Agent."
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($sid -in @("S-1-5-18", "S-1-5-19", "S-1-5-20")) { throw "Run in the paired user's account, not a service account." }
$checks = [Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
    $checks.Add([pscustomobject]@{ Check = $Name; Passed = $Passed; Detail = $Detail })
}
function Read-LocalProtectedJson([string]$Path) {
    # Only startup choice and authorization metadata, NEVER device.dat or PIN files.
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt 65536) { throw "Local policy file is too large." }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
}
function Normalize-Directory([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
    return $full.TrimEnd('\')
}

$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
try {
    $metadata = $machine.OpenSubKey("Software\ConnectLive")
    try {
        $registeredPath = if ($metadata) { $metadata.GetValue("InstallPath") } else { $null }
        $removalPath = if ($metadata) { $metadata.GetValue("UninstallRequested") } else { $null }
    } finally { if ($metadata) { $metadata.Dispose() } }
    if (-not $InstallDirectory) {
        $candidates = @($registeredPath)
        $innoKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{B4E9A1C2-7F3D-4A6E-9C2B-CONNECTLIVE500}_is1'
        foreach ($hive in @("CurrentUser", "LocalMachine")) {
            $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,
                [Microsoft.Win32.RegistryView]::Registry64)
            try {
                $key = $root.OpenSubKey($innoKey)
                try { if ($key) { $candidates += $key.GetValue("InstallLocation") } }
                finally { if ($key) { $key.Dispose() } }
            } finally { $root.Dispose() }
        }
        $candidates += @((Join-Path $env:LOCALAPPDATA "Programs\ConnectLive"), (Join-Path $env:ProgramFiles "ConnectLive"))
        $InstallDirectory = $candidates | Where-Object {
            $_ -and (Test-Path -LiteralPath (Join-Path $_ "ConnectLive.exe") -PathType Leaf)
        } | Select-Object -First 1
    }
    if (-not $InstallDirectory) { throw "No installed Agent found. Supply -InstallDirectory for a custom installation." }
    $InstallDirectory = Normalize-Directory $InstallDirectory
    $exe = Join-Path $InstallDirectory "ConnectLive.exe"
    $watchExe = Join-Path $InstallDirectory "ConnectLiveWatch.exe"
    $versions = @()
    foreach ($name in @("ConnectLive.exe", "ConnectLiveWatch.exe", "ConnectLiveUpdate.exe")) {
        $path = Join-Path $InstallDirectory $name
        $exists = Test-Path -LiteralPath $path -PathType Leaf
        Add-Check "Payload $name" $exists "Required installed runtime file"
        if ($exists) { $versions += [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion }
    }
    $versionsMatch = $versions.Count -eq 3 -and @($versions | Select-Object -Unique).Count -eq 1
    if ($ExpectedVersion) { $versionsMatch = $versionsMatch -and $versions[0] -in @($ExpectedVersion, "$ExpectedVersion.0") }
    Add-Check "Runtime versions" $versionsMatch ($versions -join ", ")

    $local = Join-Path $env:LOCALAPPDATA "ConnectLive"
    $disabled = Test-Path -LiteralPath (Join-Path $local "access-disabled")
    $pairingRequired = Test-Path -LiteralPath (Join-Path $local "session-pairing-required")
    $removing = $removalPath -and $removalPath -ne "none" -and (Normalize-Directory $removalPath) -eq $InstallDirectory
    Add-Check "Local access" (-not $disabled -and -not $pairingRequired -and -not $removing) `
        "Disabled, completed-session and uninstall markers must all be absent. This is not a server grant check."

    $grant = $null
    try {
        Add-Type -AssemblyName System.Security
        $choice = Read-LocalProtectedJson (Join-Path $local "startup-consent.dat")
        $grant = Read-LocalProtectedJson (Join-Path $local "authorization.dat")
        $hash = [Security.Cryptography.SHA256]::Create()
        try {
            $pathKey = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(
                $InstallDirectory.ToUpperInvariant()))).Replace("-", "")
        } finally { $hash.Dispose() }
        $history = $machine.OpenSubKey("Software\ConnectLive\RemovalHistory")
        try { $generation = if ($history) { $history.GetValue($pathKey) } else { $null } }
        finally { if ($history) { $history.Dispose() } }
        $generationGuid = [guid]::Empty
        $validGeneration = $null -eq $generation -or [guid]::TryParseExact([string]$generation, "D", [ref]$generationGuid)
        $approved = $choice.NoticeVersion -eq 1 -and $choice.Enabled -eq $true -and
            $choice.Origin -ceq $grant.Origin -and $choice.DeviceId -ceq $grant.DeviceId -and
            $choice.AuthorizationId -ceq $grant.Authorization.Id -and $grant.Authorization.Capabilities.View -eq $true -and
            $validGeneration -and $grant.InstallationGeneration -ceq $generation
        Add-Check "Protected startup choice" $approved "Local choice must match the saved grant and current installation; identifiers are not exported."
    } catch {
        Add-Check "Protected startup choice" $false "Missing, unreadable or invalid policy. Pair/enable startup locally; never send credential files."
    }
} finally { $machine.Dispose() }

$run = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue
Add-Check "Task Manager startup entry" ($run.ConnectLive -eq ('"{0}" /background' -f $exe)) `
    "HKCU Run must point to this installed Agent, not a source/test copy."
# StartupApproved is diagnostic only; do not rewrite Windows' private state.
$osChoice = (Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" `
    -ErrorAction SilentlyContinue).ConnectLive
$osDisabled = $osChoice -and $osChoice[0] -in @(3, 7)
Add-Check "Windows startup setting" (-not $osDisabled) `
    "A disabled Run entry needs local review. To stop both Agent and recovery, use ConnectLive.exe /disable."
$taskName = "ConnectLiveWatch-$sid"
try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    [xml]$xml = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task")
    function Task-Value([string]$XPath) {
        $node = $xml.SelectSingleNode($XPath, $ns)
        if ($node) { return $node.InnerText }; return $null
    }
    $safeTask = $task.State -ne "Disabled" -and
        (Task-Value "//t:Principal/t:UserId") -eq $sid -and
        (Task-Value "//t:Principal/t:LogonType") -eq "InteractiveToken" -and
        (Task-Value "//t:Principal/t:RunLevel") -eq "LeastPrivilege" -and
        (Task-Value "//t:LogonTrigger/t:UserId") -eq $sid -and
        (Task-Value "//t:TimeTrigger/t:Repetition/t:Interval") -eq "PT1M" -and
        (Task-Value "//t:Settings/t:ExecutionTimeLimit") -eq "PT0S" -and
        (Task-Value "//t:Settings/t:Hidden") -eq "false" -and
        (Task-Value "//t:Settings/t:WakeToRun") -eq "false" -and
        (Task-Value "//t:Exec/t:Command") -eq $watchExe -and
        (Task-Value "//t:Exec/t:WorkingDirectory") -eq $InstallDirectory
    Add-Check "Visible per-user recovery task" $safeTask "Logon plus one-minute retry; limited interactive user; no pre-login service or hidden task."
} catch { Add-Check "Visible per-user recovery task" $false "Missing or unreadable; enabling startup must succeed before a reboot test." }

$sessionId = (Get-Process -Id $PID).SessionId
$agentProcess = $null
foreach ($name in @("ConnectLive", "ConnectLiveWatch")) {
    $matches = @()
    foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        try {
            if ($process.SessionId -eq $sessionId -and $process.Path -eq (Join-Path $InstallDirectory "$name.exe")) { $matches += $process }
        } catch { }
    }
    Add-Check "$name process" ($matches.Count -eq 1) "Expected exactly one matching process in this Windows session; Task Manager can confirm."
    if ($name -eq "ConnectLive" -and $matches.Count -eq 1) { $agentProcess = $matches[0] }
}
try {
    $snapshot = Get-Content -LiteralPath (Join-Path $local "agent-process.json") -Raw | ConvertFrom-Json
    $age = ([DateTime]::UtcNow - [DateTime]::Parse($snapshot.HealthyAt).ToUniversalTime()).TotalSeconds
    $healthy = $agentProcess -and $grant -and $snapshot.ProcessId -eq $agentProcess.Id -and
        $snapshot.AuthorizationId -ceq $grant.Authorization.Id -and $age -ge -5 -and $age -lt 75 -and
        [Math]::Abs(($agentProcess.StartTime.ToUniversalTime() - [DateTime]::Parse($snapshot.StartedAt).ToUniversalTime()).TotalSeconds) -lt 2
    Add-Check "Recent acknowledged heartbeat" ([bool]$healthy) "A process alone is not proof of server health; this is a local receipt, not a new network check."
} catch { Add-Check "Recent acknowledged heartbeat" $false "No current matching receipt; inspect Agent/watch logs and Admin last check-in." }
$report = [pscustomobject]@{
    CheckedAtUtc = [DateTime]::UtcNow.ToString("o")
    ReadyLocally = @($checks | Where-Object { -not $_.Passed }).Count -eq 0
    Checks = @($checks.ToArray())
    RebootVerified = $false
    ServerRevocationChecked = $false
}
$checks | Format-Table -Wrap -AutoSize | Out-Host
Write-Host "Read-only snapshot. Run before and after reboot/sign-in. Local readiness does not prove live video or current remote authorization."
if ($OutputPath) { $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding UTF8 }
if ($RequireReady -and -not $report.ReadyLocally) { exit 1 }
