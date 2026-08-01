## Startup self-heal pass (approved scope)

Focused pass. LOCALAPPDATA hidden `device.dat` + credential-reuse are already in place — untouched. Button audit is a separate future deliverable.

### Flag casing (confirmed)

`App.xaml.cs` lines 40-46 parse `/BACKGROUND`, `--background`, `/MINIMIZED`, `--minimized` with `OrdinalIgnoreCase`. All new triggers write the exact literal `/background` (lowercase) — matches. `StartupRegistration.BackgroundFlag` already uses `/background`; the self-heal and Scheduled Task will use the same constant / literal.

---

### 1. `agent/packaging/inno/ConnectLiveSetup.iss`

**Add `[Run]` entry** (post-install, before the existing Agent launch):

```
Filename: "schtasks.exe"; \
  Parameters: "/Create /F /SC ONLOGON /TN ""ConnectLiveAgent"" /TR ""\""{app}\ConnectLive.exe\"" /background"" /RL LIMITED /DELAY 0000:10"; \
  Flags: runhidden; StatusMsg: "Registering logon task..."
```

**Add `[UninstallRun]` entry:**

```
Filename: "schtasks.exe"; Parameters: "/Delete /F /TN ""ConnectLiveAgent"""; \
  Flags: runhidden; RunOnceId: "DelConnectLiveTask"
```

No other installer changes.

---

### 2. `agent/src/StartupSelfHeal.cs` (new)

Called once from `App.xaml.cs OnStartup` (replacing the existing single `StartupRegistration.RegisterStartupWithWindows()` call).

Public API: `StartupSelfHeal.EnsureAll()` — never throws, logs Warn on any failure.

Reuses `StartupRegistration.CurrentExePath()` + `IsRunningFromInstallDir()` gate (make `IsRunningFromInstallDir` `internal` for reuse). **Dev-path guard preserved** — if not running from installed dir, log once and return without touching any of the three triggers.

When running from installed dir:

- **Run key** — delegate to existing `StartupRegistration.RegisterStartupWithWindows()` (already idempotent, already writes `/background`).
- **Startup shortcut** — `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ConnectLive.lnk`. If missing, create via `WScript.Shell` COM (`Type.GetTypeFromProgID("WScript.Shell")` + late-bound `CreateShortcut`), TargetPath = installed exe, Arguments = `/background`, WorkingDirectory = install dir, WindowStyle = 7 (minimized). If present, do not overwrite.
- **Scheduled Task** — `schtasks /Query /TN ConnectLiveAgent` (hidden window, capture exit code). Non-zero → run the same `schtasks /Create /F /SC ONLOGON /TN ConnectLiveAgent /TR "\"<exe>\" /background" /RL LIMITED /DELAY 0000:10`. Never modify a present task.

All three checks run every launch; each is independent (one failure does not skip the others).

---

### 3. `agent/src/App.xaml.cs`

- Replace line 101 `try { StartupRegistration.RegisterStartupWithWindows(); } catch { }` with `try { StartupSelfHeal.EnsureAll(); } catch { }`.
- No other changes in this pass (tray/StopFlag/etc. stay as-is — that's for the later cleanup pass).

---

### 4. Verification

- `bunx tsgo --noEmit` (unaffected but run for hygiene).
- Manual reboot test checklist appended to `.lovable/plan.md`:
  1. Install via `ConnectLiveSetup.exe` → verify task `ConnectLiveAgent` exists (`schtasks /Query /TN ConnectLiveAgent`), Run key exists, `.lnk` exists.
  2. Reboot → Agent in Task Manager after logon.
  3. Delete Run key → reboot → Agent still comes up (task fires).
  4. Delete Run key + `.lnk` → reboot → Agent still comes up (task fires).
  5. Restore Run key + `.lnk` via self-heal → confirm on next Agent launch.
  6. Uninstall via `unins000.exe` → task gone (`schtasks /Query` returns error).
  7. Run agent from `Downloads\...` build → confirm no autostart entries written (dev-path guard).

---

### Deferred (explicitly not in this pass)

- Full per-button audit across `MainWindow.xaml`, `LiveSessionWindow.xaml`, and `console.tsx` — own deliverable after reboot test passes.
- Updater/tray cleanup, live-view sharpness, dormant-pipeline comments — separate passes.
- ## ConnectLive Agent — Standalone Architecture (execution plan)
  Implements the spec you pasted, verbatim in intent. One payload `ConnectLive.exe`), three redundant logon triggers, hidden encrypted device store, self-healing autostart, sharper live view. Updater/Watcher is gone; wake pipeline goes dormant (commented, not deleted). No SYSTEM service.
  ---
  ### 1. Remove the helper service surface
  **Delete**
  - `agent/updater/` (whole folder)
  - `agent/run-elevated.ps1`, `agent/install.ps1`
  - `agent/src/StopFlagWatcher.cs`
  - `agent/src/TrayIcon.cs` (headless — no tray)
  - `.lovable/[plan.md](http://plan.md)` (stale)
  **Comment out as "Phase 2 dormant" (do NOT delete)**
  - `src/routes/api/public/agent/stream.ts` — wrap body in early `return new Response("dormant", { status: 410 })` with a header banner comment.
  - `src/routes/api/public/agent/power.$cmdId.ack.ts` — leave file, guard `wake_agent` kind only; other kinds (reboot/shutdown/lock) keep working.
  - `agent/src/StreamListener.cs` — keep source, stop instantiating it in `App.xaml.cs`.
  - Server `power_commands` table + `wake_agent` handling in existing edge code — untouched (reboot/shutdown/lock still use it).
  **Keep** MSI/Inno/GPO/Intune/Jamf packaging — they now deploy a single Agent EXE, no service component.
  ---
  ### 2. Three redundant logon triggers (installer + self-heal)
  **Installer `agent/packaging/inno/ConnectLiveSetup.iss`)** writes all three, targeted at `{app}\ConnectLive.exe /background`:
  1. HKCU `…\Run\ConnectLive` — via `[Registry]` for interactive installs.
  2. Startup shortcut `%APPDATA%\…\Startup\ConnectLive.lnk` — via `[Icons]`.
  3. Scheduled Task `ConnectLiveAgent` `SC ONLOGON`, `RL LIMITED`, `/DELAY 0000:10`) — via `[Run]` calling `schtasks /Create /F`. Machine-wide task is the reliable fleet autostart for silent Intune/GPO deploys.
  Also: keep the outbound HTTPS 443 firewall rule. Remove every service`sc.exe` line, remove the `Components` block for the Updater.
  **MSI `agent/packaging/msi/ConnectLive.wxs`)**
  - Drop `ServiceInstallServiceControl` components.
  - Keep the file component, firewall rule, and add a `CustomAction` that runs `schtasks /Create /SC ONLOGON /TN ConnectLiveAgent /TR "\"[INSTALLFOLDER]ConnectLive.exe\" /background" /RL LIMITED /F` post-install (with `Execute="deferred"`, `Impersonate="no"`).
  - HKCU Run key is deferred to Agent self-heal on first per-user launch (fleet SYSTEM install has no user hive at install time).
  **Agent self-heal `agent/src/StartupRegistration.cs`)** — extend the existing installed-path guard:
  - Method `EnsureAllTriggers()` called on every startup.
  - Rewrites HKCU Run value if missing/wrong.
  - Recreates Startup `.lnk` (via `IWshShell`/COM through `Type.GetTypeFromProgID("[WScript.Shell](http://WScript.Shell)")`) if missing.
  - Runs `schtasks /Query /TN ConnectLiveAgent`; on non-zero exit, `schtasks /Create …` to reinstate.
  - All three only written when running exe path == installed path (existing guard). Dev runs from Downloads/dist never overwrite installed autostart.
  - All failures logged Warn, never fatal.
  ---
  ### 3. Agent lifecycle — headless, resilient
  `*agent/src/App.xaml.cs*`* rewrite highlights:
  - Drop `*tray`,* `singleInstance` UI reveal path, `StopFlagWatcher` calls. Single-instance mutex stays; second launch just exits silently.
  - No SplashWindow when `/background`. Foreground launch (double-click, Start Menu shortcut) shows a status window; background launch shows nothing.
  - `ExitApplication` removed. Only quit paths: process end at logoff / explicit Task Manager kill / `_cts.Cancel()` from `OnExit`.
  - Startup order:
    1. `StartupRegistration.EnsureAllTriggers()` (never fatal).
    2. Construct `ApiClient` (reads/creates `device.dat` — §4).
    3. Kick heartbeat + Realtime subscription loops at app scope (they no-op until credentials load).
    4. Subscribe `NetworkChange.NetworkAvailabilityChanged` → force immediate enroll/heartbeat tick.
    5. `Agent.RunAsync` (indefinite retry loop — §5).
  `*agent/src/Agent.cs*`*
  - `RunAsync` already loops; verify no path throws upward. Wrap enroll/hello in `while (!ct.IsCancellationRequested)` with 5s backoff + jitter (existing pattern; assert it's unconditional).
  - On each iteration tick, re-load `device.dat` so a just-completed enroll engages the Realtime channel same tick.
  - Realtime channel backoff: 1s → 30s cap, reset on successful subscribe `webrtc-live.ts` / `RealtimeChannel.cs` on admin already do this — mirror on agent side inside `WebRtcSession`/heartbeat subscribers).
  - `InputRelay` gate: change from any window-visibility gate to `session._cts.Token` / `_activeSessionId != null` only. Confirmed target file: `agent/src/InputRelay.cs`.
  ---
  ### 4. Hidden encrypted device store `device.dat`)
  `*agent/src/ApiClient.cs*`*
  - Move path from `%ProgramData%\ConnectLive\device.dat` → `%LOCALAPPDATA%\ConnectLive\device.dat`.
  - After write: `File.SetAttributes(path, FileAttributes.Hidden | FileAttributes.System | FileAttributes.NotContentIndexed)`.
  - One-time migration: on first construction, if old ProgramData copy exists and new one doesn't, DPAPI-decrypt old → write new → delete old.
  - DPAPI scope stays `CurrentUser`.
  - Payload adds `last_session_id` (already implicitly via `LoadSessionBinding` — consolidate into `device.dat` JSON instead of a sibling file, migrate if separate).
  **Reuse flow** (in `Agent.RunAsync`):
  ```
  if (api.DeviceId != null && api.DeviceToken != null) {
      // Skip enroll. Call /agent/hello with existing token.
      // On 401: token invalid → clear device.dat → fall into enroll branch.
  } else {
      // Enroll → persist → then hello.
  }
  ```
  No new session per boot. Existing `session.$id.reconnect` handles the "rejoin last session" path already.
  ---
  ### 5. Session join decision (existing code; verify)
  In the Realtime invite handler:
  1. If invite carries `session_id` → join it.
  2. Else read `last_session_id` from `device.dat`; call `session.$id.reconnect`; on `ok:false` clear it.
  3. Else wait — Agent NEVER auto-creates a session.
  Admin-panel new-session prompt (§5.5 of your spec):
  - `src/routes/_authenticated/console.tsx` — when a device is online but its saved session id 404s on reconnect probe, surface a "Device re-enrolled. Start a new session?" banner with a Connect button that creates a fresh session invite.
  ---
  ### 6. Live view sharpness
  `*agent/src/ScreenCapture.cs*`*
  - Normal profile (default): `*maxEdge = 1920`,* `motionQuality = 70`, `_idleQuality = 85`.
  - Low-bandwidth profile (auto-fallback): `*maxEdge = 960`,* `motionQuality = 40`, `_idleQuality = 55`.
  - Auto-downgrade trigger: 5 consecutive frames with upload latency > 400 ms (already tracked in `Agent.cs`); auto-upgrade after 30 s under 150 ms.
  - Downsample interpolation → `HighQualityBicubic` whenever `scale < 1`.
  Admin renderer already consumes whatever comes in; no admin-side changes required beyond verifying `LiveSessionWindow.xaml.cs` doesn't cap the incoming image dimensions.
  ---
  ### 7. Button/route audit (Section 7 deliverable)
  Produce `agent/BUTTON_[AUDIT.md](http://AUDIT.md)` with a filled table for every button in:
  - `admin/src/Views/MainWindow.xaml` — Connect, Reconnect, Refresh, LogOut, RoleMgmt
  - `admin/src/Views/LiveSessionWindow.xaml` — Pause/Resume, Curtain, Reboot, Shutdown, Lock, LogOff, RestartStream, RestartAgent, ScreenKeyboard, Trackpad, Disconnect
  - Web `console.tsx` — same actions + New-Session prompt
  Columns exactly per your spec: Button / Bound command / CanExecute / Transport / Agent receipt / Execution / Ack / Busy-result UI. Each row ends `YES fully wired` or `NO needs work — <file>:<symbol>`.
  Verification method: `rg` each command name across `admin/src/Api/ApiClient.cs`, `src/routes/api/public/agent/*.ts`, and `agent/src/*.cs`. Any button whose transport lands on `stream.ts` or `wake_agent` is flagged NO (dormant) with the required change.
  ---
  ### 8. Verification
  - `bun run build` + `bunx tsgo --noEmit`.
  - Update `scripts/verify-agent-routes.ts` to assert `stream.ts` returns 410 and other routes still 200/401 as designed; re-run.
  - Manual Windows smoke checklist in a fresh `[TEST-PLAN.md](http://TEST-PLAN.md)`: install → reboot → confirm Agent in Task Manager on logon, no tray, no service; delete Run key manually → reboot → Startup shortcut brings it up; delete both → Scheduled Task brings it up; delete `device.dat` → Agent re-enrolls silently; admin Connect works in all four cases.
  ---
  ### 9. Repackage
  Versioned outputs:
  - `ConnectLive-RemoteAgent-src-v2.0-<yyMMdd>.zip` (no updater/, no service)
  - `ConnectLive-AdminConsole-src-v2.0-<yyMMdd>.zip` (unchanged code; version bump only)
  Mirror to `/mnt/documents/` and `public/`.
  ---
  ### Confirmations (per spec §11)
  - All three autostart triggers write `"<installed>\ConnectLive.exe" /background` — exact casing `/background`, matched OrdinalIgnoreCase in `App.xaml.cs` (verified line 40-45).
  - Credential-reuse path skips `enroll` when `DeviceId + DeviceToken` present; only calls `/agent/hello` (no new session row).
  - `InputRelay` gated on session cancellation token only — no window/tray dependency.
  ---
  ### Out of scope (unchanged)
  - SYSTEM service / login-screen wake.
  - Self-download repair of a deleted `ConnectLive.exe`.
  - MongoDB migration.
  &nbsp;