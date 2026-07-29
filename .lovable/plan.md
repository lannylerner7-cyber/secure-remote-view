## Goal

Package the current **source** for the Admin client and the Agent client as two separate zip archives (no compilation, no `.exe`), so you can download the raw C#/.NET project trees and build them on your Windows box.

## Deliverables

Two zips written to `/mnt/documents/` and linked back in chat:

1. **ConnectLive-AdminConsole-src.zip** — contents of `admin/`
   - `src/` (ApiClient.cs, WebRtcClient.cs, FrameFallbackPump.cs, CursorPollPump.cs, LiveSessionWindow.xaml, ViewModels, etc.)
   - `ConnectLiveAdmin.csproj`, `admin.config.json`, `app.manifest`
   - `INSTALL.md`, `README.md`, `build.ps1`

2. **ConnectLive-RemoteAgent-src.zip** — contents of `agent/`
   - `src/` (Agent.cs, ApiClient.cs, WebRtcSession.cs, DxgiCapture.cs, CurtainOverlay.cs, InputRelay.cs, StopFlagWatcher.cs, App.xaml.cs, etc.)
   - `watcher/` (ConnectLiveWatcher.csproj, Program.cs)
   - `assets/`, `packaging/` (msi, gpo, intune, jamf)
   - `install.ps1`, `run-elevated.ps1`, `INSTALL.md`, `README.md`, `build.ps1`

Excluded from both: `bin/`, `obj/`, `publish/`, `dist/`, any prior `*.zip`.

## Steps (build mode)

1. `cd` into repo root, create `/mnt/documents/` output dir.
2. `zip -r /mnt/documents/ConnectLive-AdminConsole-src.zip admin -x 'admin/bin/*' 'admin/obj/*' 'admin/publish/*' 'admin/dist/*' 'admin/**/*.zip'`
3. `zip -r /mnt/documents/ConnectLive-RemoteAgent-src.zip agent -x 'agent/bin/*' 'agent/obj/*' 'agent/publish/*' 'agent/dist/*' 'agent/**/*.zip'`
4. `unzip -l` each to confirm the expected files are present, then report both download paths to you, one after the other.

Approve and I'll produce both zips.
