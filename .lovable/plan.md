
## Two things in this plan

1. Replace the separate "Payments admin" login route with a button on the existing `/admin` page (safer — no duplicate auth surface).
2. Wire the uploaded Coinbase CDP API key into the backend as **secrets**, and validate its shape before anything else in the app touches it.

---

## Security note about the key you pasted

The key `d6913747-…-b0085` and its `privateKey` value were pasted in plain chat. **Treat that key as compromised** and rotate it in the Coinbase CDP dashboard once we're done wiring the new one. I'll store whatever value you keep as a proper server secret so it never lands in the codebase or client bundle.

---

## Part 1 — "Payment admin" button on `/admin`

No new route, no second login page.

- **Edit `src/routes/admin.tsx`**:
  - Add a `mode` state (`"technician" | "payments"`). Default `"technician"`.
  - Above the form, two segmented buttons: **Technician** and **Payment admin**. Purely a UI toggle — same fields, same `/api/public/auth/login` call, same lockout logic. No new endpoints.
  - On successful login, if `mode === "payments"` → `navigate({ to: "/console", search: { tab: "payments" } })`. Otherwise → `/console` as today.
  - Payment-admin mode shows a subtitle: "Sign in with a super-admin technician ID (e.g. `197200`). Non-admins will be routed to the dashboard."
- **Edit `src/routes/_authenticated/console.tsx`**:
  - Declare `validateSearch` to accept `{ tab?: Nav }`.
  - Seed `useState<Nav>` from the search param, but only when the resolved `role` allows that tab (matches existing sidebar gates on line 452). Non-admin requesting `payments` silently falls back to `dashboard`.
- **No changes** to `_authenticated/route.tsx`, `PaymentsPanel.tsx`, RLS, or the auth endpoint.

Result: `/admin` handles both flows; no extra route, no extra attack surface.

---

## Part 2 — Attach & validate the CDP API config

### Storage (secrets — never in code)
Store the uploaded credentials as two backend secrets:
- `CDP_API_KEY_NAME` — the full `organizations/…/apiKeys/…` string.
- `CDP_API_KEY_PRIVATE_KEY` — the base64 `privateKey` value.

I'll use `set_secret` for both since you've already supplied the values. If you plan to rotate first (recommended), I can switch to `add_secret` and you paste the new values into the secure form instead — tell me which.

### Validation (before injection anywhere)
- **New file `src/lib/cdp-config.server.ts`** (server-only, `.server.ts` so it's blocked from client bundles):
  - `getCdpConfig()` → reads both env vars.
  - `validateCdpConfig()` → returns `{ ok: true } | { ok: false, reason }`. Checks:
    - Both env vars present and non-empty.
    - `CDP_API_KEY_NAME` matches `/^organizations\/[0-9a-f-]{36}\/apiKeys\/[0-9a-f-]{36}$/`.
    - `CDP_API_KEY_PRIVATE_KEY` is valid base64 that decodes to exactly 64 bytes (CDP Ed25519 key length).
  - No parsing or SDK calls yet — purely shape validation, so it can't leak the key or make outbound requests.
- **Edit `src/lib/cdp.server.ts`**:
  - `issueReceiveAddress()` gets a preflight `validateCdpConfig()` call. If invalid, log a server-side warning (no key material) and fall through to the existing `admin_wallets.cdp_wallet_id` shim — nothing breaks, and the app still runs.
  - This is the only place that reads the config right now, so validation happens once at the injection point.
- **Edit `src/lib/orders.functions.ts`** — extend the existing `getPaymentsHealth` server fn (super-admin only) to include `cdp_configured: boolean` and `cdp_reason: string | null` from `validateCdpConfig()`. Never returns the key material itself.
- **Edit `src/components/PaymentsPanel.tsx`** — the existing health banner adds a new line: "CDP API key: configured ✓ / not configured — <reason>". No new tab, no new UI page.

### What this does NOT do (kept for a future turn)
- No `@coinbase/cdp-sdk` install, no per-order address derivation. The existing `admin_wallets` shim keeps issuing addresses so nothing regresses. Wiring the SDK is a separate, riskier change (Cloudflare Worker compat, private-key handling, deriv paths) and I'd rather do it as its own plan once this validation is green.

---

## Files touched

- **Edit** `src/routes/admin.tsx` — technician/payments toggle
- **Edit** `src/routes/_authenticated/console.tsx` — accept `?tab=` search param, role-gate
- **New** `src/lib/cdp-config.server.ts` — read + validate CDP secrets
- **Edit** `src/lib/cdp.server.ts` — preflight validate before use
- **Edit** `src/lib/orders.functions.ts` — extend `getPaymentsHealth`
- **Edit** `src/components/PaymentsPanel.tsx` — show CDP status in health banner
- **Secrets** (via `set_secret`) — `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE_KEY`

## Verification after build

- `/admin` shows two mode buttons; signing in under "Payment admin" as `197200` lands on `/console?tab=payments` with the Payments panel open.
- Signing in under "Technician" still lands on the dashboard tab.
- Payments Health banner shows "CDP API key: configured ✓" once secrets are set; toggling either secret off shows the exact validation reason.
- `issueReceiveAddress` continues to return the `admin_wallets` address (no behavior regression).

## One question before I implement

Do you want me to store the pasted values as-is with `set_secret`, or rotate the key in Coinbase first and then use `add_secret` so you paste the new values into a secure form? Default, if you don't reply, is `add_secret` — safer because the pasted key is now in chat history.
