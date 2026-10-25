# ConnectLive Agent (Windows)

Transparent remote-support agent for managed Windows devices. Sessions require
consent, Curtain Mode has dead-man recovery, and nothing captures without an
explicit "Allow". No hidden capture, no detection evasion.

After authorization, the status window minimizes to a persistent ConnectLive
notification-area (tray) icon. Double-click it to see device/session status;
its menu also offers authorization review and Disable remote access. Windows
may place notification icons in its overflow area. No status window is raised
for each live-session update. If the tray cannot be initialized, the status
window remains available instead.

Enrollment shows one page of terms and conditions (screen view, remote control,
clipboard, file transfer, per-session approval, tray, stop shortcut), an
"I have read and agree" checkbox, and **Accept** / **Decline**. Accept stays
disabled until the box is ticked and records an attended grant for view,
control, clipboard and files (no recording, no unattended). Declining, closing
the terms page, closing the status window, selecting Disable, or pressing
**Ctrl + Alt + Shift + X** withdraws local access; minimizing does not. The
shortcut also works while the privacy curtain is on. Every session still needs
the person's approval.

ICE establishes network paths; it does not lock Windows input. A curtain request
requires live control authorization. If Windows refuses the curtain display,
the existing code releases input locking. This UI update does not change that
behavior or establish that curtain rendering works on a particular Windows PC.

## What's in here

| File | Purpose |
|------|---------|
| `src/Agent.cs` | Session coordinator, heartbeat loop, frame/input/cursor streaming |
| `src/ApiClient.cs` | HTTP client for the ConnectLive API (enroll, heartbeat, frame, signal) |
| `src/StreamListener.cs` | SSE wake channel client (`GET /api/public/agent/stream`) |
| `src/StartupSelfHeal.cs` | Re-registers its own autostart (HKCU Run, Startup shortcut, ONLOGON task) |
| `src/ConsentPrompt.cs` | Consent dialog — 90 s auto-decline, optional standing consent |
| `src/SplashWindow.xaml.cs` | Tray indicator and on-demand status/stop window |
| `src/DxgiCapture.cs` / `src/ScreenCapture.cs` | Desktop Duplication capture with GDI fallback |
| `src/MonitorSelector.cs` | Which display is captured; source of truth for bounds |
| `src/BitrateController.cs` | Adaptive bitrate + resolution ladder (RTCP/latency driven) |
| `src/HwEncoderProbe.cs` | Hardware H.264 (NVENC/QSV/AMF) discovery, reported via heartbeat |
| `src/WebRtcSession.cs` | WebRTC/VP8 transport, RTCP PLI/FIR, HTTPS JPEG fallback |
| `src/App.xaml` / `src/App.xaml.cs` | WPF entry, splash window styling, launch-flag handling |
| `src/ConnectLiveAgent.csproj` | .NET 8 single-file project |
| `assets/logo.svg` / `assets/icon.ico` | ConnectLive branding |
| `build.ps1` | One-command build → `dist/ConnectLiveAgent.zip` |

## Build (on your Windows box)

Requires .NET 8 SDK.

```powershell
cd agent
./build.ps1
```

Outputs `dist/ConnectLive.exe` (single-file, self-contained) and `dist/ConnectLiveAgent.zip`.

## Sign (Authenticode) — automatic

`build.ps1` signs and timestamps every artifact itself (S25). Export one
credential before building and the agent exe, both installers, and the ZIP
payload are all signed in the right order:

```powershell
$env:CODESIGN_THUMBPRINT = "<sha1 thumbprint from Cert:\CurrentUser\My>"
powershell -ExecutionPolicy Bypass -File build.ps1
```

With no `CODESIGN_*` variable set the build still succeeds but warns loudly and
ships unsigned; with one set, a signing or verification failure aborts the
build. Use `-SkipSign` for fast local loops. Full procedure — OV vs EV,
hardware-key requirement, verification — is in `../docs/SIGNING.md`.

## Configure API base URL

Edit `src/ApiClient.cs` — set `ApiBaseUrl` to your ConnectLive gateway before building, or pass `--api-url https://helpdesk.example.com` at first run and it will be persisted to `%LOCALAPPDATA%\ConnectLive\config.json`.

## Deploy (MDM/GPO)

Ship `ConnectLive.exe` through Intune, SCCM, or GPO. On first run the agent:

1. Enrolls itself keylessly (`POST /api/public/agent/enroll`) — device token stored DPAPI-encrypted at `%LOCALAPPDATA%\ConnectLive\device.dat`
2. Self-heals its own autostart (HKCU Run key, Startup shortcut, ONLOGON scheduled task) — no helper service
3. Runs headless in the background; heartbeat + session reconnect happen in-process

## Non-negotiables (baked into the code)

- Invited sessions never auto-activate. `Agent.cs` awaits `ConsentPrompt.AskAsync` and only starts capture/input loops when the user clicks Allow (90 s auto-decline).
- Curtain/takeover mode uses the dedicated input-blocking hooks and always releases on dead-man failure.
- No Defender exclusions requested or applied by the installer.
