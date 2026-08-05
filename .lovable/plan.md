# Licensed customer accounts, seat limits, and a customer portal

Today every agent enrolls anonymously: `/api/public/agent/enroll` mints a device token for anyone who asks, and devices belong to nobody. Orders exist, but nothing links a paid plan to the machines running the agent.

This adds the missing middle layer: a **license** that owns seats, devices, and a subscription window — and a customer-facing portal to manage it.

## The model

```text
auth user (customer)
   └── license  (key, plan, seat_limit, starts_at, expires_at, status)
          └── devices (each device row now carries license_id)
```

- One license per customer account, identified by a single permanent **Meeting ID** shown on their profile.
- Seats used = count of that license's devices that are not deleted.
- Subscription clock starts on the license's issue date, not on install date.

## How the agent knows who it belongs to — one-time Meeting ID

No per-customer builds and no bundled key file. One installer for everyone.

- Every customer account gets one permanent Meeting ID (short, readable, e.g. `CL-8FQ2-4KDN`), displayed on their portal profile. It is the human-facing name of their license.
- On first run only, the agent shows a small prompt: "Enter your ConnectLive Meeting ID". The customer types it once.
- The agent posts it with enrollment. On success it writes the ID into its hidden local store (`%LOCALAPPDATA%\ConnectLive\meeting.dat`, DPAPI-encrypted, same folder as `device.dat`) and never asks again.
- Every later boot reads that file, skips the prompt entirely, and goes straight to background startup — the existing HKCU Run-key startup path is unchanged.
- If the file is missing or deleted (reimage, profile wipe), the prompt reappears once and the machine re-joins the same license.


## Enrollment with seat enforcement

`/api/public/agent/enroll` gains license logic:

1. Look up the license by Meeting ID. Unknown ID → refuse and let the agent re-prompt.
2. Count active devices. Under the limit and subscription live → enroll as normal, `status = active`.
3. **At or over the limit, or subscription expired → the device is still created, but marked `blocked`.** It appears in the customer portal with a "needs a seat" badge, and heartbeats return `blocked` so the agent goes quiet (no capture, no sessions) while retrying periodically.
4. When the customer frees a seat or upgrades, the next heartbeat flips it to `active` automatically — no reinstall.

Freeing a seat is instant and unlimited: deleting a device in the portal immediately opens the slot for the next blocked or new device.

Sessions and every other agent route also refuse to run for a blocked or expired device.

## Customer portal — `/connectlive/agent-user`

Separate login page and separate console from the technician console, using the existing auth system with a `customer` role.

- **Login / signup** at `/connectlive/agent-user/login`, tied to the email used at checkout so a paid order can be claimed into an account.
- **Devices + seats**: seats used vs. available, the device list with hostname / OS / last seen / status, delete to free a seat, blocked devices called out with a one-click "activate into free seat".
- **Subscription**: plan name, seat count, start date, renewal date, days remaining, plus a prominent expired/expiring banner.
- **In-app upgrade & renewal**: buy more seats or renew through the existing crypto checkout; on payment confirmation the license's seat limit and expiry update and blocked devices activate.
- **Profile**: their Meeting ID front and centre with a copy button, plus the plain agent download (same installer for everyone).

The technician console (`/console`) is untouched except that devices now display which license they belong to.

## Technical details

Database (one migration):
- `licenses` — `id`, `user_id`, `meeting_id` (unique, short readable code), `plan_code`, `seat_limit`, `status` (`active`/`expired`/`suspended`), `issued_at`, `expires_at`, timestamps. RLS: a customer reads only their own; admins read all; service role full.
- `devices` gains `license_id` (nullable, so existing rows survive) and `status` gains a `blocked` value. Existing unlicensed devices keep working for admins.
- `license_events` — audit trail of seat grants, deletions, upgrades, renewals.
- `orders` gains `license_id` so a renewal payment can be attributed.
- GRANTs for `authenticated` + `service_role` on every new table.

Backend:
- `enroll.ts`: accept `meetingId`, resolve the license, enforce seats/expiry, set `license_id` and `active`/`blocked`. Meeting-ID guessing is rate-limited per IP alongside the existing enroll throttle.
- `heartbeat.ts`: return `{ licenseState: "active" | "blocked" | "expired" }`; the agent stops capture and skips invites unless active.
- New server functions in `src/lib/licenses.functions.ts`: `getMyLicense`, `listMyDevices`, `deleteMyDevice`, `activateBlockedDevice`, `startUpgradeOrder`.
- Order confirmation path (`webhooks/cdp.ts` + reconcile cron) creates the license (and its Meeting ID) on first paid order, and extends it on renewals.

Agent (C#):
- `MeetingIdStore.cs` — DPAPI-encrypted `meeting.dat` in the existing hidden config folder, with read/write/clear helpers.
- `MeetingIdPrompt.xaml` — small first-run-only dialog; shown before the splash, skipped entirely when `meeting.dat` exists.
- `ApiClient.EnrollIfNeededAsync` sends the Meeting ID and persists it only after the server accepts it; a rejected ID clears the file and re-prompts.
- `Agent.cs` honours a `blocked`/`expired` heartbeat by staying dormant and logging the reason.
