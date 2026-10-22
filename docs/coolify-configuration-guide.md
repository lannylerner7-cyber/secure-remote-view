# ConnectLive: Coolify configuration in stages

No actual credentials are included. Replace placeholders privately in Coolify.
These are for the imported full application, not the disconnected preview.
Setting variables does not apply migrations, provision providers or verify runtime.

Run `node scripts/check-connectlive-config.cjs` in the workspace to check the
required names, selected project URL, matching public keys and accidental
browser-visible credentials. It prints outcomes, never values, and exits nonzero
when configuration is incomplete. It does not authenticate keys with Supabase.
Its isolated checks run with `node scripts/check-connectlive-config.test.cjs`.

## 1. Existing data platform: Supabase

Selected by the user: managed paid Supabase. The application uses
PostgreSQL/RLS, Supabase Auth, Realtime and Storage together. Self-hosted Supabase
is an alternative, but you own backups, updates, monitoring and recovery.
D1 is not a drop-in replacement; migrating requires an explicit redesign.
Do not purchase a D1 plan expecting it to supply Supabase-compatible APIs.

In the Supabase project's connection/API settings obtain the project URL and
publishable key. Obtain the server-only service-role credential separately.
Never put the service-role credential into a VITE variable or desktop installer.
Current source uses SUPABASE_SERVICE_ROLE_KEY; do not silently substitute a
different key type without validating all its consumers.

### Public client build settings

Make available during build; also runtime if the build/SSR setup reads them:

```dotenv
VITE_SUPABASE_URL=REPLACE_WITH_PROJECT_URL
VITE_SUPABASE_PUBLISHABLE_KEY=REPLACE_WITH_PUBLIC_PUBLISHABLE_KEY
```

These values are bundled into client code. Publishable does not mean privileged;
database policies still must be correctly applied.

### Server runtime settings

```dotenv
SUPABASE_URL=REPLACE_WITH_THE_SAME_PROJECT_URL
SUPABASE_PUBLISHABLE_KEY=REPLACE_WITH_THE_SAME_PUBLIC_KEY
SUPABASE_SERVICE_ROLE_KEY=REPLACE_PRIVATELY_WITH_SERVER_CREDENTIAL
SESSION_SECRET_KEY=REPLACE_PRIVATELY_WITH_STRONG_RANDOM_SECRET
```

The last two are secrets: runtime only, unavailable during image build by
default, not printed in logs. All app replicas must use the same configured
SESSION_SECRET_KEY; changing it can invalidate encryption-dependent data.
The workspace's SESSION_SECRET is a different name, not an automatic substitute.
Do not casually rotate either encryption material or service credentials.

## 2. SMTP: after database/auth checks

Non-secret server runtime settings:

```dotenv
SMTP_HOST=REPLACE_WITH_PROVIDER_HOST
SMTP_PORT=587
SMTP_ENCRYPTION=starttls
SMTP_FROM_ADDRESS=REPLACE_WITH_VERIFIED_SENDER
SMTP_FROM_NAME=ConnectLive
SMTP_REPLY_TO=REPLACE_WITH_REPLY_ADDRESS
```

Server-only credentials, entered separately:

```dotenv
SMTP_USERNAME=REPLACE_WITH_PROVIDER_USERNAME
SMTP_PASSWORD=REPLACE_PRIVATELY_WITH_SMTP_PASSWORD
```

587/starttls is an example, not a universal provider requirement.
Use ssl for 465 when specified by the provider. Existing database SMTP
configuration may take precedence over environment fallback; verify the selected
configuration rather than assuming an environment edit changed the active sender.

### Selected provider: Cloudflare Email Service

Verified against Cloudflare's SMTP documentation on 2026-10-21:
https://developers.cloudflare.com/email-service/api/send-emails/smtp/

- Host: `smtp.mx.cloudflare.net`; port: `465`; encryption: `ssl`.
- Username: literal `api_token`, not the sender email address.
- Password: a separate Cloudflare API token with **Email Sending: Edit**.
- Email Sending must be enabled and the sender domain onboarded for sending;
  Email Routing alone is not sufficient.
- The Cloudflare management connector does not automatically provide an SMTP
  password to the application or to Coolify.
- Cloudflare advertises a 5 MiB SMTP message limit. Do not email client ZIP
  attachments that exceed it.

Non-secret SMTP settings have been saved in workspace development configuration.
This does not configure Coolify or Supabase Auth SMTP. On 2026-10-21, a direct
workspace SMTP probe passed verified implicit TLS, EHLO, and authentication.
No MAIL FROM, RCPT TO, or DATA commands were issued. Sender-domain authorization,
application mailer behavior, and actual delivery remain unverified.

## 3. Cloudflare TURN: after isolated access tests

```dotenv
CLOUDFLARE_CALLS_APP_ID=REPLACE_WITH_TURN_KEY_ID
CLOUDFLARE_CALLS_APP_TOKEN=REPLACE_PRIVATELY_WITH_TURN_API_TOKEN
```

Important: despite the legacy APP_ID name, the implementation calls
/v1/turn/keys/{id}/... and needs a TURN key ID, not an SFU app ID.
Both are server runtime settings; the token is secret. Never embed it in clients.
The server mints temporary relay credentials for authorized clients.

Workspace credential-generation check passed on 2026-10-21: Cloudflare returned
HTTP 201 and short-lived UDP/TCP/TLS relay entries. This was a direct provider
check, not an application authorization, TURN allocation or Windows media test.
The separate Coolify runtime values have not been configured here.

Optional alternative: self-managed TURN uses TURN_URLS with TURN_STATIC_SECRET,
or TURN_USERNAME and TURN_PASSWORD. Do not configure all alternatives blindly.
TURN does not keep sleeping/offline endpoints awake.

## 4. Deferred / deliberately not requested

| Name or item | Reason |
| --- | --- |
| BOOTSTRAP_TOKEN | Only for reviewed initial privileged provisioning; remove after use |
| CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY, CDP_WEBHOOK_SECRET | Legacy code still exists, but replacement was requested; do not provision new CDP credentials |
| LOVABLE_API_KEY | No current TypeScript consumer found in the inspected source |
| SUPABASE_ANON_KEY | Legacy fallback in a few routes; use the canonical publishable-key names above |
| D1 / R2 / Redis credentials | No replacement integration established; adding names alone does nothing |
| Cron authentication | Existing reconciliation reads cron_tokens from the database, not a guessed CRON_SECRET |
| Android / Windows signing | Separate release configuration, not web runtime environment |

## Coolify entry procedure

1. Select the full application's resource, then Environment Variables.
2. Enter one NAME and VALUE at a time. Do not enter placeholder text as real
   credentials, and do not paste credentials into chat or commit a populated .env.
3. Keep build/runtime availability separate. Never enable build access for all
   secrets merely because the UI defaults both switches on.
4. Use literal/multiline settings where required for special characters or
   multiline values. Do not add quote characters in the normal value field
   unless they are part of the actual value.
5. A VITE change needs a rebuild/new deployment. Runtime-only changes require
   the appropriate restart/redeployment of the resource to be loaded.
6. Keep staging and production distinct. Configure and validate staging first.

## Verification order

Database/Auth -> migrations/RLS -> test login -> private storage/proxy ->
SMTP -> TURN -> Windows checks -> payment replacement -> Android.
Do not enable live management or production checkout merely because keys exist.

Auth health alone is not a database access test. The REST OpenAPI root can require
admin credentials, so its 401 response is not sufficient evidence that a public
key is invalid. Check a known public table with `limit=0` instead. A PGRST205
response requires investigation of the project/schema/exposure, not repeated key
replacement. For an existing project, inspect before applying any migrations.

## Scale: 10,000 endpoints

10,000 endpoints polling once per second produce roughly 10,000 requests/second,
before console polling, retries, telemetry or SQL fan-out. This is a workload to
measure, not a capacity guarantee from a paid plan.

Use a load balancer and stateless application replicas only after checking shared
state, pooling, rate limits and WebSocket routing. Separate authorized idle
presence from live media; do not route video frames through a relational database
as the primary transport. Do not change current transport before its access and
runtime gates pass.

Redis may cache ordinary profile/catalog data with tenant-safe keys and explicit
TTL/invalidation. Do not reuse stale permissions or revocation decisions for
performance. Use idempotent jobs, bounded retries with jitter, backpressure,
metrics and traces. Queue delivery may repeat.

Read replicas can lag: use authoritative reads for permission, payment and quota
decisions. D1 databases are individually single-threaded; read replication does
not remove a write bottleneck or automatically shard tenant data.
R2/S3 stores objects, not relational database shards. Profile images can use
object storage/CDN with appropriate privacy rules; private session files must
retain authorization checks and must not become public cached assets.

Measure before sharding or adding microservices. Paid service availability is not
proof of sufficient throughput, latency or recovery.

## Sources

- https://coolify.io/docs/applications/configuration/environment-variables
- https://coolify.io/docs/services/configuration/environment-variables
- https://supabase.com/docs/guides/api/api-keys
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/

Reviewed 2026-10-21. No provider, secret or deployed environment was changed.
