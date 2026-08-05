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

## 3. Order flow and emails (self-hosted SMTP)

Emails go out through **your own SMTP server**, configured in the admin panel the same way Telegram is today — no third-party email service, no domain-verification dance.

**SMTP settings panel** (in the payments / admin settings area, mirroring the Telegram card):
- Host, port, username, password, from-name, from-address, encryption (None / STARTTLS / SSL-TLS).
- Password stored server-side only, never sent back to the browser once saved (write-only field, "•••••• saved" indicator).
- **Send test** button — dispatches a test email to the signed-in admin's address and reports success / SMTP error verbatim.
- Values live in a new `smtp_settings` singleton table (one row, admin-only RLS). The sender is a server function that reads the row and pipes through `nodemailer`.

Two branded templates (rendered server-side, plain HTML + text alternative):

**Order received** — on order submit, to the email on the order.
- Subject: `Your ConnectLive order is received — #<short id>`
- Order number, plan, seats, amount in USD and crypto, pay-to address, price-lock deadline, tracking link.

**Order confirmed** — when payment is confirmed (webhook or manual mark-paid).
- Subject: `Payment confirmed — your ConnectLive access is on the way`
- "Your software and sign-in details arrive within 24–48 hours", explicit "check your spam/junk folder and mark us as safe" line, support contact.

If SMTP isn't configured yet, order submission still succeeds; the email attempt is logged as `skipped: no_smtp` on the order so you can see it in the admin view. Nothing else is automated — you send the installer links, portal URL, and password yourself once you provision the customer.

Tracking: the public order page is the status surface — received → payment detected → confirmed → access sent. Linked from both emails, no login needed.

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

## 6. In-session file transfer with password-protected zip archive

Goal: while a live session is open in the admin panel, drop files/folders into a "Files" tab on either side, watch them appear in a session file manager, and let the operator select any subset (or "Select all") to download as a single zip whose only unlock password is the customer's account password.

**Transport.** File payloads never live-stream through Supabase realtime — the existing signalling channel stays tight for input and video. Files ride the already-open WebRTC **DataChannel** (`s10` input channel is extended with a second reliable ordered channel labelled `files`), chunked at 64 KiB, with a small JSON control envelope (`file_id`, `name`, `size`, `mime`, `sha256`, `seq`, `eof`). Chunks reassemble in the receiver into a Blob and are then uploaded to a private Supabase Storage bucket `session-files/<session_id>/<file_id>` via the admin's authenticated client. This uses realtime for presence only, keeps the heavy bytes off Postgres, and works whether the peer path is P2P or TURN-relayed.

**Fallback.** If the DataChannel is closed (blocked NAT during ICE restart), the sender POSTs to `api/public/agent/session.$sessionId.file.chunk.ts` with the same envelope; the route writes chunks to the same Storage path. The bucket is private; download URLs are minted per-request as short-lived signed URLs.

**Storage & schema.** New table `session_files` (`id`, `session_id`, `direction` from-agent/from-admin, `name`, `size_bytes`, `mime`, `sha256`, `storage_path`, `uploaded_by`, `created_at`, `deleted_at`). RLS: admins on the session can select/insert/soft-delete; the agent side goes through the service-role helper after the per-device token check. Bucket `session-files` is private; auto-expire after 7 days via a cron on `prune_session_ephemera`.

**Admin panel UI.** A "Files" tab on the live session drawer:
- Drag-and-drop / picker to push files down to the agent side.
- Live list of files transferred either direction with size, direction icon, hash, timestamp.
- Multi-select checkboxes + "Select all", then **Download selected as .zip**.
- Progress bar per file (chunk count) and total.

**Password-protected zip.** The "Download selected" action calls a server function `packageSessionFiles({ session_id, file_ids })`. It:
1. Verifies the caller is bound to that session (admin binding table already exists).
2. Streams each object out of Storage and into a **AES-256 encrypted zip** using [`archiver-zip-encrypted`](https://www.npmjs.com/package/archiver-zip-encrypted) (WinZip AE-2, understood by 7-Zip, Windows Explorer 11 24H2+, and macOS's `unzip`).
3. Uses **the customer's own account password** as the zip password. This is the tricky bit — hashed passwords in `auth.users` are one-way, so we can't read the current password server-side. Two supported flows, chosen per session:
   - **Verify-and-cache flow (default):** when the operator clicks Download, a modal asks them to have the customer type their portal password in the customer portal's "Session file password" field (or the operator types it on the customer's behalf if remote). The portal POSTs the plaintext to a short-lived server function that calls `supabase.auth.signInWithPassword` to verify it, then encrypts it with the session's per-session symmetric key and stores it in a `session_secrets` row (`session_id`, `wrapped_password`, `expires_at = session end + 5 min`). Subsequent downloads in the same session reuse the cached value with no prompt. The wrapped value is dropped when the session ends.
   - **Owner-download flow:** if the operator prefers not to ask, they can hand the customer a "Download files" link that opens on the customer portal, where the customer signs in normally and downloads the zip themselves — the portal already has the password in-hand at sign-in, so zip encryption happens without any caching.
4. Streams the resulting `.zip` to the browser with `Content-Disposition: attachment`.

The customer's password is never persisted in plaintext, never logged, and never leaves the request except as the zip password on the file the operator is downloading in that moment.

**Rate & size limits.** Per-file cap 500 MB, per-session cumulative cap 5 GB, cap-hit is a soft error surfaced in the Files tab. Sizes tunable via env.

## 7. Native admin console (`admin/src`) — file-by-file

The roadmap's §10 status board lists 32 files under `admin/src/**`. Everything below is scoped against that inventory so nothing is left half-wired between web and native.

**Must change**

| File | Change |
|---|---|
| `admin/src/admin.config.json` | `baseUrl` `https://zoomlite.live` → `https://connectliveagent.com`. |
| `admin/src/Api/AppConfig.cs` | Same swap in both the property default and the embedded JSON fallback, so a console shipped without a config file still resolves. |
| `admin/src/Api/ApiClient.cs` | New calls: `ListSessionFilesAsync`, `UploadSessionFileAsync` (fallback path), `RequestZipAsync` (returns the signed download URL for `packageSessionFiles`), `SubmitSessionPasswordAsync`. Existing `/api/public/auth/login` hardcode stays the only literal route string. |
| `admin/src/Api/Models.cs` | `SessionFile`, `ZipRequest`, `ZipTicket`, `LicenseState` DTOs. |
| `admin/src/Media/WebRtcClient.cs` | `NegotiateAsync` opens a **second** ordered datachannel `files` next to the existing `input` one, before `createOffer`; exposes it to the new transfer service. Chunk traffic is excluded from the wire-bitrate counters so the HUD keeps reporting video health honestly. |
| `admin/src/Media/FileTransport.cs` *(new)* | Mirror of `InputTransport`: chunk/reassemble over the `files` channel, per-file SHA-256, progress events, one-way demotion to the HTTP fallback on first send failure — same demotion discipline S10 already established for input. |
| `admin/src/ViewModels/LiveSessionViewModel.cs` | `Files` collection, `SelectedFiles`, `SendFilesCommand`, `DownloadZipCommand`, transfer progress and per-file state; refresh on the same 10 s poll that already tracks monitors. |
| `admin/src/Views/LiveSessionWindow.xaml` + `.cs` | "Files" side panel: drop target, file list with checkboxes + Select all, progress bars, **Download selected (.zip)** button, and the password prompt dialog for the verify-and-cache flow. Drop handling must not steal keyboard focus from `Stage` — the S18 keyboard-capture gate (`Stage.IsKeyboardFocusWithin`) stays intact. |
| `admin/src/Views/MainWindow.xaml.cs` | `OpenOrders_Click` keeps opening the browser, but at the new domain via `App.Config.BaseUrl` (already indirect — verify only). No SMTP or customer-management UI in native: those are web-only surfaces, opened in the browser. |
| `admin/build.ps1` / `admin/INSTALL.md` / `admin/README.md` | Version bump, new domain, "Files" listed under in-scope features; README's Scope block currently says file transfer is absent. |

**Verify-only (no code change expected, but each is read during the pass)**

`App.xaml.cs`, `AuthStore.cs`, `ClientIdStore.cs`, `SupabaseCallException.cs`, `Diag/Log.cs`, `Input/*` (5 files), `Media/{VideoPipeline,D3DImageHost,D3D9Ex,FrameConvert,FrameFallbackPump,ContentRect,CursorPollPump,PredictiveCursor,RealtimeChannel}.cs`, `ViewModels/{DevicesViewModel,LoginViewModel,Converters}.cs`, `Views/LoginWindow.*`, `Ui/AppIcon.cs`, `app.manifest`, `ConnectLiveAdmin.csproj`, and both `spikes/`. The pass confirms none of them hold a `zoomlite.live` literal, none assume a single datachannel, and none break when the session view gains a panel.

**Explicitly out of scope for native:** SMTP settings, customer/license administration, order emails. Those live in the web payments console only; the native console links out to them.

**Agent side, matching:** `agent/src/FileTransfer.cs` (new) handles the `files` channel, writes inbound to `%LOCALAPPDATA%\ConnectLive\incoming\<session_id>\`, and reads outbound from a user-picked folder; `agent/src/WebRtcSession.cs` accepts the second channel in its existing `ondatachannel` handler; `agent/src/ApiClient.cs` gains the HTTP chunk fallback and the domain swap.

## Technical details

**Database (one migration).** `licenses` (`user_id`, `meeting_id` unique, `plan_code`, `seat_limit`, `status`, `issued_at`, `expires_at`); `devices.license_id` plus a `blocked` status value; `orders.license_id`; `customer` added to the `app_role` enum. `smtp_settings` singleton (`host`, `port`, `username`, `password_encrypted`, `from_name`, `from_address`, `encryption`, `updated_by`, `updated_at`). `session_files` (see §6). `session_secrets` (see §6). GRANTs for `authenticated` and `service_role` in the same migration, plus RLS so a customer reads only their own license and devices while admins read all — device reads by the technician console keep working through the existing admin policies. `smtp_settings` and `session_secrets` are admin-only, no anon grant.

**Enrolment.** `api/public/agent/enroll` gains an optional `meetingId`: resolve the license, count live seats, insert the device as `online` under the cap or `blocked` over it / past expiry, and audit either way. Devices with no meeting ID keep the current anonymous path so existing fleets don't break. The per-IP throttle stays.

**Heartbeat.** `api/public/agent/heartbeat` returns `license: { status, expires_at, seat_state }` so a blocked agent can idle. All existing merge discipline for metadata is preserved.

**Server functions.** Admin-only: create customer, reset password, suspend, adjust license (service-role `auth.admin`, never reachable publicly); read/save/test SMTP settings; `packageSessionFiles` for the encrypted zip; `cacheSessionPassword` / `clearSessionPassword` for the verify-and-cache flow. Customer-scoped: read own license, list own devices, delete own device, start an upgrade order, submit session password.

**Email.** New `src/lib/smtp.server.ts` wraps `nodemailer`. Order routes call `sendOrderEmail('order_received' | 'order_confirmed', order)`; the helper no-ops with a logged reason when SMTP isn't configured. Templates are plain server-rendered strings under `src/lib/email-templates/` with a text alternative. "Order received" fires from the public order-create route; "order confirmed" fires from both the paid transition in `webhooks/cdp.ts` and the admin mark-paid path, keyed on the order id so retries don't double-send.

**Storage bucket.** Create private `session-files` via the storage tool (not SQL). RLS on `storage.objects` restricts reads to admins bound to the parent session and to the customer who owns the linked license.

**Agent (C#).** `LicenseService.cs` for DPAPI `meeting.dat` read/write, a one-time WPF prompt when absent, `MeetingId` on the enrol request, dormancy handling on the heartbeat response. `FileTransfer.cs` in `agent/src/` handles the new `files` DataChannel — receive-side writes to `%LOCALAPPDATA%\ConnectLive\incoming\<session_id>\`, send-side chunks selected files; a small tray/OSD confirmation appears when the operator pushes a file down, no consent prompt for outbound (agent-uploaded) files since the customer initiates them.

## Order of work

1. Domain replacement, then re-run the route verifiers.
2. `smtp_settings` migration; SMTP admin panel; order-email helper + two templates; test-send button.
3. Licensing migration (`licenses`, `devices.license_id`, `orders.license_id`, `customer` role).
4. Enrolment + heartbeat enforcement.
5. Admin customer management.
6. Customer portal at `/public/agent/login`.
7. Agent Meeting-ID prompt and dormancy.
8. `session-files` bucket + `session_files` / `session_secrets` tables; DataChannel `files` transport with HTTP fallback; Files tab in admin session drawer; `packageSessionFiles` encrypted-zip download; verify-and-cache password flow.
9. `PROJECT-MAP.md` and `ENDPOINTS.md` updated with the new routes, tables, storage bucket, SMTP settings, and licensing rules.
