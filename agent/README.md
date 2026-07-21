# ConnectLive Agent (Windows)

Transparent, consent-based remote-support agent for Windows. Every session requires end-user consent and shows a persistent on-screen indicator. No hidden capture, no detection evasion.

## What's in here

| File | Purpose |
|------|---------|
| `src/Agent.cs` | Windows service + tray + WPF splash + consent UI |
| `src/ApiClient.cs` | HTTP + WebSocket client for the ConnectLive API |
| `src/App.xaml` / `src/App.xaml.cs` | WPF entry, splash window styling |
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
2. Installs itself as a Windows Service (`ConnectLive Agent`) for heartbeat + reconnect
3. Runs a per-user tray app for the visible indicator and consent UI

## Non-negotiables (baked into the code)

- Every session opens in `pending-consent`. Capture starts only after the user clicks **Allow**.
- Remote control requires a **second, separate** grant.
- A persistent banner + tray icon are visible for the full duration of any session. Cannot be hidden.
- End user can revoke or end at any time from the tray.
- No global keyboard hooks. Standard `SendInput` only while control is granted.
- No Defender exclusions requested or applied by the installer.
