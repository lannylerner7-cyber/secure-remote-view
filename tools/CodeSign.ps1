# ConnectLive — S25 shared Authenticode signing helper.
#
# Dot-source from a build script:
#     . (Join-Path $PSScriptRoot "..\tools\CodeSign.ps1")
#     Invoke-ConnectLiveSign -Paths @("dist\ConnectLive.exe") -Skip:$SkipSign
#
# Credential sources, in precedence order (all environment variables so no
# secret is ever committed or passed on a command line that lands in history):
#
#   1. CODESIGN_THUMBPRINT   — SHA1 thumbprint of a cert already installed in
#                              CurrentUser\My (hardware token / HSM / EV cert
#                              exposed through a CSP). Preferred for EV certs:
#                              the private key never leaves the token.
#   2. CODESIGN_PFX          — path to a .pfx file.
#      CODESIGN_PFX_PASSWORD — its password (optional if the pfx has none).
#   3. CODESIGN_SUBJECT      — substring of the cert subject name, resolved
#                              from the local store (signtool /n).
#
# Optional:
#   CODESIGN_TIMESTAMP_URL   — RFC-3161 TSA (default DigiCert). Timestamping is
#                              mandatory: without it every signature dies the
#                              day the certificate expires.
#
# Behaviour:
#   - No credentials configured  -> unsigned build, loud warning, exit 0.
#     (Developer machines and CI smoke builds must not be blocked.)
#   - Credentials configured     -> signing failure is a HARD FAILURE. A build
#     that was asked to sign and silently shipped unsigned is the exact bug
#     S25 exists to prevent.
#   - -Skip                      -> explicit opt-out, no warning.
#   - Every signature is verified with `signtool verify /pa /all` afterwards.

Set-StrictMode -Version Latest

function Get-SignTool {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # signtool ships with the Windows SDK and is not on PATH by default.
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }

    $candidates = foreach ($root in $roots) {
        Get-ChildItem -Path $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\(x64|x86)\\signtool\.exe$' }
    }
    $best = $candidates | Sort-Object FullName -Descending | Select-Object -First 1
    if ($best) { return $best.FullName }
    return $null
}

function Get-SignArgs {
    $tsa = $env:CODESIGN_TIMESTAMP_URL
    if (-not $tsa) { $tsa = "http://timestamp.digicert.com" }

    $common = @("/fd", "SHA256", "/tr", $tsa, "/td", "SHA256", "/v")

    if ($env:CODESIGN_THUMBPRINT) {
        return @{
            Args   = @("sign", "/sha1", $env:CODESIGN_THUMBPRINT) + $common
            Source = "store thumbprint $($env:CODESIGN_THUMBPRINT)"
        }
    }
    if ($env:CODESIGN_PFX) {
        if (-not (Test-Path $env:CODESIGN_PFX)) {
            throw "CODESIGN_PFX is set but the file does not exist: $($env:CODESIGN_PFX)"
        }
        $a = @("sign", "/f", $env:CODESIGN_PFX)
        if ($env:CODESIGN_PFX_PASSWORD) { $a += @("/p", $env:CODESIGN_PFX_PASSWORD) }
        return @{ Args = $a + $common; Source = "pfx $(Split-Path $env:CODESIGN_PFX -Leaf)" }
    }
    if ($env:CODESIGN_SUBJECT) {
        return @{
            Args   = @("sign", "/n", $env:CODESIGN_SUBJECT) + $common
            Source = "store subject '$($env:CODESIGN_SUBJECT)'"
        }
    }
    return $null
}

function Invoke-ConnectLiveSign {
    param(
        [Parameter(Mandatory = $true)][string[]]$Paths,
        [switch]$Skip
    )

    $targets = @($Paths | Where-Object { $_ -and (Test-Path $_) })
    if ($targets.Count -eq 0) { return }

    if ($Skip) {
        Write-Host "==> Code signing skipped (-SkipSign)."
        return
    }

    $cfg = Get-SignArgs
    if (-not $cfg) {
        Write-Warning ("Code signing NOT configured - shipping UNSIGNED binaries. " +
            "Windows SmartScreen will warn every installer. Set CODESIGN_THUMBPRINT, " +
            "or CODESIGN_PFX (+ CODESIGN_PFX_PASSWORD), or CODESIGN_SUBJECT before a " +
            "public release. Pass -SkipSign to silence this for local builds.")
        return
    }

    $signtool = Get-SignTool
    if (-not $signtool) {
        throw "Code signing was requested but signtool.exe was not found. Install the Windows 10/11 SDK (Signing Tools), or re-run with -SkipSign."
    }

    Write-Host "==> Signing $($targets.Count) artifact(s) via $($cfg.Source)..."
    foreach ($t in $targets) {
        & $signtool @($cfg.Args + @($t))
        if ($LASTEXITCODE -ne 0) {
            throw "signtool sign failed for '$t' (exit $LASTEXITCODE). Fix the certificate configuration or re-run with -SkipSign."
        }

        & $signtool @("verify", "/pa", "/all", $t)
        if ($LASTEXITCODE -ne 0) {
            throw "signtool verify failed for '$t' (exit $LASTEXITCODE) - the signature or its chain is not trusted."
        }
        Write-Host "  Signed + verified: $($t -replace '/','\')"
    }
}
