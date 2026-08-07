# Newsletter welcome emails not arriving

## What the data shows

Two people subscribed recently (Aug 7, 05:14 and 06:41) and both rows have an
empty "welcome sent" timestamp — so the site accepted the signup, saved them to
the list, and the send attempt failed silently. Earlier subscribers on Aug 5 did
get their welcome mail, so this is a regression, not a missing feature.

Two credential sets exist and they disagree:

- The saved console settings (Payments → Email) use port 587 with STARTTLS. These
  currently take priority over everything else.
- The new built-in server credentials use port 465 with implicit SSL/TLS — the
  same combination that succeeds in your external SMTP test tool.

So the platform is sending on the one configuration you have not verified, and
when it fails nothing is written anywhere: the subscriber just sees "your welcome
email is on its way shortly" and no error is recorded.

## Fix

1. **Send on the verified configuration.** Align the mail path with 465 /
   implicit SSL: update the stored console row to 465 + SSL/TLS so both sources
   agree, keeping the built-in server credentials as the fallback. Nothing else
   about precedence changes.
2. **Stop failing silently.** Record every newsletter and contact send outcome
   (success or the SMTP error text) so a failed send is visible in the console
   instead of vanishing, and log the failure reason server-side.
3. **Prove it end to end.** Run a real test send from the Email tab, then run a
   real newsletter subscribe with a live address and confirm the message lands
   and the "welcome sent" timestamp is written.
4. **Backfill the two missed subscribers.** Once sending is confirmed healthy,
   re-send the welcome mail to the two addresses that were skipped and stamp
   their rows.

## Technical notes

- `src/lib/smtp.server.ts`: precedence stays enabled DB row → env → none; the DB
  row gets corrected to `port 465` / `encryption ssl` via migration so the
  Worker uses implicit TLS instead of the STARTTLS upgrade path (STARTTLS on
  workerd is the most likely point of failure here, and it is the untested one).
- `sendNewsletterWelcome` in `src/lib/newsletter-emails.server.ts` currently
  swallows the error into a boolean. It will return the failure reason, and
  `subscribeNewsletter` will persist it (reuse of the existing `order_emails`
  style logging, scoped to a small `detail` column write plus `console.error`),
  so a repeat can be diagnosed from data rather than guesswork.
- Backfill uses the existing send helper against the two known addresses; no new
  bulk-send code path is introduced.
