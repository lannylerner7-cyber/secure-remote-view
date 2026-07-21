# ConnectLive Agent — Build & Install

Two binaries, one solution:

| Binary | Runs as | Job |
| --- | --- | --- |
| `ConnectLiveWatcher.exe` | LocalSystem (Windows Service) | Survives reboots, detects the logged-in user, spawns the Worker into their desktop session. |
| `ConnectLiveAgent.exe` | Interactive user (elevated) | Splash → Join code → screen capture, input relay, curtain overlay, shared note. |

Session 0 (services) can't capture screens or inject input — that's why the Watcher exists purely to launch the Worker inside the real user session via `CreateProcessAsUser`.

Production endpoint is baked in: **https://secure-remote-view.lovable.app**.

---

## Prerequisites

- Windows 10 / 11 / Server 2019+
- **.NET 8 SDK** (only for building — end users need nothing)
  ```cmd
  winget install Microsoft.DotNet.SDK.8
  ```

## Build (single-file, self-contained)

Open an **elevated** `cmd` in the `agent\` directory:

```cmd
:: Worker (user-session agent)
dotnet publish src\ConnectLiveAgent.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true

:: Watcher (Windows Service)
dotnet publish watcher\ConnectLiveWatcher.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true
```

Outputs:

```
src\bin\Release\net8.0-windows\win-x64\publish\ConnectLiveAgent.exe
watcher\bin\Release\net8.0-windows\win-x64\publish\ConnectLiveWatcher.exe
```

## Install (production)

From the `agent\` directory in **elevated PowerShell**:

```powershell
.\install.ps1 install
```

This copies both exes to `C:\Program Files\ConnectLive\` and registers `ConnectLiveWatcher` as an auto-start Windows service running under `LocalSystem`. The Watcher then spawns the Agent inside the interactive desktop automatically.

Uninstall:

```powershell
.\install.ps1 uninstall
```

## Dev / quick iteration (no service)

You don't need the Watcher during development — just run the Worker directly in an **elevated** shell so `BlockInput` / curtain mode work:

```cmd
cd src
dotnet run
```

The Worker will splash → prompt for a meeting code → heartbeat with exponential backoff (1 → 2 → 4 → 8 → 16 → 30 s).

## Dead-man safety

- Heartbeat fails 3× in a row → `InputBlocker.Release()` + curtain hides. The local user always regains their machine on a broken admin link.
- Curtain heartbeat ping stops for >5 s → same release path (independent watchdog inside `InputBlocker`).
- Process exit / `Ctrl+Alt+Del` (`SessionSwitch`) → same release.

## Multi-monitor mouse mapping

Admin sends normalized `(x%, y%)` against the streamed frame. Agent maps to the **virtual desktop** (`SM_XVIRTUALSCREEN` + span) and calls `SendInput` with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` so clicks land correctly on secondary/tertiary monitors.

## Live transport: WebRTC + HTTPS fallback (new)

Every session now negotiates a WebRTC peer connection alongside the existing HTTPS frame stream:

```
[1. P2P via STUN]  ──ICE fail──►  [2. HTTPS frame-stream]
  sub-100 ms latency               ~500 ms, 100% reliable
```

- **STUN**: `stun:stun.l.google.com:19302` (free, no config).
- **Signaling**: JSON offer/answer/ICE rows in `session_signals`. Agent polls
  `GET /api/public/agent/session/{id}/signal` every 500 ms; admin uses
  Supabase Realtime.
- **Video**: SIPSorcery software VP8 (~8–15% CPU on i5 @ 720p/15 fps).
- **Inputs**: reliable+ordered `RTCDataChannel` when open; otherwise the
  existing input-poll endpoint takes over — no dropped clicks.
- **No TURN**: strict NATs (~20–30% of corporate networks) transparently fall
  back to the HTTPS stream. To enable TURN later, add its URL + credentials
  as secrets and drop them into `iceServers` on both sides — no refactor.

New NuGet dependencies (bundled by `PublishSingleFile=true`, add ~5 MB to the
exe): `SIPSorcery`, `SIPSorceryMedia.Encoders`. Pure managed, no native DLLs.

**Zero-regression guarantee**: if SIPSorcery fails to initialize on the
target machine, `WebRtcSession.Start` logs a warning and the HTTPS frame
stream + input-poll loop keep working exactly as before.
