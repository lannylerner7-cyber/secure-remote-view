# Managed Supabase release alignment

## Decision

Read-only live verification on 2026-10-22 confirms **all 33 expected public tables exist**, with the installed schema matching the reviewed 64-migration provenance. No missing device/session columns or missing authorization routines were found.

The generated TypeScript schema has now been aligned with live metadata: added `device_authorizations` and `payment_quote_reservations` with Row/Insert/Update types and the two missing public FK relationships. Existing definitions were preserved. `device_authorizations.owner_id` also has a validated FK to `auth.users`; like existing auth references, it is intentionally not a public-schema PostgREST relationship in the generated types. `payment_quote_reservations.order_id` is a primary key, **not** a foreign key; none was invented.

**One known alignment gap remains:** the console subscribes to `audit_logs`, but that table is not in `supabase_realtime`. This does not stop audit display: `console.tsx` already runs `setInterval(refresh, 5000)`, and `refresh()` fetches the newest 50 audit entries. Initial load and device/session events also refresh them. The missing publication entry prevents immediate audit-only notifications; polling is a five-second fallback, not realtime delivery.

**Deployment action:** decide whether five-second audit polling is acceptable. If immediate delivery is required, separately authorize/review a new incremental migration adding `public.audit_logs` to the existing realtime publication, then verify the subscription with authenticated clients. No publication change was made in this audit. Do not replay the fresh installer: all 64 migrations are already installed. A later approved schema change will also need intentional provenance/fingerprint handling; do not overwrite the recorded checksum merely to silence drift detection.

This is a schema/static-contract assessment, **not** an end-to-end incoming/outgoing-device certification. Pushing source does not migrate this external database.

## Reproduce safely

From the repository root:

```sh
node --check scripts/verify-supabase-alignment.cjs
node scripts/verify-supabase-alignment.cjs --source-only
node scripts/verify-supabase-alignment.cjs --live
```

The default is source-only and makes no network request. Live mode requires the already-injected `SUPABASE_MIGRATION_DATABASE_URL`, the pinned trusted public CA referenced by `scripts/supabase-fresh-install.cjs`, and the workspace's existing `pg`/TypeScript dependencies. Do not paste credentials into a command or document.

The verifier imports only the installer's reviewed parsing/TLS helpers. It never invokes its CLI, installer, preflight/data-fingerprint, apply, or provisioning functions. Target validation pins the external Supabase project, database and session port; TLS verifies both CA and hostname. TLS bypass is rejected.

Every live audit uses an explicit `BEGIN READ ONLY` and `ROLLBACK`, including rollback/connection cleanup on failure. Queries inspect catalogs, migration provenance and the `session-files` bucket configuration only. No application/auth rows, credentials, user identities or raw driver errors are printed. No database, grant, auth, storage-object or publication mutations are attempted.

Exit codes: `0` all checks pass; `2` completed metadata audit with reported gaps; `1` safe validation/query failure with details suppressed. The current live result is intentionally **exit 2**, solely for the publication gap.

Validation performed: verifier syntax check passed; source-only mode passed with 33 typed tables; standalone strict TypeScript checking of the generated types passed with zero errors; final live mode completed with only the known publication gap.

## Verified results after the type correction

| Check | Result |
| --- | --- |
| Exact public-table inventory | PASS — 33/33 |
| Public-table RLS enabled | PASS — 33/33 |
| Live columns vs generated Row types, nullability and Insert optionality | PASS — 303 columns across 33 typed tables |
| Literal web/native source columns | PASS — 236 distinct references; includes seven native REST selector occurrences |
| Literal application table references / RPC names | PASS — 31 tables / seven RPC names |
| Public enum names, order and labels | PASS — one enum (`app_role`), five labels |
| Validated foreign keys | PASS — 33, including auth-schema references |
| Generated public FK names, columns, referenced columns and cardinality | PASS — 22/22 public relationships |
| Authorization/binding routine execution permissions and security configuration | PASS — seven routines |
| Restrictive live-channel/storage authorization policies | PASS — seven required policies; 63 public/storage policies in total |
| Server-only relations have no client RLS policies | PASS — six relations |
| `device_authorizations` denies client CRUD grants | PASS |
| Service-role CRUD grants | PASS — 33/33 tables |
| Enabled session/device lifecycle and channel guards | PASS — nine required trigger bindings |
| Relevant device/session request indexes | PASS — 15 required indexes present, ready and valid; 100 public indexes total |
| Private `session-files` bucket | PASS — one private bucket, 524,288,000-byte file limit, unrestricted MIME list |
| Installed reviewed migration history / standard history | PASS — 64/64 entries match reviewed source and applied checksums/statements |
| Complete installed catalog fingerprint | PASS — exact match to the final recorded catalog checksum |
| Required realtime tables | GAP — seven published, eight required; only `audit_logs` missing |

The catalog fingerprint covers public relations, column definitions/defaults/ACLs, constraints, indexes, routine definitions/ACLs/owners, policies, triggers, enums and public publication membership. Exact matching proves no detected drift from the installed reviewed schema, not correctness of every historical policy or client operation.

### Table inventory

`admin_settings`, `admin_wallets`, `audit_logs`, `contact_messages`, `cron_tokens`, `device_authorizations`, `devices`, `expected_devices`, `license_lookups`, `licenses`, `login_attempts`, `newsletter_subscribers`, `notifications`, `order_emails`, `orders`, `payment_events`, `payment_quote_reservations`, `plans`, `portal_settings`, `power_commands`, `profiles`, `releases`, `session_cursors`, `session_files`, `session_frames`, `session_inputs`, `session_secrets`, `session_signals`, `session_telemetry`, `sessions`, `smtp_settings`, `support_bookings`, `user_roles`.

### Incoming/outgoing authority contract

- Enrollment/presence uses `devices`, `licenses` and `expected_devices`; presence and cached `is_session_active` are not authorization.
- Recorded endpoint consent uses `device_authorizations` plus session `authorization_id`, `authorization_mode` and `consent_at`. The native agent sends the grant identifier and notice version to the consent route; that route binds them through the service role.
- `session_authorized(uuid,text)` requires an active session, valid unrevoked device grant, matching owner/mode, explicit view consent and capability, and an authorized caller. It is SECURITY DEFINER with a pinned public search path; anon cannot execute it.
- `device_authorization`, `record_device_authorization` and `revoke_device_authorization` are service-only. `bind_admin` is authenticated-client callable, not anonymous or service-role callable.
- Frames, cursors, signals, inputs, file manifests and session secrets have the installed channel-write trigger; restrictive policies protect client-accessible live channels. Native signal routing fields and selected REST columns exist.
- Private file transfer goes through request-authorized server/device proxies. Restrictive storage policies deny direct authenticated and anonymous access to this bucket; a private bucket alone is not the entire access-control model. The installed file trigger also enforces the 500 MiB per-file / 5 GiB per-session contract.

## Warnings and verification limits

- Four historical server-only tables (`cron_tokens`, `session_secrets`, `smtp_settings`, `login_attempts`) retain client table-level privileges; enabled RLS and the absence of client policies deny access. `device_authorizations` and payment reservations have separately restricted grants. No grants were changed.
- The literal extractor is deliberately bounded: it checks simple source selectors, filters and object-literal writes, plus native REST selectors/RPC paths. Computed table/column names, spread objects, all JSON DTO mappings and full SQL/TypeScript type equivalence are not proven. The verifier compares broad generated scalar types, nullability and insert defaults; exact SQL definitions are covered by the installed fingerprint.
- Native/admin and web lifecycle behavior needs separate acceptance tests. In particular, native `ResumeSessionAsync` and web `requestReconnect` PATCH an existing session to `active`, while `guard_client_session_transitions` rejects non-service transitions into `active` from another state. Requests against already-active sessions are different from reviving paused/ended sessions. Likewise, native session reuse cannot change technician identity or escalate view to control under the installed guards. These are intentional authority boundaries, not missing-table defects; this audit did not modify or runtime-test those callers.
- No JWT/RLS policy execution, live capture, enrollment, attended/unattended consent, revocation race, technician pairing, incoming/outgoing network transport, storage transfer, query-plan/load test, native build or signed-in UI was exercised. Index existence is not a performance guarantee.
- No installer rerun, auth bootstrap, application activation, scheduled task, Git operation or live mutation was performed.
