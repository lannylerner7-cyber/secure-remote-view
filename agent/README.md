# ConnectLive Agent (Windows)

Transparent remote-support agent for managed Windows devices. Every session shows a persistent on-screen indicator, with Curtain Mode and dead-man recovery for safe takeover. No hidden capture, no detection evasion.

## What's in here

| File | Purpose |
|------|---------|
| `src/Agent.cs` | Session coordinator, heartbeat loop, frame/input/cursor streaming |
| `src/ApiClient.cs` | HTTP + WebSocket client for the ConnectLive API |
| `src/App.xaml` / `src/App.xaml.cs` | WPF entry, splash window styling |
| `src/SessionIndicator.cs` | Persistent live-session banner shown during support |
| `src/ConnectLiveAgent.csproj` | .NET 8 single-file project |
| `assets/logo.svg` / `assets/icon.ico` | ConnectLive branding |
| `build.ps1` | One-command build → `dist/ConnectLiveAgent.zip` |

## Build (on your Windows box)

Requires .NET 8 SDK.

```powershell
cd agent
./build.ps1
```

Outputs `dist/ConnectLiveAgent.exe` (single-file, self-contained) and `dist/ConnectLiveAgent.zip`.

## Sign (Authenticode)

Before deploying to endpoints, sign with your code-signing cert. Example:

```powershell
signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 dist/ConnectLiveAgent.exe
```

## Configure API base URL

Edit `src/ApiClient.cs` — set `ApiBaseUrl` to your ConnectLive gateway before building, or pass `--api-url https://helpdesk.example.com` at first run and it will be persisted to `%ProgramData%\ConnectLive\config.json`.

## Deploy (MDM/GPO)

Ship `ConnectLiveAgent.exe` through Intune, SCCM, or GPO. On first run the agent:

1. Registers with the gateway (`POST /api/devices/enroll`) — device token stored DPAPI-encrypted at `%ProgramData%\ConnectLive\device.dat`
2. Runs under the Watcher service for heartbeat + reconnect when installed
3. Runs a per-user tray app plus the non-hideable live-session banner

## Non-negotiables (baked into the code)

- Invited sessions auto-activate for enrolled managed devices so the admin live view starts immediately.
- A persistent banner + tray icon are visible for the full duration of any session. Cannot be hidden.
- Curtain/takeover mode uses the dedicated input-blocking hooks and always releases on dead-man failure.
- End user can see the active session at all times from the banner/tray.
- No Defender exclusions requested or applied by the installer.
