# Inno Setup — ConnectLive Remote Agent

Single-file, admin-elevated installer that registers the Watcher as a
`LocalSystem` Windows service, opens outbound 443 for both binaries, and
provisions the per-tenant deployment key into `%ProgramData%\ConnectLive\`.

## Build the installer

1. Install [Inno Setup 6](https://jrsoftware.org/isdl.php) (`iscc.exe`).
2. Build the agent + watcher binaries first — this script consumes them
   from `agent\dist\`:
   ```cmd
   build.bat
   ```
3. Compile the installer:
   ```cmd
   iscc agent\packaging\inno\ConnectLiveSetup.iss
   ```
   Output: `agent\packaging\inno\Output\ConnectLiveSetup.exe`.

Sign the resulting `.exe` with your EV cert before wide rollout.

## Silent install with deployment key

Two ways to inject the key at install time — the CLI switch wins:

```cmd
:: Method 1 — CLI switch
ConnectLiveSetup.exe /VERYSILENT /DEPLOYMENT_KEY="your-tenant-key"

:: Method 2 — sidecar file next to the installer
copy deployment.key <folder-with-installer>\
ConnectLiveSetup.exe /VERYSILENT
```

Either path writes `%ProgramData%\ConnectLive\deployment.key`, which the
Watcher picks up on first boot (see `DeploymentKey.Resolve()`).

## What the installer does

- Creates `%ProgramData%\ConnectLive\` with `SYSTEM` + `Administrators` full
  control.
- Copies `ConnectLiveAgent.exe` and `ConnectLiveWatcher.exe` into
  `%ProgramFiles%\ConnectLive\`.
- Registers `ConnectLiveWatcher` service (`start= delayed-auto`,
  `obj= LocalSystem`) and starts it.
- Adds outbound-443 firewall allow rules for both binaries.
- Uninstall stops the service, kills any running agent, deletes the service,
  and removes the firewall rules.
