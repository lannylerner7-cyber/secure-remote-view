# Deploying ConnectLive Agent via Microsoft Intune

Silent, per-machine, SYSTEM-context install. No end-user interaction and **no
deployment key** — the Agent enrolls itself keylessly on first run (see
`../../INSTALL.md`).

## Prereqs

- Built MSI at `agent/dist/ConnectLiveAgent.msi` (run `../msi/build-msi.ps1`).
- `IntuneWinAppUtil.exe` from Microsoft's [Win32 Content Prep Tool](https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool).

## Wrap

```powershell
./wrap-intune.ps1 -IntuneWinAppUtil C:\Tools\IntuneWinAppUtil.exe
```

Produces `agent/dist/ConnectLiveAgent.intunewin`.

## Upload

1. Intune admin center → **Apps → Windows → Add → Win32 app**.
2. Upload `ConnectLiveAgent.intunewin`.
3. Copy the fields from `intune-app.json`. Critically:
   - **Install command** — `msiexec /i ConnectLiveAgent.msi /qn` (no properties to fill in).
   - **Install behavior** — System.
   - **Detection rules** — MSI product code (already in `intune-app.json`).
4. **Assignments** → target the device groups you want auto-enrolled.

## Enrollment

First launch POSTs `/api/public/agent/enroll` (hostname/OS metadata only); the
server mints a per-device token which the Agent stores DPAPI-encrypted at
`%LOCALAPPDATA%\ConnectLive\device.dat`. Nothing has to be pushed, rotated, or
re-wrapped.

> Historical note: earlier builds accepted a `DEPLOYMENT_KEY` MSI property and a
> `HKLM\Software\Policies\ConnectLive\DeploymentKey` registry value pushed by a
> Configuration Profile. Both were removed with the enrollment overhaul and are
> ignored by the current Agent.
