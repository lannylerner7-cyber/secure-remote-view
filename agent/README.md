# ConnectLive Agent (Windows)

Transparent remote-support agent for managed Windows devices. Sessions require
consent, Curtain Mode has dead-man recovery, and nothing captures without an
explicit "Allow". No hidden capture, no detection evasion.

The agent has exactly **one** visible surface: a ~5 s startup splash that
doubles as the connection banner (device id + session state). There is no tray
icon, no main window and no wake pop-up — `/BACKGROUND`, `/MINIMIZED` and
`/WAKE` launches show nothing at all. The only other windows it can ever raise
are the consent prompt and the curtain overlay, both session-scoped.

## What's in here

| File | Purpose |
|------|---------|
| `src/Agent.cs` | Session coordinator, heartbeat loop, frame/input/cursor streaming |
| `src/ApiClient.cs` | HTTP client for the ConnectLive API (enroll, heartbeat, frame, signal) |
| `src/StreamListener.cs` | SSE wake channel client (`GET /api/public/agent/stream`) |
| `src/StartupSelfHeal.cs` | Re-registers its own autostart (HKCU Run, Startup shortcut, ONLOGON task) |
| `src/ConsentPrompt.cs` | Consent dialog — 90 s auto-decline, optional standing consent |
| `src/SplashWindow.xaml.cs` | The 5 s splash / connection banner — the only persistent UI |
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

## Sign (Authenticode)

Before deploying to endpoints, sign with your code-signing cert. Example:

```powershell
signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 dist/ConnectLive.exe
```

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
