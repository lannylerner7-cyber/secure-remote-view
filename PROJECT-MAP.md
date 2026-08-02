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

1. `SCOPE:CAPTURE` — DXGI always duplicates output **index 0** while cursor/GDI
   math uses `Screen.PrimaryScreen`: wrong monitor and offset cursor on
   multi-monitor machines. Needs an output picker + a monitor-origin offset in
   `CursorPump.cs`.
2. `SCOPE:TRANSPORT` — agent has no RTCP **PLI/FIR handler**; keyframes only
   arrive on the 60-frame periodic refresh, so the admin's PLI is a no-op and
   recovery from packet loss takes up to two seconds.
3. `SCOPE:TRANSPORT` — `WebRtcSession._cts` / `_handoffLock` leak per session
   churn.
4. `SCOPE:PRESENCE` — `src/routes/api/public/agent/stream.ts` is dead
   server-side; either implement the SSE loop or delete the route and the
   client stub.
5. `SCOPE:INPUT` — `InputRelayBridge` reflection is unnecessary
   (`InputRelay.Apply` is already `internal`).
6. `SCOPE:WEB` — prettier formatting failures in lint (no correctness issues).

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
