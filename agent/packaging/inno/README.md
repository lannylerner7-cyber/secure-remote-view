# ConnectLive Remote Agent — Inno Setup installer

Produces a single `ConnectLiveSetup.exe` that installs the Agent and, as an
**optional component**, the background Updater service. Enrollment needs no
deployment key — the Agent POSTs `/api/public/agent/enroll` on first tick and
stores the DPAPI-encrypted token in `%ProgramData%\ConnectLive\device.dat`.

## Prerequisites

1. Install [Inno Setup 6](https://jrsoftware.org/isdl.php).
2. Run `powershell -File agent\build.ps1` once so `agent\dist\ConnectLive.exe`
   (and `agent\dist\ConnectLiveUpdater.exe`, unless `-SkipUpdater`) exist —
   the installer script pulls those single-file publishes from `dist\`.

## Build

```
iscc agent\packaging\inno\ConnectLiveSetup.iss
iscc agent\packaging\inno\ConnectLiveSetup.iss /DNoUpdater          # agent-only
iscc agent\packaging\inno\ConnectLiveSetup.iss /DAppVer=1.0.260801.1200
```

Output lands in `agent\dist\ConnectLiveSetup.exe`.

## Components

| Component | Default | What it does |
|---|---|---|
| `agent`   | always (fixed) | Installs `ConnectLive.exe`, firewall rule, launches it `/background`. Startup persistence is the Agent's own HKCU Run key. |
| `updater` | off (on only in the "Full" type) | Installs `ConnectLiveUpdater.exe` and registers `ConnectLiveUpdater` as a LocalSystem auto-start service so an admin can wake the Agent after the user closed it. |

Compiling with `/DNoUpdater` removes the component, the payload, the firewall
rule and the service code from the installer entirely.

## Interactive install

Run `ConnectLiveSetup.exe` — the wizard lets the user pick the install folder
(default `C:\Program Files\ConnectLive`) and the setup type.

## Silent deployment (RMM / Intune / GPO)

```
ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
ConnectLiveSetup.exe /VERYSILENT /COMPONENTS="agent,updater"   # include the service
ConnectLiveSetup.exe /VERYSILENT /DIR="C:\Apps\ConnectLive"
```

## Service registration

Registration uses the native Service Control Manager API (`OpenSCManager` /
`CreateService` / `StartService`), not `sc.exe`, so failures report the exact
Win32 error instead of a generic exit code. Every step is appended to
`%ProgramData%\ConnectLive\install.log`. If the service cannot start, the
install still succeeds — only remote wake-after-close is unavailable — and the
wizard says so with the log path.

## Uninstall

```
"%ProgramFiles%\ConnectLive\unins000.exe" /VERYSILENT
```

Stops and deletes the service (no-op when it was never installed), kills any
lingering Agent, and clears the firewall rules. `device.dat` is removed so a
re-install re-enrolls cleanly.
