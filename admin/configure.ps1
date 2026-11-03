$ErrorActionPreference = 'Stop'

# This is a public client key, never a service-role key or server secret.
$path = Join-Path $PSScriptRoot 'src\admin.config.json'
Write-Host 'ConnectLive Admin source configuration'
Write-Host 'Use the publishable key from your Supabase project API Keys settings.'
Write-Host 'Project: https://esjlqcfcwewymmeghbvj.supabase.co'
$key = (Read-Host 'Paste the public sb_publishable_ key').Trim()
if ($key -notmatch '^sb_publishable_[A-Za-z0-9_-]+$') {
    throw 'Expected a public sb_publishable_ key. No configuration was changed. Do not use a secret or service-role key.'
}
$config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$config.supabaseAnonKey = $key
$json = $config | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
$key = $null
Write-Host 'Saved public client configuration to admin\src\admin.config.json.'
Write-Host 'Next: cd src; dotnet run'
Write-Host 'Do not run with --no-build after changing configuration.'
