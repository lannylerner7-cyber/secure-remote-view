# Database, cache and deployment readiness

## Applied to managed Supabase — 2026-11-03

Target: the existing `esjlqcfcwewymmeghbvj` project, using its approved session
pooler on port 5432 with verified TLS 1.3. This is not the Replit scaffold DB.

The live inspection found **69 migrations already installed**, including the
pairing and browser-video migrations. Only these three pending migrations were
committed, together in one transaction:

- `20261103002000_signed_agent_update_channel.sql`
- `20261103003000_agent_lifecycle.sql`
- `20261103004000_release_database_hardening.sql`

The last migration adds the missing audit/runtime realtime publications and
removes historical client privileges from four server-only tables. It does not
delete application data. All existing baseline records remain unchanged.

| Verification | Actual result |
| --- | --- |
| Public tables and row-level security | 37/37; no missing or unexpected tables |
| Generated columns, nullability and insert defaults | 347 aligned |
| Literal web/native columns and RPCs | 239 columns; 16 RPC names present |
| Foreign keys | 40 validated; all 27 public relationships typed |
| Required request indexes | 19 present, ready and valid; 109 total |
| Realtime publication coverage | 10/10 required tables |
| Server-only tables | 8 deny client CRUD/TRUNCATE and have no client RLS policies |
| Agent lifecycle write RPCs | Service-only |
| Migration history | 64 immutable baseline entries + 8 reviewed additions = 72 |
| Rollback-only behavioral checks | 21 pairing/video + 26 lifecycle checks passed |
| Post-commit catalog | Matches the catalog tested before commit |
| PostgREST schema cache | All 37 tables accepted all expected columns with `limit=0` |
| Anonymous private-table API access | All 8 rejected with PostgreSQL permission-denied code |

The schema-cache check requested **zero rows** and used at most four simultaneous
requests. Its 172–1,307 ms round trips are workspace-to-Supabase metadata-request
measurements, not Agent latency, throughput or a load test.

The old baseline fingerprint was **not overwritten**. Additive migrations
legitimately change the catalog. The release evidence records separate before
and after fingerprints; these are comparison points, not a proof that every
historical function is free from defects.

## Recovery and repeatable checks

An encrypted, consistent logical snapshot was taken before any committed change.
It includes `public`, `auth`, `storage`, `supabase_migrations` and
`connectlive_install`. Authenticated decryption and a complete `pg_restore`
archive parse passed without writing plaintext or connecting to a restore DB.

The archive and manifest are under the private, ignored
`generated-artifacts/database-recovery/` directory. **Do not publish them.**
Encryption uses AES-256-GCM with a uniquely salted, domain-separated HKDF of
`SESSION_SECRET_KEY`. Retain the matching secret until the archive is retired
or re-encrypted. This snapshot does not contain object-storage file bytes,
platform roles or provider configuration. A full restore drill and independent
provider/off-host backup are still required for disaster-recovery certification.

Workspace commands:

```sh
node scripts/verify-supabase-alignment.cjs --live
node tests/database-source-contracts.cjs
node tests/runtime-cache.cjs
```

For a later approved release, `scripts/apply-database-release.cjs --check`
executes pending DDL and synthetic checks but rolls everything back. Its
`--apply <recovery-manifest>` mode requires a matching recent successful check,
an authenticated recovery archive, unchanged source/history and an unchanged
pre-migration catalog. Do not rerun the legacy fresh installer.

Operational helpers use the configured workspace's `pg`/TypeScript installation,
injected migration credential and pinned uploaded public CA. They are **not**
Coolify startup hooks or standalone migration commands for an unconfigured clone.
Migration credentials never belong in browser build arguments.

## Database capacity snapshot — not a load certification

- Database size approximately 17.4 MB; `max_connections=60`.
- 14 total server connections, one active, no idle-in-transaction connections,
  no currently blocked sessions and no invalid public indexes at inspection.
- Buffer hit ratio rounded to 100.00% over the available cumulative statistics.
  This does not measure current response times or prove cache capacity.
- Autovacuum and statistics tracking are enabled.
- **26 historical deadlocks** and two temporary-file events (about 16.7 MB)
  have accumulated since the statistics reset on 2026-10-02. The counters do
  not identify timing or cause. Supabase logs/query telemetry must be correlated
  before claiming the workload is deadlock-free.
- `pg_cron`/`pg_net` are absent. There is a protected order-reconciliation
  HTTP endpoint, but its external scheduling and retention-job operation were
  not verifiable from this workspace. No cleanup deletes or cron jobs were run.

## Cache corrections in source

- Public pricing now has a 60-second fresh TTL, five-minute maximum stale age,
  one in-flight provider refresh per process and a ten-second outage backoff.
  An exhausted stale cache raises an explicit error rather than quoting old
  prices indefinitely. Stablecoin $1 fallback behavior is unchanged.
- API, server-function, authenticated and operational responses explicitly
  prohibit browser/CDN caching. SSE remains unbuffered with `no-transform`;
  public assets retain their existing caching.
- 21 isolated checks cover concurrent refreshes, stale expiry, failure backoff,
  recovery, independent worker caches, private headers and streaming bodies.
- TypeScript and the **Node-server** production build pass. The restarted
  preview returned `OK` for `/health`; `/health`, the unauthorized release
  response and the console shell carried the expected no-store headers.
  The public homepage also rendered successfully.
- Restart logs contained aborted requests (`ECONNRESET`) normalized by the
  existing SSR error handler, plus existing deprecation warnings. The later
  HTTP/page checks passed; this is not a claim of error-free logs or a signed-in
  browser/Windows acceptance test.

These web-source corrections require deployment of the updated web build; the
database migration alone does not update Coolify's application containers.

## Load balancing: verified design and remaining evidence

The app uses Supabase HTTPS/PostgREST for ordinary queries, not one direct
PostgreSQL session per Agent. The migration connection uses the session pooler;
that does not establish application/PostgREST pool limits or provider quotas.

Pairing/rate buckets, session authorization, relaunch commands and mail-delivery
claims are database-backed. Every Node process maintains its own realtime
subscription and local SSE listeners; reconnect/fallback reads reconcile durable
state. Public-price caches are intentionally per process, not a shared Redis
cache. All replicas must share the same backend configuration and file-encryption
secret.

The Dockerfile binds `0.0.0.0:$PORT` (default 3000) and has a `/health` liveness
probe. The public Coolify domain returned HTTP 200 on `/health`, and inspected
responses were Cloudflare `DYNAMIC`. This does **not** reveal replica count,
traffic distribution, proxy buffering, failover or database readiness.

Outstanding deployment checks:

1. Inspect actual Coolify service/proxy settings and logs. Verify port 3000,
   healthy replica routing, SSE buffering disabled, timeout/drain behavior,
   WebSocket upgrades, and identical secrets across instances.
2. Run an authorized two-replica test with reconnects and concurrent technicians.
   Measure request rates, p95/p99 latency, DB/pool utilization, failures and
   deadlocks. Do not send uncontrolled load to enrolled production devices.
3. The console currently reloads its roster on each device/session/audit event
   and every five seconds; the device query has no explicit pagination.
   Coalescing and paginated/virtualized fleet views need separate scaling work
   before claiming support for very large fleets.
4. Complete the actual Windows media/Agent acceptance checklist. Schema and
   HTTP checks do not prove glass-to-glass latency, capture, input or recovery.

No Coolify deployment, main-branch merge, real device command, or Windows test
was performed as part of this database release.
