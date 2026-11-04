# Build and run the actual source locally. No publish, installer, signing,
# release ZIP, service installation, or prebuilt Agent download is performed.
[CmdletBinding()]
param(
    [string]$ApiUrl = "https://connectliveagent.com",
    [switch]$Pair,
    [switch]$StartWithWindows,
    [switch]$Disable,
    [string]$UpdatePublicKeyPath
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") {
    throw "Run this script from PowerShell on your Windows test machine."
}
if ($Disable) {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $agents = @(Get-Process -Name ConnectLive -ErrorAction SilentlyContinue |
        Where-Object { $_.SessionId -eq $sessionId })
    if ($agents.Count -eq 0) {
        Write-Host "No Agent is running in this Windows session. To disable future starts, run the installed ConnectLive.exe /disable."
        return
    }
    foreach ($agent in $agents) {
        if (-not $agent.Path) { throw "Cannot locate the running Agent. Run its ConnectLive.exe /disable directly." }
        $stopper = Start-Process -FilePath $agent.Path -ArgumentList "/disable" -PassThru -Wait
        if ($stopper.ExitCode -ne 0) { throw "The Agent could not save local withdrawal." }
        if (-not $agent.WaitForExit(10000)) { throw "Withdrawal was requested, but the Agent has not exited. Do not assume access stopped." }
    }
    Write-Host "Remote access is disabled for this Windows user."
    return
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "Install the Windows .NET 8 SDK, then reopen PowerShell."
}
$sdks = & dotnet --list-sdks
if ($LASTEXITCODE -ne 0 -or -not ($sdks -match '^8\.')) {
    throw "The Windows .NET 8 SDK is required. A runtime-only installation is not enough."
}
if (Get-Process -Name ConnectLive -ErrorAction SilentlyContinue) {
    throw "An Agent is already running. Run .\run.ps1 -Disable first, then rerun this script."
}

$server = [uri]$ApiUrl
if (-not $server.IsAbsoluteUri -or $server.Scheme -ne "https" -or
    $server.UserInfo -or $server.Query -or $server.Fragment -or $server.AbsolutePath -ne "/") {
    throw "-ApiUrl must be an HTTPS origin without credentials, a path, query, or fragment."
}
$origin = $server.GetLeftPart([System.UriPartial]::Authority)
$agentProject = Join-Path $PSScriptRoot "src\ConnectLiveAgent.csproj"
[xml]$definition = Get-Content -LiteralPath $agentProject -Raw
$version = [string]($definition.Project.PropertyGroup.Version |
    Where-Object { $_ } | Select-Object -First 1)
if (-not $version) { throw "The Agent project does not specify its source version." }

$publicKey = $null
if ($UpdatePublicKeyPath) {
    $publicKey = (Resolve-Path -LiteralPath $UpdatePublicKeyPath).Path
    $pem = Get-Content -LiteralPath $publicKey -Raw
    if ($pem -match "PRIVATE KEY" -or $pem -notmatch "-----BEGIN PUBLIC KEY-----") {
        throw "-UpdatePublicKeyPath accepts only the publisher's public SPKI PEM, never a private key."
    }
}

# A fresh directory prevents an old executable from being mistaken for this
# source revision. All three apphosts and their dependencies live together.
$runId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$output = Join-Path $PSScriptRoot "bin\terminal-$runId"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$projects = @(
    "src\ConnectLiveAgent.csproj",
    "src\Watch\ConnectLiveWatch.csproj",
    "src\UpdateHost\ConnectLiveUpdate.csproj"
)

Write-Host "Building ConnectLive $version from local source for terminal testing."
Write-Host "This does not create an MSI, release ZIP, or signed production package."
foreach ($relativeProject in $projects) {
    $buildArguments = @(
        "build", (Join-Path $PSScriptRoot $relativeProject),
        "--configuration", "Debug", "--runtime", "win-x64",
        "--output", $output, "-p:SelfContained=false",
        "-p:PublishSingleFile=false", "-p:Version=$version"
    )
    if ($publicKey) { $buildArguments += "-p:UpdatePublicKeyPath=$publicKey" }
    & dotnet @buildArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Source build failed: $relativeProject. No Agent was launched."
    }
}
foreach ($name in @("ConnectLive.exe", "ConnectLiveWatch.exe", "ConnectLiveUpdate.exe")) {
    if (-not (Test-Path -LiteralPath (Join-Path $output $name))) {
        throw "Expected local build output is missing: $name"
    }
}

$launchArguments = @("--api-url", $origin)
if ($Pair) { $launchArguments += "--pair" }
if ($StartWithWindows) { $launchArguments += "--start-with-windows" }
Write-Host "Launching the newly built source from: $output"
Write-Host "Enter the administrator's pairing code in the app, not in this terminal."
Write-Host "After pairing, no status window or tray controls are shown."
Write-Host "To stop locally, run .\run.ps1 -Disable in another PowerShell window."
$process = Start-Process -FilePath (Join-Path $output "ConnectLive.exe") `
    -ArgumentList $launchArguments -WorkingDirectory $output -PassThru -Wait
if ($process.ExitCode -ne 0) {
    throw "ConnectLive exited with code $($process.ExitCode). Check its startup message and local logs."
}
