
## Confirmed already in place (no rework)
- `PowerRelay.HandleAsync` has a `wake_agent` branch that surfaces UI + acks `delivered`.
- `StreamListener.cs` exists and is started from `App.xaml.cs` for the process lifetime.
- `StartupRegistration` writes only the HKCU Run key (`"…\ConnectLive.exe" /background`) — no startup-folder shortcut anywhere in code or installer.

## Step 1 — Boot-proof enrollment (fixes network race)
- `App.xaml.cs`: move `EnrollIfNeededAsync` out of the one-shot try into a background task that retries every 5s indefinitely (warn log only, no dialogs, no exit).
- Heartbeat + SSE loops start immediately and no-op until `ApiClient.DeviceToken` is set; they engage automatically the moment enrollment succeeds — no restart needed.
- Splash still runs its 5s progress and hands off to tray regardless of enrollment state; status text reflects "Waiting for network" until the token lands.

## Step 2 — Adaptive cadence (Watcher parity)
- `StreamListener` exposes a `bool Healthy` toggled on connect / disconnect / error.
- `Agent.HeartbeatLoop`: `baseDelay` = 60s while `Healthy`, snaps to 5s when unhealthy. Existing `_wakeSignal` short-circuit stays, so SSE wakes and `wake_agent` commands still cut the sleep instantly.

## Step 3 — Make Reconnect / Restart stream / Restart agent actually work

### 3a. Migration — widen `power_commands_kind_check`
```sql
ALTER TABLE public.power_commands DROP CONSTRAINT power_commands_kind_check;
ALTER TABLE public.power_commands ADD CONSTRAINT power_commands_kind_check
  CHECK (kind = ANY (ARRAY['wake','wake_agent','reboot','shutdown','lock','logoff','restart_stream','restart_agent']));
```

### 3b. Agent — `PowerRelay.HandleAsync` new branches
- `restart_stream` → `Agent.RestartStreamAsync()`: tear down `WebRtcSession` + cancel screen/input/cursor loops for the current session, then call `EnsureSessionLoops` + rebuild `WebRtcSession`. Process stays up. Ack `delivered`.
- `restart_agent` → **soft restart preferred**: `Agent.SoftRestartAsync()` cancels session loops, closes SSE, resets heartbeat back-off, clears `_acceptedSessions`/`_currentSessionId`, re-runs enrollment (idempotent), restarts SSE listener. Ack `delivered` **before** teardown so the ack isn't lost. **Fallback**: if `SoftRestartAsync` throws, `Process.Start(currentExe, "/background")` + `Shutdown()`.
- Requires a small surface on `Agent`: `RestartStreamAsync()` and `SoftRestartAsync()` methods, plus a `PowerRelay.OnRestartStream` / `OnRestartAgent` static hook set in `Agent`'s ctor (same pattern as existing `OnWakeAgent`).

### 3c. Admin surfaces
- `admin/src/ViewModels/LiveSessionViewModel.cs`: add `RestartStreamCommand` (enqueues `restart_stream`) and `RestartAgentCommand` (enqueues `restart_agent`). Existing "Reconnect" already enqueues `wake_agent`.
- `admin/src/Views/LiveSessionWindow.xaml`: two new buttons next to the existing Restart/Reconnect row.
- `src/routes/_authenticated/console.tsx`: expose the same two actions on the device row (parity with native admin).
- `scripts/verify-agent-routes.ts`: extend the kind allow-list assertion to include the two new kinds so client/DB can't drift again.

## Step 4 — UI stays minimal
Keep `SplashWindow` (5s progress) + `TrayIcon` (double-click → surface splash briefly; right-click → Exit writes `stop.flag`). `MainWindow` is retained as-is per current code but no new banners/dialogs/repair affordances are added.

## Files touched
- **Backend:** migration for `power_commands_kind_check`.
- **Agent:** `App.xaml.cs`, `Agent.cs`, `PowerRelay.cs`, `StreamListener.cs`.
- **Admin:** `admin/src/ViewModels/LiveSessionViewModel.cs`, `admin/src/Views/LiveSessionWindow.xaml`.
- **Web console:** `src/routes/_authenticated/console.tsx`.
- **Verify:** `scripts/verify-agent-routes.ts`.

## Out of scope
`agent/watcher/`, enrollment/DPAPI/`device.dat`, installer scripts, HKCU key logic.

## Deliverable
Repackaged `ConnectLive-RemoteAgent-src.zip` and `ConnectLive-AdminConsole-src.zip` after implementation.
