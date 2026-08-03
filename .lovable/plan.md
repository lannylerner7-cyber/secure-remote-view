## Audit result

Verified `PROJECT-MAP.md` claim-by-claim against `agent/`, `admin/`, `src/` and the live database. **The overwhelming majority is true as written** — the roadmap is an unusually honest document. Below is only what does *not* match.

### Confirmed (no action)

- Agent: single splash surface (zero `MainWindow`/`NotifyIcon` hits), `MonitorSelector` → DXGI/GDI/CursorPump pipeline, `PowerRelay` all 9 power kinds incl. `switch_monitor`, six-rung `BitrateController` ladder with the exact documented thresholds, RTCP RR parse before the PLI early-return + RFC 3550 RTT, 200 ms keyframe cooldown, `_cts`/`_handoffLock` disposal, `InputRelayBridge` gone, `HwEncoderProbe` + heartbeat `encoder` block, `StreamListener` SSE (infinite timeout, 30 s backoff, 60 s↔10 s cadence), `ConsentPrompt` 90 s auto-decline, `mousemove_rel` without ABSOLUTE, `PeriodicRefreshFrames = 300`, RowPitch honoured.
- Admin: `PredictiveCursor` constants (0.045 / 3 samples / 700 ms / 0.18 ease), `InputAuthoritative` gate + notifications, 10 s monitor poll with `_applyingRemote` guard and `switch_monitor`+`restart_stream`, Display combo collapsed unless multi-monitor, `GetDeviceAsync`, `EndSessionAsync` 3× backoff, Realtime join-reply 10 s budget, ICE-restart cap 4 / 2-min decay / PLI surrender, `VideoPipeline` still VP8-unconditional as documented.
- Web: all 17 public routes exist with the documented guards, `/pair` fully gone from code, input-relay and frame-state invariants exact, signal idempotency/whitelist/32 KB cap, heartbeat merge-don't-clobber for `lan`/`monitors`(cap 8)/`encoder`, `switchMonitor` semantics, pointer-lock accumulator with sub-pixel carry, `api-routes.ts` 1:1 with real files, `start.ts` bearer middleware, no protected fn in a public loader.
- DB: `power_commands_kind_check` (9 kinds) and `state_check` exact, both pg_cron jobs active, 7 realtime tables, exactly 3 triggers on `sessions`.

### Discrepancies to fix

**A. Roadmap facts now stale (§8 snapshot drift)**
1. `console.tsx` is **1,629** lines, not 1,514 (Tier A items 1 and 3 landed since).
2. "Web console has **no** monitor picker" — false since Tier A item 1; §8 row contradicts §5.
3. Row counts drifted: 8 devices (not 5), 166 audit rows.
4. §8 lists 10 extracted components as if `console.tsx` imports them all; it directly imports 9 + `MonitorPicker` — `DirectNotifyModal` and `PowerMenu` are nested inside `TeamPanel`/`DevicesTable`.
5. Turn-2 changelog says the bitrate ladder is "both directions rate-limited to one step per 3 s". Only down-steps use the 3 s `Step()` limiter; up-steps are gated by 12 s clean + 10 s since last change. Wording is wrong, code is fine.

**B. Route-map wording vs real auth**
6. `cron/reconcile-orders` is documented as "cron secret" but actually accepts the Supabase publishable/anon key as bearer. Either rename the doc row to what it is, or introduce a real `CRON_SECRET` (recommended — the anon key is public).
7. `auth/login` guard has no bucket in the §3 taxonomy; it is credential auth + `login_attempts` lockout.

**C. Real code/config gaps**
8. **Head metadata missing** on three routes: `/connectlive/admin`, `/connectlive/payment`, `/_authenticated/console` carry only `title` (+`robots`). §3 claims "All carry unique `head()` metadata" with description/og pairs. Add `description`, `og:title`, `og:description` (keep `noindex` on all three).
9. `.env.sample:29` still declares `AGENT_DEPLOYMENT_KEY` — removed everywhere else. Delete the line.
10. `agent/README.md` documents a nonexistent `src/TrayIcon.cs` and calls `ApiClient.cs` a "WebSocket client".
11. `agent/src/ApiClient.cs` comments still say "deployment key" (L66/176/221) and describe `OnEnrollmentRevoked` as "wired to a tray balloon from App.xaml.cs" — the event is **never subscribed** anywhere. Either wire it (log + force re-enroll) or delete it; the comment is wrong either way.
12. Packaging docs (`jamf/`, `intune/`, `gpo/`) still describe the deployment-key flow that `agent/INSTALL.md` says is gone.

**D. Data-truth findings (not in the roadmap at all — new)**
13. **6 ghost devices.** Six rows enrolled 2026-08-02/03 have no hostname, no OS, no `lan`, no `agent_version` — they took a machine token from `agent/enroll` and never completed `agent/hello`. Enrollment has an IP throttle but nothing reaps never-helloed devices.
14. **`devices.status` is never reaped server-side.** All 8 devices read `online`, six of them last seen 8+ hours ago. The console hides this by computing staleness client-side (`OFFLINE_MS`), but the column, Telegram `device_offline`, and any future status page all read the lie.
15. **Stale live session.** Session `decace85…` has been `state=active` since 2026-08-02 14:04 with no `ended_at`, and holds `devices.is_session_active = true` on `DESKTOP`. `prune_session_ephemera` prunes frames/cursors, not abandoned sessions.
16. **`devices.standing_consent` defaults to `true`.** Every auto-enrolled machine is born with standing consent, which sits badly against invariant §4 "consent is a click, not a default". Worth an explicit decision + a roadmap note either way.
17. No device in the fleet has reported `monitors` or `encoder` metadata yet — the field agents (1.9.0/1.9.1) predate turns 2 and 4a, so those paths are code-verified but not production-verified.

### Proposed work order

**Turn 1 — truth pass (docs only, zero behaviour change)**
Fix A1–A5, B6–B7 (doc wording), C10–C12; rewrite §8 as a dated snapshot with the numbers observed today; add the D-findings as a new "Observed data-truth issues" subsection so the next audit diffs against them.

**Turn 2 — head metadata (`SCOPE:WEB`)**
Fix C8: add description + og pairs to the three routes, keep `noindex`. Remove `AGENT_DEPLOYMENT_KEY` from `.env.sample` (C9).

**Turn 3 — presence reaper (`SCOPE:PRESENCE`/`SCOPE:DATA`)**
Fix D13–D15 in one migration + prune function extension: flip `devices.status` to `offline` past the 75 s threshold, end sessions with no agent traffic past a grace window (releasing `is_session_active`), and delete never-helloed enrollments older than 24 h. This makes Tier C items 9/11/12 (health panel, status page, wake metrics) actually feasible.

**Turn 4 — `CRON_SECRET`** (B6, if you want the hardening rather than the doc correction).

**Then resume the roadmap** at Tier A item 3 / turn 4b — the MFT-backed `IVideoEncoder` + H.264 decode branch in `VideoPipeline.cs`.

### Technical notes

- D14/D15 belong in `prune_session_ephemera()` (already scheduled `*/1`), not a new job — one function, one cron entry, observable in one place.
- D16 is a product decision, not a bug; I will not change the default without a call from you.
- Agent-side C11 is the only item that touches compiled C#; everything else in turns 1–3 is docs, web metadata, and SQL.
