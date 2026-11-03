#!/usr/bin/env node
// Explicit, additive external-Supabase upgrade. Never invoked by app startup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { connectionOptions, statements } = require('./supabase-fresh-install.cjs');
const root = path.resolve(__dirname, '..');
const files = [
  '20261103000000_disclosed_device_pairing.sql',
  '20261103001000_browser_video_sessions.sql',
];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function plan() {
  return files.map(file => {
    const source = fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8');
    const parts = statements(source);
    const plain = sql => sql.replace(/--[^\n]*/g, '').trim();
    if (!/^BEGIN;$/i.test(plain(parts[0])) || !/^COMMIT;$/i.test(plain(parts.at(-1))))
      throw new Error('Upgrade transaction wrapper changed.');
    const body = parts.slice(1, -1);
    if (body.some(sql => /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i.test(plain(sql))))
      throw new Error('Unexpected transaction boundary.');
    return { file, version: file.slice(0, 14), source, digest: hash(source), body };
  });
}
async function apply(client, mode, verify) {
  const migrations = plan();
  // One transaction covers both migrations, their history and schema reload.
  // --check executes the same DDL but always rolls it back.
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connectlive-browser-first-upgrade'))");
    for (const item of migrations) {
      const { rows } = await client.query(
        'SELECT statements FROM supabase_migrations.schema_migrations WHERE version=$1', [item.version]);
      if (rows.length) {
        if (hash((rows[0].statements || []).join('\n')) !== item.digest)
          throw new Error('Recorded migration differs from reviewed source.');
        continue;
      }
      for (const sql of item.body) await client.query(sql);
      await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ($1,$2,$3)',
        [item.version, item.file.slice(15, -4), [item.source]]);
    }
    const { rows } = await client.query(`SELECT
      to_regclass('public.device_pairings') IS NOT NULL AS pairings,
      to_regclass('public.pairing_attempts') IS NOT NULL AS rate_limits,
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sessions' AND column_name='media_mode') AS video_mode`);
    if (!Object.values(rows[0]).every(value => value === true)) throw new Error('Upgrade schema verification failed.');
    if (verify) await verify(client);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query(mode === '--apply' ? 'COMMIT' : 'ROLLBACK');
    return { project: 'esjlqcfcwewymmeghbvj', mode, verified: rows[0], committed: mode === '--apply' };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
async function main() {
  const mode = process.argv[2] || '--dry-run';
  if (!['--dry-run', '--check', '--apply'].includes(mode)) throw new Error('Unsupported upgrade mode.');
  if (mode === '--dry-run') {
    console.log(JSON.stringify({ project: 'esjlqcfcwewymmeghbvj', migrations: plan().map(({ file, digest }) => ({ file, digest })), network: false }));
    return;
  }
  // The shared helper enforces this exact project, session port, verified CA
  // and TLS hostname. It never prints the injected connection URL.
  const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');
  const client = new Client(connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL));
  try {
    await client.connect();
    const verify = mode === '--check' ? require('../tests/browser-first-database.cjs').verify : undefined;
    console.log(JSON.stringify(await apply(client, mode, verify)));
  }
  finally { await client.end().catch(() => {}); }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ error: 'Browser-first upgrade stopped; transaction rolled back.',
    code: error.code || 'validation_failed', check: error.code === 'ERR_ASSERTION' ? error.message : undefined,
    query: error.testQuery }));
  process.exitCode = 1;
});
module.exports = { plan, apply };
