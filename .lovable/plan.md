# ConnectLive — Homepage, Checkout, Orders, Emails

One consolidated build. Nothing on `/console`, `/admin`, agent code, or existing APIs changes unless listed here.

---

## 1. Homepage (`/`) redesign

Keep: animated space background, ConnectLive brand, hero video, banner image, technician link.

Add/replace:

- **Download panel** — two OS buttons side-by-side:
  - `Download for Windows (64-bit)` → active, points to `AGENT_DOWNLOAD_URL` (unchanged).
  - `Download for macOS` → disabled, label `Coming soon`.
- **5-second progress overlay** when Windows button clicked: full-screen translucent layer with ConnectLive logo, indeterminate → determinate 0→100% bar (5s), then triggers actual download and dismisses. Pure CSS/JS, no deps. Next to plan select page 
- **Live user counter** under hero: `Currently at N users` where N = `count(*)` from `public.orders` where `status='paid'`. Reads via a public server fn (anon SELECT count). Refreshes every 60s. Falls back silently to hidden if query fails.
- **Trust strip** (icons + one-liner): Consent-based · Encrypted · No background install.
- **Footer** with links: Privacy Policy, Terms of Service, Refund Policy, Contact. Each is its own route (`/privacy`, `/terms`, `/refund`, `/contact`) with real content and unique `head()` SEO. Plain typographic layout, Instrument Serif headings + Work Sans body (keep tokens semantic in `styles.css`).

Typography: switch homepage to a narrow serif display for H1 + clean sans for body (via `<link>` in `__root.tsx` head, per Tailwind v4 rule).

---

## 2. Order flow (public, no signup)

New route: `/order`

Fields: Full Name, Email, Phone (optional), Company (optional), Plan (fixed price list — admin-editable via `admin_settings`), Coin (BTC / USDT-ERC20 / USDC-ERC20).

Submit → creates row in `public.orders` with `status='pending'`, generates a **fresh receive address** from the correct CDP wallet for that coin, locks USD→coin price for **15 min**, returns invoice page `/order/:id`.

### Invoice page `/order/:id`

- Amount due (coin), USD equivalent, receive address (copy + QR), countdown to price-lock expiry, confirmations progress bar, order ID.
- Polls status every 10s; flips to `paid` when reconciler confirms.
- After paid: shows the admin-sent access link if present, plus "we emailed your invoice."

### Wallet strategy (as previously discussed)

- **One HD wallet per chain** in CDP, held forever. Never delete wallets.
- **Per-order fresh receive address** derived from that wallet (BIP32 for BTC, unique EVM address for USDT/USDC).
- Addresses stored on the order row; never reused across orders.
- Confirmation thresholds: BTC=2, USDT/USDC (ERC-20)=12.

### Reconciler

- `pg_cron` every 60s → `POST /api/public/cron/reconcile-orders` (auth via `apikey` header = anon key).
- Handler queries CDP for each pending order's address, updates `status` (`pending`→`detected`→`paid`), records tx hash and confirmations.
- Also handles `expired` (15 min without detection at old price) — order stays open but amount recalculates on next view.
- Idempotent via unique `(order_id, tx_hash)` in `payment_events`.

### CDP webhook

- `POST /api/public/webhooks/cdp` — HMAC-verified, updates same fields (belt + suspenders vs poller).
- Idempotent event log in `payment_events`.

---

## 3. Database

New tables (migration, all with GRANTs + RLS):

- `**orders**` — id, email, full_name, phone, company, plan_code, amount_usd, coin, amount_coin, price_locked_at, price_expires_at, receive_address, status (`pending|detected|paid|expired|refunded|cancelled`), tx_hash, confirmations, access_link (nullable, admin-set), created_at, updated_at.
  - RLS: no anon SELECT on rows. Only server fns with service role read individual orders. Public homepage counter uses a `SECURITY DEFINER` function `public.get_paid_order_count()` returning just the integer.
  - Indexes on `(status)`, `(receive_address)`, `(created_at)`. Fine to 100k+ rows.
- `**payment_events**` — id, order_id, source (`cdp_webhook|poller`), event_type, tx_hash, confirmations, raw jsonb, created_at. Unique `(order_id, tx_hash, event_type)`.
- `**admin_wallets**` — id, coin, chain, cdp_wallet_id, xpub (BTC only), created_at. One row per coin.
- `**plans**` — code, name, description, amount_usd, active. Seeded with initial plans; super-admin CRUD via `/console`.

Extend `admin_settings`: `sweep_to_exchange_enabled bool default false`, `payout_address_btc`, `payout_address_eth`.

---

## 4. `/console` payment admin

New tab in existing console menu: **Payments**.

- **Live totals ticker** (updates every 60s):
  - Total deposited (USD equiv, sum of paid), Total pending, Total failed/expired, Total successful count, Current balance per coin (from CDP wallet balances).
  - Presented as a running math ledger: `deposits − refunds = balance`, with per-coin breakdown.
- **Orders table** (paginated, filterable by status/coin/date/email): view, mark manually paid (super_admin only, audit-logged), refund note, resend invoice email, **set access link** field (admin pastes the download/session URL that goes to the customer).
- **Plans manager** (super_admin): edit price/name/active.
- **Wallets** panel: shows CDP wallet health, addresses issued count per coin, toggle sweep-to-exchange.
- **Audit**: every state change written to existing `audit_logs`.

Login attempt lockout (3 fails / 1 hr) already in place — no change.

---

## 5. Emails (Lovable managed email)

Requires the user's own verified email domain via `email_domain--check_email_domain_status`. If not set up, we surface the setup dialog once.

Templates (React Email, server-side render, sent via `sendLovableEmail`):

- **Order created** — invoice, amount, coin, address, QR, price-lock expiry, link back to `/order/:id`.
- **Payment detected** — "we saw your payment, waiting on N confirmations."
- **Payment confirmed** — "paid. here's your access link:" (pulls `access_link` set by admin; if admin hasn't set it yet, email says "your technician will email your access link shortly" and a second email fires when admin sets it).
- **Access link ready** (fires when admin fills `access_link` post-paid) — the link + short "how to install" steps.
- **Order expired / cancelled** — plain notice.

Admin-side: super_admin can trigger manual resend from the orders table. All sends synchronous via server fn; no queue table.

---

## 6. Public counter API

Server route `GET /api/public/stats/orders` → `{ paid: number }`. Backed by `get_paid_order_count()` SECURITY DEFINER function. Cache-Control 30s. Called by homepage every 60s.

---

## 7. Footer + legal pages

Real content (short but real) on `/privacy`, `/terms`, `/refund`, `/contact`. Each has its own head() metadata. Contact page has a mailto + a simple message form that hits a public route → sends email to admin inbox.

---

## Out of scope (explicit)

- No changes to agent zip, WebRTC pipeline, curtain mode, input relay, cursor overlay, `/console` live view, `/admin` login page, or existing `/api/public/agent/*` routes.
- No third-party logos on homepage.
- No SOL/ETH-native checkout in v1 (schema supports adding later).
- No automatic sweep to exchange in v1 (toggle exists, defaults off).

## Technical notes

- CDP creds via `secrets--add_secret`: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WEBHOOK_SECRET`. Requested after plan approval, not now.
- Reconciler and webhook under `/api/public/*` — verify caller (anon apikey for cron, HMAC for webhook) inside handler.
- `supabaseAdmin` only inside handlers (dynamic import), never at module scope of `.functions.ts`.
- Homepage counter uses server-publishable client with `SECURITY DEFINER` fn — no anon SELECT on `orders` rows.
- Price lock: fetch USD→coin at order create, store `amount_coin` + `price_expires_at`. On invoice view past expiry, recompute + rewrite row.

## Order status state machine

```text
pending ──detected──> detected ──confirmations≥threshold──> paid
   │                                                          │
   └──15m no tx──> expired                                    │
                                                    admin sets access_link
                                                              │
                                                    email "access ready"
```