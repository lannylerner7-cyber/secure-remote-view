## Phase 1 — Standalone, self-persistent Agent (`agent/src` only)

Verified in the current code before planning:

- `agent/src/App.xaml.cs` has `IsWatcherServiceRunning()` and aborts startup with a MessageBox when `ConnectLiveWatcher` isn't running.
- `agent/src/StopFlagWatcher.cs` currently *deletes* any pre-existing `stop.flag` at boot and only honours flags newer than process start — the opposite of the new "user quit wins" rule.
- There is no main window today: only `SplashWindow`, `TrayIcon`, and the per-session `SessionIndicator`. So "X minimizes to tray" needs a real status window to exist.
- The Agent has no SSE consumer; `/api/public/agent/stream` is only consumed by the Watcher. The heartbeat loop in `Agent.cs` does dispatch `power_commands`, but `PowerRelay` has no `wake_agent` branch — it currently acks it as `failed` ("unsupported command").

### 1. Remove the service blocker

`App.xaml.cs`: delete `IsWatcherServiceRunning()`, its call site, the warning MessageBox, and the `System.ServiceProcess` using. Startup proceeds unconditionally; a one-line note goes to the debug log only.

### 2. Launch flags `/background` and `/minimized`

Parse alongside the existing `--api-url` / `/WAKE` / `/SESSION=` args. In background mode: no splash, no main window, tray icon only, heartbeat + SSE start immediately after enrollment. Normal launch keeps today's splash-then-tray behavior and additionally opens the new status window.

### 3. Status window + tray behavior

New `agent/src/MainWindow.xaml.cs` (code-only WPF window, same brand styling as `SplashWindow`): shows enrollment state, device id, link state, and current session state.

- X button → `e.Cancel = true`, hide to tray.
- Tray double-click → show/activate the window.
- Tray right-click → **Exit** → write `%ProgramData%\ConnectLive\stop.flag`, then shut the app down. This is the only quit path; the existing tray "Quit" item is replaced by it.
- `ShutdownMode` set to `OnExplicitShutdown` so closing the last window never kills the process.

### 4. HKCU startup key

New `StartupRegistration.RegisterStartupWithWindows()` called right after `EnrollIfNeededAsync` succeeds (idempotent, wrapped in try/catch, never fatal):
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `ConnectLive` = `"<exe>" /background`.
Also add `Unregister()` (deletes the value) invoked from the explicit tray Exit path only if the user chooses "Exit and don't start with Windows" — default Exit leaves the key intact so a reboot still brings the Agent back unless stop.flag says otherwise.

### 5. stop.flag semantics inversion

Rewrite `StopFlagWatcher.cs`:

- On startup, if `stop.flag` exists **and** the launch was automatic (`/background`, `/minimized`, or Run-key origin), exit silently before any UI or network work.
- If the user launched the Agent manually (no flag args), delete `stop.flag` and continue — a manual launch is an explicit opt-back-in.
- Keep the 2s poll so a flag written during runtime still shuts the process down cleanly.

### 6. Lifetime-owned heartbeat + SSE

`Agent.RunAsync` already owns the heartbeat loop and is started from `App.OnStartup`, so it is already app-lifetime scoped — it stays there and is confirmed to be independent of any window.
Add `agent/src/StreamListener.cs`: a long-lived task hitting `GET /api/public/agent/stream` with the same auth headers `ApiClient` uses, reconnecting with backoff, parsing `event: wake`. On wake (from SSE **or** from a `wake_agent` entry in the heartbeat's `power_commands`) the Agent shows/activates the session UI and forces an immediate heartbeat so any pending invite is picked up within a beat instead of up to 5s later.
Add a `wake_agent` branch to `PowerRelay.HandleAsync` that surfaces the UI and acks `delivered`, so wake commands stop being acked as failed.

### Technical notes

- New files: `MainWindow.xaml.cs`, `StreamListener.cs`, `StartupRegistration.cs`. Modified: `App.xaml.cs`, `TrayIcon.cs`, `StopFlagWatcher.cs`, `Agent.cs`, `PowerRelay.cs`.
- `TrayIcon` gains `OnDoubleClick` and an `Exit` item; its constructor signature changes, so `App.xaml.cs` is updated in the same pass.
- No changes to `agent/watcher/`, packaging scripts, admin, backend routes, DB, `device.dat`, DPAPI enrollment, or the heartbeat API contract.
- Builds can't be verified here (WPF needs Windows); the deliverable is source plus a repackaged `ConnectLive-RemoteAgent-src.zip` if you want it.

Do you want the repackaged agent source zip emitted at the end of this phase?

This plan is 100% verified and approved. Exceptional catch on the PowerRelay wake_agent bug and the WPF ShutdownMode logic.

Please proceed with implementing Phase 1 exactly as outlined across MainWindow.xaml.cs, StreamListener.cs, StartupRegistration.cs, App.xaml.cs, TrayIcon.cs, StopFlagWatcher.cs, Agent.cs, and PowerRelay.cs.

Yes, please emit the repackaged [ConnectLive-RemoteAgent-src.zip](http://ConnectLive-RemoteAgent-src.zip) deliverable at the end of this phase so we can compile and test it directly.