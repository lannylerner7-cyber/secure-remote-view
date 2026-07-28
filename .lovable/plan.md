## Bugs to fix

**A. Admin exe stalls after super-admin login and never fetches signals.**
Login succeeds (auth logs show 200 for `197200`), the live-view window opens, but transport sticks at `http-poll` forever. Root cause is silent exception swallowing:
- `LiveSessionViewModel.Start` fires `_framePump.Start` and `_rtc.StartAsync` as `_ = ...` fire-and-forget.
- `WebRtcClient.PollAgentSignals` and `FrameFallbackPump` use bare `catch { }`.
- `ApiClient.SendSupabaseAsync` returns the failed response opaquely instead of surfacing status + body.
Any 401/403 from PostgREST kills the background loop with no UI feedback.

**B. Agent runs, then disconnects with `401 Unauthorized` and the tray exits.**
`HeartbeatAsync` / `HelloAsync` / signal/frame/cursor/input calls all call `EnsureSuccessStatusCode()`. If the device row was deleted from the admin console (or its `metadata.token_hash` was rewritten), `verifyDevice` returns 401 → exception bubbles into `Agent.RunAsync` and the tray tears down. No self-heal path back to `EnrollIfNeededAsync`.

## Fix plan

### 1. Agent — auto-recover from 401 with a single-flight re-enroll lock
Files: `agent/src/ApiClient.cs`, `agent/src/Agent.cs`.

- Add `private static readonly SemaphoreSlim _enrollLock = new(1, 1);` at the top of `ApiClient`, plus a private `_tokenGeneration` counter so racing callers can tell whether re-enroll already happened.
- Introduce `SendAuthedAsync(Func<HttpRequestMessage> build, CancellationToken ct)` that:
  1. Snapshots `_tokenGeneration`, builds the request, calls `AddAuth`, sends.
  2. On `401`: `await _enrollLock.WaitAsync(ct)`, then check if `_tokenGeneration` already advanced (another loop re-enrolled) — if so, just retry with the fresh token; otherwise wipe `device.dat`, call `EnrollIfNeededAsync`, bump `_tokenGeneration`, release the lock, retry once.
  3. If the retried request is still `401`, treat enrollment as revoked: raise a one-shot tray balloon "Enrollment revoked — reinstall required" and back off 60s before the next attempt (do not spin).
- Route `HeartbeatAsync`, `HelloAsync`, `SubmitConsentAsync`, `AckPowerCommandAsync`, `PushSignalAsync`, `PollAdminSignalsAsync`, `PushFrameAsync`, `PushCursorAsync`, and the input pull through `SendAuthedAsync`.
- `Agent.RunAsync`: catch `HttpRequestException` around the heartbeat loop with exponential back-off (5→10→20→30→60s) instead of tearing down.

Concurrency guarantees: only one thread ever performs the file-delete + re-enroll; other loops park on `_enrollLock`. Because we re-check `_tokenGeneration` inside the lock, a burst of 5 concurrent 401s produces exactly 1 enroll call.

### 2. Admin — make session start and signal polling loud
Files: `admin/src/Api/ApiClient.cs`, `admin/src/ViewModels/LiveSessionViewModel.cs`, `admin/src/ViewModels/DevicesViewModel.cs`, `admin/src/Media/WebRtcClient.cs`, `admin/src/Media/FrameFallbackPump.cs`.

- Add `public sealed class SupabaseCallException : Exception { public int Status; public string Body; }` and throw it from `SendSupabaseAsync` when the retried response is non-2xx. `RefreshSessionAsync` failure path still returns cleanly so the caller can prompt re-login.
- `DevicesViewModel.Connect`: `try/catch (SupabaseCallException ex)` → `MessageBox.Show($"Cannot start session ({ex.Status})\n{ex.Body}")`. This exposes the RLS reason the super_admin insert is (or isn't) failing.
- `WebRtcClient` and `FrameFallbackPump`: replace bare `catch { }` with a `_consecutiveErrors` counter; after 3 in a row, invoke a new `Action<string>? onError` callback with `$"{status}: {snippet}"`.
- `LiveSessionViewModel.Start`:
  - `await` the first `PushSignalAsync("offer", …)` so a failure updates `Transport = "signaling failed: …"` immediately.
  - Wire the `onError` callback into `Transport` via the WPF dispatcher — **all UI mutations from background loops must go through `Application.Current.Dispatcher.InvokeAsync(...)`** to avoid a cross-thread access violation:

    ```csharp
    void SurfaceError(string msg) =>
        Application.Current?.Dispatcher.InvokeAsync(() => Transport = $"error: {msg}");
    ```

  - Apply the same marshaling to the existing `TakenOver`/`TakenOverMessage` writes (they already do, keep them).

### 3. Verify RLS on `sessions` and `session_signals` for the super_admin path
Use `supabase--read_query` to inspect the live policies before we finalise the diff:
- `sessions` — confirm INSERT policy allows `authenticated` where `technician_id = auth.uid()` OR `has_role(auth.uid(),'super_admin')`. The take-over migration only rewrote signal/frame/input/cursor RLS.
- `session_signals` — confirm INSERT WITH CHECK covers the super_admin case (it currently reads `EXISTS session s WHERE s.technician_id = auth.uid() OR has_role(...,'super_admin')` — should be fine as long as the super_admin also owns the session they created; the loud UI in step 2 will name the exact rejection if not).

Open a small follow-up migration ONLY if step 2's newly-loud UI reports a real RLS rejection for the super-admin. This is a conditional step — the primary fix is client-side.

### 4. Repackage
Rebuild `ConnectLive-RemoteAgent.zip` and `ConnectLive-AdminConsole.zip` after both codebases compile clean; deliver as artifacts.

## Technical notes
- Publishable-key + Bearer JWT PostgREST calls stay as-is — this pairing is correct for opaque `sb_publishable_` keys.
- Do not touch `src/integrations/supabase/*` (auto-generated).
- Existing `RefreshSessionAsync` on `401` still runs first inside `SendSupabaseAsync`; the new `SupabaseCallException` only fires when the retried request is *still* non-2xx.
- Agent re-enroll retry is exactly one per request; a second 401 escalates to the balloon + 60s cooldown so a revoked deployment key does not hammer the gateway.
- Every background→UI write in the admin exe must go through `Dispatcher.InvokeAsync`; a plain assignment to an `[ObservableProperty]` from a non-UI thread throws `InvalidOperationException` and looks identical to "stalled".

## Out of scope
- No web console changes.
- No new endpoints or route renames.
- No RLS migration unless step 3 proves one is needed.