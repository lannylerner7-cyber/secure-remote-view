# ConnectLive — Project Map & Change Log

The single document to open before touching anything. Route map, ownership,
known-good invariants, and a rolling log of every fix with the scope tag it
belongs to. Read the map, jump straight to the file, don't grep the repo.

---

## 1. Scope tags

Used in every changelog entry below and in commit-style notes.

| Tag | Meaning |
| --- | --- |
| `SCOPE:CONSENT` | The consent gate — nothing captures without a human "Allow" |
| `SCOPE:CAPTURE` | Pixel acquisition on the agent (DXGI, GDI fallback, encode) |
| `SCOPE:TRANSPORT` | WebRTC/ICE, signalling, HTTPS frame fallback |
| `SCOPE:PRESENCE` | Enrollment, heartbeat, wake, startup self-heal |
| `SCOPE:SESSION` | Session state machine (invited/active/paused/ended), teardown |
| `SCOPE:INPUT` | Mouse/keyboard relay, coalescing, geometry mapping |
| `SCOPE:RENDER` | Admin-side decode → BGRA → D3DImage present |
| `SCOPE:REALTIME` | Supabase Realtime channels, poll fallback |
| `SCOPE:DATA` | Schema, RLS, grants, triggers, cron/prune |
| `SCOPE:WEB` | Public site, checkout, order tracking, SEO |

---

## 2. System map

```text
 END USER PC                          SUPABASE / TSS API                 TECHNICIAN
 ───────────                          ──────────────────                 ──────────
 agent/src/Agent.cs      ──heartbeat──►  /api/public/agent/heartbeat
   ├ ConsentPrompt.cs    ──decision───►  /agent/session/:id/consent   ┌─ admin (WPF)
   ├ DxgiCapture.cs                                                  │  Api/ApiClient.cs
   ├ ScreenCapture.cs    ──jpeg───────►  /agent/session/:id/frame ────┼► Media/FrameFallbackPump
   ├ CursorPump.cs       ──x,y────────►  /agent/session/:id/cursor ───┼► Media/CursorPollPump
   ├ InputRelay.cs       ◄─poll────────  /agent/session/:id/inputs ◄──┼─ Input/MouseInjector
   └ WebRtcSession.cs    ◄─signal──────  /agent/session/:id/signal ◄──┼─ Media/WebRtcClient
                              └── RTP/VP8, STUN only ─────────────────┴► Media/VideoPipeline
                                                                          → FrameConvert
                                                                          → D3DImageHost
                                                                          → D3DImage
```

Realtime (`session_frames`, `session_cursors`) rides `admin/src/Media/RealtimeChannel.cs`;
the HTTP pumps are the fallback when a join is rejected or the socket dies.

---

## 3. Route map (server)

All under `src/routes/api/public/` unless noted. `/api/public/*` bypasses site
auth — every handler authenticates itself.

| Route | Auth | Owner concern |
| --- | --- | --- |
| `agent/enroll` | IP rate limit → issues DPAPI machine token | `SCOPE:PRESENCE` |
| `agent/hello`, `agent/heartbeat` | device token | presence + invite list |
| `agent/session.$id.consent` | device token | `invited → active \| declined` |
| `agent/session.$id.frame` | device token | JPEG upsert, `active` only |
| `agent/session.$id.cursor` | device token | detached cursor telemetry |
| `agent/session.$id.inputs` | device token | control-mode gated; safety kinds always pass |
| `agent/session.$id.signal` | device token | SDP/ICE, `attempt_id` idempotent |
| `agent/session.$id.reconnect` | device token | resume after network flip |
| `agent/power.$cmdId.ack` | device token | wake/restart acknowledgement |
| `agent/stream` | device token | SSE (dead server-side — see backlog) |
| `admin/bootstrap` | BOOTSTRAP_TOKEN | first admin provisioning |
| `auth/login` | rate-limited, `login_attempts` lockout | admin sign-in |
| `cron/reconcile-orders` | cron secret | payment reconciliation |
| `webhooks/cdp` | HMAC verified | crypto payment events |
| `stats/orders`, `health` | public read-only | no PII |

Web routes: `/`, `/order`, `/order/$id`, `/license`, `/contact`, `/privacy`,
`/terms`, `/refund`, `/connectlive/admin` (login), `/connectlive/payment`,
`/_authenticated/console`. All carry unique `head()` metadata.

---

## 4. Invariants — do not "optimise" these away

- Consent is a **click**, not a default. Timeout, closed window, or missing UI
  thread all mean decline.
- Server state machine is `invited → active | declined`; `paused` and `ended`
  come later. There is no `consented` state.
- Decode **off** the UI thread, present **on** it, drop the **oldest** frame.
- Colour is BT.601 limited range. A hue drift means someone changed the
  matrix — revert, don't tune.
- Element↔source coordinate conversion goes through `ContentRect` only.
- Every new `public` table gets `GRANT`s in the same migration as its RLS.
- Input relay is gated on `state=active AND mode=control`; `curtain_off` and
  `release_inputs` always pass (dead-man safety).

---

## 5. Change log (rolling — newest first)

### 2026 — Feel work, turn 1: predictive cursor (`SCOPE:RENDER`)

| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:RENDER` | `admin/src/Media/PredictiveCursor.cs` *(new)* | Client-side pointer prediction with server reconciliation. `Predict(nx,ny)` moves the ghost on the *local* input event; `Observe(nx,ny,visible)` feeds authoritative `CursorPump` telemetry. While predicting, telemetry eases the ghost instead of snapping it; if telemetry disagrees by more than `DisagreeThreshold` for 3 consecutive samples the predictor **surrenders** (the remote machine is clearly not following us — moved by the local user, input blocked, or a stale session). Prediction also expires after 700 ms of local idle, so an abandoned pointer always converges back onto the truth. |
| `SCOPE:RENDER` | `admin/src/ViewModels/LiveSessionViewModel.cs` | Added a `CursorSample` event fired on **every** telemetry tick. `[ObservableProperty]` suppresses `PropertyChanged` when the value is unchanged, so a pointer parked at the same coordinates used to look identical to a dead feed — the predictor needs the heartbeat to know the truth is still arriving. Added the `InputAuthoritative` gate (`Mode == "control" && CurtainOn && !TakenOver`) with change notifications wired from `OnModeChanged` / `OnCurtainOnChanged` / `OnTakenOverChanged`. |
| `SCOPE:RENDER` | `admin/src/Views/LiveSessionWindow.xaml.cs` | Ghost is now driven by the predictor. Mouse move/down/up/wheel call `Predict()` **before** the coalescer so the pointer moves in the same frame as the technician's hand; the ghost is redrawn from `CompositionTarget.Rendering` (prediction expiry and easing need a steady tick, not a telemetry-arrival tick). Prediction is enabled only while `InputAuthoritative`, so in view mode / paused / taken-over the overlay is pure telemetry and cannot lie about a session that is ignoring our input. Predicted pointer draws solid, telemetry-only dimmed to 0.75 so the two are distinguishable on screen. Render hook is detached on `Closed`. |

### 2026 — Audit follow-up, pass 2 (backlog items 1–6)

| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:CAPTURE` | `agent/src/MonitorSelector.cs` *(new)* | Single source of truth for "which display are we on". Enumerates `Screen.AllScreens` into `MonitorInfo(Index, DeviceName, Label, Bounds, IsPrimary)`, resolves the selection (explicit → primary → first), falls back to auto if the chosen display disappears, and raises `SelectionChanged`. `Select(deviceName)` is the seam the console's monitor picker will call. |
| `SCOPE:CAPTURE` | `agent/src/DxgiCapture.cs` | Walks **every adapter × output** and matches `DXGI_OUTPUT_DESC.DeviceName` against `MonitorSelector.SelectedDeviceName` instead of hardcoding `EnumOutputs(0)`; builds the D3D11 device on the adapter that actually owns that display (`DriverType.Unknown`). Falls back to adapter 0 / output 0 if the target isn't duplicable. Exposes `DeviceName` and a staleness check so a picker change forces a rebuild. |
| `SCOPE:CAPTURE` | `agent/src/ScreenCapture.cs` | Uses `MonitorSelector.Resolve()` for bounds (GDI `CopyFromScreen` now blits from the selected monitor's origin, not the primary's). Detects a monitor switch mid-session, reallocates bitmaps and re-tees. Retries DXGI every 10 s while on the GDI fallback. Exposes `MaxEdge` so cursor telemetry can share the frame's coordinate space. |
| `SCOPE:INPUT` | `agent/src/CursorPump.cs` | Was hardcoded to a 960 px edge and `Screen.PrimaryScreen` — a different coordinate space than the 1920 px frames it overlaid. Now reads `ScreenCapture.MaxEdge` + `MonitorSelector.SelectedBounds`, mirrors the even-dimension rule, and reports the cursor **hidden** when it wanders off the captured monitor instead of clamping it to a border. |
| `SCOPE:TRANSPORT` | `agent/src/WebRtcSession.cs` | Real **RTCP PLI/FIR handler**: `OnReceiveReport` inspects `Feedback.Header` for `PSFB` + `PLI`/`FIR` and calls the new `RequestKeyFrame()`, which forces an IDR with a 200 ms cooldown so a PLI storm on a lossy link can't become a keyframe storm. Request/forced counters logged at close. |
| `SCOPE:CAPTURE` | `agent/src/ScreenCapture.cs` | With real feedback wired up, the periodic full refresh relaxes from 60 frames (~2 s) to `PeriodicRefreshFrames = 300` (~10 s) — pure safety net now. `ResetKeyframeClock()` lets an RTCP-driven IDR restart the countdown so we never emit a redundant refresh right after one. |
| `SCOPE:TRANSPORT` | `agent/src/WebRtcSession.cs` | `Close()` now **disposes** `_cts` and `_handoffLock`, not just cancels — both were per-session and leaked a timer registration + semaphore handle per connect/disconnect cycle. |
| `SCOPE:INPUT` | `agent/src/WebRtcSession.cs` | Deleted `InputRelayBridge`; the data-channel path calls `InputRelay.Apply` directly (it is `internal`, same assembly — the reflection was never needed). |
| `SCOPE:PRESENCE` | `agent/src/StreamListener.cs` *(new)* | The SSE route had no client. Long-lived `GET /api/public/agent/stream` on its own `HttpClient` (infinite timeout — the shared one's 20 s would kill every keepalive gap), device-token headers, exponential reconnect to 30 s, keepalive comments skipped. `event: wake` pings the heartbeat's wake signal rather than acting on the row itself, so idempotency/rate-limit logic stays in one place. |
| `SCOPE:PRESENCE` | `agent/src/Agent.cs` | Starts the listener alongside the heartbeat. Idle heartbeat cadence is now 60 s while `StreamListener.Healthy`, snapping back to 10 s the moment the stream drops — the heartbeat stays the authoritative command path. |
| `SCOPE:WEB` | `src/routes/**`, `src/shared/api-routes.ts` | Prettier pass; `agentStream` doc comment corrected (it is no longer a reserved stub). |

### 2026 — Audit follow-up, pass 1

| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:CONSENT` | `agent/src/ConsentPrompt.cs` *(new)* | Real consent dialog: topmost, names technician + view/control, 90s **auto-decline**, closing the window = decline, opt-in "Always allow" stored at `HKCU\Software\ConnectLive\StandingConsent` (revocable via `RevokeStandingConsent`). No UI thread ⇒ decline. |
| `SCOPE:CONSENT` | `agent/src/Agent.cs` | `HandleInvite` no longer hardcodes `SubmitConsentAsync(..., true)`. It awaits the dialog, submits the real decision, and records a decline so the heartbeat doesn't re-prompt. Added `_promptingSessions` reentry guard. |
| `SCOPE:SESSION` | `agent/src/Agent.cs` | Invite handling is fire-and-forget so a 90s dialog can't stall the heartbeat/presence loop. Removed the dead `state == "consented"` branch. |
| `SCOPE:CAPTURE` | `agent/src/DxgiCapture.cs` | Recover from `ACCESS_LOST` / `DEVICE_REMOVED` / `DEVICE_RESET` / `UNSUPPORTED` by rebuilding the duplication (1/s rate limit) instead of returning null forever — resolution change, driver reset, secure-desktop switch and monitor hot-plug used to freeze the session on its last frame. Mid-session size change now resizes the staging texture in place (`ResizeStaging`). |
| `SCOPE:REALTIME` | `admin/src/Media/RealtimeChannel.cs` | Health is a **reply**, not a send: every `phx_join` must answer `status:"ok"` (10s budget) before the channel reports healthy; `phx_error`/`phx_close` tear the socket down into the reconnect ladder. Previously an RLS rejection showed as "Realtime: healthy" on a permanently silent socket. |
| `SCOPE:SESSION` | `admin/src/Api/ApiClient.cs` | `EndSessionAsync` retries 3× with backoff and logs every failure instead of swallowing non-2xx — a failed teardown used to leave a live row, a device stuck `is_session_active`, and a zombie session in the reuse path. |
| `SCOPE:TRANSPORT` | `admin/src/Media/WebRtcClient.cs` | ICE-restart escalation cap (4 attempts, counter decays after 2 min). On surrender we stop PLIs and hand the session to the JPEG fallback — previously a broken media path looped PLI→restart forever. |
| `SCOPE:DATA` | migrations | `prune_session_ephemera` actually scheduled (pg_cron was absent originally); recreated the missing `trg_sync_device_session_active` and `trg_clear_admin_binding_on_end` triggers; `bind_admin` revoked from `anon` (session-UUID hijack), `sync_device_session_active` limited to `service_role`. |

---

## 6. Backlog — next attention, in priority order

Items 1–6 of the previous backlog are **closed** in pass 2 above, and the
predictive cursor is **closed** in turn 1 above. What remains is the rest of
the "unmatched feel" work, ordered by feel-per-unit-of-effort:

1. `SCOPE:INPUT` — **Multi-monitor picker** in the console *(turn 2)*. Nearly
   free now: `MonitorSelector.Outputs()` already returns the list and
   `Select()` already rebuilds the DXGI duplication. Needs a `monitors` field
   on the heartbeat response, a `set_monitor` command, and a dropdown in
   `LiveSessionWindow`.
3. `SCOPE:TRANSPORT` — **Adaptive bitrate + resolution ladder**, driven off the
   RTCP RR loss/jitter figures the new `OnReceiveReport` handler already sees.
4. `SCOPE:INPUT` — **Relative-motion pointer mode** for games/CAD.
5. `SCOPE:CAPTURE` / `SCOPE:RENDER` — **Hardware H.264 (NVENC/QSV/AMF)** with
   VP8 fallback. Largest job: touches encode on the agent and decode in
   `admin/src/Media/VideoPipeline.cs`.

---

## 7. Candidate scopes to add (decide before building)

- **Adaptive bitrate + resolution ladder** — encode at source resolution while
  the link is healthy, step down on RTT/loss instead of dropping frames.
- **Hardware H.264 (NVENC/QSV/AMF)** with VP8 fallback — the single biggest
  sharpness/latency win over the current software VP8 path.
- **Predictive cursor** — render the admin's own pointer immediately and
  reconcile against agent telemetry, so control feels zero-latency.
- **Relative-motion pointer mode** — send deltas instead of absolute positions
  for games/CAD, and for pointer-lock style precision.
- **Multi-monitor picker** in the admin console with per-output duplication.
- **Clipboard + file drop channel** over a WebRTC data channel.
- **Session recording** (consented, watermarked) to storage for audit.
- **Unattended/standing-consent policy** surfaced in the admin UI with an
  audit entry each time it is used.
