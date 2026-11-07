# Explicit, local administrator installation only. This does not build,
# download, publish, silently elevate, change logon policies or save a PIN.
[CmdletBinding()]
param([string]$SetupFile, [string]$HelperExe, [switch]$Remove)
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Run on the authorized Windows computer." }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Open PowerShell as administrator explicitly. This script will not elevate itself."
}
$install = Join-Path $env:ProgramFiles "ConnectLive"
$policyDir = Join-Path $env:ProgramData "ConnectLiveUnlock"
function No-Reparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    while ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not allowed: $Path" }
        $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
    }
}
function Lock-PolicyPath([string]$Path, [bool]$Directory) {
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetSecurityDescriptorSddlForm($(if ($Directory) {
        "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
    } else { "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)" }))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
if ($Remove) {
    Write-Warning "This removes only the Windows unlock service. First run ConnectLive.exe --unlock-disable as the paired Windows user, and revoke Windows unlock in Admin if the endpoint is offline."
    if ((Read-Host "Type REMOVE to remove the Windows unlock service") -cne "REMOVE") { return }
    $existing = Get-Service ConnectLiveUnlock -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-Service ConnectLiveUnlock -Force
        & sc.exe delete ConnectLiveUnlock | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Windows did not remove the service." }
    }
    if (Test-Path -LiteralPath $policyDir) { No-Reparse $policyDir; Remove-Item -LiteralPath $policyDir -Recurse -Force }
    Write-Host "Unlock service removed. No claim is made about offline cleanup, retained backups, or the main Agent's enrollment."
    return
}
if (-not $SetupFile -or -not $HelperExe) { throw "Supply -SetupFile exported by --unlock-setup and -HelperExe from your own local source build." }
No-Reparse $SetupFile
No-Reparse $HelperExe
No-Reparse $install
$binding = Get-Content -LiteralPath $SetupFile -Raw | ConvertFrom-Json
$expected = @("DeviceId","AuthorizationId","Origin","UserSid","AgentPath","AgentSha256")
if (@($binding.PSObject.Properties).Count -ne $expected.Count -or
    @($expected | Where-Object { -not $binding.PSObject.Properties[$_] }).Count) { throw "Invalid public setup binding." }
$agent = Join-Path $install "ConnectLive.exe"
if ([IO.Path]::GetFullPath($binding.AgentPath) -ne [IO.Path]::GetFullPath($agent)) { throw "The Agent must be installed in Program Files\ConnectLive." }
No-Reparse $agent
if ($binding.DeviceId -notmatch '^[0-9a-fA-F-]{36}$' -or $binding.AuthorizationId -notmatch '^[0-9a-fA-F-]{36}$' -or
    $binding.UserSid -notmatch '^S-1-5-21-(\d+-){3}\d+$') { throw "Invalid device, grant or Windows user binding." }
$origin = [uri]$binding.Origin
if ($origin.Scheme -ne "https" -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne "/") {
    throw "The setup origin must be HTTPS, without a path or credentials."
}
$hash = (Get-FileHash -LiteralPath $agent -Algorithm SHA256).Hash
if ($hash -ne $binding.AgentSha256) { throw "The Agent changed after setup export. Export a fresh setup binding." }
Write-Host "Windows unlock grants this specific Agent access to the signed-in user's protected sign-in screen."
Write-Host "Device: $($binding.DeviceId)"
Write-Host "Server: $($binding.Origin)"
Write-Host "Agent SHA256: $hash"
Write-Host "Helper SHA256: $((Get-FileHash -LiteralPath $HelperExe -Algorithm SHA256).Hash)"
Write-Warning "A saved reusable Hello PIN can be used by authorized operators. The PIN is not extracted from Windows and must be entered explicitly in Admin."
Write-Warning "Updating the Agent changes its hash and requires repeating this approval. The script does not disable UAC, enable autologon, or change Secure Attention Sequence policy."
if ((Read-Host "Type ENABLE to install the local Windows unlock service") -cne "ENABLE") { return }
$service = Get-Service ConnectLiveUnlock -ErrorAction SilentlyContinue
if ($service) { Stop-Service ConnectLiveUnlock -Force }
# Require administrator-controlled Agent code. Do not repair a writable main
# application folder by silently changing its permissions.
$acl = Get-Acl -LiteralPath $install
$installerSid = ([Security.Principal.NTAccount]::new("NT SERVICE", "TrustedInstaller")).Translate([Security.Principal.SecurityIdentifier]).Value
$allowedOwners = @("S-1-5-18","S-1-5-32-544",$installerSid)
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowedOwners) {
    throw "Reinstall the Agent with an administrator-controlled owner and read-only access for ordinary users."
}
$helperDestination = Join-Path $install "ConnectLiveUnlock.exe"
if ([IO.Path]::GetFullPath($HelperExe) -ne [IO.Path]::GetFullPath($helperDestination)) {
    Copy-Item -LiteralPath $HelperExe -Destination $helperDestination -Force
}
# Set ownership on this new helper only; leave unrelated Agent files unchanged.
$helperAcl = Get-Acl -LiteralPath $helperDestination
$helperAcl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
Set-Acl -LiteralPath $helperDestination -AclObject $helperAcl
if (-not (Test-Path -LiteralPath $policyDir)) { New-Item -ItemType Directory -Path $policyDir | Out-Null }
No-Reparse $policyDir
Lock-PolicyPath $policyDir $true
$policy = Join-Path $policyDir "policy.json"
$binding | ConvertTo-Json | Set-Content -LiteralPath $policy -Encoding UTF8
Lock-PolicyPath $policy $false
$binary = '"' + $helperDestination + '" --service'
if ($service) { & sc.exe config ConnectLiveUnlock binPath= $binary start= auto obj= LocalSystem | Out-Null }
else { & sc.exe create ConnectLiveUnlock binPath= $binary start= auto obj= LocalSystem DisplayName= "ConnectLive authorized Windows unlock" | Out-Null }
if ($LASTEXITCODE -ne 0) { throw "Windows did not register the unlock service." }
# A LocalSystem single-file application must never extract its runtime into
# an ordinary user's writable temporary directory.
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\ConnectLiveUnlock" -Name Environment `
    -PropertyType MultiString -Value @("DOTNET_BUNDLE_EXTRACT_BASE_DIR=$policyDir\runtime") -Force | Out-Null
& sc.exe description ConnectLiveUnlock "Locally approved, device-bound secure sign-in support. Revoke using ConnectLive.exe --unlock-disable and remove with this script -Remove." | Out-Null
Start-Service ConnectLiveUnlock
Write-Host "Service installed. As the originally paired Windows user, run ConnectLive.exe --unlock-enable and approve the disclosure."
Write-Host "The service alone does not grant remote access, store a PIN, or prove Windows unlock works."
