# Built-in SMTP configuration (no reliance on the Payments console form)

Today every outgoing email (order receipts, contact form, newsletter, portal
alerts, access-ready notices) loads its credentials from the single settings row
that a super-admin fills in on the Payments → Email tab. If that row is empty or
disabled, nothing sends.

Goal: the platform ships with its own SMTP credentials stored as server secrets,
so email works out of the box. The console form stays, but becomes an optional
override rather than a requirement.

## How it will work

1. **Server secrets become the default sender.** The mail loader first reads the
   SMTP credentials from server environment secrets. If they are complete, they
   are used.
2. **Console settings act as an override.** If a super-admin has saved settings
   in the console and marked them enabled, those win over the built-in ones — so
   nothing that already works breaks.
3. **Clear status in the console.** The Email tab shows which source is
   currently active ("Built-in credentials" vs "Custom settings saved here"),
   and the test-send button uses whichever source is active.
4. **No behaviour change for callers.** Order emails, contact form, newsletter,
   unsubscribe headers and portal alerts keep calling the same helper; they just
   stop returning "SMTP is not configured".

## Credentials needed

After you approve, I'll ask you to save these securely (values never appear in
code or chat):

- SMTP host and port
- SMTP username and password
- From address and display name (e.g. support@connectliveagent.com)
- Optional reply-to and encryption mode (defaults: reply-to = from address,
  encryption = STARTTLS on 587 / SSL on 465)

If you'd rather keep using the same mailbox that's already saved in the console,
tell me and I'll mirror those into secrets instead.

## Technical notes

- `loadSmtpSettings()` in `src/lib/smtp.server.ts` gains an env-backed source:
  reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
  `SMTP_FROM_ADDRESS`, `SMTP_FROM_NAME`, `SMTP_REPLY_TO`, `SMTP_ENCRYPTION`
  inside the function (never at module scope), and returns a normalized
  `SmtpSettings`. Precedence: enabled DB row → env → null.
- `src/lib/smtp.functions.ts` (`getSmtpSettings`) additionally returns
  `active_source: "custom" | "builtin" | "none"` plus the built-in from-address
  for display; `sendSmtpTest` switches from reading the row directly to calling
  `loadSmtpSettings()` so it exercises the real resolution path.
- `src/components/EmailSettingsPanel.tsx` renders the active-source badge and
  keeps the existing save/test controls unchanged.
- `.env.sample` documents the new SMTP_* variables.
- Verification: run a test send from the Email tab with the console row cleared,
  and confirm a contact-form submission still delivers.
