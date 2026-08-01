## ConnectLive v2.0 — Standalone Agent finalization

Verified current state: `StartupSelfHeal.cs` + the Scheduled Task in `ConnectLiveSetup.iss` are already in. Still present and contradicting the standalone spec: `agent/updater/`, `TrayIcon.cs`, `StopFlagWatcher.cs`, `install.ps1`, `run-elevated.ps1`, `StreamListener` still instantiated in `App.xaml.cs` (line 161), `ScreenCapture` still capped at 960px/quality 40, and `ApiClient.DevicePath` uses `ConfigDir` (needs confirming it resolves to LOCALAPPDATA).

### 1. Remove the helper-service surface
- Delete `agent/updater/`, `agent/install.ps1`, `agent/run-elevated.ps1`, `agent/src/TrayIcon.cs`, `agent/src/StopFlagWatcher.cs`.
- `App.xaml.cs`: drop `_tray`, all `StopFlagWatcher` calls (lines 64–75, 193), `ExitApplication`, and the `StreamListener` construction (line 161). Keep the single-instance mutex; second launch exits silently. Keep splash only for foreground launches, hidden under `/background`.
- `build.ps1`: drop the updater publish/`-SkipUpdater` branch; single payload `ConnectLive.exe`.
- `ConnectLiveSetup.iss`: remove the Updater optional component and any remaining service registration; keep Run key + Startup shortcut + Scheduled Task + firewall rule.
- Keep `StreamListener.cs` on disk, marked "Phase 2 dormant".

### 2. Live-view sharpness
`ScreenCapture.cs`: Normal profile becomes `_maxEdge = 1920`, motion 70, idle 85; low-bandwidth fallback stays 960/40/55. Interpolation switches to `HighQualityBicubic` when scaling down. Auto-downgrade after 5 consecutive frames >400 ms upload; auto-upgrade after 30 s under 150 ms, driven from the latency already tracked in `Agent.cs`. Verify `LiveSessionWindow.xaml.cs` does not cap incoming image size.

### 3. Device store + reuse (verify, don't rebuild)
Confirm `ConfigDir` resolves to `%LOCALAPPDATA%\ConnectLive` and that `device.dat` gets Hidden|System|NotContentIndexed. Confirm `Agent.RunAsync` skips enroll when DeviceId+Token exist, calls `/agent/hello`, and clears the store only on 401. Fix only what fails the check.

### 4. Session join + input gate
- Invite handler: explicit `session_id` → join; else `last_session_id` → `session.$id.reconnect`; else wait. Never auto-create.
- `InputRelay.cs`: gate on the session cancellation token / active session id only — remove the tray/stop.flag wording and any window dependency.
- `console.tsx`: add the "Device re-enrolled — start a new session?" banner when a reconnect probe 404s on an online device.

### 5. Button/route audit (own deliverable)
`agent/BUTTON_AUDIT.md` covering `admin/src/Views/MainWindow.xaml`, `LiveSessionWindow.xaml`, and web `console.tsx`. Columns: Button / Bound command / CanExecute / Transport / Agent receipt / Execution / Ack / Busy-result UI, each row ending `YES fully wired` or `NO needs work — file:symbol`. Anything routed through `stream.ts` or `wake_agent` is flagged dormant.

### 6. Verify and repackage
- `bun run build` + `bunx tsgo --noEmit`; re-run `scripts/verify-agent-routes.ts`.
- New `TEST-PLAN.md`: install → reboot → agent present, no tray, no service; delete Run key → reboot; delete shortcut too → Scheduled Task recovers; delete `device.dat` → silent re-enroll.
- Output `ConnectLive-RemoteAgent-src-v2.0-20260801.zip` and `ConnectLive-AdminConsole-src-v2.0-20260801.zip` to `public/` and `/mnt/documents/`, removing the v1.x zips from `public/`.

Out of scope: SYSTEM service / login-screen wake, self-repair of a deleted EXE, MongoDB.
