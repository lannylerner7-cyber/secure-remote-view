#!/usr/bin/env node
// Explicit additive upgrade; never invoked automatically by app startup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { statements, connectionOptions } = require('./supabase-fresh-install.cjs');
const root = path.resolve(__dirname, '..');
const file = '20261103003000_agent_lifecycle.sql';
const source = fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = value => value.replace(/--[^\n]*/g, '').trim();
const parts = statements(source);
if (!/^BEGIN;$/i.test(plain(parts[0])) || !/^COMMIT;$/i.test(plain(parts.at(-1))) ||
    parts.slice(1, -1).some(sql => /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i.test(plain(sql))))
  throw new Error('Unexpected lifecycle transaction boundaries.');
async function apply(client, mode, verify) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connectlive-agent-lifecycle-upgrade'))");
    const existing = await client.query('SELECT statements FROM supabase_migrations.schema_migrations WHERE version=$1', [file.slice(0, 14)]);
    if (existing.rows.length) {
      if (digest((existing.rows[0].statements || []).join('\n')) !== digest(source))
        throw new Error('Recorded lifecycle migration differs from reviewed source.');
    } else {
      for (const sql of parts.slice(1, -1)) await client.query(sql);
      await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ($1,$2,$3)',
        [file.slice(0, 14), file.slice(15, -4), [source]]);
    }
    const result = await client.query(`SELECT
      to_regclass('public.agent_runtime') IS NOT NULL AS runtime,
      to_regclass('public.agent_lifecycle_commands') IS NOT NULL AS commands`);
    if (!Object.values(result.rows[0]).every(Boolean)) throw new Error('Lifecycle schema is incomplete.');
    if (verify) await verify(client);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query(mode === '--apply' ? 'COMMIT' : 'ROLLBACK');
    return { migration: file, schema: result.rows[0], committed: mode === '--apply' };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
async function main() {
  const mode = process.argv[2] || '--dry-run';
  if (!['--dry-run', '--check', '--apply'].includes(mode)) throw new Error('Unsupported migration mode.');
  if (mode === '--dry-run') { console.log(JSON.stringify({ file, sha256: digest(source), network: false })); return; }
  const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');
  const client = new Client(connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL));
  try {
    await client.connect();
    console.log(JSON.stringify(await apply(client, mode,
      mode === '--check' ? require('../tests/agent-lifecycle-database.cjs').verify : undefined)));
  } finally { await client.end().catch(() => {}); }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ error: 'Lifecycle upgrade stopped; transaction rolled back.',
    code: error.code || 'validation_failed', check: error.code === 'ERR_ASSERTION' ? error.message : undefined }));
  process.exitCode = 1;
});
module.exports = { apply };
