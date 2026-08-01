## Goal
`/connectlive/admin` should be a technician-only sign-in. Payment admin sign-in moves to its own page at `/connectlive/payment`.

## Changes

**1. `src/routes/connectlive.admin.tsx` (technician only)**
- Remove the `mode` state and the two-button Technician / Payment admin toggle.
- Fixed heading "Technician sign in" and the technician helper copy (lockout note).
- On success always `navigate({ to: "/console" })` — no `tab: "payments"` branch.
- Keep the login POST to `/api/public/auth/login`, lockout/attempts-left messaging, and `supabase.auth.setSession` unchanged.
- No link to the payments page (keeps it unadvertised, same as today's hidden-admin approach).

**2. New `src/routes/connectlive.payment.tsx` (payment admin only)**
- Same card layout, same auth call and lockout handling, extracted from the current payments branch.
- Heading "Payment admin sign in", helper copy about super-admin technician IDs.
- On success `navigate({ to: "/console", search: { tab: "payments" } })`.
- `head()` with its own title ("Payment admin sign-in — ConnectLive") plus `robots: noindex`.

Both pages keep the existing dark ConnectLive styling; no backend, RLS, or console changes. Nothing in the agent or admin console source is touched.

## Note
The shared form markup will be factored into a small local component so the two routes stay in sync without duplicating the fetch/lockout logic.
