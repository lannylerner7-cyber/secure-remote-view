## Goal

1. Make transport status visible in the admin surfaces (Realtime connected / reconnecting / fallback polling).
2. Prove the wake path works end to end.
3. Prove enrollment → session → frame/cursor delivery works end to end.

## 1. Transport health indicator

**Web console (`src/routes/_authenticated/console.tsx`)**
- Track a single `transport` state derived from the existing `frames-{sessionId}` / `admin-live` channel subscribe callbacks: `connecting`, `live` (SUBSCRIBED + a push seen in the last 5s), `reconnecting` (CHANNEL_ERROR/TIMED_OUT/CLOSED), `polling` (subscribed but no push within 5s while the polling fallback is returning frames).
- Render a small pill in the live-view header: coloured dot + label + last-frame age in ms, plus frames/sec counter. Uses existing semantic tokens, no hardcoded colours.

**Native admin (`admin/src/ViewModels/LiveSessionViewModel.cs`, `admin/src/Media/RealtimeChannel.cs`, `admin/src/Views/LiveSessionWindow.xaml`)**
- Promote the existing `_realtimeHealthy` flag to an observable `TransportState` string + brush, fed by `RealtimeChannel`'s `onHealth` callback and by whether `FrameFallbackPump` / `CursorPollPump` produced the most recent frame.
- Add a status pill bound to it in the live window header, next to the existing banner.

## 2. End-to-end wake test

New script `scripts/e2e-wake.ts` (run with bun, against the deployed public API):
- Enroll a throwaway virtual device via `/api/public/agent/enroll`.
- Heartbeat once, then stop heart-beating so it goes offline.
- Open an SSE connection to `/api/public/agent/stream` as that device (this stands in for the updater).
- Enqueue a `wake_agent` power command the same way the admin Wake button does.
- Assert: the SSE client receives the wake event within a few seconds, then ack via `/api/public/agent/power/{id}/ack`, and confirm the command flips to `delivered`.
- Also assert the staged failure messaging: with the SSE listener closed and no LAN peer, the command path reports the precise reason rather than a generic "no online peer found".

## 3. Enrollment + render smoke test

New script `scripts/e2e-smoke.ts`:
- Enroll a virtual agent, heartbeat, create a session, push a synthetic JPEG frame to `/api/public/agent/session/{id}/frame` and a cursor to `.../cursor`.
- In parallel, subscribe with a Supabase Realtime client (same filters the admin uses) and assert both the frame and cursor arrive over Realtime, measuring latency.
- Assert the REST fallback read returns the same row (so the fallback pumps still work if the socket is down).
- Tear down: end the session, delete the test device.

Then drive the real web console in a headless browser against a live virtual agent to confirm the rendered screen and cursor overlay actually paint, and capture screenshots as evidence.

## Technical notes

- The native WPF admin cannot be compiled or executed in this Linux environment, so its indicator is verified by code review + the shared server-side assertions; the browser-driven verification runs against the web console. The virtual agent scripts exercise the exact same HTTP endpoints the C# agent uses.
- No schema changes required — `session_frames`, `session_cursors`, and `power_commands` are already in the `supabase_realtime` publication with `REPLICA IDENTITY FULL`.
- Test artifacts clean up after themselves so no stray devices/sessions linger.
- Both source zips are repackaged afterwards if the native admin files change.
