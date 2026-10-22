#!/usr/bin/env node
'use strict';

// Deliberately not part of startup/deploy. Only the reviewed, fresh external
// project is supported; DATABASE_URL and application API keys are never read.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const PROJECT = 'esjlqcfcwewymmeghbvj';
const INSTALLER = 'connectlive-fresh-v1';
const SOURCE_DIGEST = '64db444f491af6f24995c9b2ea9ceb7985d643f6a9d1b935d39b60e1b3045d12';
const CA_DIGEST = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
const PLATFORM_RLS_DIGEST = 'c1178db2729d7016738daa887aac55f8f0d4b3768274b4416815b27ca57d054d';
const CA_PATH = path.join(root, 'attached_assets/0_prod-ca-2021_1792610634463.crt');
const HISTORY = 'connectlive_install.migrations';
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const TABLES = 'admin_settings admin_wallets audit_logs contact_messages cron_tokens device_authorizations devices expected_devices license_lookups licenses login_attempts newsletter_subscribers notifications order_emails orders payment_events payment_quote_reservations plans portal_settings power_commands profiles releases session_cursors session_files session_frames session_inputs session_secrets session_signals session_telemetry sessions smtp_settings support_bookings user_roles'.split(' ');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
class SafeError extends Error {}
function gate(ok, message) { if (!ok) throw new SafeError(message); }
function replaceOnce(sql, regex, replacement) {
  const matches = [...sql.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'))];
  gate(matches.length === 1, 'Reviewed transformation no longer matches exactly once.');
  return sql.replace(regex, replacement);
}

// SQL lexer: semicolons inside function bodies, strings and comments are not
// transaction boundaries. No attempt is made to rewrite arbitrary future SQL.
function statements(sql) {
  const out = [];
  let start = 0, i = 0, quote = null, dollar = null, comment = 0;
  while (i < sql.length) {
    if (comment) {
      if (sql.startsWith('/*', i)) { comment++; i += 2; }
      else if (sql.startsWith('*/', i)) { comment--; i += 2; }
      else i++;
    } else if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length; dollar = null; } else i++;
    } else if (quote) {
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) i += 2; else { quote = null; i++; }
      } else i++;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) { comment = 1; i += 2; }
    else if (sql[i] === "'" || sql[i] === '"') { quote = sql[i++]; }
    else if (sql[i] === '$' && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(sql.slice(i))) {
      dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)[0]; i += dollar.length;
    } else if (sql[i] === ';') { out.push(sql.slice(start, ++i)); start = i; }
    else i++;
  }
  gate(!quote && !dollar && !comment, 'Unterminated SQL lexical construct.');
  if (sql.slice(start).trim()) out.push(sql.slice(start));
  return out.filter(s => uncomment(s).trim().replace(/;$/, '').trim());
}
function uncomment(sql) { return sql.replace(/--[^\n]*(?:\n|$)/g, '\n').trim(); }
function sanitize(file, original) {
  let sql = original;
  const version = file.slice(0, 14);
  if (version === '20260721125713') {
    sql = replaceOnce(sql, /-- Seed profile \+ promote 197200 to super_admin[\s\S]*?(?=-- Auto-create profile)/,
      '-- Legacy identity import and promotion intentionally omitted.\n\n');
  }
  if (version === '20260722191606') {
    sql = replaceOnce(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm;/, 'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;');
    sql = sql.replaceAll('public.gin_trgm_ops', 'extensions.gin_trgm_ops');
    sql = replaceOnce(sql, /-- Schedule via pg_cron if available[\s\S]*?(?=-- Autovacuum)/,
      '-- All scheduled retention work intentionally omitted.\n\n');
  }
  if (version === '20260727115223') {
    sql = replaceOnce(sql, /-- 3\. Schedule the reconcile-orders poller[\s\S]*$/,
      '-- Outbound schedules and cron/net extension installation intentionally omitted.\n');
  }
  if (version === '20260802214826') {
    sql = replaceOnce(sql, /^DO \$\$[\s\S]*?END \$\$;/,
      '-- Retention scheduling intentionally omitted.');
  }
  if (version === '20260803090421') {
    sql = sql.replace('gen_random_bytes(32)', 'extensions.gen_random_bytes(32)');
    sql = replaceOnce(sql, /SELECT cron\.unschedule[\s\S]*$/,
      '-- Outbound unscheduling/scheduling intentionally omitted.\n');
  }
  if (version === '20261002005435') {
    sql = replaceOnce(sql, /SELECT cron\.alter_job[^\n]*/, '-- Retention rescheduling intentionally omitted.');
  }
  let parts = statements(sql);
  const wrapped = version === '20261021003000';
  if (wrapped) {
    gate(/^BEGIN;?$/i.test(uncomment(parts[0])) && /^COMMIT;?$/i.test(uncomment(parts.at(-1))),
      'Expected authorization transaction wrapper changed.');
    parts = parts.slice(1, -1);
  }
  for (const part of parts) {
    gate(!/^(?:BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END|SAVEPOINT|RELEASE)\b/i.test(uncomment(part)),
      'Unexpected source transaction control.');
  }
  sql = parts.join('\n');
  gate(!/\b(?:cron|net)\s*\.|pg_cron|pg_net|https?:\/\/|197200@/i.test(sql),
    'Unsafe outbound/scheduling/legacy identity content survived review.');
  return { sql, parts, wrapped };
}
function buildPlan() {
  const dir = path.join(root, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const sources = files.map(file => ({ file, original: fs.readFileSync(path.join(dir, file), 'utf8') }));
  gate(files.length === 64 && hash(JSON.stringify(sources.map(s => [s.file, hash(s.original)]))) === SOURCE_DIGEST,
    'Source migration inventory/checksum changed; a new review is required.');
  const fileCode = fs.readFileSync(path.join(root, 'src/lib/session-files.server.ts'), 'utf8');
  gate(fileCode.includes('export const MAX_FILE_BYTES = 500 * 1024 * 1024;') &&
    fileCode.includes('export const MAX_SESSION_BYTES = 5 * 1024 * 1024 * 1024;') &&
    fileCode.includes('sessionAuthorized(supabase, sessionId, "files")'),
  'File size/access contract changed; review bucket provisioning first.');
  return sources.map(s => {
    const reviewed = sanitize(s.file, s.original);
    return { file: s.file, version: s.file.slice(0, 14), name: s.file.slice(15, -4),
      source: hash(s.original), checksum: hash(reviewed.sql), ...reviewed };
  });
}
function connectionOptions(raw) {
  gate(typeof raw === 'string' && raw.length > 0, 'Missing injected SUPABASE_MIGRATION_DATABASE_URL.');
  let url;
  try { url = new URL(raw); } catch { throw new SafeError('Invalid migration connection URL.'); }
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const direct = host === `db.${PROJECT}.supabase.co` && user === 'postgres';
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `postgres.${PROJECT}`;
  gate(['postgres:', 'postgresql:'].includes(url.protocol) && (direct || pooler) &&
    (url.port === '' || url.port === '5432') && url.pathname === '/postgres' &&
    !url.search && !url.hash && url.password, 'Migration URL failed strict project/host/session-port/database validation.');
  const ca = fs.readFileSync(CA_PATH);
  gate(hash(ca) === CA_DIGEST, 'Uploaded public CA checksum changed.');
  gate(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'Global TLS verification disablement is forbidden.');
  return { host, port: 5432, user, password: decodeURIComponent(url.password), database: 'postgres',
    ssl: { ca, rejectUnauthorized: true, servername: host, checkServerIdentity: tls.checkServerIdentity },
    connectionTimeoutMillis: 20000, application_name: INSTALLER,
    query_timeout: 120000, statement_timeout: 110000, lock_timeout: 10000 };
}

// Fingerprint definitions and ACLs, not mutable row counts/statistics. A resume
// refuses unrecorded schema/policy/grant drift rather than blindly trusting names.
async function fingerprint(client) {
  const { rows } = await client.query(`
    SELECT kind, name, definition FROM (
      SELECT 'relation' kind, c.relname name,
        jsonb_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl,c.relreplident) definition
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
      UNION ALL SELECT 'column', c.relname||'.'||a.attname,
        jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attacl)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT 'constraint', c.relname||'.'||k.conname, to_jsonb(pg_get_constraintdef(k.oid))
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'index', indexname, to_jsonb(indexdef) FROM pg_indexes WHERE schemaname='public'
      UNION ALL SELECT 'function', p.oid::regprocedure::text, jsonb_build_array(pg_get_functiondef(p.oid),p.proacl,p.proowner)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
      UNION ALL SELECT 'policy', schemaname||'.'||tablename||'.'||policyname, to_jsonb(p)
        FROM pg_policies p WHERE schemaname='public' OR (schemaname='storage' AND tablename='objects')
      UNION ALL SELECT 'trigger', n.nspname||'.'||c.relname||'.'||t.tgname, to_jsonb(pg_get_triggerdef(t.oid))
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND (n.nspname='public' OR (n.nspname='auth' AND c.relname='users'))
      UNION ALL SELECT 'enum', t.typname||'.'||e.enumsortorder, to_jsonb(e.enumlabel)
        FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'publication', pubname||'.'||schemaname||'.'||tablename, to_jsonb(p)
        FROM pg_publication_tables p WHERE schemaname='public'
    ) x ORDER BY kind,name,definition::text`);
  return hash(JSON.stringify(rows));
}
async function dataFingerprint(client) {
  const names = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`)).rows.map(r => r.tablename);
  gate(names.every(name => TABLES.includes(name)), 'Unexpected public table; refusing to inspect application data.');
  const seeds = ['plans', 'smtp_settings', 'cron_tokens'];
  const counts = names.length ? (await client.query(names.map(name =>
    `SELECT '${name}' name,count(*)::int n FROM public.${name}`).join(' UNION ALL ') + ' ORDER BY name')).rows : [];
  gate(counts.every(r => seeds.includes(r.name) || r.n === 0),
    'Unexpected application data; fresh installer will not modify a used database.');
  const seedRows = [];
  for (const name of names.filter(n => seeds.includes(n))) {
    const { rows } = await client.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) data FROM public.${name} t`);
    // Only hashes persist. In particular, cron token material is never logged.
    seedRows.push([name, rows[0].data]);
  }
  return hash(JSON.stringify({ counts, seedRows }));
}
async function platformChecks(client) {
  const { rows: [p] } = await client.query(`SELECT current_database() db, session_user,
    to_regclass('auth.users') IS NOT NULL auth, to_regclass('storage.objects') IS NOT NULL storage,
    EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') realtime,
    (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='storage.objects'::regclass) storage_owner,
    to_regclass('cron.job') IS NULL no_cron_job_table,
    to_regclass('net.http_request_queue') IS NULL no_outbound_queue,
    (SELECT count(*)::int FROM pg_extension WHERE extname IN ('pg_cron','pg_net')) outbound_extensions`);
  gate(p.db === 'postgres' && p.session_user === 'postgres' && p.auth && p.storage && p.realtime,
    'Unexpected platform/database/session identity.');
  gate(p.outbound_extensions === 0 && p.no_cron_job_table && p.no_outbound_queue,
    'Unexpected cron/net extension, scheduler or outbound queue; inspect manually. Nothing was removed.');
  const { rows: extensions } = await client.query(`SELECT e.extname,n.nspname FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname IN ('pgcrypto','pg_trgm') ORDER BY 1`);
  gate(extensions.some(e => e.extname === 'pgcrypto' && e.nspname === 'extensions') &&
    extensions.every(e => e.nspname === 'extensions'), 'Unsupported crypto/trigram extension namespace.');
  gate(['postgres', 'supabase_storage_admin'].includes(p.storage_owner), 'Unexpected storage ownership.');
  const { rows: [r] } = await client.query(`SELECT pg_has_role(current_user,$1,'USAGE') owner_access,
    pg_has_role(current_user,'supabase_privileged_role','USAGE') privileged,
    has_table_privilege(current_user,'storage.buckets','INSERT') bucket_insert`, [p.storage_owner]);
  // Managed Supabase grants postgres policy-DDL via its privileged-role
  // mechanism without membership in supabase_storage_admin. Do not transfer
  // ownership, grant roles, or assume catalog membership proves DDL ability.
  gate(r.bucket_insert && (r.owner_access || r.privileged), 'Unsupported managed storage privileges.');
  p.storage_actor = r.owner_access ? p.storage_owner : 'postgres';
  // Supabase supplied this event trigger in the otherwise-empty public schema.
  // It enables RLS for newly-created public tables; the reviewed definition,
  // owner, grants and event binding are pinned, not silently ignored.
  const functions = (await client.query(`SELECT pg_get_functiondef(p.oid) definition,p.proacl,
    (SELECT rolname FROM pg_roles WHERE oid=p.proowner) owner FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='rls_auto_enable'`)).rows;
  const events = (await client.query(`SELECT evtname,evtevent,evtenabled,evttags FROM pg_event_trigger
    WHERE evtfoid='public.rls_auto_enable()'::regprocedure ORDER BY evtname`)).rows;
  gate(hash(JSON.stringify({ functions, events })) === PLATFORM_RLS_DIGEST, 'Managed baseline RLS trigger changed.');
  return p;
}
async function preflight(client, plan) {
  await client.query('BEGIN READ ONLY');
  try {
    const platform = await platformChecks(client);
    const { rows: tables } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    const { rows: [h] } = await client.query(`SELECT to_regclass('${HISTORY}') IS NOT NULL own,
      to_regclass('supabase_migrations.schema_migrations') IS NOT NULL standard,
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='connectlive_install') own_schema`);
    let completed = [];
    if (h.own) {
      const { rows: marker } = await client.query('SELECT * FROM connectlive_install.identity');
      gate(marker.length === 1 && marker[0].installer === INSTALLER && marker[0].project === PROJECT &&
        marker[0].source_digest === SOURCE_DIGEST, 'Unrecognized installer identity/history.');
      completed = (await client.query(`SELECT * FROM ${HISTORY} ORDER BY version`)).rows;
      gate(h.standard && completed.length <= plan.length, 'Unexpected migration history.');
      const standard = (await client.query('SELECT version,name,statements FROM supabase_migrations.schema_migrations ORDER BY version')).rows;
      gate(standard.length === completed.length, 'Standard and installer history diverged.');
      for (let i = 0; i < completed.length; i++) {
        const row = completed[i], expected = plan[i];
        gate(row.version === expected.version && row.filename === expected.file && row.source_checksum === expected.source &&
          row.applied_checksum === expected.checksum && standard[i].version === row.version &&
          standard[i].name === expected.name && JSON.stringify(standard[i].statements) === JSON.stringify(expected.parts),
        'History is not an exact successful reviewed prefix; refusing replay.');
      }
      const expectedFingerprint = completed.at(-1)?.catalog_checksum || marker[0].initial_catalog_checksum;
      gate(await fingerprint(client) === expectedFingerprint, 'Unrecorded schema/policy/grant drift; refusing resume.');
      const expectedData = completed.at(-1)?.data_checksum || marker[0].initial_data_checksum;
      gate(await dataFingerprint(client) === expectedData, 'Seed data drift; refusing to overwrite existing data.');
      const extra = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='connectlive_install' ORDER BY 1`)).rows;
      gate(JSON.stringify(extra.map(r => r.tablename)) === JSON.stringify(['identity', 'migrations']), 'Unexpected installer schema tables.');
    } else {
      gate(!h.own_schema && tables.length === 0, 'Unexpected public tables or installer schema; fresh installation refused.');
      if (h.standard) {
        const count = (await client.query('SELECT count(*)::int n FROM supabase_migrations.schema_migrations')).rows[0].n;
        gate(count === 0, 'Unexpected existing migration history; installation refused.');
      }
      const { rows: [objects] } = await client.query(`SELECT
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname<>'rls_auto_enable')::int functions,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')::int relations,
        (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')::int types,
        (SELECT count(*) FROM pg_policies WHERE schemaname='storage')::int storage_policies,
        (SELECT count(*) FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal)::int auth_triggers,
        (SELECT count(*) FROM storage.buckets)::int buckets`);
      gate(Object.values(objects).every(n => n === 0), 'Unexpected public objects, auth triggers, storage policies or buckets.');
    }
    // Existing bucket is allowed only after this installer recorded provisioning.
    const bucket = (await client.query(`SELECT id,name,public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='session-files'`)).rows;
    const marker = h.own ? (await client.query('SELECT bucket_ready FROM connectlive_install.identity')).rows[0] : null;
    gate(bucket.length === (marker?.bucket_ready ? 1 : 0), 'Unexpected bucket/provisioning marker mismatch.');
    if (bucket.length) checkBucket(bucket[0]);
    await client.query('ROLLBACK');
    return { platform, completed: completed.length, standardExists: h.standard, own: h.own };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
function checkBucket(b) {
  gate(b.id === 'session-files' && b.name === 'session-files' && b.public === false &&
    Number(b.file_size_limit) === MAX_FILE_BYTES && b.allowed_mime_types === null,
  'Private session-files bucket contract mismatch.');
}
async function transaction(client, work) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path = public, extensions');
    await work();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function asStorageOwner(client, owner, sql) {
  gate(['postgres', 'supabase_storage_admin'].includes(owner), 'Unreviewed storage role.');
  await client.query(`SET LOCAL ROLE ${owner}`);
  await client.query(sql);
  await client.query('RESET ROLE');
}
async function probeStoragePolicyDDL(client, actor) {
  await client.query('BEGIN');
  try {
    await asStorageOwner(client, actor, `CREATE POLICY connectlive_install_capability_probe
      ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated USING(false) WITH CHECK(false)`);
  } finally {
    // This transaction is never committed; no policy or role changes persist.
    await client.query('ROLLBACK');
  }
}
async function initialize(client) {
  await transaction(client, async () => {
    await client.query(`CREATE SCHEMA connectlive_install;
      REVOKE ALL ON SCHEMA connectlive_install FROM PUBLIC,anon,authenticated;
      CREATE TABLE connectlive_install.identity (
        installer text PRIMARY KEY, project text NOT NULL, source_digest text NOT NULL,
        initial_catalog_checksum text NOT NULL, initial_data_checksum text NOT NULL,
        bucket_ready boolean NOT NULL DEFAULT false);
      CREATE TABLE ${HISTORY} (
        version text PRIMARY KEY, filename text NOT NULL, source_checksum text NOT NULL,
        applied_checksum text NOT NULL, catalog_checksum text NOT NULL, data_checksum text NOT NULL,
        committed_at timestamptz NOT NULL DEFAULT now());
      REVOKE ALL ON ALL TABLES IN SCHEMA connectlive_install FROM PUBLIC,anon,authenticated;
      CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
        version text PRIMARY KEY, statements text[], name text);
      REVOKE ALL ON SCHEMA supabase_migrations FROM PUBLIC,anon,authenticated;
      REVOKE ALL ON supabase_migrations.schema_migrations FROM PUBLIC,anon,authenticated;`);
    await client.query('INSERT INTO connectlive_install.identity(installer,project,source_digest,initial_catalog_checksum,initial_data_checksum) VALUES ($1,$2,$3,$4,$5)',
      [INSTALLER, PROJECT, SOURCE_DIGEST, await fingerprint(client), await dataFingerprint(client)]);
  });
}
async function applyMigration(client, migration, owner) {
  await transaction(client, async () => {
    // Source BEGIN/COMMIT were verified and removed: schema + both history
    // records are committed together, even for the source-wrapped final file.
    for (const part of migration.parts) {
      if (/^CREATE POLICY recorded_storage\b/.test(uncomment(part))) await asStorageOwner(client, owner, part);
      else await client.query(part);
    }
    await client.query(`INSERT INTO ${HISTORY}(version,filename,source_checksum,applied_checksum,catalog_checksum,data_checksum) VALUES ($1,$2,$3,$4,$5,$6)`,
      [migration.version, migration.file, migration.source, migration.checksum, await fingerprint(client), await dataFingerprint(client)]);
    await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ($1,$2,$3)',
      [migration.version, migration.name, migration.parts]);
  });
}
async function provisionBucket(client, owner) {
  const { rows: [marker] } = await client.query('SELECT bucket_ready FROM connectlive_install.identity');
  if (marker.bucket_ready) return;
  await transaction(client, async () => {
    // No anonymous policy can ever accidentally make this private bucket
    // directly accessible. Authenticated deny is in the reviewed source.
    await asStorageOwner(client, owner, `CREATE POLICY connectlive_session_files_anon_deny
      ON storage.objects AS RESTRICTIVE FOR ALL TO anon
      USING (bucket_id <> 'session-files') WITH CHECK (bucket_id <> 'session-files')`);
    await asStorageOwner(client, owner, `INSERT INTO storage.buckets(id,name,public,file_size_limit)
      VALUES ('session-files','session-files',false,${MAX_FILE_BYTES})`);
    await client.query('UPDATE connectlive_install.identity SET bucket_ready=true');
    // Provisioning changes storage policy fingerprint after the final migration.
    await client.query(`UPDATE ${HISTORY} SET catalog_checksum=$1 WHERE version=(SELECT max(version) FROM ${HISTORY})`,
      [await fingerprint(client)]);
  });
}
async function verify(client, plan) {
  const state = await preflight(client, plan);
  gate(state.completed === plan.length, 'Installation is an incomplete reviewed prefix.');
  const tables = (await client.query(`SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n
    ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1`)).rows;
  gate(JSON.stringify(tables.map(t => t.relname)) === JSON.stringify(TABLES) && tables.every(t => t.relrowsecurity),
    'Application table inventory/RLS mismatch.');
  const policies = (await client.query(`SELECT schemaname,tablename,policyname,permissive,roles,qual,with_check
    FROM pg_policies WHERE schemaname IN ('public','storage') ORDER BY schemaname,tablename,policyname`)).rows;
  for (const [table, policy] of [['session_frames','recorded_frames'], ['session_cursors','recorded_cursors'],
    ['session_signals','recorded_signals'], ['session_inputs','recorded_inputs'], ['session_files','recorded_files'],
    ['objects','recorded_storage'], ['objects','connectlive_session_files_anon_deny']]) {
    gate(policies.some(p => p.tablename === table && p.policyname === policy && p.permissive === 'RESTRICTIVE'),
      'Required restrictive authorization/storage policy missing.');
  }
  const checks = (await client.query(`SELECT
    has_function_privilege('authenticated','public.bind_admin(uuid,text)','EXECUTE') bind_authenticated,
    NOT has_function_privilege('service_role','public.bind_admin(uuid,text)','EXECUTE') bind_service_denied,
    NOT has_function_privilege('anon','public.session_authorized(uuid,text)','EXECUTE') anon_denied,
    has_function_privilege('authenticated','public.session_authorized(uuid,text)','EXECUTE') auth_allowed,
    has_function_privilege('service_role','public.record_device_authorization(uuid,jsonb)','EXECUTE') service_record,
    NOT has_function_privilege('authenticated','public.record_device_authorization(uuid,jsonb)','EXECUTE') auth_record_denied,
    NOT has_function_privilege('anon','public.create_unique_payment_order(jsonb,numeric)','EXECUTE') quote_anon_denied,
    NOT has_table_privilege('authenticated','public.device_authorizations','SELECT') authorization_private,
    (SELECT count(*)=0 FROM public.user_roles) no_admin,
    (SELECT count(*)=0 FROM public.device_authorizations) no_authorizations,
    (SELECT count(*)=0 FROM public.sessions) no_sessions,
    (SELECT enabled=false FROM public.smtp_settings WHERE id=true) smtp_disabled,
    (SELECT count(*)=0 FROM public.devices) no_devices,
    (SELECT pg_get_expr(d.adbin,d.adrelid)='false' FROM pg_attrdef d JOIN pg_attribute a
      ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE d.adrelid='public.devices'::regclass AND a.attname='standing_consent') standing_consent_disabled
  `)).rows[0];
  gate(Object.values(checks).every(Boolean), 'Authorization/grant or inactive-install verification failed.');
  for (const table of TABLES) {
    gate((await client.query(`SELECT bool_and(has_table_privilege('service_role',$1,privilege)) ok
      FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) privilege`,
      [`public.${table}`])).rows[0].ok, 'Missing required service-role table grants.');
  }
  for (const table of ['cron_tokens', 'session_secrets', 'smtp_settings', 'login_attempts', 'payment_quote_reservations', 'device_authorizations']) {
    gate(!policies.some(p => p.tablename === table && (p.roles.includes('authenticated') || p.roles.includes('public') || p.roles.includes('anon'))),
      'Unexpected client policy on server-only table.');
  }
  const bucket = (await client.query(`SELECT id,name,public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='session-files'`)).rows;
  gate(bucket.length === 1, 'Private bucket not provisioned.'); checkBucket(bucket[0]);
  const triggers = (await client.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND
    tgname IN ('guard_recorded_session_authority','guard_client_session_transitions','guard_device_credentials') ORDER BY 1`)).rows;
  gate(triggers.length === 3, 'Required lifecycle guards missing.');
  console.log(JSON.stringify({ project: PROJECT, migrations: state.completed, tables: tables.length,
    rlsTables: tables.filter(t => t.relrowsecurity).length, policies: policies.length,
    lifecycleGuards: triggers.length, criticalGrantChecks: Object.keys(checks).length,
    bucket: 'private session-files', fileSizeLimit: MAX_FILE_BYTES, cronNetExtensions: 0,
    scheduledOutboundJobs: 0, cronJobTable: 'absent', outboundQueue: 'absent', runtimeTested: false }));
}
async function selfTest() {
  const plan = buildPlan();
  assert.equal(plan.length, 64);
  assert.equal(plan.filter(p => p.wrapped).length, 1);
  assert.equal(statements("DO $$ BEGIN PERFORM ';'; END $$; SELECT 'a;''b'; -- tail").length, 2);
  assert.equal(statements('SELECT 1 /* nested /* ; */ ; */; SELECT "semi;colon";').length, 2);
  assert.throws(() => statements('SELECT $$unclosed'), SafeError);
  assert.throws(() => connectionOptions('postgres://postgres:x@evil.example/postgres'), SafeError);
  assert.throws(() => connectionOptions(`postgres://postgres.other:x@aws-0-us-east-1.pooler.supabase.com/postgres`), SafeError);
  assert.throws(() => connectionOptions(`postgres://postgres:x@db.${PROJECT}.supabase.co/postgres?sslmode=disable`), SafeError);
  assert.throws(() => sanitize('future.sql', 'BEGIN; SELECT 1; COMMIT;'), SafeError);
  assert.throws(() => sanitize('future.sql', 'SELECT cron.schedule();'), SafeError);
  const options = connectionOptions(`postgres://postgres:x@db.${PROJECT}.supabase.co/postgres`);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.checkServerIdentity, tls.checkServerIdentity);
  const calls = [];
  const fake = { query: async (sql) => { calls.push(sql); if (sql === 'FAIL') throw new Error('private'); return { rows: [] }; } };
  await assert.rejects(transaction(fake, () => fake.query('FAIL')));
  assert.deepEqual(calls, ['BEGIN', 'SET LOCAL search_path = public, extensions', 'FAIL', 'ROLLBACK']);
  calls.length = 0;
  await transaction(fake, () => fake.query('OK'));
  assert.deepEqual(calls, ['BEGIN', 'SET LOCAL search_path = public, extensions', 'OK', 'COMMIT']);
  calls.length = 0;
  await applyMigration(fake, plan.at(-1), 'postgres');
  assert.equal(calls.filter(sql => sql === 'BEGIN').length, 1);
  assert.equal(calls.filter(sql => sql === 'COMMIT').length, 1);
  assert.equal(calls.filter(sql => sql.includes(`INSERT INTO ${HISTORY}`)).length, 1);
  assert.equal(calls.filter(sql => sql.includes('INSERT INTO supabase_migrations.schema_migrations')).length, 1);
  assert.ok(calls.indexOf('RESET ROLE') < calls.findIndex(sql => sql.includes(`INSERT INTO ${HISTORY}`)));
  const broken = { query: async sql => {
    calls.push(sql);
    if (sql.includes('INSERT INTO supabase_migrations.schema_migrations')) throw new Error('private');
    return { rows: [] };
  } };
  calls.length = 0;
  await assert.rejects(applyMigration(broken, plan[0], 'postgres'));
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.includes('COMMIT'));
  assert.equal(plan.find(p => p.version === '20260721125640').parts.length, 2);
  assert.ok(plan.findIndex(p => p.version === '20260721125640') < plan.findIndex(p => p.version === '20260721125713'));
  console.log('PASS: reviewed 64-source digest, sanitization, SQL lexer/wrapper, TLS/target rejection, enum order, per-file atomic history, commit/rollback tests.');
}
async function main() {
  const mode = process.argv[2] || '--dry-run';
  gate(process.argv.length <= 3 && ['--dry-run', '--self-test', '--preflight', '--apply', '--verify'].includes(mode),
    'Use --dry-run, --self-test, --preflight, --apply or --verify.');
  if (mode === '--self-test') return selfTest();
  const plan = buildPlan();
  if (mode === '--dry-run') {
    console.log(JSON.stringify({ project: PROJECT, sourceDigest: SOURCE_DIGEST, migrations: plan.map(p =>
      ({ file: p.file, sourceChecksum: p.source, appliedChecksum: p.checksum, sourceWrapped: p.wrapped })),
    apply: false, network: false, perFileTransactions: true, schedulesEnabled: false }, null, 2));
    return;
  }
  const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');
  const client = new Client(connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL));
  let stage = 'TLS connection';
  client.on('error', () => {}); // Never emit unsanitized driver/credential errors.
  try {
    await client.connect();
    stage = 'exclusive installer lock';
    const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock(hashtextextended('connectlive-fresh-install',0)) locked");
    gate(lock.locked, 'Another installer holds the exclusive lock.');
    stage = 'read-only preflight';
    const state = await preflight(client, plan);
    console.log(JSON.stringify({ project: PROJECT, preflight: 'passed', completed: state.completed,
      remaining: plan.length - state.completed, mode }));
    if (mode === '--preflight') return;
    if (mode === '--apply') {
      stage = 'rollback-only managed storage policy privilege probe';
      await probeStoragePolicyDDL(client, state.platform.storage_actor);
      if (!state.own) { stage = 'installer history initialization'; await initialize(client); }
      for (const migration of plan.slice(state.completed)) {
        stage = `migration ${migration.version}`;
        await applyMigration(client, migration, state.platform.storage_actor);
        console.log(`Committed reviewed migration ${migration.version}.`);
      }
      stage = 'private bucket provisioning';
      await provisionBucket(client, state.platform.storage_actor);
    }
    stage = 'post-install verification';
    await verify(client, plan);
  } catch (error) {
    const code = /^[A-Z0-9_]{2,40}$/.test(error.code || '') ? ` [${error.code}]` : '';
    if (error instanceof SafeError) throw error;
    throw new SafeError(`Stopped at ${stage}${code}. Driver details suppressed; successful per-file commits remain resumable.`);
  } finally { await client.end().catch(() => {}); }
}
if (require.main === module) main().catch(error => {
  console.error(error instanceof SafeError ? error.message : 'Installer stopped; internal details suppressed.');
  process.exitCode = 1;
});
module.exports = { buildPlan, sanitize, statements, connectionOptions, transaction, applyMigration };
