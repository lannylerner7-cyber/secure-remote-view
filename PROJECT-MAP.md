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
| `agent/stream` | device token | SSE wake channel — **live**; client is `agent/src/StreamListener.cs` |
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

### 2026-08-02 — Truth pass: docs ↔ code ↔ DB reconciliation (`SCOPE:DATA`, `SCOPE:WEB`)

| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:DATA` | migration | Dropped the duplicate `trg_sync_device_session_active` on `public.sessions`. Both it and `trg_sessions_sync_device_active` executed `sync_device_session_active()`; the dropped one fired on **every** update (including bare `updated_at` touches), the survivor is column-scoped (`AFTER INSERT OR DELETE OR UPDATE OF state, device_id`) and therefore the correct one to keep. Note: the pass-1 changelog named the other trigger — the *narrow* trigger wins on merit, and this entry is the correction. |
| `SCOPE:WEB` | `PROJECT-MAP.md` §3 | `agent/stream` was still documented as "dead server-side". It has had a client since pass 2 (`agent/src/StreamListener.cs`) and `ENDPOINTS.md` already described it as live. Row corrected. |
| `SCOPE:WEB` | `PROJECT-MAP.md` §6, §8 | Backlog re-indexed into Tier A / B / C with 12 ordered items; new §8 records the verified DB + code state with a date so the next audit has something to diff against. |

**Verification run (this pass)**

- Agent tree: `SplashWindow.xaml.cs`, `MonitorSelector.cs`, `StreamListener.cs`, `StartupSelfHeal.cs`, `DxgiCapture.cs` all present; zero `MainWindow`/`NotifyIcon` hits under `agent/`.
- Native console: `PredictiveCursor.cs`, `LiveSessionViewModel.cs`, `LiveSessionWindow.xaml` present — turns 1 and 2 confirmed on disk.
- Web console: **gap confirmed** — `monitors` / `selected_monitor` appear only in `src/routes/api/public/agent/heartbeat.ts`; `/console` never reads them and never enqueues `switch_monitor`. Tier A item 1.
- `src/routes/_authenticated/console.tsx` is **1,514 lines** (route shell + live view). Tier C item 8 **done** — presentational blocks now live in `src/components/console/*` with shared types in `src/lib/console-types.ts` and input mapping in `src/lib/console-input.ts`.
- DB: `power_commands_kind_check` vocabulary matches the doc; 2 active pg_cron jobs; 7 tables in `supabase_realtime`; `sessions` now carries exactly 3 triggers.

### 2026 — Agent surface reduction + verification pass (`SCOPE:PRESENCE`)


| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:PRESENCE` | `agent/src/App.xaml.cs` | The agent has exactly one visible surface: the ~5 s startup splash, which doubles as the connection banner (device id + session state). No `MainWindow`, no tray icon, no wake pop-up — `onWake: null`, and `/BACKGROUND`, `/MINIMIZED`, `/WAKE` launches show nothing at all. Splash auto-closes after 5 s and every later state change is a no-op once it is gone. |
| `SCOPE:PRESENCE` | `agent/src/SplashWindow.xaml.cs` | Borderless branded card: wordmark, indeterminate progress, live status line, Device / Session rows, and the standing consent promise. Only remaining agent UI besides `ConsentPrompt` and `CurtainOverlay`. |
| `SCOPE:WEB` | `scripts/verify-agent-routes.ts` | Power-command vocabulary assertion now includes `switch_monitor` (turn 2 added it to the DB check constraint but not to the verifier). |

**Verification run (this pass)**

- TypeScript: clean, no diagnostics.
- `scripts/verify-agent-routes.ts` → 19/19 against `https://zoomlite.live` (enroll issues a token; every device-token route 401s unauthenticated; login lockout active; PostgREST rejects keyless calls).
- `scripts/verify-payment-routes.ts` → 5/5 (`stats/orders`, unsigned CDP webhook rejected, cron requires secret, `/order` + `/license` render).
- DB: `power_commands_kind_check` confirmed to contain `switch_monitor`.
- Agent tree: no `MainWindow`/`NotifyIcon` references remain (`admin/` hits are the technician console, which is meant to have a window).

### 2026 — Feel work, turn 2: multi-monitor picker (`SCOPE:CAPTURE`)


| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:DATA` | migration | `power_commands_kind_check` extended with `switch_monitor`. |
| `SCOPE:CAPTURE` | `agent/src/ApiClient.cs` | Heartbeat payload now carries `monitors[]` (index, device_name, label, bounds, primary) from `MonitorSelector.Outputs()` plus `selected_monitor`. Re-read every beat, so hot-plug/undock shows up in the console within one heartbeat. Wrapped in try/catch — a display-enumeration failure must never cost us the heartbeat itself. |
| `SCOPE:WEB` | `src/routes/api/public/agent/heartbeat.ts` | Merges `monitors` + `selected_monitor` into `devices.metadata` alongside the LAN fingerprint, capped at 8 displays with each field normalised/length-clamped. Omitting the field never erases what's already stored. |
| `SCOPE:CAPTURE` | `agent/src/PowerRelay.cs` | New `switch_monitor` branch: resolves `device_name` (preferred) or `index` through `MonitorSelector.Select`/`SelectByIndex`. Everything downstream — DXGI duplication, GDI fallback, cursor telemetry, input mapping — already reads `MonitorSelector`, so the selection flip is the whole change. |
| `SCOPE:CAPTURE` | `admin/src/ViewModels/DevicesViewModel.cs` | Added `MonitorOption` and a `MonitorMetadata.Parse` helper; `DeviceItem` now carries `Monitors` + `SelectedMonitor` off the device row. |
| `SCOPE:CAPTURE` | `admin/src/Api/ApiClient.cs` | `GetDeviceAsync` — single-row device fetch so the live window can track displays without pulling the whole grid. |
| `SCOPE:CAPTURE` | `admin/src/ViewModels/LiveSessionViewModel.cs` | `Monitors` / `SelectedMonitor` / `HasMultipleMonitors`, seeded from the device row and refreshed on a 10 s poll. The picker is a **mirror**, not a source of truth: a pick enqueues `switch_monitor` and the next heartbeat confirms it. `_applyingRemote` guards the setter so the confirmation can't re-fire the command in a loop, and the inventory is only rebuilt when it genuinely changed (a blind `Clear()` closes an open drop-down). A switch also enqueues `restart_stream`, because the new display invalidates the encoder's reference chain and the old resolution's buffered frames. |
| `SCOPE:CAPTURE` | `admin/src/Views/LiveSessionWindow.xaml` | "Display" combo in the status bar, collapsed unless `HasMultipleMonitors`. |

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

Closed so far: audit backlog items 1–6 (pass 2), predictive cursor (turn 1),
multi-monitor picker (turn 2), agent surface reduction, docs/DB truth pass.
Re-indexed 2026-08-02 into three tiers. One item per turn, as before.

### Tier A — finish what is half-shipped

1. `SCOPE:WEB` — **Monitor picker in the browser console.** Read
   `devices.metadata.monitors` / `selected_monitor`, render a Display dropdown
   in the live view, enqueue `switch_monitor` + `restart_stream`. Mirror, not
   source of truth — identical semantics to `LiveSessionViewModel.cs`.
2. `SCOPE:TRANSPORT` — **Adaptive bitrate + resolution ladder** *(turn 3)*.
   Drive off the RTCP RR loss/jitter/RTT figures `WebRtcSession.OnReceiveReport`
   already parses. A small agent-side controller owning
   `(targetBitrate, maxEdge, fps)`, stepping **down** fast on sustained loss and
   **up** slowly on a clean window, with hysteresis so it cannot oscillate; a
   resolution step forces an IDR through the existing `RequestKeyFrame()` and
   resets the encoder reference chain (same seam the monitor switch uses). The
   HTTPS JPEG fallback gets the same ladder on its quality/interval.
3. `SCOPE:INPUT` / `SCOPE:CAPTURE` — **Relative-motion pointer mode** for
   games/CAD, plus **hardware H.264 (NVENC/QSV/AMF)** with VP8 fallback
   *(turn 4)*. Largest job: touches encode on the agent and decode in
   `admin/src/Media/VideoPipeline.cs`.

### Tier B — new capability

4. `SCOPE:SESSION` — **Clipboard sync + file drop** over a WebRTC data channel.
   Text first, then files with a size cap and an `audit_logs` row per transfer.
5. `SCOPE:SESSION` — **Consented session recording**: watermarked capture to a
   storage bucket, retention policy, audit row on start/stop. Only item that
   needs new infrastructure — there are no storage buckets yet, so this adds
   the first (bucket + RLS + grants in one migration).
6. `SCOPE:PRESENCE` — **Standing-consent policy surfaced in the console**: show
   which devices carry standing consent, allow remote revoke, write an audit
   entry every time it is exercised.
7. `SCOPE:SESSION` — **Session transcript / activity timeline** per session,
   built from the rows already in `audit_logs`, shown on a device detail page.

### Tier C — operations and hardening

8. ~~`SCOPE:WEB` — **Split `console.tsx`**~~ **DONE (this pass)**. 3,119 →
   1,514 lines. Extracted `VirtualTrackpad`, `OnScreenKeyboard`, `StatCard`,
   `DevicesTable`, `SessionsTable`, `TelegramSettings`, `TeamPanel`,
   `DirectNotifyModal`, `RemoteCursorOverlay`, `PowerMenu` into
   `src/components/console/`; shared types → `src/lib/console-types.ts`;
   `keyToVirtualKey` + `getContainedPoint` → `src/lib/console-input.ts`.
   Behaviour unchanged. Tier A items 1, 6 and 7 now land on small files.
9. `SCOPE:PRESENCE` — **Device health panel**: agent version, uptime,
   last-error, capture backend (DXGI vs GDI), monitor count. All of it already
   flows in the heartbeat; none of it is surfaced.
10. `SCOPE:DATA` — **Retention + growth guard**: row counters and a
    console-visible prune dashboard so `prune_session_ephemera` is observable
    rather than assumed.
11. `SCOPE:WEB` — **Ops status page** at `/status`, fed by
    `/api/public/health`, `stats/orders`, and an online-device count.
12. `SCOPE:DATA` — **Wake reliability metrics**: record dispatch→delivered
    latency on `power_commands` and surface a success rate, so "wake didn't
    work" becomes measurable instead of anecdotal.

---

## 7. Candidate scopes to add (decide before building)

- **Adaptive bitrate + resolution ladder** — encode at source resolution while
  the link is healthy, step down on RTT/loss instead of dropping frames.
- **Hardware H.264 (NVENC/QSV/AMF)** with VP8 fallback — the single biggest
  sharpness/latency win over the current software VP8 path.
- ~~**Predictive cursor**~~ — shipped, turn 1.
- **Relative-motion pointer mode** — send deltas instead of absolute positions
  for games/CAD, and for pointer-lock style precision.
- ~~**Multi-monitor picker**~~ — shipped in the native console (turn 2); the
  browser console is Tier A item 1.
- **Clipboard + file drop channel** over a WebRTC data channel.
- **Session recording** (consented, watermarked) to storage for audit.
- **Unattended/standing-consent policy** surfaced in the admin UI with an
  audit entry each time it is used.

---

## 8. Verified state — 2026-08-02

Snapshot of what was actually observed, so the next audit diffs rather than
re-derives. Anything here that stops being true is a regression, not a
surprise.

**Code**

| Claim | Evidence |
| --- | --- |
| Agent has one visible surface | `agent/src/SplashWindow.xaml.cs` present; zero `MainWindow` / `NotifyIcon` hits under `agent/` |
| Turn 1 + 2 shipped in the native console | `admin/src/Media/PredictiveCursor.cs`, `admin/src/ViewModels/LiveSessionViewModel.cs`, `admin/src/Views/LiveSessionWindow.xaml` |
| SSE wake has a client | `agent/src/StreamListener.cs` ↔ `src/routes/api/public/agent/stream.ts` |
| Web console has **no** monitor picker | `monitors` / `selected_monitor` appear only in `src/routes/api/public/agent/heartbeat.ts` |
| Console is modular | `src/routes/_authenticated/console.tsx` = 1,514 lines + 10 components in `src/components/console/` |
| Server routes | 11 agent routes, `admin/bootstrap`, `auth/login`, `cron/reconcile-orders`, `webhooks/cdp`, `stats/orders`, `health` (+ unauthenticated `/health` probe for Coolify) |

**Database**

| Fact | Value |
| --- | --- |
| `power_commands_kind_check` | `wake`, `wake_agent`, `reboot`, `shutdown`, `lock`, `logoff`, `restart_stream`, `restart_agent`, `switch_monitor` |
| `power_commands_state_check` | `queued`, `dispatched`, `delivered`, `failed`, `expired` |
| pg_cron jobs (both active, `*/1 * * * *`) | `reconcile-orders` HTTP post; `public.prune_session_ephemera()` |
| `supabase_realtime` publication | `devices`, `sessions`, `session_frames`, `session_signals`, `session_cursors`, `notifications`, `power_commands` |
| Triggers on `sessions` | `sessions_touch`, `trg_clear_admin_binding_on_end`, `trg_sessions_sync_device_active` (duplicate dropped this pass) |
| Row counts | 5 devices · 2 sessions · 11 orders · 3 active plans · 3 roles · 163 audit rows · 424 notifications · 4 power commands |

**Known, accepted linter findings** (pre-existing, unrelated to this pass):
two `RLS enabled / no policy` INFO rows on deliberately closed tables
(`license_lookups`, `login_attempts` — service-role only by design),
`pg_trgm` living in `public`, `SECURITY DEFINER` execute grants on the
helper functions, and leaked-password protection disabled in auth settings.

### 2026 — Console split (`SCOPE:WEB`, Tier C item 8)

- `src/routes/_authenticated/console.tsx`: 3,119 → 1,514 lines. Route keeps the
  data layer, realtime subscriptions, live-view surface and nav shell only.
- New: `src/components/console/{VirtualTrackpad,OnScreenKeyboard,StatCard,DevicesTable,SessionsTable,TelegramSettings,TeamPanel,DirectNotifyModal,RemoteCursorOverlay,PowerMenu}.tsx`.
- New: `src/lib/console-types.ts` (`Device`, `Session`, `LiveFrame`, `LiveCursor`, `Nav`, `NAV_VALUES`, `STALE_MS`, `OFFLINE_MS`), `src/lib/console-input.ts` (`keyToVirtualKey`, `getContainedPoint`).
- Pure move — no behaviour, prop or DOM change. Verified: `tsgo --noEmit` clean,
  `verify-agent-routes.ts` 19/19, `/console` returns 200 from the dev server.
- Next: Tier A item 1 — browser monitor picker in `DevicesTable` / live view.

### Turn: Tier A item 1 — browser monitor picker (`SCOPE:WEB`) — 2026-08-03

- New `src/components/console/MonitorPicker.tsx`: `readMonitors()` parses
  `devices.metadata.monitors` / `selected_monitor` defensively (agent is the
  authority; the browser never optimistically rewrites the selection), and the
  dropdown only renders when 2+ displays were reported.
- `console.tsx`: new `switchMonitor(session, monitor)` enqueues
  `switch_monitor` `{device_name,index}` then `restart_stream`, clearing the
  frame/cursor buffers first — identical semantics to
  `admin/src/ViewModels/LiveSessionViewModel.cs`. Picker sits in the live-view
  toolbar, hidden for `viewer` role.
- Verified: `tsgo --noEmit` clean, `verify-agent-routes.ts` 19/19
  (`switch_monitor` present in the power-command vocabulary).
- Next: Tier A item 2 — adaptive bitrate + resolution ladder (`SCOPE:TRANSPORT`).
