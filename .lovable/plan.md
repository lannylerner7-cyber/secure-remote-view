# ConnectLive — combined plan: licensing, order emails, customer portal, domain switch

One sequence that folds the earlier licensing/Meeting-ID work together with the new order-email, admin-provisioning, and domain-change requests. Nothing in the technician console, the native admin app, or the live-session pipeline changes behaviour.

## 0. Domain switch — connectliveagent.com

`zoomlite.live` appears in 19 files. All of it becomes `https://connectliveagent.com` (bare host; the `www` variant already redirects).

- Web routes: canonical/og tags on `contact`, `privacy`, `refund`, `connectlive.payment`, `connectlive.admin`, console.
- Desktop apps: `agent/src/ApiClient.cs`, `admin/src/Api/AppConfig.cs` (both the property default and the embedded fallback), `admin/src/admin.config.json`.
- Scripts and docs: `e2e-smoke`, `e2e-soak`, `e2e-wake`, `verify-agent-routes`, `verify-payment-routes`, `PROJECT-MAP.md`, `ENDPOINTS.md`, `RELEASE-CHECKLIST.md`, `agent/INSTALL.md`, `admin/INSTALL.md`.

Ships first, independent of everything else.

## 1. Licensing model — one account, one Meeting ID, N seats

- A customer account (auth user, `customer` role) owns exactly one license.
- The license carries a permanent, human-readable **Meeting ID** (e.g. `CL-8FQ2-4KDN`), the plan, the seat limit (10 / 20 / 50), the issue date and the expiry date. The subscription clock starts at issue, not at install.
- Seats used = that license's devices that aren't deleted. Delete a device and the seat frees immediately, so a machine can be swapped for a replacement.
- Beyond the cap, or after expiry, a device still enrols but lands `blocked`: visible in the portal, dormant on the machine until a seat frees or the plan is upgraded.

## 2. How the agent knows who it belongs to

One installer for everyone — no per-customer builds, no bundled key file.

- On first run only, the agent shows a small prompt: "Enter your ConnectLive Meeting ID".
- It posts that with enrolment, then writes it to `%LOCALAPPDATA%\ConnectLive\meeting.dat`, DPAPI-encrypted, beside the existing `device.dat`.
- Every later boot reads the file, skips the prompt, and goes straight to silent background startup. The HKCU Run-key path is untouched.
- If the file is gone (reimage, profile wipe) the prompt reappears once and the machine rejoins the same license.
- On a `blocked` or `expired` heartbeat the agent stays dormant — no capture, no session — and keeps heartbeating so it wakes the moment a seat opens.

## 3. Order flow and emails

Email needs a verified sender on `connectliveagent.com`; that setup is the gate for this section. Two branded templates:

**Order received** — on order submit, to the email on the order.
- Subject: `Your ConnectLive order is received — #<short id>`
- Order number, plan, seats, amount in USD and crypto, pay-to address, price-lock deadline, tracking link.

**Order confirmed** — when payment is confirmed (webhook or manual mark-paid).
- Subject: `Payment confirmed — your ConnectLive access is on the way`
- Payment confirmed, "your software and sign-in details arrive within 24–48 hours", an explicit "check your spam/junk folder and mark us as safe" line, support contact.

Nothing further is automated. You send the agent installer link, the admin console link, the portal URL, and the customer's password yourself once you provision them.

Tracking: the public order page becomes the status surface — received → payment detected → confirmed → access sent — with the 24–48 hour message on the confirmed state. Linked from both emails, no login needed.

## 4. Admin-issued customer accounts

No public signup. A **Customers** section in the payments console:

- **Create account** from a paid order: pick the order, set a password, and it creates the auth user with the `customer` role, mints the license with the plan's seat count and the subscription window, and links the order. The password is shown once for you to pass on.
- **Reset password**, **suspend / restore**, **extend or upgrade** a license.
- Each row: customer, plan, seats used vs. total, expiry, device list.

## 5. Customer portal — `/public/agent/login`

Its own login page and console, separate from the technician one, with no technician features.

- Sign in with the email and password you issued.
- **Overview**: plan, seats used vs. total, start date, renewal date, days remaining, warning banner near expiry.
- **Devices**: hostname, OS, last seen, status; delete to free a seat; over-cap machines show "needs a seat".
- **Downloads**: agent installer, and the admin console installer for their own operator.
- **Their Meeting ID** with a copy button — the value the agent asks for on first run.
- **Upgrade / renew**: starts a new order in the existing crypto checkout, pre-bound to their license, so a confirmed payment raises their seat limit or extends expiry.
- Password change.

## Technical details

**Database (one migration).** `licenses` (`user_id`, `meeting_id` unique, `plan_code`, `seat_limit`, `status`, `issued_at`, `expires_at`); `devices.license_id` plus a `blocked` status value; `orders.license_id`; `customer` added to the `app_role` enum. GRANTs for `authenticated` and `service_role` in the same migration, plus RLS so a customer reads only their own license and devices while admins read all — device reads by the technician console keep working through the existing admin policies.

**Enrolment.** `api/public/agent/enroll` gains an optional `meetingId`: resolve the license, count live seats, insert the device as `online` under the cap or `blocked` over it / past expiry, and audit either way. Devices with no meeting ID keep the current anonymous path so existing fleets don't break. The per-IP throttle stays.

**Heartbeat.** `api/public/agent/heartbeat` returns `license: { status, expires_at, seat_state }` so a blocked agent can idle. All existing merge discipline for metadata is preserved.

**Server functions.** Admin-only: create customer, reset password, suspend, adjust license (service-role `auth.admin`, never reachable publicly). Customer-scoped: read own license, list own devices, delete own device, start an upgrade order.

**Email.** Set up the sending domain, scaffold the app-email system, add the two templates. "Order received" fires from the public order-create route; "order confirmed" fires from both the paid transition in `webhooks/cdp.ts` and the admin mark-paid path, keyed on the order id so retries don't double-send.

**Agent (C#).** `LicenseService.cs` for DPAPI `meeting.dat` read/write, a one-time WPF prompt when absent, `MeetingId` on the enrol request, and dormancy handling on the heartbeat response.

## Order of work

1. Domain replacement, then re-run the route verifiers.
2. Email sending domain, the two templates, and their triggers.
3. Licensing migration.
4. Enrolment + heartbeat enforcement.
5. Admin customer management.
6. Customer portal at `/public/agent/login`.
7. Agent Meeting-ID prompt and dormancy.
8. `PROJECT-MAP.md` and `ENDPOINTS.md` updated with the new routes, tables, and licensing rules.
