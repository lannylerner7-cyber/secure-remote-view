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
   │   └ InputBlocker.cs  (curtain: LL hooks swallow physical input)  │
   ├ StartupRegistration.cs ← StartupSelfHeal.cs  (HKCU Run key)      │
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
| `agent/ice` | device token **or** technician JWT | S9 ICE set: STUN always, TURN when `TURN_URLS` is set |
| `agent/release` | device token **or** technician JWT | S14 release manifest from `public.releases`; 204 when nothing published |
| `admin/bootstrap` | BOOTSTRAP_TOKEN | first admin provisioning |
| `auth/login` | rate-limited, `login_attempts` lockout | admin sign-in |
| `cron/reconcile-orders` | cron secret | payment reconciliation |
| `webhooks/cdp` | HMAC verified | crypto payment events |
| `stats/orders`, `api/public/health`, `/health` | public read-only | no PII; `/health` is the standalone Coolify probe |

Web routes: `/`, `/order`, `/order/$id`, `/license`, `/contact`, `/privacy`,
`/terms`, `/refund`, `/connectlive/admin` (login), `/connectlive/payment`,
`/_authenticated/console`. All carry unique `head()` metadata; the three
non-public ones (`/connectlive/admin`, `/connectlive/payment`, `/console`)
additionally carry `robots: noindex` and a self-referencing canonical.

---

## 4. Invariants — do not "optimise" these away

- Consent is a **click**, not a default. Timeout, closed window, or missing UI
  thread all mean decline. `/agent/session/:id/consent` is the only writer and
  it 409s on any state other than `invited`.
- Server state machine is `invited → active | declined`, then `paused` /
  `ended`. `consented` is a **legacy value** that the consent route never
  writes, but heartbeat, `prune_session_ephemera()`, the web console and
  `admin/src/Api/ApiClient.cs` all still include it in their "live" filters, so
  it must stay in those `IN (...)` lists until a migration retires it.
  `sessions.state` and `sessions.mode` are now guarded by validated CHECK
  constraints (`sessions_state_check`, `sessions_mode_check`) — the six states
  above and `view`/`control`. Widening the vocabulary is a migration, not a
  string edit.
- Decode **off** the UI thread, present **on** it, drop the **oldest** frame.
- Colour is BT.601 limited range. A hue drift means someone changed the
  matrix — revert, don't tune.
- Element↔source coordinate conversion goes through `ContentRect` only.
- Every new `public` table gets `GRANT`s in the same migration as its RLS.
- Input relay is gated on `state=active AND mode=control`; `curtain_off` and
  `release_inputs` always pass (dead-man safety).
- **Presence is derived, never asserted.** `devices.status = 'online'` is only
  true while heartbeats arrive; `prune_session_ephemera()` flips it to
  `offline` after 3 missed minutes and ends any live session on a device that
  has been silent for 10. Nothing in the app may set `online` without a
  matching `last_seen_at`.

---

## 5. Change log (rolling — newest first)

### 2026-08-03 — S11 closed: render telemetry (`SCOPE:RENDER`)

- New table **`public.session_telemetry`** (session_id, admin_client_id, fps,
  latency_ms, queue_depth, frames_decoded/dropped/presented, source_width/height,
  render_path, input_path, wire_path, ice_restarts, peer_state). Staff read;
  super_admin/admin/technician write. Rows cascade with the session.
- **`WebRtcClient.StatsLoop`** now writes the same per-minute reading twice: to
  `admin.log` (unchanged human line, plus `wire=`) and to `session_telemetry`
  via `ApiClient.PushTelemetryAsync`. Telemetry failures are logged and never
  disturb the live session.
- **`wire_path`** (S9 leftover) is derived in `WebRtcClient` from the candidate
  types actually exchanged (`NoteCandidate`): any relay wins, else srflx, else
  host — SIPSorcery does not expose the nominated pair.
- **Live-window status bar** now reads
  `fps · latency · queue · size · D3D|bitmap · wire … · input dc|rest`, so the
  whole hop is visible to the technician, not just the decoder.
- **`InputTransport.CurrentPath`** exposes `dc|rest` for both the bar and the row.
- **Web console → Audit tab** gains `RenderHealthPanel` (last 10 samples,
  30 s refresh) — the first place render health is visible without opening a
  technician's local log file.

### 2026-08-03 — S10 closed: input over the WebRTC datachannel (`SCOPE:INPUT`)

- New **`admin/src/Input/InputTransport.cs`** owns the transport switch. It
  attaches to the peer's `input` datachannel, sends UTF-8 JSON envelopes
  (`{ kind, ...payload }`, identical to the REST shape), and falls back to
  `App.Api.PushInputAsync` on any of: channel closed, channel errored, one
  failed send (the session is then permanently demoted so late deltas cannot
  arrive out of order over two transports).
- Safety kinds — `curtain_off`, `release_inputs` — always take REST: they
  must land precisely when the media pipe is broken, which is exactly when
  the datachannel is untrustworthy.
- **`admin/src/Media/WebRtcClient.NegotiateAsync`** now `createDataChannel("input", { ordered: true })`
  BEFORE `createOffer`, so SDP advertises the SCTP m-line, then hands the
  channel to `InputTransport.Attach`. Teardown calls `InputTransport.Detach`.
- **`MouseInjector` / `KeyboardInjector`** route every event through
  `InputTransport.SendAsync`. Wire shapes unchanged (`mousemove`,
  `mousemove_rel`, `mousedown`, `mouseup`, `wheel`, `keydown`, `keyup`,
  `text`) so the agent's `InputRelay.Apply` switch does not need to know
  which pipe delivered the event.
- Per-minute stats line now includes `input.path=dc|rest dc.sent=… rest.fallback=… demoted=…`
  so S8 soak has evidence for the input hop as well as the render hop.



### 2026-08-03 — S13 + S15(a): loss gating and pill honesty (`SCOPE:RENDER`)

- **Audit answer for S13:** SIPSorcery reassembles VP8 frames internally
  (`OnVideoFrameReceived`), and `VideoPipeline` already holds a bounded
  3-frame drop-oldest jitter queue. No reorder buffer was missing — *loss
  visibility* was.
- **`WebRtcClient.WireVideo`** now watches the 16-bit RTP sequence number
  (wrap-safe; duplicates and late/reordered packets are ignored so healthy
  links never gate) and reports gaps to the pipeline.
- **`VideoPipeline.NotifyPacketLoss(missing)`** flushes the queue, sets an
  await-keyframe gate, and fires `KeyFrameRequested` → PLI. While gated only
  a VP8 keyframe (`(f[0] & 0x01) == 0`, RFC 6386 §9.1) is admitted, so no
  inter frame is ever decoded against a reference buffer that never arrived —
  the stripe-corruption class is closed at its source.
- **Stats line** gains `loss=` and `gated=` for the S8 soak log.
- **S15(a)** — `LiveSessionViewModel` re-promotes the transport pill to
  "Native video" when `Pipeline.IsPresenting` returns true again; previously
  only the one-shot `FirstFrame` callback could set it, so a recovered stream
  stayed mislabelled as fallback.

### 2026-08-03 — S9 code half landed: ICE gateway (`SCOPE:TRANSPORT`)


- New route **`GET /api/public/agent/ice`** (`src/routes/api/public/agent/ice.ts`).
  Single source of truth for the ICE set: STUN always; TURN appended when
  `TURN_URLS` is configured, with ephemeral coturn REST credentials derived from
  `TURN_STATIC_SECRET` (`<expiry>:<peer>` + base64 HMAC-SHA1), or static
  `TURN_USERNAME`/`TURN_PASSWORD`. Authed by device token **or** technician
  bearer JWT — unauthenticated callers get 401, because relay minutes are
  billable. Registered as `API_ROUTES.agentIce`; documented in `ENDPOINTS.md`.
- All three peers now fetch it and **fall back to hardcoded STUN on any
  failure**, so a relay outage removes the relay path but never the session:
  `src/lib/webrtc-live.ts` (fetch in flight at construction, applied via
  `setConfiguration` before the first offer, i.e. before gathering starts),
  `agent/src/WebRtcSession.cs` (warm fetch in `StartAsync`, `_iceServers` read by
  `BuildPeer`), `admin/src/Media/WebRtcClient.cs` (awaited in `NegotiateAsync`,
  logged as `ice servers: N`), plus `ApiClient.GetIceConfigAsync` /
  `GetIceServersAsync` on the two native clients.
- `scripts/verify-agent-routes.ts` now asserts the route is 401 without creds —
  **20/20 passing** against localhost. Production shows 404 until publish.
- **Still open on S9:** no TURN server is deployed (the env vars are unset, so
  the gateway returns STUN only today) and the `wire_path` heartbeat field
  (`host`/`srflx`/`relay`) is not yet emitted, so relay rate is still not a
  number.

### 2026-08-03 — Audit pass 4 merged, §6 re-sequenced (`SCOPE:DOCS`)

- New **§9.5** registers soft spots **S8–S15** (missing soak, no TURN/ICE, dead
  input datachannel, no render telemetry, unverified admin D3D device-lost, no
  named depacketizer/jitter buffer, no agent auto-update, pill + contract
  truth).
- **§6 order changed**: turn 4b is no longer next. Rollout (S3) + field soak
  (S8) with render stats (S11) come first, then ICE/TURN (new Tier A item 4),
  then 4b, then the input datachannel (new Tier B 3a).
- New Tier C items 13 (render telemetry), 14 (agent auto-update), 15 (pill
  honesty + retiring the two contracts). §7 candidates updated to match.
- Documentation only — no schema, no route behaviour, no C# touched.



### 2026-08-03 — Gap merge S6 / S7-consent (`SCOPE:PRESENCE`, `SCOPE:CONSENT`)

| Scope | File / object | Change |
| --- | --- | --- |
| `SCOPE:PRESENCE` | `src/components/console/ReaperPanel.tsx`, `src/routes/_authenticated/console.tsx` | **S6 closed.** The reaper's `session.reaped` audit rows were technically readable (super-admin RLS covers `audit_logs`) but drowned in the raw feed and printed as an opaque UUID, so nobody could tell *which* machine dropped. New `ReaperPanel` at the top of the Audit tab filters the last 10 reap events out of the `audit` state that's already streamed via `postgres_changes`, resolves `device_id` → `display_name` against the loaded devices list, and highlights the event amber in the raw log below. No new query, no new policy, no new realtime subscription — everything reads state already in memory, so a super-admin opening the tab sees the existing `EC2AMAZ-5UBQG30 / device_silent` row on first paint. |
| `SCOPE:CONSENT` | migration → `public.devices.standing_consent` | **S7 closed.** Column default flipped `true` → `false`. Existing 8 rows are untouched because a default only fires on `INSERT` without an explicit value; nothing in `src/routes/api/public/agent/enroll.ts` sends `standing_consent`, so every future enrollment lands opt-out. Consent must now be granted per session or explicitly toggled on the device page — the safer posture for a remote-support tool, and it removes the last "silently on" default from the trust chain. |

### 2026-08-03 — Gap merge S2 / S7-cron (`SCOPE:PAYMENTS`)

| Scope | File / object | Change |
| --- | --- | --- |
| `SCOPE:PAYMENTS` | secret `CDP_WEBHOOK_SECRET` | **S2 closed.** A 64-char signing secret is provisioned, so `/api/public/webhooks/cdp` no longer short-circuits on `503 Webhook not configured`. The verifier now reports the correct closed state — `401 Invalid signature` on an unsigned POST — which means the HMAC path is live and a real signed webhook can be accepted. Crypto confirmation no longer rides the once-a-minute reconciler alone. The same value must be pasted into the CDP notification config for real callbacks to verify. |
| `SCOPE:PAYMENTS` | migration → `public.cron_tokens`, `cron.job` `reconcile-orders` | **S7, cron half closed.** New table holds one row (`reconcile-orders`) with a `gen_random_bytes(32)` hex token. `GRANT ALL … TO service_role` only, RLS on with **no policies**, so anon and authenticated cannot read it and the value never leaves the database — it is not in env, not in code, not in any log. `cron.schedule` was re-created to send it as `x-cron-secret`. |
| `SCOPE:PAYMENTS` | `src/routes/api/public/cron/reconcile-orders.ts` | Auth rewritten: the anon-key check is **gone**. The published anon key is not a credential — anyone reading the client bundle could trigger reconciliation. The handler now reads the expected token via `supabaseAdmin` and compares with `timingSafeEqual` after a length guard (`timingSafeEqual` throws on unequal lengths). Missing header → `401` before any DB hit. **Deploy note:** the rescheduled job sends the new header immediately, so production reconciliation stays `401` until this build is published. |



### 2026-08-03 — Gap merge S1 / S4 / S5 (`SCOPE:DATA`, `SCOPE:PRESENCE`)

Closing §9.3 soft spots one at a time, each validated three times before the
next was started.

| Scope | File / object | Change |
| --- | --- | --- |
| `SCOPE:DATA` | migration → `public.sessions` | **S1 closed.** `sessions_state_check` (`invited\|consented\|active\|paused\|declined\|ended`) and `sessions_mode_check` (`view\|control`), both `convalidated = true`. Pre-flight showed the only live values were `ended` / `view` / `control`, and all state+mode write sites in `src/`, `agent/src/` and `admin/src/` fall inside the vocabulary, so nothing had to change in code. The state machine consent, capture gating and the reaper all key off can no longer be handed an arbitrary string. Widening it is now a migration, not a string edit. |
| `SCOPE:PRESENCE` | `scripts/verify-agent-routes.ts` | **S4, half 1.** The enroll assertion is a real keyless enrollment, so it now tags itself `hostname: "route-verifier"`. Note the trap this walked into first: the enroll route copies `hostname` into `display_name`, which makes the row *invisible* to the 24 h nameless-ghost sweep — a naive tag would have leaked a permanent row per run instead of a temporary one. |
| `SCOPE:PRESENCE` | migration → `public.prune_session_ephemera()` | **S4, half 2.** New clause 4 deletes `hostname = 'route-verifier'` rows after 1 h, still gated on "never in a session, never got a power command" so a real machine carrying the reserved hostname cannot be deleted mid-session. Clauses 1–3 re-verified byte-for-byte; `SECURITY DEFINER` + `search_path=public` preserved. Verified against live rows: the two real devices and the NULL-hostname legacy ghosts all evaluate **false** against the new predicate. |
| `SCOPE:PRESENCE` | `agent/src/InputBlocker.cs`, `agent/src/StartupRegistration.cs` | **S5 closed.** Both now appear in the §2 system map. `InputBlocker` is the curtain: `WH_MOUSE_LL`/`WH_KEYBOARD_LL` hooks on a dedicated STA message-pump thread that swallow physical input while engaged, passing admin `SendInput` through on a `dwExtraInfo` magic (`CLIV`). It fails **open** — `ProcessExit`, unhandled exception, `SessionSwitch` (lock / Ctrl+Alt+Del / RDP disconnect), a 5 s input-pump watchdog and heartbeat loss all release it, so a crashed agent can never leave a user locked out of their own keyboard. `StartupRegistration` owns the HKCU Run key (`"<exe>" /background`), written by the agent itself rather than the installer because an elevated installer writes to the wrong user hive on silent deployments; it is idempotent and refuses to write unless the exe is running from the installed directory, so a dev run out of `dist\` cannot clobber a real machine's autostart. |



### 2026-08-03 — Truth pass 2 + presence reaper (`SCOPE:DATA`, `SCOPE:PRESENCE`, `SCOPE:WEB`)

Three turns in one pass: docs made to match the code, head metadata completed
on the three non-public routes, and the reaper that closes the gap between
"what the DB says is happening" and "what is actually happening".

| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:PRESENCE` | migration → `public.prune_session_ephemera()` | **Presence reaper**, appended to the existing every-minute job. (1) Devices with `last_seen_at` older than 3 minutes flip to `offline` — three missed beats at the slowest (60 s, SSE-healthy) cadence, so a healthy agent can never be reaped. (2) Sessions in `invited/consented/active/paused` whose device has been silent for **10** minutes are ended, with a `session.reaped` row in `audit_logs` carrying `{reason:'device_silent'}`; the window is deliberately far wider than the offline mark so a network flip can still reconnect into its own session. (3) Ghost enrollments — a token was issued, the agent never came back — are deleted after 24 h, gated on *four* conditions (no second heartbeat, no name, no session ever, no power command ever) so a quiet-but-real device cannot be swept. |
| `SCOPE:WEB` | `src/routes/connectlive.admin.tsx`, `connectlive.payment.tsx`, `_authenticated/console.tsx` | All three had a title and nothing else. Now full `head()`: description, `og:title`/`og:description`/`og:type`/`og:url`, `twitter:card`, self-referencing canonical, `robots: noindex` retained (console gained it — it was indexable-by-default before). No `og:image`: none of the three has a meaningful cover, and a placeholder previews worse than nothing. |
| `SCOPE:PRESENCE` | `agent/README.md` | Stale since the standalone refactor: it advertised `src/TrayIcon.cs` and "every session shows a persistent on-screen indicator". Both are gone. Rewritten to state the real UI contract (5 s splash + consent prompt + curtain overlay, nothing else) and the file table now lists what actually ships — `StreamListener`, `StartupSelfHeal`, `MonitorSelector`, `BitrateController`, `HwEncoderProbe`, `DxgiCapture`. |
| `SCOPE:PRESENCE` | `.env.sample` | Removed `AGENT_DEPLOYMENT_KEY` and the "Agent / Watcher" heading. Enrollment has been keyless + IP-rate-limited since the enrollment overhaul; leaving the variable in the sample invited someone to wire a gate the server no longer reads. `BOOTSTRAP_TOKEN`'s comment corrected — it gates `/admin/bootstrap`, not `/enroll`. |
| `SCOPE:WEB` | `PROJECT-MAP.md` §3, §4, §8 | Route table notes the noindex/canonical set; new presence invariant; §8 re-snapshotted below against observed rows rather than remembered ones. |

**Observed data-truth issues that motivated the reaper**

These were real rows, not hypotheses — the reaper is the fix, and running it
resolved all three:

- 8 devices, **all** flagged `online`; only one (`EC2AMAZ-5UBQG30`) had
  heartbeated within the hour. `devices.status` had no writer that could ever
  say "offline" — the agent sets it on the way up and nothing sets it on the
  way down. After the pass: 1 online / 8 total.
- Session `decace85-2945-4094-b2e1-9b33fc925e8c` sat `active` with a null
  `ended_at` since 2026-08-02 14:04 on a device last seen at 15:10 — a
  ~17-hour zombie holding `is_session_active` true on `DESKTOP`. Reaped;
  `trg_sessions_sync_device_active` correctly flipped the device flag to false,
  which also confirms the surviving (column-scoped) trigger works.
- 6 "Unnamed device" rows enrolled 2026-08-02, each with `last_seen_at` within
  a second of `enrolled_at` and no session, no power command. Ghost
  enrollments. They are inside the 24 h grace window at time of writing, so
  the reaper deliberately left them; they age out on their own.

**Deliberately NOT changed:** `devices.standing_consent` defaults to `true`,
which reads against the "consent is a click" invariant. It is left alone
because the agent's `ConsentPrompt` is the real gate and the column is only the
*opt-in* record ("Always allow" stored under `HKCU\Software\ConnectLive`) —
flipping the default is a product decision about unattended fleets, not a bug
fix, and it needs your call before a migration touches it.

**Verification run (this pass)**

- `bunx tsgo --noEmit` — clean.
- `select public.prune_session_ephemera();` executed against the live DB:
  devices online 8 → 1, zombie session ended with `ended_at` set, one
  `session.reaped` audit row written, `DESKTOP.is_session_active` → false.
- Ghost-device delete verified as a **no-op** at 10 h age (the 24 h gate holds).

### 2026-08-02 — Truth pass: docs ↔ code ↔ DB reconciliation (`SCOPE:DATA`, `SCOPE:WEB`)

| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:DATA` | migration | Dropped the duplicate `trg_sync_device_session_active` on `public.sessions`. Both it and `trg_sessions_sync_device_active` executed `sync_device_session_active()`; the dropped one fired on **every** update (including bare `updated_at` touches), the survivor is column-scoped (`AFTER INSERT OR DELETE OR UPDATE OF state, device_id`) and therefore the correct one to keep. Note: the pass-1 changelog named the other trigger — the *narrow* trigger wins on merit, and this entry is the correction. |
| `SCOPE:WEB` | `PROJECT-MAP.md` §3 | `agent/stream` was still documented as "dead server-side". It has had a client since pass 2 (`agent/src/StreamListener.cs`) and `ENDPOINTS.md` already described it as live. Row corrected. |
| `SCOPE:WEB` | `PROJECT-MAP.md` §6, §8 | Backlog re-indexed into Tier A / B / C with 12 ordered items; new §8 records the verified DB + code state with a date so the next audit has something to diff against. |

**Verification run (this pass)**

- Agent tree: `SplashWindow.xaml.cs`, `MonitorSelector.cs`, `StreamListener.cs`, `StartupSelfHeal.cs`, `DxgiCapture.cs` all present; zero `MainWindow`/`NotifyIcon` hits under `agent/`.
- Native console: `PredictiveCursor.cs`, `LiveSessionViewModel.cs`, `LiveSessionWindow.xaml` present — turns 1 and 2 confirmed on disk.
- Web console: gap **closed** — `src/components/console/MonitorPicker.tsx` reads `devices.metadata.monitors` and `switchMonitor()` in `console.tsx` enqueues `switch_monitor` + `restart_stream`. Tier A item 1 done.
- `src/routes/_authenticated/console.tsx` is **1,648 lines** (route shell + live view). Tier C item 8 **done** — presentational blocks now live in `src/components/console/*` with shared types in `src/lib/console-types.ts` and input mapping in `src/lib/console-input.ts`.
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

**Re-sequenced 2026-08-03 (§9.5).** Turn 4b is *no longer next*. Order of work:

0. **S3 + S8 + S11** — Windows build + fleet rollout, then a scripted 10-min
   field soak (leak / tear / colour-drift / forced `switch_monitor`) with the
   new `RenderStats` numbers as its pass criteria. Closes the evidence gap
   under turns 2, 3 and 4a. **S12** (admin D3D device-lost) and **S13**
   (depacketize/jitter audit) are verification-first checks in the same week.
1. **Tier A item 4 — ICE gateway + TURN** (S9). Connectivity floor.
2. **Turn 4b — hardware H.264**, now landing on a measured baseline.
3. **Tier B item 3a — input datachannel** (S10), ahead of clipboard.


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
3. `SCOPE:INPUT` / `SCOPE:CAPTURE` — ~~Relative-motion pointer mode~~ shipped
   (turn 3). **Hardware H.264 (NVENC/QSV/AMF)** with VP8 fallback is split in
   two: discovery shipped as **turn 4a** (`agent/src/HwEncoderProbe.cs`,
   heartbeat `encoder` block); the encoder/decoder swap is **turn 4b** and
   touches encode on the agent plus decode in
   `admin/src/Media/VideoPipeline.cs`. Largest remaining job in Tier A.
4. `SCOPE:TRANSPORT` — **ICE gateway + TURN** *(S9, do before 4b)*. One authed
   route (`/api/public/agent/ice` + admin equivalent) returning a STUN+TURN set
   with per-session ephemeral credentials, a coturn/managed-TURN deployment,
   and a `wire_path` (`host|srflx|relay`) field in the heartbeat so relay rate
   and silent JPEG-fallback degradation become numbers. Today both peers
   hardcode public STUN, so symmetric NAT and corporate egress filters are
   unhandled and unmeasured. De-risks S13.

### Tier B — new capability

3a. `SCOPE:INPUT` — **Input over the WebRTC datachannel** *(S10)*. Receive side
   already ships (`WebRtcSession` calls `InputRelay.Apply` directly); the admin
   never opens the channel, so every click still pays a REST round trip. Admin
   side only: open an `input` datachannel in `WebRtcClient`, serialize the
   existing wire shapes (`mousemove`, `mousemove_rel`, keys, wheel), fall back
   to REST when the channel is closed. Safety kinds (`curtain_off`,
   `release_inputs`) stay on REST permanently as the guaranteed route.
4. `SCOPE:SESSION` — **Clipboard sync + file drop** over a WebRTC data channel.
   Text first, then files with a size cap and an `audit_logs` row per transfer.
   Lands after 3a — same channel machinery, smaller feel win.
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
    rather than assumed. *Half-shipped 2026-08-03*: the job now also reaps
    presence (stale devices, zombie sessions, ghost enrollments) and writes a
    `session.reaped` audit row; what remains is the **dashboard** — nobody can
    see any of this without a psql prompt.
11. `SCOPE:WEB` — **Ops status page** at `/status`, fed by
    `/api/public/health`, `stats/orders`, and an online-device count.
12. `SCOPE:DATA` — **Wake reliability metrics**: record dispatch→delivered
    latency on `power_commands` and surface a success rate, so "wake didn't
    work" becomes measurable instead of anecdotal.
13. `SCOPE:RENDER` — **Render telemetry** *(S11, gates the S8 soak)*.
    `RenderStats` on the admin: frames decoded / presented / dropped per
    second, decode-ms and upload-ms rolling averages, queue depth and working
    set — shown in the live-window status bar and written to the soak log.
    Without it turn 4b's "sharper, lower latency" claim cannot be demonstrated.
    `VideoPipeline.StatsLine()` already emits most of this; it is unsurfaced.
14. `SCOPE:PRESENCE` — **Agent auto-update** *(S14)*. Version in the heartbeat,
    a signed-release manifest route, agent-side download → verify → swap →
    restart through the existing `restart_agent` power command, staged rollout
    flag per device. S3 is the standing proof of the cost of not having it.
15. `SCOPE:RENDER` / docs — **Truth housekeeping** *(S15)*. (a) Verify the
    transport pill keys off "a decoded frame presented in the last N ms"
    (`VideoPipeline.IsPresenting`) rather than "RTP arrived", so the ICE
    surrender to JPEG can never be reported as native video. (b) Mark both
    contracts SUPERSEDED with a pointer to this map and fold the surviving
    obligations (S8 soak, S9 TURN) into §6.


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
- **ICE gateway + TURN relay** with `wire_path` telemetry — promoted to Tier A
  item 4 (S9); the current "STUN only" posture cannot cross symmetric NAT.
- **Input over the datachannel** — Tier B 3a (S10); receive side already ships.
- **Render telemetry (`RenderStats`)** — Tier C 13 (S11); pass criteria for the
  soak and the only way to prove turn 4b.
- **Agent auto-update** — Tier C 14 (S14); the rollout bottleneck behind S3.
- **RTP depacketize / jitter buffer audit** — S13, verification-first.
- **Session recording** (consented, watermarked) to storage for audit.
- **Unattended/standing-consent policy** surfaced in the admin UI with an
  audit entry each time it is used.

---

## 8. Verified state — 2026-08-03

Snapshot of what was actually observed, so the next audit diffs rather than
re-derives. Anything here that stops being true is a regression, not a
surprise.

**Code**

| Claim | Evidence |
| --- | --- |
| Agent has one visible surface | `agent/src/SplashWindow.xaml.cs` present; zero `MainWindow` / `NotifyIcon` hits under `agent/`; `agent/README.md` now says so too |
| Turn 1 + 2 shipped in the native console | `admin/src/Media/PredictiveCursor.cs`, `admin/src/ViewModels/LiveSessionViewModel.cs`, `admin/src/Views/LiveSessionWindow.xaml` |
| SSE wake has a client | `agent/src/StreamListener.cs` ↔ `src/routes/api/public/agent/stream.ts` |
| Web console **has** a monitor picker | `src/components/console/MonitorPicker.tsx` + `switchMonitor()` in `console.tsx` (was the gap in the 08-02 snapshot) |
| Console is modular | `src/routes/_authenticated/console.tsx` = 1,648 lines + 11 component files in `src/components/console/` — 9 imported directly by the route, `DirectNotifyModal` and `PowerMenu` nested inside `TeamPanel` / `DevicesTable` |
| Every route has real head metadata | 11 web routes, each with a unique title + description; the 3 non-public ones also `noindex` + self-canonical |
| Server routes | 11 agent routes, `admin/bootstrap`, `auth/login`, `cron/reconcile-orders`, `webhooks/cdp`, `stats/orders`, `api/public/health`, plus the standalone unauthenticated `/health` probe for Coolify |
| Known dead code | `admin/src/Input/MouseInjector.MoveRelAsync` is defined but never called — the WPF console has no pointer-capture toggle yet (the browser console does). Intentional: it is the seam for that turn, not a regression. |
| Packaging docs | `agent/packaging/{jamf,intune,gpo}` documented a `DeploymentKey` registry/ADMX/MSI-property gate that no longer exists in `agent/src` (removed in the enrollment overhaul). Fixed 08-03: ADMX/ADML and the Jamf configuration profile deleted, all four READMEs + `intune-app.json` + `wrap-intune.ps1` + `install-gpo.ps1` rewritten around keyless enrollment. Diff against this row on the next audit. |

**Database**

| Fact | Value |
| --- | --- |
| `power_commands_kind_check` | `wake`, `wake_agent`, `reboot`, `shutdown`, `lock`, `logoff`, `restart_stream`, `restart_agent`, `switch_monitor` |
| `power_commands_state_check` | `queued`, `dispatched`, `delivered`, `failed`, `expired` |
| pg_cron jobs (both active, `*/1 * * * *`) | `reconcile-orders` HTTP post; `public.prune_session_ephemera()` (now also the presence reaper) |
| `supabase_realtime` publication | `devices`, `sessions`, `session_frames`, `session_signals`, `session_cursors`, `notifications`, `power_commands` |
| Triggers on `sessions` | `sessions_touch`, `trg_clear_admin_binding_on_end`, `trg_sessions_sync_device_active` |
| Presence truth after the reaper ran | 8 devices, **1** online · 2 sessions, **0** live · 1 `session.reaped` audit row |
| Row counts | 8 devices · 2 sessions · 11 orders · 3 active plans · 3 roles · 167 audit rows · 424 notifications · 4 power commands |

**Known, accepted linter findings** (pre-existing, unrelated to this pass):
two `RLS enabled / no policy` INFO rows on deliberately closed tables
(`license_lookups`, `login_attempts` — service-role only by design),
`pg_trgm` living in `public`, `SECURITY DEFINER` execute grants on the
helper functions, and leaked-password protection disabled in auth settings.

**Open decisions for you** (not bugs, and not changed unilaterally):

1. `devices.standing_consent` defaults to `true` — see the truth-pass entry
   above. Flip to `false` if consent must always be a click on first contact.
2. `src/routes/api/public/cron/reconcile-orders.ts` authenticates the pg_cron
   caller with the Supabase **anon key** as a bearer token. It works and the
   route is otherwise closed, but the anon key is a published value — a
   dedicated secret would be stronger. Say the word and it becomes one turn.


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

### Turn: Tier A item 2 — adaptive bitrate + resolution ladder (`SCOPE:TRANSPORT`) — 2026-08-03

- New `agent/src/BitrateController.cs`: single owner of
  `(targetBitrate, maxEdge, fps)` across a six-rung ladder
  (1920/70/30fps → 640/38/12fps). Asymmetric policy: down 1 rung on
  loss ≥ 4% or RTT ≥ 350 ms, down 2 on loss ≥ 12% or RTT ≥ 600 ms; up 1 rung
  only after 12 s clean and never within 10 s of the previous change. Both
  directions rate-limited to one step per 3 s so a burst of RRs cannot fall
  through the whole ladder.
- `WebRtcSession.cs`: `OnReceiveReport` now parses the RR block
  (`FractionLost`, `Jitter`, `LastSenderReportTimestamp`,
  `DelaySinceLastSenderReport`) *before* the PLI/FIR early-return, and derives
  RTT per RFC 3550 §6.4.1. `BuildPeer()` calls `BitrateController.Reset()` so a
  new technician does not inherit the previous link's rung.
- `ScreenCapture.cs`: no longer owns tunables. Reads
  `BitrateController.Current` once per frame for max edge, JPEG motion/idle
  quality and motion cadence; `SetQualityMode(bool)` and `NoteUploadLatency`
  now delegate to the ladder, so the HTTPS fallback and the WebRTC path move
  the same control. A rung change re-tees the encoder (frame size changed →
  the decoder needs a fresh picture, not a delta).
- `MaxEdge` / `PerformanceMode` stay as public reads, so `CursorPump` keeps
  landing cursor telemetry in the exact coordinate space of the shipped frame.
- Verification: no .NET toolchain in this sandbox — agent changes are reviewed,
  not compiled here; they build in `agent/build.ps1` on Windows. Web side
  untouched.
- Next: Tier A item 3 — relative-motion pointer (`SCOPE:INPUT`).

### Turn: Tier A item 3 — relative-motion pointer (`SCOPE:INPUT`) — 2026-08-03

- Web `/console` (`src/routes/_authenticated/console.tsx`): new **Capture
  pointer** button on the live-view header (control mode only). Clicking calls
  `requestPointerLock()` on the live surface; Esc, focus loss or a stolen lock
  all resolve through a single `pointerlockchange` listener that flips the
  React state and drains the delta accumulator, so the button label never
  lies. Mode flip to view exits the lock immediately.
- While locked, `onMouseMove` reads `movementX/movementY` instead of
  `clientX/Y` and pushes them into `queueRelMove`, a per-frame accumulator
  that ships integer `mousemove_rel { dx, dy }` and carries sub-pixel
  remainders forward (no drift, no lost precision at rest). `flushMoveNow`
  drains both the absolute and relative queues before mousedown/mouseup so a
  click never lands ahead of the delta that aimed it.
- Native admin (`admin/src/Input/MouseInjector.cs`): added `MoveRelAsync(dx,
  dy)` for the same wire shape. Kept alongside `MoveAsync` so the WPF
  console can flip modes without a rewrite when we wire its pointer capture.
- Agent side unchanged: `InputRelay.cs` already had `mousemove_rel →
  MoveRel(dx, dy)` using `MOUSEEVENTF_MOVE` (no ABSOLUTE flag), so Windows'
  own accel curve runs. Pointer lock therefore gets the native feel that
  absolute mapping through a letterboxed video can't match.
- Verification: `bunx tsgo --noEmit` clean. WPF change is a one-line addition
  reviewed against the existing `PushInputAsync` signature.

### Turn 4a — hardware H.264 discovery (`SCOPE:CAPTURE`), 2026-08-03

Hardware H.264 is a two-stage job and this is stage one: **find the silicon,
report it, change nothing on the wire.**

- `agent/src/HwEncoderProbe.cs` (new): enumerates Media Foundation's
  `MFT_CATEGORY_VIDEO_ENCODER` for `MFVideoFormat_H264` with
  `MFT_ENUM_FLAG_HARDWARE | SYNCMFT | ASYNCMFT | SORTANDFILTER`, reads each
  MFT's `MFT_FRIENDLY_NAME_Attribute`, and classifies the winner as
  `nvenc` / `qsv` / `amf` / `hw` / `none`. Pure P/Invoke against `mfplat.dll`
  — no new package, no native payload, single-file publish contract intact.
  Every failure path (Windows N without the media pack, locked-down container,
  MFStartup failure) resolves to "none" and leaves software VP8 running.
  Probes once per process and caches.
- `agent/src/Agent.cs`: `HwEncoderProbe.LogCapability()` at the top of
  `RunAsync`, so every field log states the machine's encode ceiling whether
  or not a session is ever opened on it.
- `agent/src/ApiClient.cs` heartbeat: new `encoder { wire_codec, hw_h264,
  hw_vendor, hw_name }` block.
- `src/routes/api/public/agent/heartbeat.ts`: persists it into
  `devices.metadata.encoder` + `encoder_updated_at`, using the same
  merge-don't-clobber discipline as the `lan` and `monitors` blocks — an older
  agent that omits `encoder` must not erase what a newer build reported.

**Deliberately NOT in this turn.** Both peers stay VP8-pinned. The codec
guardrail comments in `agent/src/WebRtcSession.cs` and
`admin/src/Media/WebRtcClient.cs` are unchanged and still describe reality.
`wire_codec` is reported as the literal `"VP8"` rather than derived, because a
telemetry field that can silently disagree with the guardrail is worse than no
field. Negotiating H.264 before an `IVideoEncoder` exists that can produce it
would hand the admin a stream nothing encodes.

**Why staged.** `SIPSorceryMedia.Encoders` ships software VP8 only, and
`SIPSorceryMedia.Windows` is a *capture* end-point — neither contains a
hardware H.264 `IVideoEncoder`. Stage two therefore has to wrap the MFT this
probe selects (`IMFTransform` set up output-type-first per the MF H.264
encoder contract, NV12 in, Annex-B out) and pair it with an H.264 depacketise
+ decode branch in `admin/src/Media/VideoPipeline.cs`, which currently calls
`DecodeVideo(..., VideoCodecsEnum.VP8)` unconditionally. That is a genuine
encoder implementation, not a package swap, and it lands against a fleet where
this probe has already told us how many machines can use it.

- Verification: `bunx tsgo --noEmit` clean for the route change. The agent
  change is additive and every entry point is wrapped so a probe failure
  cannot affect enrollment, heartbeat or capture.
- Next (turn 4b): MFT-backed `IVideoEncoder` on the agent, H.264 decode branch
  in `VideoPipeline.cs`, and codec negotiation that prefers H.264 only when
  `HwEncoderProbe.HardwareH264Available` — VP8 stays the guaranteed fallback.



### Next up

**Turn 4b — hardware H.264 end-to-end** (Tier A, last item): MFT-backed
`IVideoEncoder` on the agent, an H.264 depacketise + decode branch in
`admin/src/Media/VideoPipeline.cs`, and negotiation that prefers H.264 only
where `HwEncoderProbe` found silicon. VP8 stays the guaranteed fallback on both
peers. After that Tier A is closed and the queue moves to Tier B (clipboard +
file drop) or Tier C item 9 (device health panel), whichever you want first.

---

## 9. Audit — 2026-08-03 (pass 3, roadmap ↔ codebase ↔ live DB)

Three independent sweeps: web/API (`src/`), native C# (`agent/`, `admin/`),
and the live database. Method: every checkable claim in §3, §4 and §8 re-read
against the file it names, then the DB re-queried rather than remembered.

### 9.1 Confirmed — no drift

| Area | Result |
| --- | --- |
| Server routes | 17 handlers on disk, every §3 row backed by a file; auth mechanism matches the doc on all of them (`verifyDevice` on all 11 agent routes, `BOOTSTRAP_TOKEN`, `login_attempts` lockout, HMAC on CDP, open on the two probes + `stats/orders`) |
| `src/shared/api-routes.ts` | Zero drift — every registry entry resolves to a route file, and `admin/src/Api/ApiClient.cs:42` is the only hardcoded route string in the native console (`/api/public/auth/login`, exact match) |
| Head metadata | All 11 web routes carry unique title + description + `og:*` + `twitter:card`; `/connectlive/admin`, `/connectlive/payment`, `/console` also carry `robots: noindex` + self-canonical |
| Console modularity | `console.tsx` = **1,648** lines, 11 files in `src/components/console/`, 9 imported directly, `DirectNotifyModal`/`PowerMenu` nested — §8 row exact |
| Input invariant | `session.$sessionId.inputs.ts:41-44` gates on `state=active AND mode=control`, `curtain_off`/`release_inputs` always pass; frame route 409s `not_active` |
| Agent surface | One visible surface confirmed; zero `MainWindow`/`NotifyIcon`/`TrayIcon` hits under `agent/` |
| Turns 1–4a | `StreamListener` wired at `Agent.cs:196`; `BitrateController` 6-rung ladder owned centrally and read per frame by `ScreenCapture.cs:33,70,110`; `HwEncoderProbe.LogCapability()` at `Agent.cs:165`; heartbeat sends `monitors[]` + `selected_monitor` + `encoder{}` + `lan{}` (`ApiClient.cs:244-296`) |
| Power vocabulary | All 9 kinds handled in `PowerRelay.cs` (52/60/64/68/72/76/99/107/117) — matches `power_commands_kind_check` exactly |
| Transport | VP8 pin + non-VP8 reject (`WebRtcSession.cs:158,193`); RR parsed **before** the PLI/FIR early-return (:262-275); RTT per RFC 3550 §6.4.1 (:295-307); PLI/FIR → `RequestKeyFrame` |
| Render | `PredictiveCursor` driven from the render loop and gated on `InputAuthoritative` (`LiveSessionWindow.xaml.cs:77,131`); `VideoPipeline` is VP8-only as documented |
| Live DB | 8 devices / **1** online · 2 sessions / **0** live · 11 orders · 167 audit rows · 424 notifications · 4 power commands · 7 realtime tables · 3 triggers on `sessions` · both cron jobs active. §8 snapshot still true, and the reaper is holding presence honest a day later. |
| Route smoke | `verify-agent-routes.ts` 19/19 against `https://zoomlite.live`; `verify-payment-routes.ts` 5/5; `tsgo --noEmit` clean |

### 9.2 Drift found and fixed in this pass (documentation truth)

| File | Was | Now |
| --- | --- | --- |
| `ENDPOINTS.md` header | Production URL given as `secure-remote-view.lovable.app` while every canonical, the sitemap and both verifiers target `zoomlite.live` | Canonical URL stated first, platform alias kept as an alias |
| `ENDPOINTS.md` consent row | "Legacy auto-ack; the standalone agent posts an implicit accept" — **flatly contradicts the §4 consent invariant** and the code | Describes the real gate: `ConsentPrompt` → `invited → active\|declined`, 409 otherwise, audit row either way |
| `ENDPOINTS.md` stream row | "Retained server-side… the standalone agent uses adaptive heartbeat instead" — stale since the SSE client shipped | "Live on both ends", names `StreamListener.cs`, states heartbeat remains the source of truth |
| `ENDPOINTS.md` ops table | `/health` missing entirely; cron auth and CDP webhook state undocumented | `/health` row added; anon-key cron caveat and the CDP **503 not-configured** state written down |
| `PROJECT-MAP.md` §4 | "There is no `consented` state" — false in practice: the value appears in heartbeat, `prune_session_ephemera()`, the web console and the native `ApiClient` live-state filters | Reworded as a legacy value that is never written but must stay in every `IN (...)` filter until a migration retires it |
| `session.$sessionId.consent.ts:26` | Comment said `invited -> consented\|declined`; the code writes `active` | Comment corrected — no behaviour change |

### 9.3 Soft spots — open, nothing changed unilaterally

Ordered by risk. None of these override the Tier A→C plan; they are the gaps
that plan does not currently name.

| # | Gap | Evidence | Cost |
| --- | --- | --- | --- |
| ~~S1~~ | ~~**`sessions.state` has no CHECK constraint.**~~ **CLOSED.** Migration adds `sessions_state_check` (`invited\|consented\|active\|paused\|declined\|ended`) and `sessions_mode_check` (`view\|control`), both `convalidated = true`. Pre-flight confirmed the only live values were `ended` (state) and `view`/`control` (mode), and all 12 state/mode write sites across `src/`, `agent/` and `admin/` fall inside the vocabulary. | `pg_get_constraintdef` on `public.sessions` now returns both rows | Done — one migration, no code change |
| ~~S2~~ | ~~**CDP webhook is not configured in production.**~~ **CLOSED.** `CDP_WEBHOOK_SECRET` provisioned (64 chars); the HMAC path in `/api/public/webhooks/cdp` is live. Remaining human step: paste the same value into the CDP notification config so real callbacks sign correctly. | `verify-payment-routes.ts` → `401 Invalid signature` (was `503`) | Done |
| S3 | **The fleet is running an agent older than turns 2 and 4a.** The one online device (`EC2AMAZ-5UBQG30`) has `lan` in `metadata` but **no `monitors[]` and no `encoder{}`**. So the web monitor picker (Tier A item 1) renders nothing, the bitrate ladder is unobserved and the H.264 probe has reported from zero machines — three shipped turns with no production evidence behind them. | `devices.metadata` keys, all 8 rows | Windows build + rollout (`agent/build.ps1`); nothing to change in code |
| ~~S4~~ | ~~**`verify-agent-routes.ts` mints a real device on every run.**~~ **CLOSED.** The enrollment now tags `hostname: "route-verifier"` and `prune_session_ephemera()` clause 4 sweeps that tag after 1 h (gated on no session / no power command). The 7 pre-existing NULL-hostname ghosts are untouched by the new clause and still age out under the 24 h rule. | Post-fix run: 19/19 passing, new row `route-verifier` present and matching the sweep predicate; both real devices evaluate `false` | Done |
| ~~S5~~ | ~~**Two agent files are undocumented.**~~ **CLOSED.** `InputBlocker.cs` and `StartupRegistration.cs` are in the §2 map with a changelog entry covering the curtain's fail-open release paths and the install-dir guard on the Run key. | `rg` over `PROJECT-MAP.md` now hits both | Done |
| ~~S6~~ | ~~**`prune_session_ephemera()` is still invisible.**~~ **CLOSED.** New `ReaperPanel` at the top of the Audit tab (`src/components/console/ReaperPanel.tsx`) filters `session.reaped` audit rows out of the same feed already streamed via `postgres_changes`, resolves `device_id` → `display_name` against the loaded devices list, and highlights the event in amber in the raw log below. No new query, no new policy: it reads the super-admin-scoped feed that was already in memory. | Audit tab renders `Session reaper` block; existing `session.reaped` row (`EC2AMAZ-5UBQG30`, `reason=device_silent`) surfaces on first paint | Done |
| ~~S7~~ | ~~**Half closed.**~~ **CLOSED.** ~~`cron/reconcile-orders` authenticates with the published anon key~~ — it now requires the `x-cron-secret` token stored in `public.cron_tokens` (service-role only, RLS on with no policies), compared with `timingSafeEqual`. **Consent default:** `devices.standing_consent` default flipped `true` → `false`. Existing 8 rows are untouched (the default only fires on `INSERT` without an explicit value), so no live device silently loses its standing grant, but every future enrollment lands opt-out and consent must be granted per session or explicitly toggled on the device page. | `information_schema.columns.column_default` on `devices.standing_consent` = `false`; `verify-payment-routes.ts` cron check still `401` | Done |

### 9.4 What this pass deliberately did not touch

No schema, no route behaviour, no C#. Every edit above is a comment or a
document sentence that disagreed with the code, and in each case the **code
was right**. *(Superseded by §9.5: the §6 order has since changed — turn 4b is
no longer next; rollout + soak + ICE/TURN come first.)*


---

## 9.5 Audit — 2026-08-03 (pass 4, contract-standard review)

External sweep: the roadmap re-read against the two signed contracts
(CONTRACT-Native-Video-Engine-B, CONTRACT-Connection-Layer) and the Gate Plan
v2 amendment, at their standard of evidence. Method: every contract clause
checked for a corresponding map entry, invariant, or verification run. The
engine itself is built past what the contracts asked for; these are the gaps
the map does not currently name. Ordered by risk. Nothing changed
unilaterally.

| # | Gap | Evidence | Cost |
| --- | --- | --- | --- |
| S8 | **The SOAK has never run, and turn 4b is queued on top of it.** No verification run in §5 or §9 contains a sustained-motion endurance test of the native render path — no leak check, no tear check, no color-drift check, no forced mid-session resolution change. Compounded by open S3: the entire fleet runs an agent older than turns 2 and 4a, so the bitrate ladder, `monitors[]`, and the H.264 probe have zero production evidence. Turn 4b (hardware H.264) would be the fourth consecutive turn shipped with no field observation behind it. | §5/§9 verification runs list `tsgo`, route verifiers, and DB queries only; S3 row (`devices.metadata` on all 8 rows); §6 "Next up" names 4b as next | Rollout via `agent/build.ps1` (S3's own remedy) + one scripted 10-min soak: per-minute log of fps, queue depth, working set, decode errors; forced `switch_monitor` mid-run; pass/fail written into §8. **Sequencing change, near-zero code** |
| S9 | **PARTIALLY CLOSED 2026-08-03 — gateway shipped, TURN not deployed.** Original finding: TURN and an ICE-config gateway are absent from all 12 backlog items.** §2 states "RTP/VP8, STUN only"; no `agent/ice` route exists in §3; both peers hardcode a public STUN server. A commercial remote-support tool meets symmetric NAT and corporate egress filtering as a matter of course — those sessions silently degrade to the JPEG fallback, which is the exact lag the engine was built to escape, and nothing measures how often it happens. | §2 system map; §3 route table (no ice row); §6 Tiers A–C (no TURN/ICE item); §7 candidate scopes (no TURN/ICE item) | One route (`/api/public/agent/ice` + admin equivalent, device-token/JWT authed, returns STUN+TURN set), a coturn or managed-TURN deployment with per-session ephemeral credentials, and a `wire_path` telemetry field (`host/srflx/relay`) in the heartbeat so relay rate becomes a number. Tier A sized | — **Status:** `/api/public/agent/ice` now exists and all three peers consume it with STUN fallback (see §5). Remaining: deploy coturn/managed TURN and set `TURN_URLS` + `TURN_STATIC_SECRET`, and emit `wire_path` in the heartbeat.
| S10 | **CLOSED 2026-08-03 — input rides the datachannel with REST fallback.** Original finding: agent's ondatachannel handler exists but no admin ever opened one; every click paid REST round-trip. — **Status:** `admin/src/Input/InputTransport.cs` owns the transport switch; `WebRtcClient.NegotiateAsync` opens an ordered `input` datachannel before `createOffer` and attaches it. `MouseInjector`/`KeyboardInjector` now call `InputTransport.SendAsync`; safety kinds `curtain_off` / `release_inputs` stay pinned to REST. First send failure demotes the session to REST for good, and the per-minute stats line now includes `input.path` + `dc.sent` + `rest.fallback` counters. |
| S11 | **CLOSED 2026-08-03 — render telemetry shipped (see §5): `session_telemetry` table, per-minute rows from the native console, live-window status bar, and the console Audit tab `RenderHealthPanel`. S8 now has pass criteria to read.** Original finding: nothing measures the render path. No fps counter, no decode-to-present latency, no dropped-frame counter anywhere in `SCOPE:RENDER`. Tier C item 9 (device health panel) surfaces agent-side facts only. Without these numbers the soak (S8) has no pass criteria and turn 4b's entire justification — "sharper, lower latency than software VP8" — cannot be demonstrated, only asserted. | §6 Tier C item 9 scope text; absence of any fps/latency mention in §4, §5, §8, §9 | `RenderStats` on the admin: frames decoded/presented/dropped per second, decode-ms and upload-ms rolling averages, exposed in the live-window status bar + logged. Feeds S8's soak log directly. Small |
| S12 | **Admin-side D3D device-lost is unverified.** The agent's capture recovery is thorough (`ACCESS_LOST` / `DEVICE_REMOVED` / `DEVICE_RESET` rebuild, pass-1 row). No audit pass has ever exercised the technician-side equivalent: `D3DImageHost` surviving a GPU reset, driver update, RDP session switch, or laptop dGPU/iGPU flip mid-session. The engine contract required recreate-and-continue; the map neither confirms nor denies it. | §5 pass-1 `DxgiCapture.cs` row (agent side only); §9.1 Render row (checks PredictiveCursor + VP8-only, not device-lost) | One targeted test (trigger device removal via driver restart / `dxcap -forcetdr` on a dev box) + whatever recreate path is missing in `D3DImageHost`. Verification-first: may already work, has never been shown |
| S13 | **CLOSED 2026-08-03 — loss detection + keyframe gate in front of the decoder.** Audit result: SIPSorcery *does* reassemble VP8 into whole frames (`OnVideoFrameReceived`) and `VideoPipeline` already ran a bounded 3-frame drop-oldest jitter queue, so no reorder buffer was needed. What was genuinely missing was loss visibility: a frame reassembled across a hole was fed to the decoder and every later inter frame referenced a reference buffer that never existed — the stripe corruption class. **Fix:** `WebRtcClient.WireVideo` now tracks the 16-bit RTP sequence number (wrap-safe, duplicates/late packets ignored) and calls `VideoPipeline.NotifyPacketLoss(missing)` on a gap; the pipeline flushes the queue, gates decode until the next VP8 keyframe (`(f[0] & 1) == 0`, RFC 6386 §9.1) and fires `KeyFrameRequested` → PLI. `loss=` and `gated=` counters added to the per-minute stats line for the S8 soak. |
| S14 | **No agent auto-update exists, and S3 is the standing proof of the cost.** Deployment is `build.ps1` + MDM packaging by hand; the map's own audit shows the fleet frozen on an old build while three shipped turns wait for evidence. Every future turn (4b included) inherits this bottleneck. Not in any tier or candidate scope. | S3 row; §8 packaging-docs row (jamf/intune/gpo are install-time only); §6/§7 (no update item) | Modest but real: version in heartbeat (already trivially available), a signed-release manifest route, agent-side download-verify-swap-restart via the existing `restart_agent` power command, staged rollout flag per device. Tier B sized; pays for itself by turn 4b's rollout |
| S15 | **(a) CLOSED 2026-08-03 — the pill is honest in both directions.** `LiveSessionViewModel.StartVideoStats` already demoted off `Pipeline.IsPresenting` (a decoded frame presented in the last 2 s, not "RTP arrived"); it now also *re-promotes* to "Native video" when presentation resumes after a keyframe recovery or ICE restart, which the one-shot `FirstFrame` callback could never do. **(b) still open** — the two contracts remain stale. Original finding: two truth items: the pill and the contracts. (a) Transport-pill honesty — "Native video" only when decoded frames are presenting — was contract clause 6.1 and gate G2's companion; no changelog or audit row ever confirms it closed. Given the ICE-surrender path deliberately drops to JPEG (pass-1 row), an untruthful pill would mask exactly the S9 degradations. (b) The two contracts + v2 amendment are now stale against reality (state machine is `invited → active\|declined` with `consented` legacy; admin-offers is settled; aspect/ContentRect shipped) — leaving them un-amended re-creates the ENDPOINTS.md class of drift that pass 3 just cleaned up. | (a) no `SCOPE:RENDER`/pill entry in §5, §8, §9; pass-1 ICE-surrender row. (b) §9.2 drift table (the precedent); contract texts vs §4 invariants | (a) One read of the pill's binding: it must key off "presented a decoded frame in the last N ms", not "RTP arrived" — verify or fix, one small change + audit row. (b) Documentation turn: mark both contracts SUPERSEDED with a pointer to this map, fold surviving obligations (S8's soak, S9's TURN scope) into §6 |

### Recommended re-sequencing (§6 impact)

Current "Next up" is turn 4b. This register argues the order should be:

1. **S3 + S8** — fleet rollout, then the field soak with S11's stats as the
   pass criteria. Closes the evidence gap under everything already shipped.
2. **S9** — ICE gateway + TURN + `wire_path` telemetry (new Tier A item 4).
   The connectivity floor for a commercial tool; also de-risks S13.
3. **Turn 4b** — hardware H.264, now landing on a measured, field-proven
   baseline that can actually demonstrate its improvement.
4. **S10** — input datachannel (new Tier B item, ahead of clipboard: same
   channel machinery, bigger feel win, receive side already shipped).

S12, S13 are verification-first checks that slot into the S8 soak week.
S14 lands whenever rollout pain next bites — before 4b if the S3 rollout
proves as slow as the map implies. S15 is a documentation turn, one sitting.

### What this pass deliberately did not claim

No code was read in this pass beyond what the map itself cites — S12 and S13
in particular are phrased as *unverified*, not *broken*. If `VideoPipeline`
already jitter-buffers or `D3DImageHost` already survives reset, the fix is a
§8 evidence row, not code. That is the same standard §9.4 set: where the code
is right, the document catches up.
