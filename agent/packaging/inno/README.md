# ConnectLive Remote Agent — Inno Setup installer

Produces a single `ConnectLiveSetup.exe` that installs the Agent + Watcher,
registers the Watcher as a LocalSystem service, and lets the first-boot
auto-enrollment flow mint the per-device token. **No deployment key is
required** — the Watcher POSTs `/api/public/agent/enroll` on first tick
and stores the DPAPI-encrypted token in `%ProgramData%\ConnectLive\device.dat`.

## Prerequisites

1. Install [Inno Setup 6](https://jrsoftware.org/isdl.php).
2. Run `build.bat` at the repo root once so
   `agent\dist\ConnectLiveAgent.exe` and `agent\dist\ConnectLiveWatcher.exe`
   exist — the installer script pulls those single-file publishes.

## Build

```
iscc agent\packaging\inno\ConnectLiveSetup.iss
```

Output lands in `Output\ConnectLiveSetup.exe` next to the script.

## Silent deployment (RMM / Intune / GPO / Jamf)

```
ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

That is the entire command line — no key, no tokens, no sidecar files.

## What the installer does

- Stops any running Watcher service and drops fresh binaries.
- Registers `ConnectLiveWatcher` as a delayed-auto LocalSystem service with
  self-heal restarts at 5s / 10s / 30s.
- Adds outbound TCP/443 firewall allow rules for both binaries.
- Starts the Watcher, which auto-enrolls on first tick.

## Uninstall

```
"%ProgramFiles%\ConnectLive\unins000.exe" /VERYSILENT
```

Removes the service, kills any lingering interactive Agent, and clears the
firewall rules. `%ProgramData%\ConnectLive\device.dat` is left in place so a
re-install on the same box keeps its identity — delete that folder manually
if you want a completely fresh enrollment.
