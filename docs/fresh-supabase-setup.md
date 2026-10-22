# Fresh managed Supabase setup

The user clarified that the selected project is fresh, with no application
tables. This supersedes the earlier assumption that it held the Lovable data.
The reviewed fresh install has now been applied to **esjlqcfcwewymmeghbvj**.
This is database setup only: no application runtime credentials were changed,
no administrator was provisioned, and remote access was not activated.

## Read-only preflight result — 2026-10-21

The uploaded public Supabase CA certificate resolved the TLS trust failure.
Certificate-chain and hostname verification stayed enabled. The SQL connection
matched the selected project and the inspection ran in a read-only transaction,
ending with ROLLBACK.

- Public application tables: none.
- Migration history table: absent.
- Supabase Auth and Storage schemas/tables: present.
- Supabase Realtime publication: present.
- pgcrypto and uuid-ossp: installed in the extensions schema.
- pg_trgm, pg_cron and pg_net: not installed.

That initial inspection confirmed SQL connectivity and a fresh public schema,
not application readiness. It created nothing. The installation and subsequent
verification described below happened afterward.

## Reviewed installer and completed result

Run from the repository root:

```sh
node scripts/supabase-fresh-install.cjs --self-test
node scripts/supabase-fresh-install.cjs --dry-run
node scripts/supabase-fresh-install.cjs --preflight
node scripts/supabase-fresh-install.cjs --apply
node scripts/supabase-fresh-install.cjs --verify
```

The default is `--dry-run`: it does not connect, read a credential or execute
SQL. It prints the ordered filenames, original SHA-256 checksums and applied
SHA-256 checksums. `--self-test` also needs no database credential.
`--preflight` inspects in a read-only transaction and rolls it back; it takes
only a session-level advisory lock outside that transaction.
`--apply` is an explicit external-database operation, not a startup/build hook.
Do not use this installer for an already-used application database.

Completed checks against the selected external project:

- **64/64 reviewed migrations committed**, with matching standard history and
  installer history, original/applied checksums, and an exact ordered prefix.
- **33 public application tables; all 33 have RLS enabled.**
- **63 policies** across public and Storage, including restrictive guards for
  frames, cursors, signals, inputs, session file manifests and Storage objects.
  Server-only tables have no anon/authenticated/public client policies.
- Three required lifecycle/credential triggers were verified. Fourteen
  critical grant/inactive-state checks passed, including service-only
  authorization recording, authenticated-only admin binding, denied anonymous
  sensitive RPC access, no accounts promoted, no devices/sessions/recorded
  authorizations, disabled SMTP and a false standing-consent default.
  Service-role CRUD grants were checked on all 33 application tables.
- `pgcrypto` and newly installed `pg_trgm` are in `extensions`; trigram indexes
  and the crypto default explicitly resolve that namespace.
- `pg_cron` and `pg_net` are absent. `cron.job` and
  `net.http_request_queue` are absent: **no scheduled/outbound jobs were
  installed**, including retention jobs.
- Exactly the private **session-files** bucket was provisioned, with a
  **524,288,000-byte (500 MiB)** per-object limit, `public=false`, and no MIME
  allowlist (the application supports arbitrary transferred file types).
  Direct authenticated and anonymous access to that bucket is restrictively
  denied. File bytes must go through the application/device service-role
  proxy paths, not direct client Storage requests or signed download URLs.
- Independent `--verify` passed after installation. A subsequent `--apply`
  found 64 completed, zero remaining, replayed no migrations and passed again.
- Tool-level interruptions occurred after successful prefixes of 16 and 48
  migrations. Both subsequent read-only preflights verified the recorded
  prefix/catalog/seed fingerprints before resuming. No history was erased or
  blindly replayed.

The source intentionally seeds three plan catalog records, disabled SMTP
settings and a server-only reconciliation token. The token is neither printed
nor sent anywhere. No administrator, Auth account, device, authorization or
session was created. Existing Auth/Storage/Realtime platform objects were not
deleted or transferred to a different owner.

### Boundaries and remaining work

**Client runtime, real account authorization and end-to-end file transfers
were not tested.** SQL/catalog success is not a claim that the website, desktop
clients, agent, proxy routes or deployment are connected or ready.

The bucket limit matches `MAX_FILE_BYTES` in
`src/lib/session-files.server.ts`. Static code review also
confirmed the 5 GiB cumulative session limit, repeated authority checks, bounded
stream upload and post-upload size checks in the file proxy/functions and
admin/agent file routes. The 5 GiB session quota is an application check, not an
atomic database/storage quota. Supabase project/plan global upload limits may
be lower than the bucket limit; Dashboard/API configuration and actual uploads
remain to be verified before enabling file transfer.

Runtime credentials, administrator provisioning, live activation, cron
destinations/schedules, application lifecycle compatibility and actual
authorization/file-path tests remain separate work. No blocker remains for
the **reviewed schema installation itself**.

The temporary migration secret has not been changed or removed by this task.
Remove `SUPABASE_MIGRATION_DATABASE_URL` from workspace Secrets once any further
authorized verification is finished. Never copy it into application runtime.

## Safety, history and resumability

- Only injected `SUPABASE_MIGRATION_DATABASE_URL` is read; the driver is `pg`
  resolved with `createRequire` from `lib/db/package.json`. There is no fallback
  to Replit's managed `DATABASE_URL`, a service-role API key, or a client key.
- Target validation accepts only this project's direct database hostname or
  an approved Supabase session-pooler hostname with this project's exact
  `postgres.<project-ref>` username, database `postgres`, port 5432. Query-string
  connection overrides are rejected. The connected database/session identity
  and platform schemas/publication are checked.
- TLS uses the uploaded public CA
  `attached_assets/0_prod-ca-2021_1792610634463.crt`, with a pinned certificate-file
  checksum, `rejectUnauthorized: true`, SNI and Node hostname verification.
  Global TLS verification disablement is rejected. Connection strings,
  passwords, tokens and raw driver errors are never printed; failures report
  a safe stage and, where available, SQLSTATE/error code only.
- The exact 64-file inventory is pinned by its SHA-256 manifest digest:
  `64db444f491af6f24995c9b2ea9ceb7985d643f6a9d1b935d39b60e1b3045d12`.
  Changed/new source files require another review, not an automatic replay.
  The source migrations themselves are unchanged.
- An exclusive advisory lock prevents concurrent copies of this installer.
  Unexpected tables, history, buckets, Storage policies or Auth triggers stop
  the first install. The pre-existing Supabase `rls_auto_enable()` /
  `ensure_rls` event-trigger baseline was additionally inspected: it only
  enables RLS on newly created public tables. Its definition, owner, ACL and
  event binding are separately checksum-pinned; it is retained unchanged.
- On this project `postgres` is not a member of `supabase_storage_admin`.
  Supabase's managed privileged-role mechanism nevertheless permits policy
  DDL as `postgres`. This was tested with a restrictive policy inside a
  **rollback-only capability probe** before installation; the probe never
  commits. The installer does not change Storage ownership, grant role
  memberships, or elevate itself. When owner-role membership is available,
  narrowly scoped `SET LOCAL ROLE` is supported.
- Each source file has its **own transaction**. Its schema work and both
  history records commit together. Newly added enum values therefore commit
  before subsequent files use them. The final authorization source's own
  outer `BEGIN`/`COMMIT` are lexically verified and removed, then replaced by
  the installer-owned per-file transaction, so it cannot commit ahead of its
  history records. SQL strings/comments/dollar-quoted bodies are handled by a
  lexer rather than splitting blindly on semicolons.
- `supabase_migrations.schema_migrations` retains every source version/name
  and the **sanitized applied statements**, including files with omissions.
  `connectlive_install.identity` and `connectlive_install.migrations` retain
  the installer/project identity, raw and applied checksums, catalog
  fingerprints, seed-data fingerprints and successful commit timestamps.
  Do not treat this as permission to run the original unmodified chain.
- Only this installer's exact successful recorded prefix is resumable.
  Schema/policy/grant drift, changed seed rows, or any unexpected application
  data stop a resume. No data is deleted to restore a "fresh" state. A failing
  migration rolls back and is not recorded; earlier committed files remain.
  Bucket provisioning and its readiness marker are atomic and resumable too.
- No-network self-tests passed for the pinned source inventory,
  sanitization, SQL lexer and outer-transaction handling, malicious
  host/project/TLS-override rejection, enum order, atomic dual-history writes,
  and commit/rollback behavior (including a history-write failure).

## Source review

64 migrations define 33 application tables. Static review is not proof that the
chain executes correctly on the target Supabase version.

Do not replay the unmodified chain automatically:

- `20260727115223_f01993ce-47ff-435d-a3f5-ddda124423a0.sql` and
  `20260803090421_b8368cb5-f1ed-4a68-b4a3-56fdd4c75a17.sql` schedule calls to a
  legacy external application. The later job sends the new database's cron
  secret to that destination. Preserve required table/index changes but exclude
  these outbound schedules from the fresh-install path.
- `20260721125713_2756f3f4-d265-435e-a389-8af0aaedade5.sql` includes conditional
  promotion of a legacy identity. Do not import that promotion. New administrator
  provisioning must identify the intended account explicitly after schema setup.
- Check pg_trgm namespace before indexes using public.gin_trgm_ops.
- Check pgcrypto availability/search path before gen_random_bytes defaults.
- Review pg_cron/pg_net availability, conditional unscheduling, and retention
  jobs. Keep jobs disabled until their destinations and behavior are approved.
- Preserve migration order and commit boundaries for newly added enum values.
  Do not concatenate the entire history inside one transaction.
- The latest authorization migration has its own transaction and requires
  suitable storage.objects privileges. Validate its lifecycle guards against the
  clients before activating remote access.
- The history does not create the private session-files storage bucket.
  Provision it separately with appropriate limits and reviewed access rules.

## Temporary migration credential

`SUPABASE_MIGRATION_DATABASE_URL` is a temporary SQL connection string.
It is separate from public API keys and from the application service-role key.
Do not place it in VITE variables, source control, logs, desktop packages or the
normal Coolify application runtime.

Use the selected Supabase project's **Connect → Session pooler** connection
string (normally port 5432). Replace the password placeholder privately, encoding
special password characters correctly as required for a connection URL.
Do not paste the connection string into chat.

### TLS trust

Keep certificate and hostname verification enabled. If the client reports
`SELF_SIGNED_CERT_IN_CHAIN`, download the project's public CA certificate from
Supabase Dashboard → Database Settings → SSL Configuration. Supply that
certificate explicitly to the migration client while retaining verification.
Do not use `rejectUnauthorized: false` or trust a certificate obtained from an
unverified connection. A TLS failure occurs before schema checks; do not describe
it as a failed database password or a failed migration.

Only the public CA certificate is required—never a private key.
Reference: https://supabase.com/docs/guides/platform/ssl-enforcement

## Execution gates

1. Verify the supplied connection targets the selected project; no fallback to
   the workspace's scaffold database.
2. Read-only preflight: platform schemas, application-table presence, migration
   history, extensions/namespaces and relevant privileges.
3. Stop if unexpected application data/schema is present.
4. Prepare a reviewed install path excluding legacy outbound jobs and identity
   promotion, preserving required schema changes and migration history.
5. Apply only the reviewed setup under the user's authorized configuration work,
   with explicit failure reporting and no blind replay of completed migrations.
6. Verify tables/RLS/grants and provision private storage. Actual runtime
   authorization/file-path tests are still required separately; do not infer
   runtime correctness from SQL success.
7. Configure server-only application credentials afterward. Remove the temporary
   migration credential from workspace secrets when migration work is finished.

The reviewed database installation is complete as reported above. These gates
do not constitute application activation or a client-runtime readiness claim.
