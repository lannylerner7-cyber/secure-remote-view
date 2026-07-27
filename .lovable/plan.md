## ConnectLive — Below are graded improvements, grouped by tier. Each item is verified against the files I actually read (agent + `/api/public/**` + core libs + `_authenticated/console.tsx`).

### security / correctness

1. **Rate-limit `/api/public/auth/login` by IP, not just identifier.**
  Today `login_attempts` keys only on `identifier` (email). An attacker can spray one attempt per account across many accounts from a single IP and never trigger a lockout. Add a second bucket per IP (or IP+identifier composite) and short-circuit at, e.g., 20 fails / 15 min. `getIp()` already extracts the header.
2. **Rate-limit + throttle `/api/public/agent/enroll`.**
  A single global `AGENT_DEPLOYMENT_KEY` is the whole trust boundary for onboarding. If it leaks, anyone can create unlimited fake devices. Add: per-IP rate limit, an optional per-install `nonce`/`serial` header stored in `deployment_keys` table with revocation + usage cap, and audit-log every failed key check with the masked IP (already done for success).
3. **Purge live-session tables.**
  `session_frames`, `session_cursors`, `session_inputs`, `session_signals` are written every ~100–500 ms during active sessions and never deleted. On session `state=ended`, delete rows for that `session_id`; also add a `pg_cron` sweeper that drops rows older than N hours. `audit_logs` and `notifications` need retention too.
4. **Replace anon-key auth on `/cron/reconcile-orders` with a dedicated `CRON_SECRET`.**
  The anon publishable key is by design shipped to the browser; using it to gate a mutating cron endpoint means anyone reading `window` can trigger reconciliation. Introduce `CRON_SECRET` env + `X-Cron-Secret` header, keep anon fallback off in production.
5. **CDP webhook replay protection.**
  HMAC is verified, but a captured request can be replayed forever. Require `x-cdp-timestamp` header, reject if >5 min skew, and include it in the HMAC input. Also persist `event_id` for idempotency instead of relying on `(order_id, tx_hash, event_type)`.
6. **Per-order deposit addresses.**
  `issueReceiveAddress` returns the same base address per coin. Two pending orders with the same USD amount land on the same address and become indistinguishable — the reconciler will match one order and orphan the other. Ship the real CDP-derived per-order address, or (interim) require a unique cent-level jitter in `amount_coin` so amount-match is unique.
7. **Broadcast-notification dedupe.**
  `/heartbeat` inserts a "Device reconnected" notification any time `wasOffline` is true. A flapping device (bad Wi-Fi) will spam every admin. Add a cooldown: skip insert if the same `device_id` produced a `device.reconnected` audit or notification in the last 5 minutes.
8. **Watcher + Agent double-heartbeat.**
  Both processes hit `/heartbeat` with the same device token. That doubles DB writes and can race the "reconnect gap" logic (Watcher heartbeat resets `last_seen_at`, Agent then doesn't look offline even though its own loop died). Split concerns: give the Watcher its own `/api/public/agent/watcher-heartbeat` that updates a `watcher_last_seen_at` column and only fires reconnect notifications from the Agent endpoint.
9. **Rotate device tokens.**
  `devices.metadata.token_hash` is set at enroll and never rotated. Add a rotation endpoint the agent hits every N days and store `token_hash_previous` with a 24-hour grace window.

###  Scale & performance

10. **Get frame delivery out of Postgres.**
  Uploading base64 JPEGs into `session_frames` and relying on `postgres_changes` replication for admin delivery works, but it puts binary bytes through WAL + logical replication + realtime broadcast per frame. At 5–10 FPS × several concurrent sessions this is expensive. Two better paths, in order of effort:
  - Short-term: switch from `postgres_changes` to Supabase **Realtime Broadcast** — agent posts to a broadcast channel, admin subscribes; database is untouched.
  - Medium-term: upload JPEG bytes to a Supabase Storage bucket (`session-frames/<sessionId>/latest.jpg`), send a broadcast "frame ready" ping, admin fetches the signed URL. Bandwidth and DB load both drop.
    Keep the WebRTC path as the fast lane it already is.
11. **Ship DXGI Desktop Duplication.**
  `DxgiCapture.cs` is a stub; `ScreenCapture` still uses GDI `CopyFromScreen`, which peaks CPU, misses hardware cursor, and can't see protected surfaces. Wire DXGI as the primary capture with GDI as fallback — the current adaptive-cadence + dirty-hash code moves over cleanly.
12. **Prefer H.264 (Media Foundation) over software VP8.**
  `WebRtcSession` uses `VideoEncoderEndPoint` (software VP8). On a normal endpoint that's a full CPU core for a 1080p stream. On Windows 10+ with a modern GPU, Media Foundation H.264 is essentially free. This is the single biggest quality-per-watt win left.
13. **TURN server, not just STUN.**
  `iceServers` is Google STUN only. Symmetric NAT (a lot of corporate networks) → WebRTC will never connect and the whole session runs on the HTTPS fallback. `.env.sample` already reserves `TURN_SERVER_*`; wire it through both agent and the browser side.
14. **Cache blockchain lookups in `cdp.server.ts`.**
  Every cron tick hits blockstream / etherscan once per pending order. Public endpoints will 429 you at scale. Cache per-address for 30–60 s in memory (or in a `blockchain_query_cache` table) keyed by `(coin, address)`.

### Codebase health

15. **Break up `src/routes/_authenticated/console.tsx` (1,748 lines).**
  The route holds state, realtime subscriptions, keymap tables, RBAC gating, WebRTC lifecycle, live-view canvas, trackpad, OSK, team panel, and payments — plus a `[]`-dep master `useEffect` that references `refresh`, `fetchRole`, `loadTg`, `nav` (stale-closure risk). Split into: `useAdminRealtime`, `useLiveSession`, `LiveViewCanvas`, `VirtualTrackpad`, `OnScreenKeyboard`, `DevicesPanel`, `SessionsPanel`, `AuditPanel`, `TeamPanel`, `SettingsPanel`. Each becomes independently testable and the effect deps become honest.
16. **Auth session storage.**
  `/api/public/auth/login` returns access + refresh tokens that the client stores in `localStorage` via `supabase.auth.setSession`. That is Supabase's default posture, but for an admin panel that controls remote machines, an XSS bug becomes total account takeover. Consider server-set httpOnly cookies via `@supabase/ssr` for `/connectlive/admin` specifically.
17. **Delete dead code & duplication.**
  `notify.functions.ts` vs `notifications.functions.ts` overlap; `PairingCode` field and `pair.ts` (410 Gone) are legacy of the removed PIN flow; several `as never` casts in `console.tsx` mask real type errors. Removing these tightens the graph.
18. `**select("*")` in `verifyDevice`.**
  Called on every agent request. Select the columns we actually need (`id, device_id, status, last_seen_at, display_name, metadata`) — smaller wire, cheaper JSON parse.
19. **Automated tests.**
  There's `scripts/verify-payment-routes.ts` but no unit/integration suite. Even a small `vitest` set around `verifyDevice`, login lockout math, `usdToCoin`, and the reconcile matcher would prevent quiet regressions in the modules that already carry real money.
20. **Observability.**
  Server routes only `console.warn` on errors. Add a `logEvent()` helper that writes to `audit_logs` for anything that returns 4xx/5xx from `/api/public/agent/*`, and expose a `/api/public/health` (already exists) that also reports agent-heartbeat lag percentiles.

### Notable things you got right

- Curtain mode via low-level hooks with `LLMHF_INJECTED` + magic `dwExtraInfo` (`CLIV`) is exactly the correct pattern; the 5-second watchdog + `SessionSwitch` dead-man release is genuinely production-grade.
- STA input pump on its own thread avoids the WPF dispatcher for input replay — smart.
- Watcher/Worker split with `CreateProcessAsUser` from `winsta0\default` is the right shape for surviving reboots and lockscreen.
- Timing-safe `timingSafeEqual` on both deployment key and webhook signature.
- Device token = raw only to client, SHA-256 hash at rest — correct.
- Auto-restart of session loops via `EnsureSessionLoops` health check.
- `/connectlive/admin` obfuscation + `robots: noindex` on the login page.

---

&nbsp;