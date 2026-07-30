## What's wrong

I read the admin client source (`App.xaml.cs`, `Api/ApiClient.cs`, `ViewModels/*`, `Media/*`, `Views/*`) end to end. Three separate problems explain the symptoms.

### 1. Startup can hang with no window and no error (the "nothing shows" bug)

`App.OnStartup` runs on the WPF UI thread and calls:

```csharp
Api.RefreshSessionAsync(CancellationToken.None).GetAwaiter().GetResult();
```

`RefreshSessionAsync` awaits HTTP work without `ConfigureAwait(false)`, so its continuations are posted back to the dispatcher — which is blocked by `GetResult()`. Classic sync-over-async deadlock: the process starts, never returns from `OnStartup`, and never shows a window. No exception, no prompt. On a slow/flaky link this is exactly the "start the script, nothing appears" report.

Two aggravators:
- The single-instance mutex means a previously hung, invisible instance makes every later launch either silently exit or pop "already running".
- There is no `DispatcherUnhandledException` / `AppDomain.UnhandledException` handler and no startup log, so any other early failure is also invisible.

### 2. Connection lag / stalling

- `FrameFallbackPump` polls `session_frames` every 200 ms and re-downloads the same base64 JPEG even when the agent hasn't produced a new frame — wasted bandwidth that competes with the frames that matter, producing stutter.
- `CursorPollPump` has the same re-fetch-everything pattern at 5 Hz.
- Devices `PollLoop`: `Refresh()` returns immediately when `Busy` is true, and the loop counts that as success, so a stuck refresh looks healthy while the grid goes stale; `Busy` is also mutated off the UI thread.
- Nothing in the pumps uses `ConfigureAwait(false)`, so every callback hop marshals through the dispatcher.

### 3. Route/endpoint audit

Every Supabase/gateway call in the admin client needs re-verification against the live schema and RLS (this is where the earlier `is_session_active` / `jpeg_base64` breakages came from).

## Plan

**A. Make startup unkillable and observable**
1. Show a window immediately: `LoginWindow` (or `MainWindow` when a still-valid saved session exists) is created synchronously; the refresh attempt moves to an `async void`/`Task` continuation that swaps to `MainWindow` on success. No blocking calls on the UI thread anywhere in `App.xaml.cs`.
2. Add `DispatcherUnhandledException`, `AppDomain.CurrentDomain.UnhandledException`, and `TaskScheduler.UnobservedTaskException` handlers that write to `%AppData%\ConnectLiveAdmin\admin.log` and show a message box, so a failure is never silent again.
3. Append startup breadcrumbs (config loaded, client id, session state, window shown) to the same log.
4. Harden the single-instance mutex: only treat it as "already running" when the existing instance is actually alive; release correctly on all exit paths.

**B. Kill sync-over-async and marshalling overhead**
5. Add `.ConfigureAwait(false)` to every await in `Api/ApiClient.cs`, `Media/FrameFallbackPump.cs`, `Media/CursorPollPump.cs`, `Media/WebRtcClient.cs`, `Input/*`.

**C. Stabilise the live stream**
6. `GetLatestFrameAsync` takes a `since` timestamp and filters `updated_at=gt.<last>`; the pump keeps the last `updated_at` and skips decode when nothing changed. Same treatment for `PollSessionCursorAsync`.
7. Adaptive cadence: fast (~200 ms) while frames are flowing, backing off to 1 s when the agent is idle, immediate return to fast on the next change.
8. `DevicesViewModel.PollLoop`: treat a skipped refresh as "not ok", move `Busy` onto the dispatcher, and surface consecutive-failure state in the status strip instead of an empty grid.
9. Show transport/stall state in `LiveSessionWindow` — last frame age and "waiting for agent" — driven by the pump rather than only on error.

**D. Full route re-verification (no oversight)**
10. Walk every endpoint the admin client touches and confirm the exact table, columns, filters and RLS path against the live backend:
    - `POST /api/public/auth/login`, `POST {supabase}/auth/v1/token?grant_type=refresh_token`
    - `devices` select/delete (column list incl. `is_session_active`)
    - `sessions` lookup / PATCH reuse / INSERT / end / mode
    - `session_inputs` insert, `session_signals` insert + agent poll (`admin_client_id` filter, `attempt_id` idempotency)
    - `rpc/bind_admin`
    - `session_frames` (`frame`, `updated_at`), `session_cursors`
    - `device_commands` power enqueue
    Any mismatch found is fixed in `ApiClient.cs`, and the checks are added to `scripts/verify-agent-routes.ts` so regressions are caught by the verifier rather than at runtime.
11. Cross-check the web console (`src/routes/_authenticated/console.tsx`) reads the same shapes so native and web stay in parity.

**E. Repackage**
12. Regenerate `ConnectLive-AdminConsole-src.zip` with the fixes.

## Technical notes

No schema migration is expected unless step 10 turns up a genuinely missing column — if it does, I'll add it with the required GRANT + RLS policy in the same pass. Changes are confined to the `admin/` tree plus the verifier script; the agent bundle is untouched unless the route audit exposes a shared mismatch.
