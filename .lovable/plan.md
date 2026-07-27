## Root cause

The Allow/Deny consent dialog works and the server correctly flips the session to `active`, but the admin panel stays blank because the agent never starts the three HTTPS loops that push data:

- `ScreenCapture.RunAsync` → `/api/public/agent/session/:id/frame`
- `InputRelay.RunAsync` → `/api/public/agent/session/:id/inputs`
- `CursorPump.RunAsync` → `/api/public/agent/session/:id/cursor`

In `agent/src/App.xaml.cs`, those three loops are only launched on the cold-boot "restored session" path (lines 80–82). The normal live path — heartbeat delivers an invite → `Agent.HandleInvite` prompts consent → user clicks Allow — only starts `WebRtcSession` (agent/src/Agent.cs:175). No frame/input/cursor upload ever happens, so `session_frames` stays empty and the admin live view shows nothing. WebRTC alone can't cover it either: without a TURN server, ICE typically never reaches `connected` on the first try, and the HTTPS fallback that was supposed to carry the stream is exactly what's missing.

Route audit (all correct on the server side, no changes needed):
- `enroll`, `hello`, `heartbeat`, `reconnect`, `consent`, `frame`, `inputs`, `cursor`, `signal` all present under `src/routes/api/public/agent/` and each calls `verifyDevice`. `heartbeat` returns pending sessions in states `invited|consented|active|paused` so restored `active` sessions still surface. `consent` transitions `invited → active` and stamps `consent_at`. `pair` is intentionally 410 Gone.

## Changes

### 1. `agent/src/Agent.cs` — launch the three loops on Allow

- Add a per-session `CancellationTokenSource _sessionCts` linked to the outer token.
- In `HandleInvite`, after `SubmitConsentAsync(..., true)` succeeds and the indicator is shown, start the same three loops that `App.xaml.cs` uses on the restored-session path:
  ```csharp
  _sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
  InputRelay.SessionBanner = _indicator;
  _ = ScreenCapture.RunAsync(_api, sessionId, _sessionCts.Token);
  _ = InputRelay.RunAsync(_api, sessionId, _sessionCts.Token);
  _ = CursorPump.RunAsync(_api, sessionId, _sessionCts.Token);
  ```
  Keep the existing `WebRtcSession` start immediately after — HTTPS carries the stream, WebRTC upgrades when ICE completes.
- In `EndSession`, cancel and null out `_sessionCts` so the loops stop cleanly when the session ends server-side or the user hits End in the banner.
- In `DispatchPendingSessions`, treat sessions returned in state `active` that this agent has never accepted (edge case: cold-boot with an already-active session that wasn't restored via `/reconnect`) the same as a fresh accept — join and start the loops, skipping the consent dialog since consent is already recorded.

### 2. `agent/src/App.xaml.cs` — remove the duplicate loop start

The cold-boot restored-session path (lines 74–82) now duplicates what `Agent.HandleInvite` does. Simplify by always going through `Agent`: on a restored session, pre-seed `_acceptedSessions` and `_currentSessionId` inside `Agent`, then let the first heartbeat's `active` entry trigger the normal join path. This gives one code path for "session is running" so future fixes only touch one place.

Concretely: replace the `if (string.IsNullOrEmpty(sessionId))` split with a single `agent.RunAsync(...)`, passing the restored `sessionId` (if any) into a new `Agent` ctor arg or a `SeedRestoredSession(sessionId)` call before `RunAsync`.

### 3. No admin-panel or server-route changes

`session_frames`, `session_cursors`, and `session_inputs` realtime subscriptions in `src/routes/_authenticated/console.tsx` are already wired correctly — they simply had nothing to display. Verified by re-reading the frame route and heartbeat route.

## Verification

- Build the agent locally (`dotnet build agent/src`) and confirm no new warnings.
- Manual smoke: enroll a test device, click "Take control" in `/console`, then Allow on the agent. Within ~1s the live view should show frames; the FPS badge should read ~30; the SVG cursor overlay should track movement; typing in the input tunnel should land on the remote.
- Repackage `ConnectLiveAgent.zip` after the fix is verified.
