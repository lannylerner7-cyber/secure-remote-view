# ConnectLive Agent dev launcher
# Starts `dotnet run` for the worker from an elevated PowerShell window.

$ErrorActionPreference = "Stop"

$src = Join-Path $PSScriptRoot "src"
if (-not (Test-Path (Join-Path $src "ConnectLiveAgent.csproj"))) {
  throw "ConnectLiveAgent.csproj not found at $src"
}

Start-Process dotnet -ArgumentList "run" -Verb RunAs -WorkingDirectory $src