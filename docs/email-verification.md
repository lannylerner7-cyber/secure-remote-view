# Email and notification verification

## Scope and evidence

Existing message flows were repaired without production sends, schema changes,
secret changes, customer-data access, desktop changes or deployment.
Tests use synthetic fixtures and isolated SQL/SMTP boundaries.

## Event → recipient → template/channel matrix

| Event | Recipient | Channel/template | Implementation and limits |
| --- | --- | --- | --- |
| New pending order | Order email | order_received | Saved order loaded server-side; state guard, reference and exact quote; duplicate suppression |
| Payment accepted by existing webhook | Order email | order_confirmed | Reads persisted paid status before dispatch; existing payment-validation defects from source audit remain outside email scope |
| Reconciler changes order to paid | Order email | order_confirmed | Newly wired; dispatch only after successful conditional update |
| Super-admin marks paid | Order email | order_confirmed | Uses same guarded, duplicate-suppressed dispatcher |
| Paid order access link saved | Order email | access_ready | HTTPS link required; no false-ready fallback; acceptance timestamp written after SMTP acceptance, including successful resend |
| Admin retries order email | Stored order recipient | Same original kind | All three kinds supported; explicit duplicate warning, two-minute claim lease, state checks and visible result |
| Newsletter signup | Submitted subscriber | Welcome | Unique subscription, suppression check, persistent send claim; missing-SMTP failure can recover on later signup |
| Repeat newsletter signup | Existing subscriber | Usually no email | Accepted welcome suppressed; uncertain SMTP attempts are not automatically repeated |
| Previously unsubscribed address signs up | Suppressed subscriber | No email | Existing suppression preserved; verified re-subscription flow not implemented |
| Newsletter footer GET | Link holder | Confirmation page | Token checked; no mutation by email scanners |
| Newsletter one-click POST | Token-authenticated subscriber | No outgoing email | Idempotent unsubscribe; storage failure 503, invalid token 400 |
| Contact submitted | Support mailbox | Support notification | Escaped content, visitor Reply-To; bounded independent send |
| Contact submitted | Visitor | Acknowledgment | Support Reply-To; independent partial outcome, request remains saved |
| Portal support booking | Support mailbox | Booking request | Shared branded/escaped template; best-effort email, no customer confirmation invented |
| Requested SMTP test | Super-admin-selected recipient | SMTP test | Shared template; no test sent during this task |
| Admin direct/broadcast notice | Target/all admins | In-app notification | Existing notification database/bell; not an email template |
| Device/session operational alerts | Administrators | Existing in-app events | No new email categories; remote-agent behavior not modified |
| Portal Telegram integration | Configured chat | Telegram | Separate existing best-effort channel; not SMTP, not exercised |
| Newsletter campaigns, decline/expiry receipts, booking-confirmed mail | — | Not implemented | No callers/templates were invented or campaigns sent |

## Template corrections

Eight distinct templates share a readable inline/table-based shell: three order
types, newsletter welcome, two contact messages, booking request and SMTP test.
Subjects/order references, hidden preview text, plain-text counterparts,
long-string wrapping, escaping and HTTPS CTA validation were checked.
The order greeting no longer double-escapes names. Missing/unsafe delivery links
cannot generate a misleading access-ready email.

The existing site disagrees on 24-hour versus 24–48-hour delivery promises.
Templates now describe provisioning without inventing an SLA; public page
promises remain for the business to reconcile. Support reply addresses in order
and newsletter messages are explicitly aligned with the displayed support address.

The legacy logo asset path returned development HTTP 404. Emails now use a
network-independent ConnectLive text wordmark rather than a broken image.
Link/button blue is darkened to support readable text contrast.

## Delivery semantics and configuration

- Enabled custom settings take precedence; absent/disabled custom falls back to
  environment settings. Disabled custom is **not** a global mail kill switch.
- Configuration lookup failure or invalid enabled custom config fails explicitly,
  rather than silently switching sender.
- Password remains server-only; blank save preserves it. Address/header injection,
  invalid host/port/encryption and plaintext credential authentication are rejected.
- SMTP deadlines abort pending connect/TLS/STARTTLS and close sockets; no late
  sends continue after timeout. Replies are bounded. DATA 250 is acceptance;
  lack of a QUIT response cannot incorrectly turn acceptance into failure.
- Admin “Accepted by relay” is not a claim of inbox delivery. Provider error
  content is sanitized before reaching UI/logs.
- Order/newsletter sends use deterministic audit-log claims and compare-and-swap
  ownership. Accepted events do not automatically resend, including across
  processes. Interrupted sends remain uncertain; manual order retry is explicit
  after a two-minute lease. This is **not transactional exactly-once SMTP**.
- Do not purge `mail.delivery_claim` audit rows without a replacement retention/
  idempotency design. Existing audit storage was used to avoid unauthorized DDL.
- Secret tooling confirmed password presence and SSL/465 environment setup;
  configured sender differs from the displayed support domain. No credentials
  were printed, changed or transmitted to the provider. Sender authorization,
  DKIM/SPF/DMARC, bounces and actual inbox placement remain unverified.

## Verification performed

- `node scripts/email-flow-check.cjs`: 15 groups passed, including actual
  transpiled dispatch/claim/unsubscribe/auth code with mocks. Enum/UI mapping
  checks are explicitly static-only.
- `node scripts/smtp-transport-check.cjs`: loopback timeout/cancellation,
  held DNS, TLS/STARTTLS, accepted DATA/QUIT, injection, provider sanitization,
  reply limits, source precedence and simulated Cloudflare lock handling passed.
- `node scripts/newsletter-config-check.cjs`: missing/rotated signing-key tests passed.
- `node scripts/email-template-preview.cjs`: 13 synthetic
  standard/stress variants plus booking and SMTP-test output passed.
- Browser review: eight distinct templates at 375px/800px, plus stress cases;
  no template document-wide horizontal overflow, readable wrapping and escaped
  markup. The generator's navigation index itself overflowed on mobile, not the
  messages. Offline remote-image placeholders led to the subsequent text-wordmark
  fix; regenerated fixtures check the final templates, not a second browser run.
- Production Node bundle builds. Restarted web workflow serves technician
  sign-in. Existing restart-related aborted-request/SSR warnings were observed.
- Whole-app TypeScript check remains blocked by an unchanged unrelated nullable
  session argument at `agent/session.$sessionId.reconnect.ts:57`; no email-file
  type errors were reported. This is not a clean whole-repository type-check claim.

Signed-in EmailSettingsPanel browser interaction was not exercised: its
contract/error branches were inspected and statically checked. No real-provider
TLS authentication, delivery, production DB writes, Gmail/Outlook/Apple Mail,
DKIM checks or marketing mail occurred. Portal booking mail remains best-effort
without an operator-visible per-attempt delivery log.

## Review assets

Run the preview generator, then `node scripts/export-email-preview.cjs` for
`generated-artifacts/email-template-review.html`, a standalone synthetic gallery.
Detailed browser findings are in the ignored generated email-review-checks
directory. Generated previews are not part of the production app or Git history.
