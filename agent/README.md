# ConnectLive Agent (Windows)

Transparent remote support with one pairing-code screen in ConnectLive colors.
The administrator's organization and permitted access are reviewed inline;
**Pair and connect** records the local acceptance. There is no separate
authorization popup or status/splash window. Attended sessions still require
their chosen per-session approval. No hidden capture or silent permission grants.

After pairing the Agent runs in the background: no status window, tray menu,
or Stop/Disconnect control UI. The code is the only input; the administrator's
access choices are read-only context. Local withdrawal still works through
`ConnectLive.exe /disable`, `.\run.ps1 -Disable`, or uninstalling.

**Start here: [RUN-SOURCE.md](RUN-SOURCE.md).** On your Windows terminal, run
`.\run.ps1 -Pair` to build and test the actual source before any MSI bundling.

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
| `src/StartupSelfHeal.cs` | Locally opted-in HKCU Run entry and visible per-user Watch task |
| `src/StartupSetup.cs` | Explicit owner startup setup; never grants remote access |
| `src/PairingPrompt.cs` | One pairing-code screen with inline organization/access review |
| `src/DxgiCapture.cs` / `src/ScreenCapture.cs` | Desktop Duplication capture with GDI fallback |
| `src/MonitorSelector.cs` | Which display is captured; source of truth for bounds |
| `src/BitrateController.cs` | Adaptive bitrate + resolution ladder (RTCP/latency driven) |
| `src/HwEncoderProbe.cs` | Hardware H.264 (NVENC/QSV/AMF) discovery, reported via heartbeat |
| `src/WebRtcSession.cs` | WebRTC/VP8 transport, RTCP PLI/FIR, HTTPS JPEG fallback |
| `src/App.xaml` / `src/App.xaml.cs` | WPF entry, brand resources, pairing-only startup and launch flags |
| `src/ConnectLiveAgent.csproj` | .NET 8 single-file project |
| `assets/logo.svg` / `assets/icon.ico` | ConnectLive branding |
| `run.ps1` | Manual source build/run, optional startup request, and local disable without a control UI |
| `build.ps1` | Deferred installer/release packaging, including MSI generation |
| `Verify-Startup.ps1` | Read-only Windows startup/process/heartbeat check before and after reboot |

## Installer packaging (only after manual source testing)

Requires .NET 8 SDK and the documented installer tools. This is not the
terminal-test command. `-SkipInno` still creates an MSI.

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

Deploy the complete MSI/Inno payload, not a lone executable. Installation alone
does not enroll a device or enable startup. The intended user pairs locally,
then explicitly approves **ConnectLive - enable Windows startup**.
The Agent starts after that Windows user signs in; Watch recovery requires fresh
server authority and never bypasses withdrawal or device revocation.

See [INSTALL.md](INSTALL.md) for exact build commands, status meanings,
uninstall/reinstall safeguards and the real-Windows acceptance checklist.

## Non-negotiables (baked into the code)

- Attended/unattended behavior follows the accepted grant; software installation, a saved session ID or process launch is not consent.
- Curtain/takeover mode uses the dedicated input-blocking hooks and always releases on dead-man failure.
- No Defender exclusions requested or applied by the installer.
