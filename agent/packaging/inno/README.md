# ConnectLive Remote Agent — Inno Setup installer

Produces a single `ConnectLiveSetup.exe` that installs the standalone Agent.
There is no helper service and no separate updater binary — wake-after-close is
delivered over the SSE stream and the Agent's own autostart self-heal.
Enrollment needs no deployment key: the Agent POSTs `/api/public/agent/enroll`
on first tick and stores the DPAPI-encrypted token in
`%LOCALAPPDATA%\ConnectLive\device.dat`.

## Prerequisites

1. Install [Inno Setup 6](https://jrsoftware.org/isdl.php).
2. Run `powershell -File agent\build.ps1` once so `agent\dist\ConnectLive.exe`
   exists — the installer script pulls that single-file publish from `dist\`.

## Build

```
iscc agent\packaging\inno\ConnectLiveSetup.iss
iscc agent\packaging\inno\ConnectLiveSetup.iss /DAppVer=1.0.260801.1200
```

Output lands in `agent\dist\ConnectLiveSetup.exe`.

## Payload

| Item | What it does |
|---|---|
| `ConnectLive.exe` | The whole product. Installed to `C:\Program Files\ConnectLive`, firewall rule added, launched `/background`. |
| Autostart | Four triggers are created at install time, all using the identical `/background` flag: HKCU Run key, HKLM Run key, all-users Startup folder shortcut, and an ONLOGON scheduled task. `StartupSelfHeal.cs` re-asserts the HKCU key + Startup shortcut on every launch as belt-and-braces. |
| Install metadata | Version and install path are recorded under `HKLM\Software\ConnectLive` for self-update and support tooling. |

### Verify the four triggers

```cmd
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ConnectLive
reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v ConnectLive
reg query "HKLM\Software\ConnectLive"
schtasks /Query /TN ConnectLiveAgent
```

The Startup shortcut lives in the all-users Startup folder (typically `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp` on English Windows).

## Interactive install

Run `ConnectLiveSetup.exe` — the wizard lets the user pick the install folder
(default `C:\Program Files\ConnectLive`).

## Silent deployment (RMM / Intune / GPO)

```
ConnectLiveSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
ConnectLiveSetup.exe /VERYSILENT /DIR="C:\Apps\ConnectLive"
```

Every step is appended to `%ProgramData%\ConnectLive\install.log`.

## Uninstall

```
"%ProgramFiles%\ConnectLive\unins000.exe" /VERYSILENT
```

Kills any lingering Agent and clears the firewall rules. `device.dat` is
removed so a re-install re-enrolls cleanly.
