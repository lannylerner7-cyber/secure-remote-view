# Full-Codebase vs Roadmap Verification Pass

Goal: a three-pass, line-by-line audit that reconciles `PROJECT-MAP.md` (and `ENDPOINTS.md`, `AGENTS.md`) with every shipping file across web, agent, and native admin — no oversight, no assumptions. Output is a written audit report plus targeted doc/code fixes for any drift found.

## Scope

Four surfaces, audited independently then cross-referenced:

1. **Web (`src/`)** — routes, server functions, Supabase client wiring, shared contracts.
2. **Agent (`agent/src/`)** — capture, WebRTC, self-update, startup, input, power.
3. **Native admin (`admin/src/`)** — API client, media pipeline, input transport, view models.
4. **Docs + DB** — `PROJECT-MAP.md`, `ENDPOINTS.md`, `AGENTS.md`, `supabase/config.toml`, live migrations, `src/shared/api-routes.ts`.

Scripts (`scripts/verify-agent-routes.ts`, `verify-payment-routes.ts`, `e2e-smoke.ts`, `e2e-wake.ts`, `e2e-soak.ts`) are audited as contracts too — they encode the invariants.

## Method — three passes per file

For every file in scope:

- **Pass 1 — Read.** Full file read, top to bottom. Note exported symbols, side effects, env reads, and every network/DB call.
- **Pass 2 — Contract check.** Cross-reference against `src/shared/api-routes.ts`, `PROJECT-MAP.md` §3 route table, `ENDPOINTS.md`, and the corresponding C# consumer (agent or admin `ApiClient.cs`). Flag any route/header/payload/status mismatch.
- **Pass 3 — Invariant check.** Verify the file honours the roadmap invariants that touch it: auth gate on `/api/public/*`, GRANTs + RLS on any new table, `attempt_id` idempotency on signal writes, `admin_client_id` on takeover, loss-gating on video, D3D recovery classes, telemetry shape, self-update SHA-256, etc.

Findings are logged per file with `path:line` citations and classified: `OK`, `DOC-DRIFT` (code is correct, docs stale), `CODE-DRIFT` (docs correct, code stale), `CONTRACT-BREAK` (web/agent/admin disagree), `INVARIANT-BREAK` (roadmap rule violated).

## Audit order

Ordered so contracts are locked before their consumers are inspected.

1. **Contracts + docs first**
   - `src/shared/api-routes.ts`, `PROJECT-MAP.md`, `ENDPOINTS.md`, `AGENTS.md`, `.env.sample`.
2. **Web routes**
   - `src/routes/api/public/agent/*` (13 files), `src/routes/api/public/auth/login.ts`, `admin/bootstrap.ts`, `webhooks/cdp.ts`, `cron/reconcile-orders.ts`, `stats/orders.ts`, `health.ts`.
   - `src/routes/_authenticated/console.tsx` + `src/components/console/*`.
   - Public pages: `index.tsx`, `order.*`, `license.tsx`, `contact.tsx`, `privacy.tsx`, `refund.tsx`, `terms.tsx`, `connectlive.admin.tsx`, `connectlive.payment.tsx`.
3. **Web server libs**
   - `src/lib/agent-auth.server.ts`, `cdp.server.ts`, `cdp-config.server.ts`, `pricing.server.ts`, `server-supabase.ts`, `webrtc-live.ts`, `webrtc-signal.functions.ts`, `orders.functions.ts`, `notify.functions.ts`, `notifications.functions.ts`, `admins.functions.ts`, `console-input.ts`, `console-types.ts`.
4. **Agent (`agent/src/*`)**
   - `Agent.cs`, `ApiClient.cs`, `WebRtcSession.cs`, `DxgiCapture.cs`, `ScreenCapture.cs`, `CursorPump.cs`, `InputRelay.cs`, `InputBlocker.cs`, `PowerRelay.cs`, `MonitorSelector.cs`, `HwEncoderProbe.cs`, `BitrateController.cs`, `CurtainOverlay.cs`, `ConsentPrompt.cs`, `StreamListener.cs`, `StartupRegistration.cs`, `StartupSelfHeal.cs`, `SelfUpdate.cs`, `SplashWindow.xaml.cs`, `App.xaml.cs`, manifest + csproj.
5. **Native admin (`admin/src/*`)**
   - `App.xaml.cs`, `Api/*`, `Media/*` (esp. `D3DImageHost.cs`, `VideoPipeline.cs`, `WebRtcClient.cs`, `RealtimeChannel.cs`, `RtpCapture.cs`, `FrameFallbackPump.cs`), `Input/*`, `ViewModels/*`, `Views/*`, `Ui/AppIcon.cs`, spikes.
6. **DB + verification scripts**
   - Live schema pull for tables named in the roadmap (`sessions`, `devices`, `power_commands`, `session_cursors`, `session_telemetry`, `releases`, `cron_tokens`, `audit_logs`, `user_roles`, `admins`, `orders`, ...); confirm constraints, GRANTs, RLS, and `prune_session_ephemera()`.
   - Run `verify-agent-routes.ts` and `verify-payment-routes.ts` against prod; capture pass/fail.

## Deliverables

- `AUDIT-REPORT.md` at repo root: per-file table with pass verdicts and citations, plus a "Drift & Breaks" section grouped by classification.
- Targeted patches for any `CODE-DRIFT` / `CONTRACT-BREAK` / `INVARIANT-BREAK`, one commit per fix, each linked back to its audit row.
- `PROJECT-MAP.md` updates for `DOC-DRIFT` only — no roadmap re-sequencing in this pass.
- Fresh runs of `verify-agent-routes.ts`, `verify-payment-routes.ts`, `e2e-smoke.ts`, `e2e-wake.ts`, and a short `e2e-soak.ts` (3 agents, 60s) attached as evidence.

## Non-goals

- No new features. No roadmap re-sequencing. No refactors beyond fixing drift.
- No touching auto-generated files (`routeTree.gen.ts`, `integrations/supabase/*` generated files, `supabase/config.toml` project settings).

## Technical notes

- Every `/api/public/agent/*` handler must call `verifyDevice` (or `verifyTechnician` for `ice`/`release`) before any DB work; the audit greps for handlers that skip it.
- Every `CREATE TABLE public.*` in migrations must be followed by `GRANT` + `ENABLE RLS` + policies — audit re-verifies live via `information_schema`.
- `src/shared/api-routes.ts` is the single source of truth; any string literal path in agent or admin C# that isn't mirrored here is a `CONTRACT-BREAK`.
- Loss-gating (S13), D3D recovery (S12), telemetry shape (S11), self-update SHA-256 (S14), and ICE gateway auth (S9) each have a named invariant check in Pass 3.
