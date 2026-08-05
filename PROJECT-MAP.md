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
| `agent/ice` | device token **or** technician JWT | S9 ICE set: STUN always, TURN via Cloudflare Calls when configured, then coturn/static fallbacks |
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

### 2026-08-03 — Native console: keyboard dead + picture soft (`SCOPE:INPUT` / `SCOPE:RENDER`)

- **Typing did nothing in `ConnectLiveAdmin.exe` while the web console typed
  fine.** `LiveSessionWindow.OnKeyDown` set `e.Handled = true` for *every* key
  and then returned early for printable ones, expecting `TextInput` to carry the
  character. WPF never raises `TextInput` for a key event that was already
  marked handled, so letters, digits, punctuation and space were dropped
  entirely; only non-printables (Enter, Tab, arrows, Ctrl/Alt combos) reached
  the agent. **Fix:** `e.Handled` is now set only for non-printable keys; an
  ordered `_awaitingText` list of pending printable keys, popped by
  `OnTextInput`, lets key-up send the raw `vk` down+up when no character was
  composed (dead keys / exotic layouts), so a keystroke can never be silently
  lost. It is a list rather than one slot because fast overlapping typing (B
  pressed before A is released) loses track of the outstanding key with a
  single field; it is capped at 16 entries and cleared on `Deactivated` so a
  key-up swallowed by a focus change cannot fire a spurious raw key later. The
  window also takes keyboard focus on `Loaded`, not just on first click. No
  change to `KeyboardInjector` / `InputTransport` — the `{ vk }` / `{ text }`
  payloads already match `agent/src/InputRelay.cs`.
- **Soft picture.** `FrameImage` scaled with WPF's default bilinear filter and
  unrounded layout, which smears remote text when a 1920px source is drawn into
  a ~1100px element. Now `RenderOptions.BitmapScalingMode="HighQuality"` (Fant)
  with `StretchDirection="DownOnly"`, `UseLayoutRounding` and
  `SnapsToDevicePixels` on the host grid.
- **Geometry follows `StretchDirection` (`SCOPE:RENDER` invariant).**
  `ContentRect.Compute` assumed the picture is always scaled to fit, so
  `DownOnly` would have broken click mapping and the ghost cursor for any
  source smaller than the element — precisely the low-rung case (1280px and
  below in a maximised window). `Compute` now takes `allowUpscale` (default
  `false`, capping scale at 1.0) and `LiveSessionWindow.Rect()` derives it from
  `FrameImage.StretchDirection`, so XAML stays the single declaration.
  **Invariant: if you change `StretchDirection` on the live surface, the
  `allowUpscale` policy must change with it.**
- **Rung is now readable.** `VideoStats` renders the source size as
  `1280x720 · rung 2/5` (edges mirrored from `agent/src/BitrateController.cs`)
  and, on the JPEG fallback path where there is no `VideoPipeline`, reports the
  decoded frame's own pixel size. The cached JPEG size is zeroed whenever the
  surface becomes a non-`BitmapSource` (the WebRTC `D3DImage` swap, or teardown)
  so a connected-but-not-yet-presenting session cannot report stale dimensions.
  A soft picture now says whether the agent stepped the encoder down or whether
  the presenter is at fault.


### 2026-08-03 — S12 closed: admin D3D device-lost survival (`SCOPE:RENDER`)

- **What was actually broken.** `D3DImageHost` recovered from exactly one of the
  four ways a technician's D3D9Ex device dies:
  1. TDR / GPU hang — handled before this turn (`TestCooperativeLevel` → rebuild).
  2. **Driver update / reinstall** — `D3DERR_DEVICEREMOVED` also invalidates the
     `IDirect3D9Ex` *factory*; the old code kept it and every `CreateDeviceEx`
     retry failed against a dead driver, so the session fell to bitmap for good.
  3. **RDP attach/detach, screen lock, laptop dGPU↔iGPU flip** — WPF drops the
     front buffer and produces **no HRESULT at all**; nothing in the polling path
     could ever see it. `Image.IsFrontBufferAvailableChanged` is now subscribed
     and rebuilds device + surface when the buffer returns.
  4. **Endless thrash** — a permanently sick GPU strobed between D3D and bitmap
     forever. A guard retires the D3D path after
     `MaxLossesPerWindow` (5) losses inside `LossWindowMs` (10 s); the caller
     then stays on the `WriteableBitmap` presenter for the session. A degraded
     picture beats a strobing one.
- **Also fixed:** `ReleaseSurface` called `Dispatcher.Invoke` unconditionally —
  reachable from the UI thread itself via the new front-buffer handler, which
  would have deadlocked; it now checks `CheckAccess()` first.
- **Observability.** `DeviceLost(reason)` / `DeviceRecovered` events plus
  `DeviceLosses`, `DeviceRecoveries`, `LastLossReason`, and `HealthLine()`.
  `VideoPipeline` subscribes both edges: the session log gets
  "GPU device lost (…) — rebuilding the present path" / "GPU device recovered",
  the pill demotes off `UsingD3D` immediately, the per-minute stats line carries
  `losses=`/`recovered=`/`lastloss=`, and S11 telemetry `render_path` now reads
  e.g. `d3d lost2/rec2` so a GPU reset on the technician's box is visible in the
  web console's Audit tab without a new column.
- **Evidence harness (the S12 ask).** `admin/spikes/d3d-present` gained an
  automated mode against the *shipping* host — no parallel implementation:

  ```text
  dotnet run --project admin/spikes/d3d-present -- --auto
  ```

  It drives class 1 (`SimulateDeviceLossForTest`), class 2
  (`SimulateDeviceLossForTest(removed: true)`), class 3
  (`SimulateFrontBufferLossForTest`), the G3 park→resume ×3 no-device-churn
  check, and class 4 (thrash guard), asserting after each that frames present
  again and the device count rose by exactly the losses caused. Writes
  `s12-evidence.txt` next to the exe and exits 0 (pass) / 1 (fail). On a host
  with no usable D3D it reports SKIP rather than a false failure — the bitmap
  presenter is the contract fallback there.
- Interactive buttons added for the same three classes so a technician box can
  be exercised by hand alongside `dxcap -forcetdr`.
- Files: `admin/src/Media/D3DImageHost.cs`, `admin/src/Media/VideoPipeline.cs`,
  `admin/src/Media/WebRtcClient.cs`, `admin/spikes/d3d-present/SpikeWindow.cs`.



### 2026-08-03 — S8 harness landed: soak driver (`SCOPE:TRANSPORT`, `SCOPE:REALTIME`)

- New **`scripts/e2e-soak.ts`** — the endurance driver S8 was missing. It spawns
  `SOAK_AGENTS` virtual agents; each one enrolls for real through
  `/api/public/agent/enroll` (keyless, so the harness exercises the production
  enrollment path, rate limiter included), heartbeats every 15 s, opens an
  `active` session, and pushes JPEG frames + cursor telemetry at `SOAK_FPS` for
  `SOAK_DURATION_S`.
- **Latency is measured end to end, not asserted**: a per-session Realtime
  subscriber using the console's own `postgres_changes` filters timestamps the
  delivery of each push, and the report prints p50 / p95 / p99 / max separately
  for frames and cursors, plus ok/err counts and error rate per hop
  (`enroll`, `heartbeat`, `frame`, `cursor`).
- **Exit code is a gate**: any hop above a 1 % error rate fails the run, so the
  soak can sit in CI or a release checklist rather than being read by eye.
- **Always cleans up** — every enrolled device and its sessions are deleted at
  the end, and devices are tagged `os: "soak"` / `hostname: soak-*` so a killed
  run leaves greppable rows rather than mystery fleet members.
- First validation run (3 agents × 15 s × 2 fps, localhost): 0 % error on all
  four hops; frame p50 1568 ms / p95 5096 ms, cursor p50 2473 ms / p95 4417 ms —
  that is the **HTTPS+Realtime fallback path**, not the native WebRTC path, and
  it is the baseline the render soak has to beat.
- **Still open on S8:** the native-render half (working set, decode errors,
  tear/colour drift, forced mid-run `switch_monitor`) needs the S3 fleet rollout
  and a Windows box; this harness covers the server, presence and realtime hops.

### 2026-08-03 — S14 closed: agent self-update (`SCOPE:PRESENCE`)

- New **`agent/src/SelfUpdate.cs`** — download → verify → swap → restart, run
  from the heartbeat loop. Invariants, all load-bearing:
  - **only when idle** (`_currentSessionId` empty) and **at most hourly**
    (`SelfUpdate.DueForCheck`), so an update can never interrupt a live
    session or become a restart loop;
  - **a manifest without `sha256` is never installed.** An unverified binary
    swap is a remote-code-execution primitive, not an update. Mismatch =
    discard + log, never install;
  - the swap is **rename-then-replace** (Windows won't overwrite a running
    image but will rename it): live exe → `%LOCALAPPDATA%\ConnectLive\update\
    ConnectLive-<old>.old`, new exe into its place, **rolled back on any
    failure** so the machine is never left without an agent;
  - startup registration is re-asserted against the new image, the relaunch is
    `/background` (silent, no splash), then the old process `Environment.Exit(0)`s;
  - one attempt per version per process, and every failure path is swallowed
    and logged — an update check must never take presence down.
- Accepts either a bare `.exe` or a `.zip` containing `ConnectLive.exe`.
- **`agent/build.ps1` / `admin/build.ps1`** now print the SHA-256 of every
  shipped artifact plus the ready-to-paste `insert into public.releases` row,
  so publishing a build cannot silently omit the checksum the updater requires.

### 2026-08-03 — S14 groundwork: release manifest + fleet version (`SCOPE:PRESENCE`)

- New table **`public.releases`** (product `agent|admin`, channel
  `stable|beta`, version, download_url, sha256, notes, min_supported_version,
  mandatory, published, published_at; unique per product+channel+version).
  Signed-in technicians read `published = true` rows; the service role writes.
  Nothing is exposed to `anon` — download URLs and checksums are not
  open-internet data.
- New route **`GET /api/public/agent/release`** (`?product=&channel=`), authed
  by device token *or* technician JWT, returning the newest published row or
  **204** when the channel is empty. Registered in `src/shared/api-routes.ts`
  as `agentRelease` and smoke-tested (401 unauthenticated) by
  `scripts/verify-agent-routes.ts`.
- **Agent** — `ApiClient.AgentVersion` (assembly `major.minor.build`) now rides
  every heartbeat as `version`; the heartbeat route merges it into
  `devices.metadata.agent_version` with the same non-clobbering discipline as
  `lan`/`monitors`/`encoder`, so the fleet's build spread is finally a number
  (this is what S3 could never answer). `ApiClient.GetReleaseAsync` +
  `ReleaseManifest.IsNewerThan` give the standalone agent a swap-free update
  check; the download/verify/restart step is still open.
- **Native admin** — `ApiClient.GetReleaseAsync` for the console's own update
  banner and to tell the technician which agent zip the fleet expects.
- **`.env.sample`** — the stale `TURN_SERVER_*` names are replaced with the
  ones `agent/ice` actually reads: `TURN_URLS`, `TURN_STATIC_SECRET`, and the
  static `TURN_USERNAME`/`TURN_PASSWORD` fallback.
- **§3** gains the missing `agent/ice` and `agent/release` rows; `ENDPOINTS.md`
  gains the release row.



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
  configured. **Cloudflare Calls TURN** is the primary relay source — the route
  mints per-request credentials via `rtc.live.cloudflare.com/v1/turn/keys/{appId}/credentials/generate`
  using `CLOUDFLARE_CALLS_APP_ID` + `CLOUDFLARE_CALLS_APP_TOKEN` and returns
  `turn:turn.cloudflare.com:3478?transport=udp` and `turn:turn.cloudflare.com:3478?transport=tcp`
  with short-lived username/password. Fallbacks: coturn REST credentials derived
  from `TURN_STATIC_SECRET`, then static `TURN_USERNAME`/`TURN_PASSWORD`.
  Authed by device token **or** technician bearer JWT — unauthenticated callers
  get 401, because relay minutes are billable. Registered as `API_ROUTES.agentIce`;
  documented in `ENDPOINTS.md`.
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
- **S9 CLOSED on 2026-08-04:** Cloudflare Calls TURN credentials are wired and
  the installer autostart gap is closed. The `wire_path` heartbeat field
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
- `src/routes/_authenticated/console.tsx` is **1,666 lines** (route shell + live view). Tier C item 8 **done** — presentational blocks now live in `src/components/console/*` with shared types in `src/lib/console-types.ts` and input mapping in `src/lib/console-input.ts`.
- DB: `power_commands_kind_check` vocabulary matches the doc; 2 active pg_cron jobs; 7 tables in `supabase_realtime`; `sessions` now carries exactly 3 triggers.

### 2026 — Agent surface reduction + verification pass (`SCOPE:PRESENCE`)


| Scope | File | Change |
| --- | --- | --- |
| `SCOPE:PRESENCE` | `agent/src/App.xaml.cs` | The agent has exactly one visible surface: the ~5 s startup splash, which doubles as the connection banner (device id + session state). No `MainWindow`, no tray icon, no wake pop-up — `onWake: null`, and `/BACKGROUND`, `/MINIMIZED`, `/WAKE` launches show nothing at all. Splash auto-closes after 5 s and every later state change is a no-op once it is gone. |
| `SCOPE:PRESENCE` | `agent/src/SplashWindow.xaml.cs` | Borderless branded card: wordmark, indeterminate progress, live status line, Device / Session rows, and the standing consent promise. Only remaining agent UI besides `ConsentPrompt` and `CurtainOverlay`. |
| `SCOPE:WEB` | `scripts/verify-agent-routes.ts` | Power-command vocabulary assertion now includes `switch_monitor` (turn 2 added it to the DB check constraint but not to the verifier). |

**Verification run (this pass)**

- TypeScript: clean, no diagnostics.
- `scripts/verify-agent-routes.ts` → 19/19 against `https://connectliveagent.com` (enroll issues a token; every device-token route 401s unauthenticated; login lockout active; PostgREST rejects keyless calls).
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
   (depacketize/jitter audit) are both CLOSED 2026-08-03; S12's `--auto` spike
   run belongs in the same soak week's evidence, on a real GPU box.

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
| Console is modular | `src/routes/_authenticated/console.tsx` = 1,666 lines + 11 component files in `src/components/console/` — 9 imported directly by the route, `DirectNotifyModal` and `PowerMenu` nested inside `TeamPanel` / `DevicesTable` |
| Every route has real head metadata | 11 web routes, each with a unique title + description; the 3 non-public ones also `noindex` + self-canonical |
| Server routes | 11 agent routes, `admin/bootstrap`, `auth/login`, `cron/reconcile-orders`, `webhooks/cdp`, `stats/orders`, `api/public/health`, plus the standalone unauthenticated `/health` probe for Coolify |
| Known dead code | **None.** The last two orphans — `MouseInjector.MoveRelAsync` and the `RtpCapture` RTP tap — were removed in the 08-05 alignment pass (§10.11). The agent still speaks `mousemove_rel`; re-add the admin wrapper the same turn WPF pointer capture lands. |
| Packaging / autostart | Inno + MSI installers now create four identical `/background` triggers at install time (HKCU Run, HKLM Run, all-users Startup shortcut, ONLOGON scheduled task with `/IT`), record `HKLM\Software\ConnectLive` `{InstallPath,Version}`, and clean up all four on uninstall. `StartupSelfHeal.cs` remains as belt-and-brades. `agent/INSTALL.md` and `agent/packaging/inno/README.md` list the verify commands. |

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
  dy)` for the same wire shape. **Removed again on 08-05 (§10.11)** — it never
  gained a call site because WPF pointer capture was never wired. Restore it
  together with that toggle; the agent side already accepts the shape.
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

**S15(b)** — retire the two stale contracts (one documentation sitting), then
**Turn 4b — hardware H.264 end-to-end** (Tier A, last item): MFT-backed
`IVideoEncoder` on the agent, an H.264 depacketise + decode branch in
`admin/src/Media/VideoPipeline.cs`, and negotiation that prefers H.264 only
where `HwEncoderProbe` found silicon. VP8 stays the guaranteed fallback on both
peers. After that Tier A is closed and the queue moves to Tier B (clipboard +
file drop) or Tier C item 9 (device health panel), whichever you want first.

Carried ops (not gaps): run `admin/spikes/d3d-present -- --auto` on a real GPU
box during the S8 soak week and paste `s12-evidence.txt` into §8; publish the
first `releases` rows (S14); verify Cloudflare Calls TURN relay rate in the
field (S9).


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
| Console modularity | `console.tsx` = **1,666** lines, 11 files in `src/components/console/`, 9 imported directly, `DirectNotifyModal`/`PowerMenu` nested — §8 row exact |
| Input invariant | `session.$sessionId.inputs.ts:41-44` gates on `state=active AND mode=control`, `curtain_off`/`release_inputs` always pass; frame route 409s `not_active` |
| Agent surface | One visible surface confirmed; zero `MainWindow`/`NotifyIcon`/`TrayIcon` hits under `agent/` |
| Turns 1–4a | `StreamListener` wired at `Agent.cs:196`; `BitrateController` 6-rung ladder owned centrally and read per frame by `ScreenCapture.cs:33,70,110`; `HwEncoderProbe.LogCapability()` at `Agent.cs:165`; heartbeat sends `monitors[]` + `selected_monitor` + `encoder{}` + `lan{}` (`ApiClient.cs:244-296`) |
| Power vocabulary | All 9 kinds handled in `PowerRelay.cs` (52/60/64/68/72/76/99/107/117) — matches `power_commands_kind_check` exactly |
| Transport | VP8 pin + non-VP8 reject (`WebRtcSession.cs:158,193`); RR parsed **before** the PLI/FIR early-return (:262-275); RTT per RFC 3550 §6.4.1 (:295-307); PLI/FIR → `RequestKeyFrame` |
| Render | `PredictiveCursor` driven from the render loop and gated on `InputAuthoritative` (`LiveSessionWindow.xaml.cs:77,131`); `VideoPipeline` is VP8-only as documented |
| Live DB | 8 devices / **1** online · 2 sessions / **0** live · 11 orders · 167 audit rows · 424 notifications · 4 power commands · 7 realtime tables · 3 triggers on `sessions` · both cron jobs active. §8 snapshot still true, and the reaper is holding presence honest a day later. |
| Route smoke | `verify-agent-routes.ts` 19/19 against `https://connectliveagent.com`; `verify-payment-routes.ts` 5/5; `tsgo --noEmit` clean |

### 9.2 Drift found and fixed in this pass (documentation truth)

| File | Was | Now |
| --- | --- | --- |
| `ENDPOINTS.md` header | Production URL given as `secure-remote-view.lovable.app` while every canonical, the sitemap and both verifiers target `connectliveagent.com` | Canonical URL stated first, platform alias kept as an alias |
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
| S8 | **PARTIALLY CLOSED 2026-08-03 — soak harness landed (see §5): `scripts/e2e-soak.ts` drives N virtual agents through the real enrollment/heartbeat/frame/cursor path, measures end-to-end Realtime delivery p50/p95/p99, and exits non-zero on >1 % error per hop. First validation run (3×15 s×2 fps, localhost): 0 % errors, frame p50 1568 ms / p95 5096 ms (HTTPS + Realtime fallback baseline).** Remaining: the native-render half — sustained-motion fps, working set, decode errors, tear/colour drift, forced mid-session `switch_monitor` — still needs S3 fleet rollout on a Windows box. Original finding: no verification run in §5 or §9 contained a sustained-motion endurance test of the native render path — no leak check, no tear check, no color-drift check, no forced mid-session resolution change. Compounded by open S3: the entire fleet runs an agent older than turns 2 and 4a, so the bitrate ladder, `monitors[]`, and the H.264 probe have zero production evidence. Turn 4b (hardware H.264) would be the fourth consecutive turn shipped with no field observation behind it. | §5/§9 verification runs list `tsgo`, route verifiers, and DB queries only; S3 row (`devices.metadata` on all 8 rows); §6 "Next up" names 4b as next | Rollout via `agent/build.ps1` (S3's own remedy) + one scripted 10-min soak: per-minute log of fps, queue depth, working set, decode errors; forced `switch_monitor` mid-run; pass/fail written into §8. **Sequencing change, near-zero code** |
| S9 | **CLOSED 2026-08-03 — Cloudflare Calls TURN wired.** Original finding: TURN and an ICE-config gateway are absent from all 12 backlog items.** §2 states "RTP/VP8, STUN only"; no `agent/ice` route exists in §3; both peers hardcode a public STUN server. A commercial remote-support tool meets symmetric NAT and corporate egress filtering as a matter of course — those sessions silently degrade to the JPEG fallback, which is the exact lag the engine was built to escape, and nothing measures how often it happens. | §2 system map; §3 route table (no ice row); §6 Tiers A–C (no TURN/ICE item); §7 candidate scopes (no TURN/ICE item) | One route (`/api/public/agent/ice` + admin equivalent, device-token/JWT authed, returns STUN+TURN set), a coturn or managed-TURN deployment with per-session ephemeral credentials, and a `wire_path` telemetry field (`host/srflx/relay`) in the heartbeat so relay rate becomes a number. Tier A sized | — **Status:** `/api/public/agent/ice` now mints Cloudflare Calls TURN credentials per request when `CLOUDFLARE_CALLS_APP_ID` + `CLOUDFLARE_CALLS_APP_TOKEN` are configured; coturn/static branches remain as fallbacks. `wire_path` telemetry is already emitted by `WebRtcClient`/`VideoPipeline` (see S11).
| S10 | **CLOSED 2026-08-03 — input rides the datachannel with REST fallback.** Original finding: agent's ondatachannel handler exists but no admin ever opened one; every click paid REST round-trip. — **Status:** `admin/src/Input/InputTransport.cs` owns the transport switch; `WebRtcClient.NegotiateAsync` opens an ordered `input` datachannel before `createOffer` and attaches it. `MouseInjector`/`KeyboardInjector` now call `InputTransport.SendAsync`; safety kinds `curtain_off` / `release_inputs` stay pinned to REST. First send failure demotes the session to REST for good, and the per-minute stats line now includes `input.path` + `dc.sent` + `rest.fallback` counters. |
| S11 | **CLOSED 2026-08-03 — render telemetry shipped (see §5): `session_telemetry` table, per-minute rows from the native console, live-window status bar, and the console Audit tab `RenderHealthPanel`. S8 now has pass criteria to read.** Original finding: nothing measures the render path. No fps counter, no decode-to-present latency, no dropped-frame counter anywhere in `SCOPE:RENDER`. Tier C item 9 (device health panel) surfaces agent-side facts only. Without these numbers the soak (S8) has no pass criteria and turn 4b's entire justification — "sharper, lower latency than software VP8" — cannot be demonstrated, only asserted. | §6 Tier C item 9 scope text; absence of any fps/latency mention in §4, §5, §8, §9 | `RenderStats` on the admin: frames decoded/presented/dropped per second, decode-ms and upload-ms rolling averages, exposed in the live-window status bar + logged. Feeds S8's soak log directly. Small |
| S12 | **CLOSED 2026-08-03 — device-lost survival implemented and provable (see §5).** Verification-first answer: the old `D3DImageHost` handled only class 1 (a lost/hung device seen through an HRESULT). Three real classes were unhandled — driver update (`D3DERR_DEVICEREMOVED` leaves the `IDirect3D9Ex` factory stale), RDP attach/detach + screen lock + dGPU/iGPU flip (WPF drops the front buffer with **no** HRESULT anywhere, so polling never notices), and endless thrash (a permanently sick GPU strobed between paths forever). **Fix:** factory rebuild on `DEVICEREMOVED`, `IsFrontBufferAvailableChanged` subscription, a 5-losses-in-10s thrash guard that retires the D3D path to the `WriteableBitmap` presenter, `DeviceLost`/`DeviceRecovered` events + `DeviceLosses`/`DeviceRecoveries`/`LastLossReason` counters, and a deadlock fix in `ReleaseSurface` (`Dispatcher.Invoke` from the UI thread). `VideoPipeline` logs both edges and demotes the pill; the per-minute line carries `losses=`/`recovered=` and telemetry `render_path` carries `lost{n}/rec{m}`. **Evidence:** `dotnet run --project admin/spikes/d3d-present -- --auto` drives all four classes plus the G3 park×3 no-churn check against the shipping host and writes `s12-evidence.txt` (exit 0/1). Original finding: admin-side D3D device-lost is unverified; the contract required recreate-and-continue and the map neither confirmed nor denied it. |
| S13 | **CLOSED 2026-08-03 — loss detection + keyframe gate in front of the decoder.** Audit result: SIPSorcery *does* reassemble VP8 into whole frames (`OnVideoFrameReceived`) and `VideoPipeline` already ran a bounded 3-frame drop-oldest jitter queue, so no reorder buffer was needed. What was genuinely missing was loss visibility: a frame reassembled across a hole was fed to the decoder and every later inter frame referenced a reference buffer that never existed — the stripe corruption class. **Fix:** `WebRtcClient.WireVideo` now tracks the 16-bit RTP sequence number (wrap-safe, duplicates/late packets ignored) and calls `VideoPipeline.NotifyPacketLoss(missing)` on a gap; the pipeline flushes the queue, gates decode until the next VP8 keyframe (`(f[0] & 1) == 0`, RFC 6386 §9.1) and fires `KeyFrameRequested` → PLI. `loss=` and `gated=` counters added to the per-minute stats line for the S8 soak. |
| S14 | **CLOSED 2026-08-03.** Manifest + version reporting + `agent/src/SelfUpdate.cs` (idle-only hourly check, mandatory sha256, rename-then-replace with rollback, silent `/background` relaunch); build scripts emit the checksum and the `releases` insert. Remaining as ordinary ops, not a gap: publishing the first rows, and an optional per-device staged-rollout flag. Original finding: **No agent auto-update exists, and S3 is the standing proof of the cost.** Deployment is `build.ps1` + MDM packaging by hand; the map's own audit shows the fleet frozen on an old build while three shipped turns wait for evidence. Every future turn (4b included) inherits this bottleneck. Not in any tier or candidate scope. | S3 row; §8 packaging-docs row (jamf/intune/gpo are install-time only); §6/§7 (no update item) | Modest but real: version in heartbeat (already trivially available), a signed-release manifest route, agent-side download-verify-swap-restart via the existing `restart_agent` power command, staged rollout flag per device. Tier B sized; pays for itself by turn 4b's rollout |
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

S12, S13 were verification-first checks; both CLOSED 2026-08-03 (S12 needed
real code, not just a test — see §5).

S14 lands whenever rollout pain next bites — before 4b if the S3 rollout
proves as slow as the map implies. S15 is a documentation turn, one sitting.

### What this pass deliberately did not claim

No code was read in this pass beyond what the map itself cites — S12 and S13
in particular are phrased as *unverified*, not *broken*. If `VideoPipeline`
already jitter-buffers or `D3DImageHost` already survives reset, the fix is a
§8 evidence row, not code. That is the same standard §9.4 set: where the code
is right, the document catches up.

---

## 10. Source-cut pre-flight — 2026-08-03 (`SCOPE:RELEASE`)

Run immediately before packaging the Agent / Admin source zips.

### 10.1 Verification run (2026-08-03)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `tsgo` | clean, exit 0 |
| Agent + auth routes | `BASE=http://localhost:8080 bun run scripts/verify-agent-routes.ts` | **24/24 passing** |
| Payment / order routes | `bun run scripts/verify-payment-routes.ts` | **5/5 passing** |

Note (ops, not a code gap): running the agent verifier against its default
`BASE=https://connectliveagent.com` returns 404 for `/api/public/agent/ice` and
`/api/public/agent/release` — the published deployment predates S9/S14. Both
routes are mounted and gated (401) on the current build; publish to clear it.

### 10.2 S15(b) — CLOSED 2026-08-03

The two legacy contracts (**CONTRACT-Native-Video-Engine-B**,
**CONTRACT-Connection-Layer**) and the **Gate Plan v2 amendment** are hereby
marked **SUPERSEDED** by this document. They are historical records only; where
they disagree with `PROJECT-MAP.md`, this map wins. Surviving obligations were
already folded in: the soak lives in S8 (§9.5 + `scripts/e2e-soak.ts`), the
TURN/ICE scope in S9 (`/api/public/agent/ice`, Cloudflare Calls), the
transport-pill honesty clause in S15(a), and the state machine is
`invited → active | declined` (`consented` legacy) per §4.

With this, **S15 is CLOSED in full**. Remaining open backlog: **S3** (Windows
fleet rollout) and the **S8 residual** (native-render soak) — both require a
Windows host and are unblocked by the source zips.

### 10.3 Packaging

- `RELEASE-CHECKLIST.md` (repo root) is the single procedure for the Windows
  build: prerequisites, `agent/build.ps1` / `admin/build.ps1`, signing, sha256
  capture, and the `public.releases` insert consumed by
  `/api/public/agent/release`.
- Source zips are cut from the `agent/` and `admin/` trees only, excluding
  `bin/ obj/ publish/ dist/ .vs/ *.user *.suo` and editor cruft. No secrets in
  either tree — re-verified at cut time (configs carry only the publishable
  key and public URLs).

### 10.4 S16 — "live video never starts" made visible — 2026-08-03 (`SCOPE:RENDER`)

Both consoles could sit on the JPEG fallback indefinitely while reporting
nothing more useful than "Frame fallback". The three causes and their fixes:

1. **Native decoder death was silent.** `VideoPipeline` created the VP8
   decoder inside the worker loop and swallowed failures, so a missing/failed
   `VpxVideoEncoder` produced an endless PLI storm and a frozen surface.
   Decoder init is now hoisted into `Start()`, consecutive convert/decode
   failures are counted (`MaxConsecutiveFailures = 60`), and crossing the
   threshold fires `VideoPipeline.NativeVideoUnavailable(reason)` exactly
   once. `WebRtcClient` reacts by surrendering to JPEG and setting
   `HasRelay/NativeVideoUnavailable` state the ViewModel reads back into the
   stats pill (`… · decoder unavailable · …`), instead of leaving the
   technician staring at "stalled".

2. **Stride-padded / NV12 decoder output was dropped as "Unknown".**
   `FrameConvert.Classify` now tolerates a padded row pitch and understands
   NV12 in addition to I420, so a healthy decode is no longer discarded as
   an unrecognised shape.

3. **The D3D surface bound to the wrong HWND.** `D3DImageHost.GetFocusWindow`
   fell back to `Application.MainWindow`, which stays as the Device List
   window; certain drivers refused to present into a hidden HWND and the
   surface stayed black. `LiveSessionWindow` now captures its own handle via
   `WindowInteropHelper.EnsureHandle()` on `Loaded` and passes it through
   `LiveSessionViewModel.PresentationWindow` → `VideoPipeline.PresentationWindow`
   → `D3DImageHost.PresentationWindow` before `Start()`.

4. **Web console applied the ICE gateway set after ICE gathering began.**
   `startWebRtcLive` created the `RTCPeerConnection` with the STUN-only
   fallback and awaited `fetchIceServers()` only later, racing
   `setLocalDescription`. It now awaits the gateway set first, calls
   `setConfiguration` before `addTransceiver`, records `relayState`
   (`"pending" | "relay" | "none"`), and exposes it via `WebRtcLive.relay()`.
   The console pill reads `Frame fallback (… · no relay)` with a tooltip
   naming the exact cause — "no relay — direct paths only, symmetric NAT
   will fail" — instead of a bare "Frame fallback".

Files touched: `admin/src/Media/{VideoPipeline,FrameConvert,D3DImageHost,WebRtcClient}.cs`,
`admin/src/Views/LiveSessionWindow.xaml.cs`,
`admin/src/ViewModels/LiveSessionViewModel.cs`,
`src/lib/webrtc-live.ts`, `src/routes/_authenticated/console.tsx`.

S16 status: **CLOSED** (visibility). The underlying "no TURN configured"
condition is a deployment concern — Cloudflare Calls credentials
(`CLOUDFLARE_CALLS_APP_ID` / `CLOUDFLARE_CALLS_APP_TOKEN`) are already
wired at `/api/public/agent/ice`; when unset, every console now says so
in-band. The 4K/H.264 quality ceiling is tracked as **S17** (step 1 shipped; see 10.5) (Agent-side
`BitrateController` 1080p clamp + software VP8).


### 10.5 S17 step 1 — native-resolution capture, 4K/2K ladder rungs — 2026-08-04 (`SCOPE:CAPTURE`/`SCOPE:TRANSPORT`)

S17 is the quality-ceiling item left open by S16. It ships in three steps;
step 1 (below) is capture-side only and is independently revertable. Steps 2
and 3 are deliberately NOT in this build — see "Still open" at the end.

**Cause 1 — the ladder had no rung above 1080p.**
`BitrateController.Ladder` topped out at `1920px / 4000 kbps`, so a 4K desktop
was captured at 4K, resampled down to 1920px, JPEG/VP8-encoded, then upscaled
again by the admin. Text was resampled twice and quantised at q70; "not sharp"
was a design ceiling, not a bug in the renderer.
**Fix:** two rungs prepended — `3840 / q82-92 / 30fps / 20000 kbps` and
`2560 / q76-88 / 30fps / 12000 kbps`. Every existing rung kept, unchanged, at
index+2.

**Cause 2 — a raised ceiling would have become a raised floor.**
`Reset()` set `_rung = 0`, which after the prepend would have opened every
session at 20 Mbps regardless of link.
**Fix:** `BitrateController.DefaultRung = 2` (the old 1920 top rung). Sessions
open exactly where they used to and only climb into 3840/2560 after the
existing sustained-clean-window rule. `Pin(performance)` maps to index 5
(the old index 3 / 1024px) and `Pin(sharp)` to `DefaultRung`, not 0.
`ScreenCapture.PerformanceMode` moved from `RungIndex >= 3` to `>= 5` for the
same reason.

**Cause 3 — the resample ran even at 1:1.**
`ScreenCapture` always allocated a second full-size bitmap and `DrawImage`d
the desktop into it. At 3840x2160 that is a ~33 MB copy per frame, 30x a
second, for a pixel-identical result — and `NearestNeighbor` at 1:1 is not
guaranteed bit-exact, so it also cost sharpness.
**Fix:** true passthrough. When `scale >= 1.0` and both dimensions are already
even, the raw DXGI bitmap is teed/encoded directly and the scratch buffer is
released. Odd desktop dimensions still take the resample path because the
encoder needs even dimensions (I420 2x2 chroma). A new `lastFrame` reference
feeds the idle keepalive and is nulled whenever the buffer it aliases is
reallocated.

**Cause 4 — hardcoded `1920x1080` fallbacks capped 4K boxes silently.**
`ScreenCapture`, `CursorPump` and `MonitorSelector` each invented
`new Rectangle(0, 0, 1920, 1080)` when monitor geometry was unavailable.
**Fix:** all three now read `SystemInformation.VirtualScreen` first and only
guess 1080p when that is also unusable — and `ScreenCapture` logs when it
does. Capture and cursor must agree here or the cursor overlay drifts out of
the picture's coordinate space.

**Cause 5 — the admin rung readout would have lied.**
`LiveSessionViewModel.RungEdges` mirrored the old six-entry ladder.
**Fix:** extended to `{ 3840, 2560, 1920, 1600, 1280, 1024, 800, 640 }`. This
array MUST stay in lockstep with the agent ladder.

**Cause 6 — a raised ceiling would have killed the WebRTC path.**
The wire codec is still software VP8 (`WebRtcSession` pins it). libvpx cannot
encode 3840x2160 in real time on a support machine's CPU, so a clean link
climbing to rung 0 would have replaced a soft picture with a dead one.
**Fix:** `BitrateController.Ceiling` — the sharpest rung the ladder may climb
into. `Reset`, `Pin` and the climb path all respect it. `WebRtcSession` sets
`Ceiling = DefaultRung` when a peer is built and back to `0` in `Close()`, so
the new rungs are live for the JPEG transport (what most sessions actually
render today) and dormant for VP8. Step 2 lifts the ceiling in the same change
that lands hardware H.264 — not before.

Files touched: `agent/src/{BitrateController,ScreenCapture,CursorPump,MonitorSelector,WebRtcSession}.cs`,
`admin/src/ViewModels/LiveSessionViewModel.cs`.

S17 step 1 status: **SHIPPED**.

**Still open (S17 steps 2-3):**

- **Step 2 — hardware H.264.** `HwEncoderProbe` finds NVENC/QuickSync/AMF and
  reports it in the heartbeat (`ApiClient.cs:277`), but nothing consumes it:
  `WebRtcSession.cs` still restricts to `VideoCodecsEnum.VP8` and rejects any
  other negotiated codec, and the admin decodes with libvpx. Consuming the
  probe requires a new `agent/src/HwH264Encoder.cs` wrapping the winning MFT
  behind SIPSorcery's video-encoder interface (NV12 in, Annex-B out, forced
  IDR on PLI/FIR) plus a Media Foundation H.264 decode path in
  `admin/src/Media/VideoPipeline.cs`. Negotiation is the small half; the MFT
  wrapper is the work. Gated behind step 1 being verified on a real 4K
  session, per plan — flipping the wire codec first would negotiate a stream
  nothing can encode, which is exactly what the current hard pin prevents.
- **Step 3 — ladder re-tune.** The step-down thresholds and the 10s/12s climb
  windows were tuned against a 4 Mbps ceiling and will oscillate at 20 Mbps.
  Re-measure RTCP loss/RTT on a real 4K session before touching them.


### 10.6 Benchmark — how ScreenConnect / Parsec render live video, and where we stand — 2026-08-04 (`SCOPE:CAPTURE`/`SCOPE:TRANSPORT`)

This section is the measuring stick for S17 steps 2-3. It records what the
reference products actually do, so future work is compared against facts
rather than impressions.

**What the reference products do**

| Stage | ScreenConnect (support-grade) | Parsec (pixel-grade) | ConnectLive today |
| --- | --- | --- | --- |
| Capture | Desktop Duplication + dirty-rect diffing | Desktop Duplication, full-frame, GPU-resident | DXGI Desktop Duplication + dirty-rect gating, now 1:1 passthrough (S17.1) |
| Encode | Tile/delta image codec, CPU, tuned for text and low bandwidth | Hardware H.264/HEVC (NVENC / QuickSync / AMF), frame never leaves the GPU | Software VP8 (WebRTC path) or GDI+ JPEG (fallback path), CPU |
| Transport | TCP relay through the server, session survives reconnects | UDP, custom BUD protocol, FEC, no relay unless required | WebRTC (STUN + Cloudflare TURN) with an HTTPS/JPEG fallback |
| Decode | CPU image blit | Hardware decode (DXVA / Media Foundation / VideoToolbox) | libvpx software VP8 → BGRA → D3DImage (native admin) or `<video>` (web) |
| Present | GDI blit | D3D11 swapchain, vsync-aware, no extra copy | D3D9Ex + `D3DImage`, WriteableBitmap fallback |
| Target | legibility over fidelity — ~10-15 fps at 1080p is normal and accepted | 60 fps at 4K, sub-frame input lag | 30 fps ladder, 640-3840px |

**The honest read on where we sit**

- *Capture:* at parity with both. Desktop Duplication with dirty rects is the
  same primitive ScreenConnect uses, and S17.1 removed the last redundant
  full-frame copy.
- *Transport:* at parity with ScreenConnect, and arguably ahead — they relay
  everything through their server by default; we do direct WebRTC first and
  only relay through Cloudflare TURN when NAT forces it.
- *Present:* at parity. `D3DImage` with a device-lost recovery path (S12) is
  the correct WPF answer.
- *Encode/decode:* **this is the whole gap, and it is the only one.** Both
  reference products keep the frame on the GPU end to end. We round-trip
  through system memory and a CPU codec on both sides. That single difference
  is what "soft picture, can't do 4K" reduces to — everything else in the
  pipeline is already the right shape.

**Verdict on the question "do we match their standard?"**

Against ScreenConnect's *support* standard: after S17.1, on the JPEG path, at
native resolution — yes, for text legibility. Against Parsec's *pixel*
standard: no, and we cannot until the frame stops touching the CPU. There is
no third architecture that closes it; both brands solved it the same way, so
S17 step 2 (hardware H.264 encode on the agent + Media Foundation decode in
the admin) is not "being different", it is reaching parity.

**Sequencing decision: measure before building step 2.** Step 2 is the
highest-risk change in the project (MFT P/Invoke, forced IDR on PLI/FIR,
Annex-B framing, negotiation rewrite on both ends). Building it before S17.1
is measured on real hardware risks tuning it against a problem that has
already moved. Required evidence first, from a real 4K session:

1. `session_telemetry` rows showing `source_width`/`source_height` at the
   monitor's native size (proves the 1:1 passthrough and the unclamped
   bounds are live).
2. Sustained `fps` and `latency_ms` at rung 2 and, on the JPEG path, at rungs
   1 and 0 — this tells us whether the CPU wall arrives at 2560 or 3840.
3. `render_path` = `d3d` for the whole session, `frames_dropped` flat, and no
   `NativeVideoUnavailable` in the session log.
4. Agent CPU while encoding, alongside the `HwEncoderProbe` result already
   carried in the heartbeat — this is the number that sizes the win from
   step 2 and justifies the work.

If (2) shows the software encoder wall at 2560px, step 2 goes ahead as
written. If the JPEG path holds 3840 acceptably, step 2 stays queued and step
3 (ladder re-tune) ships first, which is far cheaper.

**Ideas deliberately parked as "different", not better** — content-aware rung
selection (text vs video regions), server-side frame relay for slow admins,
and HEVC. None of them are worth touching before the encode/decode gap is
closed; all three are optimisations on top of hardware codecs, not
replacements for them.


### 10.7 S17 step 2 / phase 1 — encode instrumentation + codec kill switch — 2026-08-04 (`SCOPE:CAPTURE`/`SCOPE:TRANSPORT`)

§10.6 made hardware H.264 conditional on measurement rather than impression.
This is that measurement, plus the switch that will govern the encoder before
the encoder exists. **No codec behaviour changes in this build: the wire is
still software VP8 on all three peers.**

**`agent/src/EncodeStats.cs` (new)** — a measuring instrument, nothing else.
Two interlocked adds per frame, one `TotalProcessorTime` read per 2 s window.
Tracks, per session:

| Field | Meaning |
|---|---|
| `jpeg_ms` | mean JPEG encode, HTTPS fallback transport |
| `vp8_ms` | mean software VP8 encode submission, WebRTC transport |
| `cpu_pct` | agent process CPU as % of **one** core (>100 = spilling across threads) |
| `ws_mb` | working set |
| `peak_width`/`peak_height` | widest geometry actually handed to an encoder |
| `rung` | current ladder rung |

Encode time excludes upload — the ladder already owns upload latency via
`BitrateController.NoteUploadLatency`, and folding the two makes a slow link
look like a slow encoder. Every read is failure-tolerant: a refused CPU or
working-set read reports "not measured" (`null` in the payload, `-` in logs)
instead of throwing. `Reset()` runs on each new peer — last session's averages
say nothing about this one.

**`agent/src/CodecPolicy.cs` (new)** — the single answer to "which codec may
this build put on the wire?", read from `CONNECTLIVE_CODEC` = `vp8` (default)
| `auto` | `h264`. `auto` means H.264 *only* where hardware exists, and is
never the default: Windows always offers a **software** H.264 MFT that is
slower than libvpx VP8, so drifting into it would be a regression. An
unrecognised value logs a warning and stays on VP8.

`AllowH264` has **no consumer yet**. Flipping the VP8 pin in `WebRtcSession`
to read it is the first line of S17 step 3, and must land in the same change
as the MFT wrapper and the admin Media Foundation decoder — advertising a
codec the agent cannot encode negotiates a stream nothing can produce.

**Wiring**

- `ScreenCapture.cs` — times `frame.Save(...)` alone; emits `[encode]` every
  10 s from the capture loop, so the line appears even when the WebRTC peer
  never comes up and only JPEG is carrying.
- `WebRtcSession.cs` — times `ExternalVideoSourceRawSample`; `[encode]` rides
  alongside the existing 5 s `webrtc video pipe:` line, so one log excerpt
  answers both "are frames flowing?" and "what did they cost?". `EncodeStats.Reset()`
  on peer init.
- `Agent.cs` — `CodecPolicy.LogPolicy()` at startup, next to
  `HwEncoderProbe.LogCapability()`.
- `src/routes/api/public/agent/heartbeat.ts` — persists the `encode` block into
  `devices.metadata.encode` (+ `encode_updated_at`) with the same merge
  discipline as `lan`/`monitors`/`encoder`: an older agent that omits it must
  not erase what a newer build reported. Values are clamped and non-finite
  numbers dropped; `null` stays `null`, because "not measured" is not "zero".
  Without this the fleet-wide answer stops at the agent log.
- `ApiClient.cs` — heartbeat gains `encode {...}`; `encoder.wire_codec` now
  derives from `CodecPolicy` instead of the old `"VP8"` literal, so it cannot
  drift from the guardrail. Both are wrapped: a telemetry fault must never
  fail a heartbeat and mark a healthy machine offline.

**Invariant** — `encoder.wire_codec` is derived, never asserted. If it ever
disagrees with what `WebRtcSession` negotiates, the fleet data is lying and
that is the bug to fix first.

**Left to wire before step 3**: read a real 4K session's `[encode]` line and
`devices.metadata.encode` against the §10.6 decision rule — VP8 encode time
approaching the ~33 ms frame budget, or CPU pinning a core at the 2560/3840
rungs, is what authorises the MFT work. Admin- and web-side decode telemetry
already exist (`VideoPipeline.StatsLine()`, S11 render telemetry).

---

## §10.8 — Codebase / route / key verification pass (V1–V5)

Full sweep of every route file, every endpoint string in `agent/` and
`admin/`, and every environment key the code reads versus what is provisioned.

**V1 — TURN was dead for every technician console (FIXED).**
`src/routes/api/public/agent/ice.ts` verified technician bearers with a client
built from `SUPABASE_URL` + `SUPABASE_ANON_KEY`. `SUPABASE_ANON_KEY` is not set
on this project — the deployed name is `SUPABASE_PUBLISHABLE_KEY` (which is why
`agent/release.ts` already read both). `verifyTechnician` therefore always
returned false, both consoles got 401 from the ICE gateway, and every session
ran on Google STUN only: the Cloudflare Calls TURN credentials wired in S9 were
reachable by the agent side alone, so symmetric-NAT sessions silently degraded
to the JPEG fallback.

Fix: read `SUPABASE_PUBLISHABLE_KEY ?? SUPABASE_ANON_KEY`, and log once (module
flag, not per request) when neither is present.

**Invariant** — the ICE gateway's technician auth reads the *publishable* key
name first. A rename that drops it does not break loudly; it degrades video
quality silently. `scripts/verify-agent-routes.ts` now probes `/agent/ice` with
a bogus bearer and asserts 401 (never 500), proving the client still constructs.

**V2 — stale secrets retired.** `AGENT_DEPLOYMENT_KEY` (removed with the
enrollment overhaul) and `CRON_SECRET` (the cron route validates against
`public.cron_tokens`, not env) are read by no code and have been deleted from
the environment.

**V3 — route inventory.** No ghosts: every endpoint string in the agent and
admin sources resolves to a real file under `src/routes/api/public/`, and every
entry in `src/shared/api-routes.ts` exists. The verifier's one hole —
`/api/public/agent/power/{cmdId}/ack` — is now probed; the rest of the
session-scoped family was already covered.

**V4 — `src/routes/_authenticated/route.tsx`** gained a `head()` with a console
title, description, og tags, and `robots: noindex, nofollow`. It is the
authenticated shell and must never be indexed.

**V5 — keys correctly absent.** `TURN_URLS` / `TURN_STATIC_SECRET` /
`TURN_USERNAME` / `TURN_PASSWORD` are the coturn fallback and stay unset while
Cloudflare is configured. `SUPABASE_SERVICE_ROLE_KEY` appears only in
`scripts/e2e-wake.ts`, an operator script — not a runtime dependency.

No agent or admin C# changes were required: both already handle an empty ICE
set gracefully and start using TURN the moment the gateway stops returning 401.

---

## §10.9 — Where we are / what is left — 2026-08-04 (`SCOPE:ROADMAP`)

Rolling status board. Update this section with every change so the next pass
starts from truth instead of memory.

**Wired and verified (closed)**

| Item | State |
| --- | --- |
| S8 soak harness (`scripts/e2e-soak.ts`) | closed |
| S9 ICE gateway (Cloudflare Calls TURN) | closed — technician path fixed in V1 |
| S10 input over WebRTC datachannel | closed |
| S11 render telemetry | closed |
| S12 admin D3D device-lost survival | closed |
| S13 jitter-buffer audit / S15 contracts | closed |
| S14 agent self-update + versioned installer | closed |
| S16 stride/NV12 hardening, JPEG fallback signal, ICE await on web | closed |
| S17 step 1 — native-resolution capture, 2560/3840 rungs, ceiling guard | closed (§10.5) |
| S17 step 2 phase 1 — `EncodeStats` + `CodecPolicy` kill switch + heartbeat `encode` payload | closed (§10.7) |
| V1–V5 route / key / metadata verification | closed (§10.8) |
| Sanitized agent + admin source zips | re-cut 2026-08-04 |
| U1 admin console UX — reachable toolbar, scoped key capture, Fit/1:1, docked banners | closed (§10.10) |

## §10.10 — Native admin console UX repair — 2026-08-05 (`SCOPE:RENDER`)

Four defects, all in the WPF chrome — no transport, capture or ViewModel change.

1. **Toolbar layout.** `LiveSessionWindow.xaml` docked the status panel first
   and let it grow without bound, so the eight action buttons (the last child)
   were clipped out of the window and the bar looked dead. **INVARIANT** — the
   action `WrapPanel` is declared FIRST with `DockPanel.Dock="Right"` so it
   always reserves its width; the status panel is the fill child and trims with
   `TextTrimming`. Power actions (lock / reboot / shutdown) now live in a single
   `Menu` so the bar fits a normal window.
2. **Key capture scope.** The window-level `PreviewKeyDown/Up` handlers marked
   Enter/Space/Tab/arrows handled everywhere, disabling keyboard operation of the
   chrome. **INVARIANT** — forwarding is gated on `Stage.IsKeyboardFocusWithin`;
   the live surface (`Stage`) is focused on load and on any click on the picture.
3. **Fit / 1:1.** Fit = `Stretch=Uniform` + `StretchDirection=Both` (upscale
   allowed, small rungs fill the window); 1:1 = `Stretch=None` +
   `StretchDirection=DownOnly` inside `FrameScroll`. **INVARIANT** —
   `ContentRect.Compute`'s `allowUpscale` is still read off the Image's live
   `StretchDirection` in `Rect()`, and the ghost cursor maps image-space to
   canvas-space via `TransformToVisual` so scroll offset is honoured in 1:1.
4. **Banners** (take-over, status) are docked above the picture instead of
   overlaid on it, and the live window opens maximised. Device-list action cells
   use a `DataGridCell` style with `Focusable=False` so Connect / Wake / Delete
   fire on the first click.


**Open / next**

1. **S17 step 2 phase 2 — measurement window.** Run real 4K sessions and read
   `devices.metadata.encode` against the §10.6 decision rule (mean VP8 encode
   time approaching the ~33 ms frame budget, or a pinned core at the 2560/3840
   rungs). No MFT work starts until this evidence exists.
2. **S17 step 2 phase 3 — hardware H.264** (conditional on phase 2): agent-side
   MFT `IVideoEncoder` wrapper (NV12 in / Annex-B out, IDR on PLI), admin-side
   Media Foundation decoder, web console codec preference. Ships behind
   `CodecPolicy` with VP8 as the default fallback.
3. **S3 fleet verification** — remains the oldest unclosed audit item.
4. **Release** — re-run `scripts/verify-agent-routes.ts` (24/24) and
   `RELEASE-CHECKLIST.md` before each packaged drop.

**Invariant** — nothing here is marked closed on intent. A row moves to the
closed table only after the code exists in the repo and the matching probe,
telemetry line, or checklist step passes.

---

## 10.11 — End-to-end audit pass (2026-08-05): bridge inventory & doc drift

A read-only line-by-line pass over every web route, `agent/src/*.cs` (22 files),
`admin/src/**` (32 files), `scripts/**`, and the Supabase migrations, diffed
against this document. Result: **no CLAIMED-BUT-MISSING code.** Everything the
map says is wired, is wired. Three items were corrected or recorded.

### Route-string cross-check — clean
Every hardcoded `/api/public/...` string in `agent/src/ApiClient.cs`,
`agent/src/StreamListener.cs`, `admin/src/Api/ApiClient.cs`, `scripts/**`, and
the web console resolves one-to-one to a real file under
`src/routes/api/public/**` (19 route files). **Zero mismatches, zero 404 risk.**

### Bridge inventory (indirection layers, all three codebases)

| Bridge | Location | Status |
|---|---|---|
| `InputTransport` (datachannel → REST) | `admin/src/Input/*`, `Media/WebRtcClient.cs` | **Live** — consumed by `MouseInjector`, `KeyboardInjector`, `LiveSessionViewModel` |
| `FrameFallbackPump` (JPEG path when WebRTC is unavailable) | `admin/src/Media/FrameFallbackPump.cs` | **Live** — dual-path with WebRTC, matches §2 |
| `StartupSelfHeal` → `StartupRegistration` | `agent/src/StartupSelfHeal.cs:9,33,40,47` | **Live** — belt-and-braces, called from `App.xaml.cs:82` |
| `RtpCapture` diagnostic tap | ~~`admin/src/Media/RtpCapture.cs`~~ | **DELETED 08-05.** Env-gated (`CONNECTLIVE_RTP_CAPTURE=1`) passive RTP dump built for Spike 1 under a contract §10.2 superseded; its own docstring ordered its removal after Phase 3. File deleted, field/arm/write/dispose call sites stripped from `WebRtcClient.cs`. The RTP receive path now does loss detection only. |
| `MouseInjector.MoveRelAsync` | ~~`admin/src/Input/MouseInjector.cs:38`~~ | **DELETED 08-05.** Zero call sites since it shipped. A comment at `MouseInjector.cs:32` records the wire shape and the re-add condition (WPF pointer-capture toggle). Agent `InputRelay.cs:88` and the browser console are untouched — `mousemove_rel` still works end-to-end from the web side. |
| `CodecPolicy.AllowH264` | `agent/src/CodecPolicy.cs:18,67` | **Dead switch by design** — no consumer until S17 Step 2 Phase 3. `HwH264Encoder.cs` genuinely does not exist yet; VP8 is still hard-pinned at `WebRtcSession.cs:158,193`. |

### Doc drift corrected in this pass
- `console.tsx` line count: **1,648 → 1,666** (4 occurrences: §7, §8, §9.1, §10).
- Agent route verifier: **22/22 → 24/24** (§10.1) — the power-ack and
  technician-bearer ICE probes were added but the count was never bumped.

### Still open (unchanged, needs a physical Windows host)
S3 fleet verification, native-render soak, and the 4K measurement window that
gates S17 Step 2 Phase 3. No sandbox pass can close these.

---

## §9.6 — The "feels like enterprise RMM" register — S18–S25 — 2026-08-05 (`SCOPE:ROADMAP`)

Not plumbing gaps — the pipeline is RMM-grade. These are the gaps between
"works" and "feels like the technician is sitting at the physical machine."
Nothing here is closed on intent; every row is tagged
*asserted-absent / regressed / verify-first / unmeasured*.

| # | Gap | Evidence | Tag | Cost / priority |
|---|---|---|---|---|
| S18 | **No native-path latency or fps number exists.** Every figure in this doc is the JPEG+Realtime fallback on localhost (frame p50 1568 ms / p95 5096 ms). Zero measured glass-to-glass, sustained fps, or fps-under-motion for the native VP8→D3D path. | §5 S8; §10.9 open 1; §10.11; S11 | **INSTRUMENTED 08-05 — reading still owed** | **Instrumentation shipped (§10.12).** Remaining: one Windows host, one real session under sustained motion, paste the `Copy stats` line back. Unblocks S17-P2, S20 and all rung tuning. |
| S19 | **The pointer lags the hand.** The ghost cursor follows decoded video, so every motion pays the full round trip. Enterprise RMMs draw the technician cursor locally at input time and reconcile. Relative mode is regressed: `mousemove_rel` works from the browser and `agent/src/InputRelay.cs:88` honours it, but admin `MouseInjector.MoveRelAsync` was deleted 08-05 (re-add condition at `MouseInjector.cs:32`). | §2; §10.10; §10.11 | **CLOSED 08-05** | **Shipped.** (a) local cursor draw + reconcile, hide OS cursor over the stage; (b) re-add `MoveRelAsync` behind a pointer-capture toggle. |
| S20 | **Nothing paces presents to the display** — motion micro-judders even at good fps. Render invariants cover correctness, not smoothness. Distinct from the encoder: H.264 (S17-P3) raises the ceiling, pacing makes whatever fps you have look even. | §4; §10.9 1–2; S12 | not addressed | **P1.** Present on a vsync/`CompositionTarget.Rendering` cadence with a 1–2 frame smoothing buffer; measure judder via S18. `Media/VideoPipeline.cs`, `Media/D3DImageHost.cs`. |
| S21 | **No file transfer.** Table-stakes RMM (push a driver, pull a log). The input datachannel is the pattern to mirror. | §2/§3; S10 | asserted absent | **P1.** Ordered/reliable file datachannel, chunked + SHA-256 (reuse S14 checksum discipline), progress UI, per-transfer owner approval. |
| S22 | **No clipboard sync.** | §2/§3 | asserted absent | **P2.** Text-first, size-capped, `mode=control` only, off by default (exfiltration-capable). |
| S23 | **No technician-side monitor picker.** Agent enumerates and switches (`MonitorSelector`, `switch_monitor`); U1 fixed toolbar/keys/Fit/banners, not a monitor strip. | §10.10 U1 | verify-first | **P2.** Confirm nothing is wired, then selector + thumbnail strip driving the existing `switch_monitor`. |
| S24 | **No session recording / playback.** Rich event auditing exists; nothing captures what was done on screen. | §3 `audit_logs`; §5 | asserted absent | **P2, larger.** Retention-limited, encrypted, owner-accessible; schema + retention cron. |
| S25 | **Code-signing / procurement lead time.** Only item that can progress without a physical Windows host — start the cert now. | §10 release | open | **P0 by lead time, small code change.** |

**Sequence:** S18 first (nothing else can be tuned honestly until it reads a
number) → S19 + S25 in parallel → S20 with S17-P3 → S21/S22/S23 → S24.

### Consent policy change — 2026-08-05
The connect-time consent dialog is **off by default**. `ConsentPrompt.AskAsync`
now returns `true` immediately unless
`HKCU\Software\ConnectLive\PromptOnConnect = 1`, in which case the Allow/Deny
dialog (and `StandingConsent`) behave exactly as before. Nothing else changed:
the server still records the consent transition via
`POST /api/public/agent/session/:id/consent`, and the curtain, session banner
and audit trail keep the session visible to the owner.

### S19 — local cursor draw + pointer capture — CLOSED 2026-08-05 (SCOPE:INPUT)
(a) `LiveSessionWindow.SyncLocalCursor()` hides the OS cursor over the stage
whenever the console is authoritative (`InputAuthoritative`) or capture is
engaged, so the only pointer on screen is the orange ghost drawn from LOCAL
input by `PredictiveCursor` — the pointer now tracks the hand, not the decoded
video.
(b) `Input/PointerCapture.cs` (new) implements pointer-lock the way WPF cannot:
the physical cursor is parked at the centre of `Stage` and each move is read as
a delta and warped back (self-warps ignored). `MouseInjector.MoveRelAsync` is
re-added (`mousemove_rel { dx, dy }`, matching `agent/src/InputRelay.cs:88`) and
`InputCoalescer.UpdateRel` SUMS deltas between flushes — a dropped delta is
lost motion, unlike an absolute point. The remote pointer is therefore
unbounded and free of letterbox clamping.

Invariants: capture releases on Esc/F8, window deactivation, loss of
`InputAuthoritative`, and window close. While captured WPF routes mouse events
to the capturing element, so `Stage` carries delegate handlers that are no-ops
unless capture is engaged (no double-fire in normal mode). Absolute and
relative moves never interleave — `TryPointFor` uses a locally integrated
normalised point while captured.


---

## §10.12 — S18 Session Health HUD — instrumentation shipped — 2026-08-05 (`SCOPE:ADMIN`, `SCOPE:WEB`, `SCOPE:DB`)

S18 was never a code gap in the usual sense: fps and latency were already
counted, but nothing on the technician's glass said *how much data the link
delivered*, and the first telemetry row only landed 60 s in — so a short
measurement session wrote nothing at all. Both are now fixed.

**Wire bitrate (`admin/src/Media/VideoPipeline.cs`).** `_bytesIn` /
`_bytesWindow` are incremented in `Submit`, at the wire, *before* any gating or
drop decision, so the number reads what arrived rather than what survived.
`TickFps` converts the window to kbps on the exact same span that produces fps
(`bytes * 8 / span_ms` is kbit/s by definition), so the two figures always
describe the same second. Exposed as `BitrateKbps` / `BytesReceived` and added
to `StatsLine()`.

**First sample at 15 s (`admin/src/Media/WebRtcClient.cs`).** `StatsLoop`
delays 15 s once, then settles to the 60 s cadence. A session a technician ends
after half a minute now leaves a durable row.

**On-glass HUD (`admin/src/ViewModels/LiveSessionViewModel.cs`).** `VideoStats`
carries `fps · kbps · ms · queue · drop · size · path · wire · input`. fps alone
cannot separate "the link starved us" from "the decoder fell behind"; bitrate
and drop count together can.

**`Copy stats` (`LiveSessionWindow.xaml` → `CopyDiagnosticsCommand`).** Puts
session id, device, UTC timestamp, the full `StatsLine()`, wire path, ICE
restart count and the input-transport line on the clipboard. This is the
measurement path: the reading S18 still owes comes from a human on a real
Windows host, and asking them to dig `admin.log` out of `%LOCALAPPDATA%` is
exactly how that measurement never happens.

**Persistence.** `session_telemetry.bitrate_kbps` (numeric, nullable) added by
migration; the admin writes it straight through PostgREST in
`ApiClient.PushTelemetryAsync`, so no server route changed. The web console's
`RenderHealthPanel` shows a `bitrate` column and its empty-state copy now says
15 seconds, not a minute.

**Still open on S18:** the number itself. Run one real session under sustained
motion at a high rung, hit `Copy stats`, and record the result here — S17-P2
(hardware H.264) and S20 (present pacing) both stay unjustified until it exists.

---

## §10.13 — Commercial surface split + responsive pass — 2026-08-05 (SCOPE:WEB)

**Pricing (DB, authoritative).** `public.plans` re-priced to a monthly desktop
subscription ladder: `starter` = 10 desktop devices / **$250 mo**, `team` = 20
devices / **$570 mo**, `business` = 50 devices / **$840 mo**. `custom` stays a
`/contact` funnel. The homepage plan cards now render price + `/month` + device
count and are sourced from the same tiers; `/order` reads live rows from
`getActivePlansPublic`, so the DB is the single source of truth — never hardcode
prices in a second place.

**Payments split from the technician console.** `Payments` is gone from
`/console` (nav button, panel mount, `PaymentsPanel` import, and the
`payments` member of `NAV_VALUES`). The panel now lives on its own authenticated
route `src/routes/_authenticated/payments.tsx` (`/payments`, `noindex`), gated on
`admin | super_admin` with an explicit "not a payments administrator" state.
`/connectlive/payment` signs in and lands on `/payments`; `/connectlive/admin`
still lands on `/console`. Cross-links exist both ways. The native admin's
`Payments (web)` toolbar button and `OpenPayments_Click` handler were removed —
payments are a browser-side, separately-authenticated surface now.

**Responsive.** `/console` sidebar is `lg:` only; below that a scrollable pill
nav strip carries the same destinations and the header collapses to a
`grid-cols-[minmax(0,1fr)_auto]` row with a mobile sign-out. `/order` coin
selector stacks to one column under `sm:`, the submit row wraps, and both home
and order render at 768/390 with `scrollWidth == viewport` (no overflow).

**Iconography.** Order form fields carry lucide glyphs (user / mail / phone /
building), coin tiles carry brand-tinted icons (BTC `#F7931A`, USDT `#26A17B`,
USDC `#2775CA`), and the footer policy row is icon-led (shield / file /
rotate / mail) with the project blurb trimmed to one line.

---

## §10.14 — Step 2: Self-hosted SMTP + order emails — 2026-08-05 (`SCOPE:WEB`, `SCOPE:DB`)

**Goal.** Order confirmations must leave our own mail server, with no third-party
email SDK and no Node-only dependency (the site runs on the Worker runtime).

### Database
| Object | Shape | Access |
|---|---|---|
| `public.smtp_settings` | singleton (`id boolean PK CHECK (id)`): `host, port, username, password, from_name, from_address, reply_to, encryption('none'\|'starttls'\|'ssl'), enabled, updated_at, updated_by` | RLS on, **zero policies**, `service_role` only — the password can never reach a browser |
| `public.order_emails` | `order_id → orders`, `kind('order_received'\|'order_confirmed'\|'test')`, `recipient`, `status('sent'\|'skipped'\|'error')`, `detail` | `SELECT` for `admin` / `super_admin`; writes via service role |

### Code
| File | Role |
|---|---|
| `src/lib/smtp.server.ts` | dependency-free SMTP client. Dual wire: `cloudflare:sockets` (prod, dynamic specifier so bundlers don't resolve it on Node) and `node:net`/`node:tls` (dev). Handles EHLO, STARTTLS upgrade, implicit SSL, AUTH PLAIN/LOGIN, multipart/alternative body, RFC 2047 headers. `loadSmtpSettings()` returns `null` unless `enabled && host && from_address`. |
| `src/lib/order-emails.server.ts` | branded HTML+text templates (`order_received`, `order_confirmed`) on `connectliveagent.com`; `sendOrderEmail*` never throws and always logs to `order_emails`. |
| `src/lib/smtp.functions.ts` | super-admin `getSmtpSettings` (returns `has_password`, never the secret), `saveSmtpSettings` (blank password keeps the stored one; audit-logged as `smtp.settings_saved`), `sendSmtpTest`, `resendOrderEmail`; admin `listOrderEmails`. |
| `src/components/EmailSettingsPanel.tsx` | Payments console → **Email** tab (super-admin only): relay form, test send, delivery log with Resend on failed/skipped rows. |

### Triggers
- `createOrderPublic` → `order_received` (invoice, pay-to address, price-lock expiry, track link).
- `markOrderPaid` (manual) and the CDP webhook on a `→ paid` transition → `order_confirmed`
  ("software + sign-in details within 24–48 hours; check your spam folder").
  The webhook reads the prior status first so redeliveries can't re-send.

### Invariants added
1. Order/payment flows must never fail because SMTP is down — every send is wrapped and logged.
2. `smtp_settings` stays policy-free; all reads go through server functions with the service role.
3. No `nodemailer` / Node-only mail package — it cannot bundle for workerd.

---

## §10.15 — Step 3+4: Meeting-ID licensing & seat enforcement — 2026-08-05 (`SCOPE:DB`, `SCOPE:AGENT`, `SCOPE:WEB`)

**Model.** One customer account = one license = one permanent Meeting ID
(`CL-XXXX-XXXX`, minted by `public.generate_meeting_id()`, service-role only)
carrying plan, seat limit, term (`starts_at`/`expires_at`) and status.

### Database
| Object | Notes |
|---|---|
| `public.licenses` | `meeting_id UNIQUE`, `user_id` (portal account), contact/company, `plan_code`, `seat_limit`, `status(active\|suspended\|cancelled)`, term, `notes`. Staff read all; a customer reads only their own row. |
| `devices.license_id` + `devices.license_state` | `unlicensed\|active\|blocked\|expired`. Customers may read and delete their own devices (deleting frees a seat immediately). |
| `orders.license_id` | binds renewals/upgrades to an existing license. |
| `app_role` | new `customer` value — portal accounts only, zero technician surface. |

### Enforcement
- `POST /api/public/agent/enroll` accepts `meetingId`. Unknown ID → **403 `invalid_meeting_id`** so the agent can re-prompt. Known but full/expired/suspended → enrolls **blocked** (visible in the portal, dormant on the machine). Response now carries `license: { state, reason }`.
- `POST /api/public/agent/heartbeat` re-evaluates every beat, writes back `license_state` when it changes, and returns `license { state, reason, meeting_id, expires_at, seats_used, seat_limit }`. A non-licensed device gets **no sessions and no power commands** (and commands are not consumed/marked dispatched), but keeps heartbeating so it wakes the instant a seat frees.
- Seat ranking is enrollment order: the oldest `seat_limit` devices hold the seats; later ones are blocked. An already-seated device never blocks itself.
- **Grandfather rule:** `license_state = 'unlicensed'` (no license bound) stays fully functional — the pre-licensing fleet and direct admin enrollments are untouched. Only a *bound* license that is full/expired/suspended makes a machine dormant.

### Code
| File | Role |
|---|---|
| `src/lib/licensing.server.ts` | `normalizeMeetingId`, `findLicenseByMeetingId`, `evaluateLicense` (single source of the seat/expiry verdict). |
| `src/lib/licenses.functions.ts` | staff `listLicenses` (with live seat usage) / `listLicenseDevices`; super-admin `createLicense` (mints Meeting ID, optionally creates the auth user + `customer` role, links a paid order), `updateLicense` (seats, term extension, suspend/restore, plan), `resetCustomerPassword`. All audit-logged. |
| `src/components/CustomersPanel.tsx` | Payments console → **Customers** tab: provision form (email, seats 10/20/50, term, generated portal password shown once), license table with seats used/limit, expiry, suspend/restore, +1 month, seat change, password reset, and per-license device list. |

**Next:** customer portal at `/public/agent/login` (step 6) and the agent-side Meeting-ID prompt + dormancy (step 7).

---

## §10.16 — Step 6: Customer portal — 2026-08-05 (`SCOPE:WEB`)

Two new page routes, entirely separate from the technician console (no session,
device-control or payment-admin surface reachable from them):

| Route | File | Notes |
|---|---|---|
| `/public/agent/login` | `src/routes/public.agent.login.tsx` | Customer sign-in, reuses `AdminLoginCard` → `POST /api/public/auth/login` (same 3-strike / 1-hour lockout). Links across to `/connectlive/admin` for technicians. |
| `/public/agent/portal` | `src/routes/public.agent.portal.tsx` | `ssr: false` + `beforeLoad` session gate → redirects to the login route. Meeting ID with copy button, plan/seats/status/renewal stats, expiry banner at ≤7 days, device list (remove frees a seat), renewal CTA into `/order`, password change. |

`src/lib/portal.functions.ts` (all `requireSupabaseAuth`, all scoped to the
caller's own license — no `supabaseAdmin` reads):
`getMyPortal` (license + devices + `days_left` + `seats_used`),
`removeMyDevice` (double-scoped by `license_id` on top of RLS),
`changeMyPassword` (admin `updateUserById` for the caller's own id only).

RLS verified in place: `customer reads own license`, `customer reads own devices`,
`customer deletes own devices` — alongside the staff policies.

`/license` now links to the customer portal so paid subscribers can find it.
Route check: `/public/agent/login`, `/public/agent/portal`, `/license`, `/order`,
`/connectlive/admin` all return 200 and are registered in `routeTree.gen.ts`.

**Next:** step 7 — the agent-side Meeting-ID prompt, DPAPI `meeting.dat`, and
dormancy UX when the heartbeat reports `blocked`/`expired`.

---

## §10.17 — Step 7: Agent Meeting-ID prompt + dormancy — 2026-08-05 (`SCOPE:AGENT`)

The Agent now owns the customer-side of licensing end-to-end. First run
prompts once, remembers the ID forever, and stays enrolled through every
license state (active / blocked / expired) so a machine revives the instant a
seat frees or a subscription renews.

| File | Change |
|---|---|
| `agent/src/MeetingIdPrompt.cs` | New WPF modal matched to the splash's brand tokens. Uppercase 16-char input, Enter/Escape wired, inline error re-shown on `invalid_meeting_id` server response. `MeetingIdPrompt.Ask(error?)` is thread-safe (marshals to the WPF dispatcher) and returns null on cancel. |
| `agent/src/ApiClient.cs` | `EnrollIfNeededAsync` now sends `meetingId`, loops on HTTP 403 `invalid_meeting_id` back to the prompt with a clear error, persists the ID under DPAPI-encrypted `%LOCALAPPDATA%\ConnectLive\license.dat` (Hidden|System), and exposes `LicenseState` + `OnLicenseChanged`. `HeartbeatAsync` parses `license.{state,reason,meeting_id,expires_at}` on every response and raises the same event. `EnrollResponse` gained `[JsonPropertyName]` attributes; the local device-creds file was split into its own POCO (`StoredCreds`, case-insensitive read) so pre-existing `device.dat` blobs deserialize unchanged. |
| `agent/src/App.xaml.cs` | Wires `api.MeetingIdProvider = MeetingIdPrompt.Ask` only on foreground launches — `/BACKGROUND` and `/WAKE` starts stay silent and defer enrollment. `OnLicenseChanged` updates the splash status while it is still visible (`Licensed — Meeting XXXX`, `Subscription expired — renew to resume support`, `All seats in use — remove a device in your portal`, `Device not activated on this license`). |
| `agent/src/Agent.cs` | Enroll retry loop catches `OperationCanceledException` when the user dismisses the prompt: sets `Activation required — enter your Meeting ID` on the splash and stays resident/dormant instead of hammering the prompt in a loop. |

Dormancy contract: heartbeat keeps flowing in every state so the server always
knows the machine's presence and can flip it live the moment
`evaluateLicense` returns `active`. Frames, cursor, inputs, power commands
already gate on `licensed` in `heartbeat.ts` — the agent side is purely UX.

Route/keys inventory: no new endpoints. The enroll and heartbeat contracts
introduced in §10.15 are consumed as designed. `meeting.dat` (DPAPI machine
scope) is the fourth file in the hidden `ConnectLive` config folder, joining
`device.dat`, `session.dat`, `config.json`.

**Next:** Native Admin Console side of licensing (Customers panel, seat
management, portal password reset from within the console).


## §10.18 — Step 8: Session files + encrypted archive — 2026-08-05 (`SCOPE:FILES`)

In-session file transfer now exists end-to-end on the web side. Bytes ride a
dedicated `files` WebRTC DataChannel (separate from `inputs`, so a 400 MB push
can never head-of-line block a keystroke) and every payload is archived in the
private `session-files` bucket, giving the session a durable transcript that
outlives the peer connection.

| File | Change |
|---|---|
| `public.session_files` / `public.session_secrets` | Manifest rows + short-lived wrapped password. RLS: technicians reach only their own sessions; secrets are service-role only. |
| `session-files` storage bucket | Private. Browsers never hold a durable link — uploads use one-shot signed upload URLs, downloads 5-minute signed URLs. |
| `src/lib/session-files.server.ts` | Quotas (500 MB/file, 5 GB/session), path sanitising, AES-GCM wrap/unwrap of the verified customer password, WinZip AE-2 (AES-256) archive build via `@zip.js/zip.js` with web workers disabled for the Worker runtime. |
| `src/lib/session-files.functions.ts` | `listSessionFiles`, `prepareSessionUpload`, `registerSessionFile`, `deleteSessionFile`, `getSessionFileUrl`, `cacheSessionPassword`, `clearSessionPassword`, `packageSessionFiles`. Every fn re-checks technician ownership (or `super_admin`) before touching storage. |
| `src/routes/api/public/agent/session.$sessionId.file.ts` | Device-token authed chunk fallback (`?fileId&seq&eof=1`, ≤8 MiB/chunk). Parts stitch into the final object on EOF, then the manifest row is written and parts pruned. Same quotas as the datachannel path. |
| `src/lib/webrtc-live.ts` | Second ordered/reliable `files` channel. Wire format: JSON `file_begin` / raw chunks / `file_end`. Backpressure yields at 4 MiB `bufferedAmount`. New API: `filesReady()`, `sendFile()`, `onFile()`. |
| `src/components/console/SessionFilesPanel.tsx` | Drag-and-drop send, inbound list with direction arrows, per-transfer progress, single-file download, and "Encrypted .zip" for a multi-select. |
| `src/routes/_authenticated/console.tsx` | Panel mounted under the live drawer for non-viewer roles. |

Password handling: the technician verifies the customer's own account password
(checked against auth via a throwaway client that immediately signs out). Only
the AES-GCM ciphertext is stored, it expires after two hours, and it is
unwrapped server-side solely to lock an archive — it is never returned, logged,
or echoed to the browser.

**Next:** Agent-side `files` DataChannel handler + HTTP fallback client
(`agent/src/FileTransfer.cs`). The native Admin Console Files side panel is
implemented in §10.19.

## §10.19 — Step 9: Native Admin Console file manager — 2026-08-06 (`SCOPE:FILES`)

The WPF admin console now exposes the same session-file capabilities as the web
panel, using the raw Supabase JWT of the signed-in technician for storage calls.

| File | Change |
|---|---|
| `src/routes/api/public/admin/session.$sessionId.files.ts` | Technician-JWT authed `GET`/`POST`/`DELETE`. Mirrors §10.18 quotas and password verification. |
| `admin/src/Api/Models.cs` | `SessionFile`, `PrepareUploadResponse`, `PackageFilesResponse`, `SimpleResult`, `SessionFilesList` DTOs. |
| `admin/src/Api/ApiClient.cs` | `ListSessionFilesAsync`, `PrepareSessionUploadAsync`, `UploadToSignedUrlAsync`, `RegisterSessionFileAsync`, `RequestZipAsync`, `SubmitSessionPasswordAsync`, `DeleteSessionFileAsync`. |
| `admin/src/Media/FileTransport.cs` | `files` DataChannel protocol: 64 KiB chunks, SHA-256 reassembly, progress events, 4 MiB backpressure gate. |
| `admin/src/Media/WebRtcClient.cs` | Negotiates a second ordered DataChannel named `files` and wires it to `FileTransport`. |
| `admin/src/Converters/BooleanConverters.cs` | `InverseBooleanConverter` + `NullToVisibilityConverter` used by the new panel. |
| `admin/src/ViewModels/LiveSessionViewModel.cs` | `Files` collection, bytes-used tracker, unlock/password helpers, `SendFiles`/`DownloadZip`/`DeleteFile`/`RefreshFiles` commands. |
| `admin/src/Views/LiveSessionWindow.xaml` | Toolbar "Files" toggle + right-side slide-out panel with file list, password UI, and action buttons. |
| `admin/src/Views/LiveSessionWindow.xaml.cs` | Password box mirror and drag-and-drop file enqueue. |

---

## §10.20 — Step 10: Agent file receiver + HTTP fallback — 2026-08-05 (`SCOPE:FILES`, `SCOPE:AGENT`)

Closes the file-transfer loop: files pushed from the web console or native
admin now land on the remote machine, and files initiated on the agent flow
back to the technician through the same channel — with an authed HTTP fallback
the mo

| File | Change |
|---|---|
| `agent/src/FileTransfer.cs` | New. `files` DataChannel receiver/sender identical to `admin/src/Media/FileTransport.cs` and `src/lib/webrtc-live.ts` (control JSON + 64 KiB binary frames, SHA-256, 4 MiB backpressure gate, 500 MiB per-file cap). Inbound files land atomically in `%PUBLIC%\Desktop\ConnectLive Files` with `.part`-then-rename; falls back to `%ProgramData%\ConnectLive\Files` then `%TEMP%\ConnectLive Files` when the interactive-session desktop is unwritable. Outbound tries the channel first, then permanently demotes to HTTP if the channel closes/fails mid-flight. |
| `agent/src/WebRtcSession.cs` | `ondatachannel` now dispatches the reliable `files` channel to `FileTransfer.Attach` instead of routing every payload into `InputRelay`. `Close()` calls `FileTransfer.Detach()` so a superseded session cannot keep an inbound reassembly buffer or a stale `RTCDataChannel` reference alive across reconnects. |
| `agent/src/ApiClient.cs` | New `UploadSessionFileChunkAsync(sessionId, fileId, seq, eof, name, mime, sha256, totalSize, chunk, ct)` posts 4 MiB chunks to `/api/public/agent/session/{id}/file?fileId=&seq=&eof=1` with `X-File-Name / X-File-Mime / X-File-Sha256 / X-File-Size` headers — byte-for-byte the envelope `session.$sessionId.file.ts` already parses. Uses the shared `SendAuthedAsync` pipeline so the machine token auto-refresh and revocation cooldown apply here too. |

**Verifier note:** `scripts/verify-agent-routes.ts` reports `POST
/api/public/agent/session/…/file` as `404` against production because the
route ships in this deploy — locally it returns `401` as designed. The next
publish flips that check green with no code change.

**Next up (S21 register — file transfer):** admin-console UX polish for
inbound files pushed *from* the remote machine (surface a "New file from
agent" toast in the web console/native admin, deep-linking to the manifest
row), and a small `files` health tile in the Session HUD so operators can see
DC vs. HTTP for the currently-transferring file.
