# Order emails, admin-issued customer accounts, and the domain switch

Three connected changes: emails around the order lifecycle, a customer portal whose accounts you create by hand, and moving every reference off the old domain.

## 1. Domain switch — connectliveagent.com

`zoomlite.live` appears in 19 files. All of it becomes `https://connectliveagent.com` (no `www`, so links stay consistent; the `www` host already redirects).

- Web: canonical + og:url tags on `contact`, `privacy`, `refund`, `connectlive.payment`, `connectlive.admin`, and the console.
- Agent + Admin apps: the base URL in `agent/src/ApiClient.cs`, `admin/src/Api/AppConfig.cs`, `admin/src/admin.config.json`.
- Scripts and docs: the four e2e/verify scripts, `PROJECT-MAP.md`, `ENDPOINTS.md`, `RELEASE-CHECKLIST.md`, both `INSTALL.md` files.

## 2. Order emails

Email needs a verified sender domain first — `connectliveagent.com` is not set up for sending yet, so that is step one and everything below waits on it. Two templates, both branded to the site:

**Order received** — sent the moment a customer submits the order form, to the email on the order.
- Subject: `Your ConnectLive order is received — #<short id>`
- Contents: order number, plan, seats, amount in USD and crypto, the pay-to address, the price-lock deadline, and a link to the tracking page for that order.

**Order confirmed** — sent when you mark the order paid (manual confirm or webhook confirmation).
- Subject: `Payment confirmed — your ConnectLive access is on the way`
- Contents: confirmation of payment, "your software and sign-in details arrive within 24–48 hours", an explicit "check your spam or junk folder, and mark us as safe" line, and the support contact.

Nothing else is automated. You send the actual download links, the customer's portal password, and any setup notes yourself once you have provisioned them.

## 3. Order tracking

The existing public order page becomes the tracking surface: status timeline (received → payment detected → confirmed → access sent), with the confirmed state showing the 24–48 hour message. The link is in both emails, so no login is needed to track.

## 4. Admin-issued customer accounts

No public signup. In the payments console you gain a **Customers** section:

- **Create account** from a paid order in one click: pick the order, set a password, and the account is created with the customer role, the license, the seat count from the plan, and the subscription window. The password is shown once for you to pass on.
- **Reset password** and **suspend/restore** for an existing customer.
- Each customer row shows plan, seats used vs. total, expiry, and their devices.

## 5. Customer portal — `/public/agent/login`

A separate login page and console from the technician one, with its own look and no technician features.

- Sign in with the email and password you issued.
- **Overview**: plan, seats used vs. total, start date, renewal date, days remaining, expiry banner when close.
- **Devices**: hostname, OS, last seen, status; delete a device to free a seat; devices over the seat cap appear as "needs a seat".
- **Downloads**: the agent installer and, for their admin, the console installer.
- **Their ID**: the license/meeting ID with a copy button — this is what the agent asks for on first run so a machine joins the right account.
- Password change.

The technician console and the native admin app are unchanged; the native app keeps working exactly as today since it only authenticates and reads.

## Technical details

Domain: a straight replacement pass across the 19 files listed above, then re-run the route verifier scripts against the new host.

Email: set up `connectliveagent.com` as a sending domain, then scaffold the app-email system and add the two templates. The "order received" send hooks into `createOrderPublic`; the "order confirmed" send hooks into both the paid transition in `webhooks/cdp.ts` and `markOrderPaid`, keyed off the order id so retries do not double-send.

Database (one migration): `licenses` (`user_id`, `meeting_id` unique, `plan_code`, `seat_limit`, `status`, `issued_at`, `expires_at`), `devices.license_id` plus a `blocked` status, `orders.license_id`, and a `customer` value on `app_role`. GRANTs and RLS so a customer reads only their own license and devices, admins read all.

Backend: admin-only server functions to create/reset/suspend a customer (service-role `auth.admin` user creation, never public); customer-scoped functions for license, devices, and device deletion. `agent/enroll` resolves the meeting ID, enforces seats and expiry, and marks over-cap devices `blocked`; `agent/heartbeat` returns the license state so a blocked agent stays dormant.

Agent (C#): a DPAPI-encrypted `meeting.dat` next to `device.dat`, a one-time first-run prompt for the ID when that file is absent, and dormancy on a `blocked`/`expired` heartbeat.

## Order of work

1. Domain replacement (independent, ships immediately).
2. Email domain setup, then the two templates and their triggers.
3. Licensing migration + enrollment enforcement.
4. Admin customer management, then the customer portal.
5. Agent meeting-ID prompt.
