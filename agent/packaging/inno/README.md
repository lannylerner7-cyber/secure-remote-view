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
  control and `Users` read+execute — the Agent runs as the interactive user
  and must read `deployment.key`.
- Copies `ConnectLiveAgent.exe` and `ConnectLiveWatcher.exe` into
  `%ProgramFiles%\ConnectLive\`.
- On upgrade: `BeforeInstall: StopWatcherService` stops the running Watcher
  before copy so its exe lock releases (Restart Manager alone doesn't cover
  `LocalSystem` services).
- Registers `ConnectLiveWatcher` service (`start= delayed-auto`,
  `obj= LocalSystem`, DisplayName "ConnectLive Watcher") with a self-heal
  failure policy (`restart/5000/10000/30000`, reset 60s) and starts it.
- Adds outbound-443 firewall allow rules for both binaries.
- Uninstall order: stop service → delete service → kill orphan Agent →
  remove firewall rules. `%ProgramData%\ConnectLive\` is intentionally left
  behind so device tokens survive a reinstall.

## Watcher exe lookup order (know before you refactor)

`agent/watcher/Program.cs` looks for the Agent binary at
`%ProgramData%\ConnectLive\ConnectLiveAgent.exe` first and only falls back to
`AppContext.BaseDirectory` (i.e. `%ProgramFiles%\ConnectLive\`) if that's
missing. This installer relies on the fallback — it ships the Agent to
Program Files only. If you ever move the Watcher out of `%ProgramFiles%\ConnectLive\`,
either update the primary lookup path in `Program.cs` or add a `[Files]`
entry that also drops `ConnectLiveAgent.exe` into `{commonappdata}\ConnectLive\`.

