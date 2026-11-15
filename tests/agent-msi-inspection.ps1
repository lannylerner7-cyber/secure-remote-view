$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$agent = Join-Path $root "agent"
$script:checks = 0
function Check([bool]$Value, [string]$Name) {
    if (-not $Value) { throw $Name }
    $script:checks++
}
foreach ($file in @(Get-ChildItem -LiteralPath $agent -Filter *.ps1 -File -Recurse |
    Where-Object { $_.FullName -notmatch '[/\\](?:bin|obj|publish|dist)[/\\]' })) {
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    Check ($errors.Count -eq 0) "PowerShell parse errors: $($file.Name): $errors"
}
. (Join-Path $agent "packaging/msi/Inspect-Msi.ps1")
function Fixture {
    @{
        Template = "x64;1033"
        Property = @(
            @{ Property = "ProductCode"; Value = "{f7e4505c-661c-4c18-81aa-a03e76d2a6d3}" },
            @{ Property = "UpgradeCode"; Value = "{7f2e6b9c-9a35-4a1b-8f2d-91b0a8f8c7d1}" },
            @{ Property = "ProductVersion"; Value = "1.10.14" },
            @{ Property = "ALLUSERS"; Value = "1" }
        )
        File = @(
            @{ FileName = "AGENT.EXE|ConnectLive.exe"; FileSize = "100"; Version = "1.10.14.0"; Component_ = "Agent" },
            @{ FileName = "WATCH.EXE|ConnectLiveWatch.exe"; FileSize = "200"; Version = "1.10.14.0"; Component_ = "Watch" },
            @{ FileName = "UPDATE.EXE|ConnectLiveUpdate.exe"; FileSize = "300"; Version = "1.10.14.0"; Component_ = "Update" }
        )
        Component = @(@{ Component = "Agent"; Attributes = 256 }, @{ Component = "Watch"; Attributes = 256 }, @{ Component = "Update"; Attributes = 256 })
        ServiceInstall = @()
        Registry = @(@{ Key = "Software\ConnectLive"; Name = "UninstallRequested"; Value = "none" })
        Shortcut = @(@{ Arguments = "--startup-enable" })
        CustomAction = @(
            @{ Action = "MarkRemoval"; Type = 3074; Source = "AgentExeFile"; Target = "--uninstall-machine" },
            @{ Action = "WithdrawCurrentUser"; Type = 1090; Source = "AgentExeFile"; Target = "/uninstall" },
            @{ Action = "RollbackRemovalMarker"; Type = 3362 }
        )
        InstallExecuteSequence = @(
            @{ Action = "RollbackRemovalMarker"; Sequence = 3400; Condition = 'REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE' },
            @{ Action = "MarkRemoval"; Sequence = 3401; Condition = 'REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE' },
            @{ Action = "WithdrawCurrentUser"; Sequence = 3402; Condition = 'REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE' },
            @{ Action = "RemoveFiles"; Sequence = 3500 }
        )
    }
}
$sizes = @{ "ConnectLive.exe" = 100; "ConnectLiveWatch.exe" = 200; "ConnectLiveUpdate.exe" = 300 }
$result = Assert-ConnectLiveMsiTables (Fixture) "1.10.14" $sizes
Check ($result.TableChecksPassed -and -not $result.InstallAndRebootTested) "A table check cannot claim installation or reboot evidence."
Check ($result.ProductCode -eq "{f7e4505c-661c-4c18-81aa-a03e76d2a6d3}") "Use actual ProductCode for Intune, not UpgradeCode."
function Reject([scriptblock]$Mutation, [string]$Label) {
    $tables = Fixture
    & $Mutation $tables
    $rejected = $false
    try { $null = Assert-ConnectLiveMsiTables $tables "1.10.14" $sizes } catch { $rejected = $true }
    Check $rejected $Label
}
Reject { param($t) $t.File = $t.File[0..1] } "Missing companion is rejected."
Reject { param($t) $t.File[2].FileName = "Unknown.exe" } "Unexpected executable is rejected."
Reject { param($t) $t.File[1].FileName = "ConnectLive.exe" } "Duplicate executable is rejected."
Reject { param($t) $t.File[1].FileSize = 199 } "Stale payload size is rejected."
Reject { param($t) $t.File[1].Version = "1.9.0.0" } "Stale companion version is rejected."
Reject { param($t) $t.Property[2].Value = "1.10.13" } "Wrong ProductVersion is rejected."
Reject { param($t) $t.Property[0].Value = $t.Property[1].Value } "UpgradeCode is not a ProductCode."
Reject { param($t) $t.Property[0].Value = "{" + ("-" * 36) + "}" } "GUID-looking junk is rejected."
Reject { param($t) $t.Property[0].Value = "{00000000-0000-0000-0000-000000000000}" } "Empty ProductCode is rejected."
Reject { param($t) $t.Property[3].Value = "2" } "Unexpected install scope is rejected."
Reject { param($t) $t.Template = "Intel;1033" } "x86 package is rejected."
Reject { param($t) $t.Component[1].Attributes = 0 } "x86 companion component is rejected."
Reject { param($t) $t.ServiceInstall = @(@{ Name = "HiddenCapture" }) } "Capture service is rejected."
Reject { param($t) $t.Registry += @{ Key = "Software\Microsoft\Windows\CurrentVersion\Run" } } "Installer-created autorun is rejected."
Reject { param($t) $t.Registry += @{ Key = "Software\ConnectLive\RemovalHistory" } } "Installer ownership of removal history is rejected."
Reject { param($t) $t.Shortcut = @() } "Missing local startup action is rejected."
Reject { param($t) $t.InstallExecuteSequence[1].Condition = 'REMOVE="ALL"' } "Upgrade must not withdraw access."
Reject { param($t) $t.InstallExecuteSequence[1].Sequence = 3600 } "Uninstall receipt must precede file removal."
Reject { param($t) $t.CustomAction[0].Type = 1026 } "Machine receipt must run with installer elevation."
Reject { param($t) $t.CustomAction[0].Type = 3138 } "Receipt failure must fail the uninstall."
Reject { param($t) $t.CustomAction[1].Type = 3074 } "User withdrawal must not become SYSTEM-owned."
Write-Host "$script:checks PowerShell parser/MSI validator checks passed with synthetic tables."
Write-Host "No dotnet publish, WiX build, Windows Installer COM, installation, signing or reboot was executed."
