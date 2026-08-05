# ConnectLive — Endpoint Audit

Canonical production URL: `https://connectliveagent.com` (this is what `head()`
canonicals, `sitemap.xml` and `scripts/verify-agent-routes.ts` all target).
Platform alias: `https://secure-remote-view.lovable.app`
Stable preview: `https://project--13b47594-1b4d-46c6-a939-da4132e55c1c-dev.lovable.app`

Everything under `/api/public/*` bypasses site auth, so each handler does its
own verification (device token, admin bearer token, cron secret, or webhook
signature).

## Agent endpoints (called by `agent/src/ApiClient.cs`, `agent/src/PowerRelay.cs`)

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| POST | `/api/public/agent/enroll` | Auto-enrollment; returns the device id + machine token persisted (DPAPI) in `%LOCALAPPDATA%\ConnectLive\device.dat`. | none + IP rate limit |
| POST | `/api/public/agent/hello` | First contact after enrollment; reports OS, hostname, MAC/subnet. | device token |
| POST | `/api/public/agent/heartbeat` | Adaptive cadence presence ping; returns the active session, mode, power commands. | device token |
| POST | `/api/public/agent/session/{sessionId}/frame` | Uploads the JPEG screen frame (`frame` column, base64). | device token |
| POST | `/api/public/agent/session/{sessionId}/cursor` | Detached cursor telemetry for the SVG overlay. | device token |
| GET | `/api/public/agent/session/{sessionId}/inputs` | Drains queued mouse/keyboard input for the session. | device token |
| POST | `/api/public/agent/session/{sessionId}/signal` | WebRTC offer/answer/ICE publish. | device token |
| GET | `/api/public/agent/session/{sessionId}/signal` | WebRTC signal poll (fallback transport). | device token |
| POST | `/api/public/agent/session/{sessionId}/reconnect` | Rebinds a stored session after reboot / soft restart. | device token |
| POST | `/api/public/agent/session/{sessionId}/consent` | The agent's session-acceptance post. Since the consent dialog was removed (PROJECT-MAP §10.28) the agent auto-accepts — authorisation is account-level via Meeting-ID enrollment and enforced server-side on every heartbeat. Still the **only** writer of `invited → active` (or `invited → declined`); any other current state is a 409. Writes `session.consent_granted` / `session.consent_declined` to `audit_logs`. | device token |
| POST | `/api/public/agent/power/{cmdId}/ack` | Acknowledges a queued power command (restart, shutdown, wake, restart_stream, switch_monitor). | device token |
| GET | `/api/public/agent/stream` | SSE wake channel — **live on both ends**. Client is `agent/src/StreamListener.cs`, which nudges the heartbeat loop on `event: wake` for sub-second revival. Heartbeat stays the source of truth; SSE only shortens the latency. | device token |
| GET | `/api/public/agent/ice` | **S9 — ICE gateway.** Single source of truth for the ICE server set: STUN always, plus TURN when configured. Preferred: Cloudflare Calls TURN credentials minted per request via `CLOUDFLARE_CALLS_APP_ID` + `CLOUDFLARE_CALLS_APP_TOKEN`. Fallback: coturn REST creds from `TURN_STATIC_SECRET`, then static `TURN_USERNAME`/`TURN_PASSWORD`. Consumed by `agent/src/WebRtcSession.cs`, `admin/src/Media/WebRtcClient.cs` and `src/lib/webrtc-live.ts`; every caller falls back to hardcoded STUN if the call fails. | device token **or** technician bearer JWT |
| GET | `/api/public/agent/release` | **S14 — release manifest.** `?product=agent\|admin&channel=stable\|beta` returns the newest `published` row in `public.releases` (`version`, `download_url`, `sha256`, `notes`, `min_supported_version`, `mandatory`), or **204** when nothing is published. Consumed by `agent/src/SelfUpdate.cs` (via `ApiClient.GetReleaseAsync`; refuses any row without `sha256`) and `admin/src/Api/ApiClient.GetReleaseAsync`; publishers insert the row after `build.ps1` uploads the zip. | device token **or** technician bearer JWT |

Retired: `/api/public/agent/pair` (meeting-code pairing) — removed with the
auto-enrollment overhaul.

## Admin / console endpoints

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| POST | `/api/public/auth/login` | Native Admin console sign-in (`admin/src/Api/ApiClient.cs`); returns the Supabase session used for all later REST calls. | credentials + 3-attempt / 1-hour lockout |
| POST | `/api/public/admin/bootstrap` | One-time super-admin provisioning. | bootstrap secret |

Everything else the web console does goes straight through the Supabase client
(`supabase.from(...)`) under RLS, or through server functions:

- `src/lib/notify.functions.ts` — `sendTelegramNotify` (session_start,
  session_end, control_taken, control_released, device_offline)
- `src/lib/notifications.functions.ts` — in-app notification fan-out
- `src/lib/admins.functions.ts` — role reads, admin create/delete (super admin)
- `src/lib/orders.functions.ts` — checkout / order lifecycle
- `src/lib/webrtc-signal.functions.ts` — admin-side WebRTC signalling

## Public site / ops endpoints

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/public/health` | Uptime probe. | none |
| GET | `/robots.txt` | Crawl policy; disallows console/portal/checkout/API, points at the sitemap. | none |
| GET | `/sitemap.xml` | Six indexable public pages. | none |
| GET/POST | `/api/public/newsletter/unsubscribe` | One-click unsubscribe (RFC 8058). HMAC token over the address; GET renders a confirmation page, POST answers the `List-Unsubscribe-Post` call. | HMAC token |
| GET | `/health` | Standalone Docker/Coolify liveness probe (`src/routes/health.ts`) — no auth, no DB touch. | none |
| GET | `/api/public/stats/orders` | Aggregate, non-PII order counters for the landing page. | none |
| POST | `/api/public/cron/reconcile-orders` | Scheduled crypto-payment reconciliation. Currently authenticated with the Supabase **anon key** as bearer, not a dedicated secret (open decision, PROJECT-MAP §8). | cron secret |
| POST | `/api/public/webhooks/cdp` | Coinbase CDP payment webhook. Returns **503 `Webhook not configured`** until the CDP webhook signing secret is set — until then, order confirmation rides the cron reconciler alone. | signature verified |

## Telegram notification matrix

Configured per-admin in **Console → Settings** (`admin_settings`: bot token,
chat id, per-kind toggles). All sends funnel through `pushNotify()` in
`src/routes/_authenticated/console.tsx`, which logs `not_configured`, `muted`,
`provider_error`, and `network_error` to the browser console.

| Event | Kind | Trigger |
| --- | --- | --- |
| Session started / wake sent | `session_start` | Connect, wake, and the Settings test button |
| Session ended | `session_end` | End session / bulk end |
| Curtain engaged | `control_taken` | Take control, queued power commands |
| Curtain released | `control_released` | Release curtain |
| Device went offline | `device_offline` | Presence transition online → offline in the console poll loop |

## Transport parity (web console + native admin + agent)

Mouse-move coalescing runs on a per-frame flush (browser rAF, WPF
`CompositionTarget.Rendering`, agent batch-local drain). Ordered events
(mousedown/up, wheel, keys, text, curtain_*) flush any pending move first so
click targeting stays pixel-accurate across transport swaps. Transport labels
are shared between surfaces: `WebRTC video`, `Realtime frames`,
`Frame fallback`, `Reconnecting`, `Ended`.

## Verification

`bun run scripts/verify-agent-routes.ts` smoke-tests the agent routes.
`scripts/e2e-smoke.ts` and `scripts/e2e-wake.ts` cover enrollment, frame/cursor
delivery, and the wake path end to end.
