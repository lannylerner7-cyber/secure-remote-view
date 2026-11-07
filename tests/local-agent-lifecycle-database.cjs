#!/usr/bin/env node
// Disposable Unix-socket PostgreSQL only. Never reads a deployed database URL.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { Client } = createRequire(path.resolve('lib/db/package.json'))('pg');
const { buildPlan } = require('../scripts/supabase-fresh-install.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connectlive-lifecycle-pg-'));
const data = path.join(directory, 'data');
const port = 55439;
const command = (exe, args) => execFileSync(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let started = false, client;
async function main() {
  command('initdb', ['-D', data, '-U', 'lifecycle_test', '--auth=trust', '--no-locale', '-E', 'UTF8']);
  command('pg_ctl', ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o',
    `-k ${directory} -p ${port} -c listen_addresses='' -c wal_level=logical -c shared_buffers=32MB`, '-w', 'start']);
  started = true;
  client = new Client({ host: directory, port, user: 'lifecycle_test', database: 'postgres' });
  await client.connect();
  await client.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA storage; CREATE SCHEMA supabase_migrations;
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}',
      raw_app_meta_data jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT COALESCE(nullif(current_setting('request.jwt.claim.sub',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(nullif(current_setting('request.jwt.claim.role',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role') $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean DEFAULT false,
      file_size_limit bigint,allowed_mime_types text[],created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),
      name text,owner uuid,owner_id text,metadata jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
      SELECT (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
    GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role;
    CREATE PUBLICATION supabase_realtime;
    SET search_path=public,extensions;
  `);
  for (const migration of buildPlan()) {
    try { await client.query(migration.sql); }
    catch (error) { error.phase = migration.file; throw error; }
  }
  console.log('Loaded the frozen reviewed 64-migration baseline into disposable PostgreSQL.');
  for (const file of [
    '20261022001000_allow_recorded_control_transition.sql',
    '20261022002000_reconcile_recorded_control_guard.sql',
  ]) await client.query(fs.readFileSync(path.join('supabase/migrations', file), 'utf8'));
  for (const migration of require('../scripts/apply-browser-first-migrations.cjs').plan()) {
    try { await client.query(migration.source); }
    catch (error) { error.phase = migration.file; throw error; }
  }
  // Real runner, rollback-only: assert its DDL and history also roll back.
  const { apply } = require('../scripts/apply-agent-lifecycle.cjs');
  if (process.argv.includes('--windows-unlock')) {
    // This client only points at the disposable Unix-socket instance above.
    await apply(client, '--apply');
    await require('../scripts/apply-windows-unlock.cjs').apply(client, '--check',
      require('./windows-unlock-database.cjs').verify);
    const absent = (await client.query("SELECT to_regclass('public.device_unlock_permissions') IS NULL AS absent")).rows[0].absent;
    if (!absent) throw new Error('Windows unlock verification did not roll back.');
    console.log('Windows unlock DDL, synthetic records and migration history rolled back. No remote database accessed.');
    return;
  }
  await apply(client, '--check', async connection => {
    await require('./browser-first-database.cjs').verify(connection);
    await require('./agent-lifecycle-database.cjs').verify(connection);
  });
  const rolledBack = (await client.query("SELECT to_regclass('public.agent_runtime') IS NULL AS absent")).rows[0].absent;
  if (!rolledBack) throw new Error('Rollback-only verification left lifecycle tables behind.');
  console.log('Lifecycle migration, synthetic records and migration history rolled back. No remote database accessed.');
}
main().catch(error => {
  console.error({ error: error.message, code: error.code, phase: error.phase });
  process.exitCode = 1;
}).finally(async () => {
  if (client) await client.end().catch(() => {});
  if (started) { try { command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); } catch { return; } }
  fs.rmSync(directory, { recursive: true, force: true });
});
