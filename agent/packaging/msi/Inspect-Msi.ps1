# Read-only Windows Installer inspection. Dot-sourcing this file does not build,
# install, repair or uninstall anything. The table validator also runs in tests.
function Assert-ConnectLiveMsiTables {
    param(
        [hashtable]$Tables,
        [string]$ExpectedVersion,
        [hashtable]$PayloadSizes
    )
    $properties = @{}
    foreach ($row in $Tables.Property) { $properties[$row.Property] = $row.Value }
    if ($properties.ProductVersion -cne $ExpectedVersion) { throw "MSI ProductVersion does not match the requested version." }
    $productGuid = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$properties.ProductCode, "B", [ref]$productGuid) -or
        $productGuid -eq [guid]::Empty -or
        $properties.ProductCode -eq $properties.UpgradeCode) { throw "MSI ProductCode is missing or invalid." }
    if ($properties.ALLUSERS -ne "1" -or $Tables.Template -notmatch '^x64;') {
        throw "Expected an x64, per-machine MSI."
    }
    $names = @{}
    $components = @{}
    foreach ($row in $Tables.Component) { $components[$row.Component] = [int]$row.Attributes }
    foreach ($row in $Tables.File) {
        $name = ($row.FileName -split '\|')[-1]
        if ($names.ContainsKey($name) -or -not $PayloadSizes.ContainsKey($name)) { throw "Unexpected or duplicated MSI payload: $name" }
        $names[$name] = $true
        if ([long]$row.FileSize -ne [long]$PayloadSizes[$name]) { throw "MSI payload size mismatch: $name" }
        if ($row.Version -notin @($ExpectedVersion, "$ExpectedVersion.0")) { throw "MSI payload version mismatch: $name" }
        if (-not $components.ContainsKey($row.Component_) -or ($components[$row.Component_] -band 256) -eq 0) {
            throw "MSI runtime component is not 64-bit: $name"
        }
    }
    if ($names.Count -ne 3 -or @($PayloadSizes.Keys | Where-Object { -not $names.ContainsKey($_) }).Count) {
        throw "The MSI must contain the Agent, Watch and update worker."
    }
    if (@($Tables.ServiceInstall).Count) { throw "The MSI must not install a background capture service." }
    foreach ($row in $Tables.Registry) {
        if ($row.Key -match '\\CurrentVersion\\Run(?:Once)?$' -or $row.Key -match '\\RemovalHistory(?:\\|$)') {
            throw "MSI must not create autorun or own the durable removal history."
        }
    }
    $startup = @($Tables.Shortcut | Where-Object { $_.Arguments -eq "--startup-enable" })
    if ($startup.Count -ne 1) { throw "MSI is missing the explicit owner startup shortcut." }
    $actions = @{}; $sequence = @{}
    foreach ($row in $Tables.CustomAction) { $actions[$row.Action] = $row }
    foreach ($row in $Tables.InstallExecuteSequence) { $sequence[$row.Action] = $row }
    foreach ($id in @("RollbackRemovalMarker", "MarkRemoval", "WithdrawCurrentUser")) {
        if (-not $actions.ContainsKey($id) -or -not $sequence.ContainsKey($id) -or
            ($sequence[$id].Condition -replace '\s+', ' ').Trim() -ne 'REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE') {
            throw "MSI removal action must exclude upgrades: $id"
        }
    }
    if ($actions.MarkRemoval.Source -ne "AgentExeFile" -or $actions.MarkRemoval.Target -ne "--uninstall-machine" -or
        ([int]$actions.MarkRemoval.Type -band 2048) -eq 0 -or ([int]$actions.MarkRemoval.Type -band 1024) -eq 0 -or
        ([int]$actions.MarkRemoval.Type -band 64) -ne 0) { throw "Machine removal receipt is not mandatory and elevated." }
    if ($actions.WithdrawCurrentUser.Target -ne "/uninstall" -or
        ([int]$actions.WithdrawCurrentUser.Type -band 2048) -ne 0) { throw "User withdrawal must run as the invoking user." }
    if (-not $sequence.ContainsKey("RemoveFiles") -or
        [int]$sequence.RollbackRemovalMarker.Sequence -ge [int]$sequence.MarkRemoval.Sequence -or
        [int]$sequence.MarkRemoval.Sequence -ge [int]$sequence.WithdrawCurrentUser.Sequence -or
        [int]$sequence.WithdrawCurrentUser.Sequence -ge [int]$sequence.RemoveFiles.Sequence) {
        throw "MSI removal/rollback actions are out of order."
    }
    return [pscustomobject]@{
        ProductCode = $properties.ProductCode
        ProductVersion = $properties.ProductVersion
        Architecture = "x64"
        Payload = @($names.Keys | Sort-Object)
        TableChecksPassed = $true
        InstallAndRebootTested = $false
    }
}

function Read-ConnectLiveMsiRows {
    param($Database, [string]$Query, [string[]]$Columns)
    $view = $null
    try {
        $view = $Database.OpenView($Query)
        $view.Execute()
        while ($null -ne ($record = $view.Fetch())) {
            try {
                $row = [ordered]@{}
                for ($i = 0; $i -lt $Columns.Count; $i++) { $row[$Columns[$i]] = $record.StringData($i + 1) }
                [pscustomobject]$row
            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        }
    } finally {
        if ($null -ne $view) {
            $view.Close()
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
        }
    }
}

function Get-ConnectLiveMsiInspection {
    param([string]$Path, [string]$ExpectedVersion, [string]$PayloadDirectory)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw "MSI database inspection requires Windows." }
    $sizes = @{}
    foreach ($name in @("ConnectLive.exe", "ConnectLiveWatch.exe", "ConnectLiveUpdate.exe")) {
        $sizes[$name] = (Get-Item -LiteralPath (Join-Path $PayloadDirectory $name) -ErrorAction Stop).Length
    }
    $installer = $null; $database = $null; $summary = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase((Resolve-Path -LiteralPath $Path).Path, 0)
        $tableNames = @(Read-ConnectLiveMsiRows $database 'SELECT `Name` FROM `_Tables`' @("Name") |
            ForEach-Object { $_.Name })
        $tables = @{}
        foreach ($definition in @(
            @{ Name = "Property"; Columns = @("Property", "Value") },
            @{ Name = "File"; Columns = @("File", "Component_", "FileName", "FileSize", "Version") },
            @{ Name = "Component"; Columns = @("Component", "Attributes") },
            @{ Name = "Registry"; Columns = @("Root", "Key", "Name", "Value") },
            @{ Name = "Shortcut"; Columns = @("Shortcut", "Arguments") },
            @{ Name = "CustomAction"; Columns = @("Action", "Type", "Source", "Target") },
            @{ Name = "InstallExecuteSequence"; Columns = @("Action", "Condition", "Sequence") }
        )) {
            if ($definition.Name -notin $tableNames) { throw "Required MSI table is missing: $($definition.Name)" }
            $columns = ($definition.Columns | ForEach-Object { '`{0}`' -f $_ }) -join ', '
            $query = 'SELECT {0} FROM `{1}`' -f $columns, $definition.Name
            $tables[$definition.Name] = @(Read-ConnectLiveMsiRows $database $query $definition.Columns)
        }
        $tables.ServiceInstall = @()
        if ("ServiceInstall" -in $tableNames) {
            $tables.ServiceInstall = @(Read-ConnectLiveMsiRows $database 'SELECT `Name` FROM `ServiceInstall`' @("Name"))
        }
        $summary = $database.SummaryInformation(0)
        $tables.Template = $summary.Property(7)
        Assert-ConnectLiveMsiTables $tables $ExpectedVersion $sizes
    } finally {
        # Release handles before signtool opens the MSI. Close() on the view
        # alone leaves the database locked until COM garbage collection.
        foreach ($object in @($summary, $database, $installer)) {
            if ($null -ne $object) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($object) }
        }
    }
}
