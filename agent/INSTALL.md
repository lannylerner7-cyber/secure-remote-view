# ConnectLive Agent — Build & Install

One binary, standalone. The old `ConnectLiveUpdater` / watcher service was
removed — the Agent persists itself and needs no helper.

| Binary | Runs as | Job |
| --- | --- | --- |
| `ConnectLive.exe` | Interactive user (elevated for curtain mode) | Splash → auto-session restore/invite handling → screen capture (DXGI), input relay, curtain overlay, WebRTC live transport. Self-heals its own autostart (HKCU Run key + Startup shortcut + ONLOGON scheduled task). |

Because capture and input injection cannot work from Session 0, the Agent runs
in the user's own desktop session — that is exactly why no LocalSystem service
is required any more.

Production endpoint is baked in: **https://zoomlite.live**.

---

## Silent auto-enrollment (no key required)

Both the 6-digit PIN pairing flow and the earlier `X-Deployment-Key` header are gone. On first boot the Agent POSTs `/api/public/agent/enroll` with just hostname/OS metadata; the server mints a random per-device token and returns `{ deviceId, deviceToken }`. The Agent DPAPI-encrypts that pair into `%LOCALAPPDATA%\ConnectLive\device.dat` (legacy `%ProgramData%` stores are migrated on first run) and all further calls authenticate with `X-Device-Id` + `X-Device-Token`.

Enrollments are throttled per source IP (backed by `login_attempts`) so a burst can't flood the devices table. A fresh device row is inert until a super-admin creates a session against it, so accidental enrollments are cheap to clean up.

---

## Enterprise deployment (Inno / MSI / Intune / GPO / Jamf)

Silent mass-deployment lives under `agent/packaging/`. The Inno Setup script is the reference channel — it consumes `agent\dist\ConnectLive.exe` produced by `build.ps1` and installs the Agent with an ONLOGON scheduled task, firewall rules, and autostart registration in one step:

```cmd
iscc agent\packaging\inno\ConnectLiveSetup.iss
ConnectLiveSetup.exe /VERYSILENT
```

The MSI / Intune / GPO / Jamf folders remain as alternate wrappers around the same single binary; none of them push a deployment key. **Sign the installer with your own EV cert before wide rollout** — the packaging pipeline produces an unsigned artifact.

---


## Prerequisites

- Windows 10 / 11 / Server 2019+
- **.NET 8 SDK** (only for building — end users need nothing)
  ```cmd
  winget install Microsoft.DotNet.SDK.8
  ```

## Build (single-file, self-contained)

One command from the `agent\` directory builds the binary and both installers:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

Or publish the binary alone:

```cmd
dotnet publish src\ConnectLiveAgent.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

Outputs:

```
agent\dist\ConnectLive.exe          (raw binary — installer payload)
agent\dist\ConnectLiveSetup.exe     (Inno installer)
agent\dist\ConnectLiveAgent.msi     (MSI for Intune / GPO)
```

## Install (production)

Run the packaged installer — there is no service to register:

```cmd
ConnectLiveSetup.exe /VERYSILENT
```

It copies `ConnectLive.exe` to `C:\Program Files\ConnectLive\`, creates the
ONLOGON scheduled task, and launches the Agent with `/background` as the
original (non-elevated) user. The Agent itself then re-asserts its autostart on
every run via `StartupSelfHeal` — Run key, Startup shortcut, and scheduled task
— so removing one of them does not stop it coming back after reboot.

Per-user state (DPAPI-encrypted device token, last session id) lives in
`%LOCALAPPDATA%\ConnectLive\`; legacy `%ProgramData%\ConnectLive` stores are
migrated automatically on first run.

After a successful active session, the Agent stores the session id in
DPAPI-protected storage. On reboot it tries
`POST /api/public/agent/session/{id}/reconnect` first, so the admin sees the
same session come back online without any user interaction.

Uninstall: Apps & Features → **ConnectLive Agent** (removes the binary, the
scheduled task, and the autostart entries).

## Dev / quick iteration

Run the Agent directly in an **elevated** shell so the low-level hooks and
curtain mode work.

If you run `dotnet run` from a normal terminal, Windows will stop it with `Win32Exception (740): The requested operation requires elevation`. That is expected because the agent manifest asks Windows for administrator rights before Curtain Mode can block local input.

Self-elevating one-liner from the `agent\src` folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process dotnet -ArgumentList 'run' -Verb RunAs -WorkingDirectory (Get-Location)"
```

Or from the `agent\` folder, run the packaged helper:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run-elevated.ps1
```

Or open **Command Prompt / PowerShell as Administrator** first:

```cmd
cd src
dotnet run
```

The Worker will splash → restore the last still-open session if one exists → otherwise idle for admin-created invites → heartbeat with exponential backoff (1 → 2 → 4 → 8 → 16 → 30 s).

## Control modes

- **Co-op (default while admin has control):** admin `SendInput` events are
  mixed natively with the local user's physical mouse/keyboard. No lag, no
  lockout — both cursors coexist.
- **Curtain / takeover:** installs `WH_MOUSE_LL` + `WH_KEYBOARD_LL` hooks on
  a dedicated STA thread with a `GetMessage` pump (0% CPU when idle). The
  callback swallows physical input in microseconds while letting admin
  `SendInput` pass at native 60+ FPS. We identify admin input two ways:
  the OS `LLMHF_INJECTED` / `LLKHF_INJECTED` mask (both base and LOWER_IL
  bits) AND a `dwExtraInfo` magic signature (`0x434C4956` — "CLIV") that
  we stamp on every SendInput. Third-party synthetic inputs (gaming mice,
  auto-clickers) that carry the injected bit but not our signature are
  blocked. `BlockInput` is no longer used — it was the source of the
  "sluggish takeover" symptom.
- **Ctrl+Alt+Del / Win+L:** the OS forwards SAS keys to a secure desktop
  no user-mode hook can intercept — same behavior as under the old
  `BlockInput`. This is by design and is the local user's guaranteed
  escape hatch.

## Dead-man safety

- Heartbeat fails 3× in a row → hooks uninstalled, curtain hides. The local user always regains their machine on a broken admin link.
- Curtain heartbeat ping stops for >5 s → same release path (watchdog inside the input pump).
- Process exit / `Ctrl+Alt+Del` (`SessionSwitch`) → same release.

## Multi-monitor mouse mapping

Admin sends normalized `(x%, y%)` against the streamed frame. Agent maps to the **virtual desktop** (`SM_XVIRTUALSCREEN` + span) and calls `SendInput` with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` so clicks land correctly on secondary/tertiary monitors.

## Live transport: WebRTC + HTTPS fallback (new)

Every session now negotiates a WebRTC peer connection alongside the existing HTTPS frame stream:

```
[1. P2P via STUN]  ──ICE fail──►  [2. HTTPS frame-stream]
  sub-100 ms latency               ~500 ms, 100% reliable
```

- **ICE servers**: fetched at session start from `GET /api/public/ice`, which
  mints short-lived Metered TURN credentials server-side (STUN + `turn:` +
  `turns:443` for firewall-hostile networks). No ICE URLs are hardcoded in the
  client any more.
- **Signaling**: JSON offer/answer/ICE rows in `session_signals`. Agent polls
  `GET /api/public/agent/session/{id}/signal` every 500 ms; admin uses
  Supabase Realtime.
- **Video**: SIPSorcery software VP8 (~8–15% CPU on i5 @ 720p/15 fps). Frames
  are handed to the encoder tightly packed (no stride padding) with the R/B
  order the encoder expects and alpha forced to `0xFF`.
- **Inputs**: reliable+ordered `RTCDataChannel` when open; otherwise the
  existing input-poll endpoint takes over — no dropped clicks.
- **TURN relay**: strict NATs relay through Metered instead of dropping to
  HTTPS. If ICE still fails entirely, the HTTPS frame stream takes over.

New NuGet dependencies (bundled by `PublishSingleFile=true`, add ~5 MB to the
exe): `SIPSorcery`, `SIPSorceryMedia.Encoders`. Pure managed, no native DLLs.

**Zero-regression guarantee**: if SIPSorcery fails to initialize on the
target machine, `WebRtcSession.Start` logs a warning and the HTTPS frame
stream + input-poll loop keep working exactly as before.

## MSI: "A newer version of ConnectLive Agent is already installed."

This dialog is a Windows Installer upgrade rule, not an Agent or Updater error.
It appeared because the MSI shipped a hardcoded `ProductVersion` of `1.0.0.0`
and `MajorUpgrade` defaulted to rejecting same-version installs, so every
rebuild refused to install over the previous one.

Fixed in the build pipeline:

- `packaging/msi/ConnectLive.wxs` now sets
  `MajorUpgrade AllowSameVersionUpgrades="yes" Schedule="afterInstallInitialize"`.
- `build.ps1` injects a moving 4-field version (`1.0.<yyMMdd>.<HHmm>` by
  default, or `-Version 1.2.0.0`) via `wix build -d Version=...`.

If a machine is still stuck on an older package:

```powershell
# find the installed product
Get-WmiObject Win32_Product | Where-Object { $_.Name -like 'ConnectLive*' } |
    Select-Object Name, Version, IdentifyingNumber

# remove it, then reinstall
msiexec /x "{PRODUCT-CODE-FROM-ABOVE}" /qn
msiexec /i ConnectLiveAgent.msi /qn
```

Apps & Features → ConnectLive Agent → Uninstall does the same thing.

## Building the installers

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1              # Inno + MSI
powershell -ExecutionPolicy Bypass -File build.ps1 -SkipMsi     # Inno only
powershell -ExecutionPolicy Bypass -File build.ps1 -SkipInno    # MSI only
```

A missing `iscc` or `wix` now fails the build instead of silently skipping a
target, so a run can no longer end with only half the artifacts.
