# ConnectLive Agent (Windows)

Transparent remote-support agent for managed Windows devices. Every session shows a persistent on-screen indicator, with Curtain Mode and dead-man recovery for safe takeover. No hidden capture, no detection evasion.

## What's in here

| File | Purpose |
|------|---------|
| `src/Agent.cs` | Session coordinator, heartbeat loop, frame/input/cursor streaming |
| `src/ApiClient.cs` | HTTP + WebSocket client for the ConnectLive API |
| `src/App.xaml` / `src/App.xaml.cs` | WPF entry, splash window styling |
| `src/TrayIcon.cs` | Persistent tray icon that carries session transparency |
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

- Invited sessions auto-activate for enrolled managed devices so the admin live view starts immediately.
- Curtain/takeover mode uses the dedicated input-blocking hooks and always releases on dead-man failure.
- No Defender exclusions requested or applied by the installer.
