Yes — the web console changes in PR#1 leave the two native clients out of sync on cadence, transport labeling, and mouse-move coalescing. This pass brings both to parity without touching signal semantics (kinds, payload shapes, admin_client_id routing, curtain heartbeat contract, bind_admin cadence all preserved).

## agent/

**`agent/src/InputRelay.cs`** — already at 25–60ms adaptive from the previous pass. Add one sanitising guard only: when a `mousemove` arrives while a newer `mousemove` is already sitting in the same drained batch for the same session, drop the older one before enqueuing (batch-local coalescer). Buttons, wheel, keys, text, curtain_* always pass through in order. Keeps raw signal semantics; only removes redundant intermediate positions the admin's rAF couldn't collapse because they came from separate transports (DB fallback path).

**`agent/src/WebRtcSession.cs`** — no signal changes. Add a small ingress coalescer on the data-channel `onmessage` handler mirroring the same rule: consecutive `mousemove` frames collapse to the latest before hitting `InputRelayBridge.Apply`. Everything else applied immediately and in order.

## admin/ (WPF native console)

**`admin/src/Input/InputCoalescer.cs`** — today runs a fixed 16ms `Task.Delay` loop. Replace with a `CompositionTarget.Rendering` (per-frame) flush so moves ride the WPF render tick instead of a background timer — matches the web console's rAF cadence and removes the 0–16ms jitter floor. Buttons/wheel/keys keep going through `MouseInjector`/`KeyboardInjector` directly and unchanged.

**`admin/src/Views/LiveSessionWindow.xaml.cs`** — before each `MouseDown`/`MouseUp`/`MouseWheel`/key event, call a new `_coalesce.FlushNow()` so the queued move lands before the ordered event (same guarantee the web `flushMoveNow()` gives). Pure ordering fix, no new signal kinds.

**`admin/src/Media/FrameFallbackPump.cs`** — 200ms fast / 1000ms idle → **120ms fast / 600ms idle** to match the web console's tighter fallback cadence. Error backoff and bind_admin 15s heartbeat unchanged.

**`admin/src/Media/CursorPollPump.cs`** — 200ms/800ms → **100ms/500ms** while in control mode (parity with web). Idle detection unchanged.

**`admin/src/ViewModels/LiveSessionViewModel.cs`** — expand the `Transport` string to the explicit labels the web console now surfaces so the native banner reads the same taxonomy: `WebRTC video`, `Realtime frames`, `Frame fallback`, `Reconnecting`, `Ended`. Values are set at the same call sites already there; no new state machine.

## Docs

**`ENDPOINTS.md`** — no route changes, but add one line noting the browser + admin now share the same coalescer cadence (per-frame flush) and the same fallback labels, so the transport matrix stays a single source of truth across all three surfaces.

## Not touched (kept raw and steady, as requested)

- Signal kinds, payload shapes, `admin_client_id` routing, `attempt_id` idempotency.
- Curtain 1s heartbeat contract and the 5s agent watchdog (RTC-first with DB fallback stays as PR#1 shipped it).
- `bind_admin` 15s cadence, take-over sequence, `terminated`/`bye` handling.
- WebRTC codec pinning (VP8), STUN config, ICE flow.
- Enrollment, power commands, SSE wake, Telegram fan-out.

## Deliverable

After edits: `bun run scripts/verify-agent-routes.ts` for the endpoint smoke, then repack both source zips as `ConnectLive-RemoteAgent-src-v1.4-<date>.zip` and `ConnectLive-AdminConsole-src-v1.3-<date>.zip` under `/mnt/documents/` and `public/`.
