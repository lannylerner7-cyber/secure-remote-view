## Goal

Do a final correctness pass over the two Windows clients, remove the pile of duplicate/stale zip archives, and cut one clean pair of source bundles.

## 1. Client-side verification (read-only)

**Agent (`agent/src/`)**
- `ScreenCapture.cs` — confirm the tee packs tightly (`width*4` per row), swaps R/B, forces alpha `0xFF`, keeps the JPEG path on the untouched bitmap, and that the 500 ms idle keep-alive is in place.
- `WebRtcSession.cs` — `PushFrame` has no stride argument and no caller passes a strided buffer.
- `DxgiCapture.cs` — `Format32bppRgb` + `SourceCopy` still intact (the darkening fix).
- `ApiClient.cs` — every endpoint it calls exists under `src/routes/api/public/**`; no dead `X-Deployment-Key`; ICE + power-ack routes present.
- `StartupSelfHeal.cs` / `StartupRegistration.cs` — three autostart triggers, `/background` lowercase, dev-path guard.
- Project file: `AllowUnsafeBlocks`, `ApplicationIcon`, assembly name `ConnectLive`; no leftover updater/watcher references anywhere in `agent/`.

**Admin (`admin/src/`)**
- `Api/ApiClient.cs` — endpoints and column names match the live schema; ICE fetch present.
- `Media/WebRtcClient.cs`, `RealtimeChannel.cs`, `FrameFallbackPump.cs`, `CursorPollPump.cs` — cadences and fallback ordering as designed.
- `ViewModels/LiveSessionViewModel.cs` — transport taxonomy and watchdog wording match the web console.
- `Input/InputCoalescer.cs` — moves flushed before discrete clicks/keys.
- `Ui/AppIcon.cs` + `assets/icon.ico` present and wired.

Anything broken and unambiguous gets fixed in this pass; anything ambiguous is reported, not silently changed.

## 2. Zip cleanup

Current state is messy — 16 archives in `/mnt/documents` plus 7 duplicated copies in `public/`:

```text
/mnt/documents  v1.1 … v1.6 agent, v1.1 … v1.4 admin,
                plus unversioned ConnectLive-*-src.zip,
                ConnectLive-RemoteAgent.zip, ConnectLiveAgent.zip,
                ConnectLiveAdmin.zip, agent-src-package/
public/         7 stale copies (nothing in src/ links to them)
```

Action:
- Delete every `public/*.zip` — no route, component, or page references them, so they only bloat the deploy.
- Delete all superseded archives in `/mnt/documents`, keeping only the two new bundles.
- Remove the empty `agent-src-package/` scratch dir and the now-pointless `public/ConnectLiveAgent.zip` line in `.dockerignore`.

## 3. Repackage

Build from the live source tree (source-only: no `bin/`, `obj/`, `publish/`, `dist/`):
- `ConnectLive-RemoteAgent-src-v1.7-20260802.zip` — `agent/src`, `agent/assets`, `agent/packaging`, `build.ps1`, `INSTALL.md`, `README.md`
- `ConnectLive-AdminConsole-src-v1.5-20260802.zip` — `admin/src`, `admin/assets`, `build.ps1`, `INSTALL.md`, `README.md`

Then list each archive's contents and confirm `icon.ico`, the fixed `ScreenCapture.cs`, and the current `ApiClient.cs` are actually inside before handing them over.

## Technical notes

- No database, RLS, or ICE/TURN changes — that work stays as is.
- The colour fix can't be validated from here (needs a Windows build against a real desktop); verification is code-level. The visual check stays yours: the desert must render orange under the "WebRTC video" pill.
