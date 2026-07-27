
## Route audit — what I verified

**Buyer funnel (public)**
- `/order` → `src/routes/order.tsx` ✓ loads plans via `getActivePlansPublic`, submits via `createOrderPublic`, navigates to `/order/$id`.
- `/order/$id` → `src/routes/order.$id.tsx` ✓ polls `getOrderPublic` every 10s, renders address, QR, confirmations, access-link CTA.
- Homepage `src/routes/index.tsx` links to `/order` in 4 spots ✓ and fetches `/api/public/stats/orders` for the paid-orders ticker.

**Server functions** (`src/lib/orders.functions.ts`)
- `createOrderPublic`, `getOrderPublic`, `getActivePlansPublic` — anon-callable ✓
- `listOrdersAdmin`, `getOrderTotals`, `setOrderAccessLink`, `markOrderPaid` — behind `requireSupabaseAuth` ✓; `markOrderPaid` also re-checks `super_admin`.

**HTTP routes** (`src/routes/api/public/...`)
- `webhooks/cdp` ✓ HMAC-verified with timing-safe compare, resolves by `order_id` or `receive_address`.
- `cron/reconcile-orders` ✓ gated on Supabase publishable key header.
- `stats/orders` ✓ 30s-cached paid count.

**Payment-admin UI** (`src/components/PaymentsPanel.tsx`, mounted in `_authenticated/console.tsx`)
- Nav item "Payments" gated to `admin` + `super_admin` ✓, `Mark paid` gated to `super_admin` only ✓.
- Totals, filter, access-link editor, manual mark-paid — all wired to the server fns ✓.

**Data / infra check (live DB)**
- `plans` table: Starter $49, Team $199, Business $799 — all active ✓.
- `admin_wallets` table: **empty** — no receive addresses configured.
- `pg_cron`: `cron.job` not present — reconcile poller **never runs**.
- Secrets: `CDP_WEBHOOK_SECRET` **missing** — webhook returns 503 for every hit.

## Gaps that block real payments

1. **No wallet configured** → every new order gets `receive_address = null`; the invoice page shows "address being provisioned" forever. There is no admin UI to set the payout address.
2. **No poller schedule** → detection depends on the CDP webhook alone. If the webhook secret isn't set, no order ever moves past `pending`.
3. **Idempotency drift on `payment_events`** → each poller tick inserts a new event row for the same tx. Should upsert on `(order_id, tx_hash, event_type)`.
4. **No license lookup for buyers** → if a buyer loses the invoice URL, they can't recover it (order ID is the only key).
5. **`src/shared/api-routes.ts`** doesn't list the order/webhook/cron/stats routes — same drift risk we fixed for agent routes.

## Fixes (small, surgical, no feature removal)

### 1. Wallet-management panel (super-admin only)
- Add a "Wallets" tab inside `PaymentsPanel.tsx` visible only when `isSuperAdmin`.
- New server fns in `src/lib/orders.functions.ts`: `listWalletsAdmin`, `upsertWalletAdmin({ coin, chain, address })`. Both require `requireSupabaseAuth` + inline `super_admin` check.
- One row per coin (BTC / USDT_ERC20 / USDC_ERC20). Saving upserts into `admin_wallets` with `cdp_wallet_id = address` (matches the v1 shim contract).

### 2. Migration: pg_cron + payment_events idempotency
- New migration:
  - `SELECT cron.schedule('reconcile-orders', '*/1 * * * *', $$ SELECT net.http_post( url := '<STABLE_URL>/api/public/cron/reconcile-orders', headers := jsonb_build_object('apikey', current_setting('app.settings.anon_key', true), 'Content-Type', 'application/json'), body := '{}'::jsonb) $$)` — with fallback if `net.http_post` isn't enabled, we document a manual External-Cron path in `COOLIFY.md`.
  - Add `CREATE UNIQUE INDEX IF NOT EXISTS payment_events_dedupe ON public.payment_events(order_id, COALESCE(tx_hash, ''), event_type);` then switch cron+webhook inserts to `.upsert(..., { onConflict: 'order_id,tx_hash,event_type', ignoreDuplicates: true })`.

### 3. Prompt operator to set `CDP_WEBHOOK_SECRET`
- Detect at runtime in `PaymentsPanel` via a tiny `getPaymentsHealth` server fn that returns `{ wallets_configured, webhook_secret_set, cron_running_estimate }`. Show an amber banner listing whatever is missing so the operator sees the gap.

### 4. `/license` lookup page (buyer self-service)
- New route `src/routes/license.tsx` — email-only lookup form.
- New server fn `lookupLicenseByEmail({ email })` that returns the most recent `paid` order for that email (id, plan, access_link). Rate-limited by inserting into a small `license_lookups` table (email + ts) and rejecting > 5/hour per email.
- Homepage adds a subtle "Have a license? Look it up" link next to the "Order a license" CTA.

### 5. Registry hygiene
- Extend `src/shared/api-routes.ts` with a `PAYMENT_ROUTES` block: `webhookCdp`, `cronReconcileOrders`, `statsOrders`. No runtime behavior change — just single-source-of-truth.

### 6. Verify script
- Add `scripts/verify-payment-routes.ts` (Node, run manually): hits `/api/public/stats/orders`, posts an unsigned request to `/api/public/webhooks/cdp` (expects 401), posts to `/api/public/cron/reconcile-orders` without apikey (expects 401), and calls the two public server fns via TanStack `_serverFn` URL to prove they're mounted. Prints a PASS/FAIL table.

## Technical notes

- `getOrderPublic` intentionally uses `supabaseAdmin` because the invoice must render for the unauthenticated buyer; the UUID acts as an unguessable bearer. Left as-is.
- `access_link_sent_at` column already exists (used by `setOrderAccessLink`); no schema change needed for the access-link editor.
- The wallet panel writes the plain address into `cdp_wallet_id` — matches the current `issueReceiveAddress` v1 shim so no code churn in `cdp.server.ts`.
- No plan tier, price, RLS policy, or route path is removed. Every change is additive.

## Files touched

- `src/lib/orders.functions.ts` — add `listWalletsAdmin`, `upsertWalletAdmin`, `getPaymentsHealth`, `lookupLicenseByEmail`.
- `src/components/PaymentsPanel.tsx` — add "Wallets" sub-tab + health banner.
- `src/routes/license.tsx` — new buyer lookup page.
- `src/routes/index.tsx` — add "Look up license" link near the order CTA.
- `src/shared/api-routes.ts` — export `PAYMENT_ROUTES`.
- `src/routes/api/public/webhooks/cdp.ts` and `cron/reconcile-orders.ts` — switch `payment_events` insert to upsert.
- New migration for `payment_events_dedupe` unique index (and optional `cron.schedule` if `pg_net` is available).
- `scripts/verify-payment-routes.ts` — smoke check.
- `COOLIFY.md` — note about `CDP_WEBHOOK_SECRET` and external cron fallback.
