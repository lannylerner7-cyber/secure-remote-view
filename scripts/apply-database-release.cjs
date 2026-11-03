#!/usr/bin/env node
'use strict';

// Explicit external-Supabase release; never called by build, startup or health.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { buildPlan, connectionOptions } = require('./supabase-fresh-install.cjs');
const { releasePlan, digest } = require('./database-release-plan.cjs');
const { sourceContracts, verify, fingerprint } = require('./verify-supabase-alignment.cjs');
const { verifyArchive } = require('./backup-supabase-release.cjs');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'generated-artifacts/database-release');
const checkFile = path.join(directory, 'rollback-check.json');
const project = 'esjlqcfcwewymmeghbvj';

async function historyCheck(client, baseline, additions) {
  const history = (await client.query('SELECT version,name,statements FROM supabase_migrations.schema_migrations ORDER BY version')).rows;
  const installed = (await client.query('SELECT version,filename,source_checksum,applied_checksum FROM connectlive_install.migrations ORDER BY version')).rows;
  if (installed.length !== baseline.length || !baseline.every((m, i) =>
    installed[i]?.version === m.version && installed[i]?.filename === m.file &&
    installed[i]?.source_checksum === m.source && installed[i]?.applied_checksum === m.checksum &&
    history.some(h => h.version === m.version && h.name === m.name && JSON.stringify(h.statements) === JSON.stringify(m.parts))))
    throw new Error('Baseline provenance mismatch');
  const expected = new Set([...baseline, ...additions].map(m => m.version));
  if (history.some(h => !expected.has(h.version))) throw new Error('Unreviewed database migration');
  for (const m of additions) {
    const existing = history.find(h => h.version === m.version);
    if (existing && (existing.name !== m.name || digest((existing.statements || []).join('\n')) !== m.sha256))
      throw new Error('Additive migration provenance mismatch');
    if (!existing && m.version < '20261103000000') throw new Error('Earlier deployment prerequisites are missing');
  }
  return { history, pending: additions.filter(m => !history.some(h => h.version === m.version)) };
}
async function apply(client, mode, options = {}) {
  const baseline = buildPlan(), additions = releasePlan(), source = sourceContracts();
  const planDigest = digest(JSON.stringify(additions.map(m => [m.file, m.sha256])));
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connectlive-database-release'))");
    const { history, pending } = await historyCheck(client, baseline, additions);
    const beforeFingerprint = await fingerprint(client);
    if (mode === '--apply') {
      const evidence = options.evidence, backup = options.backup;
      if (!evidence || evidence.status !== 'PASS' || evidence.committed !== false ||
        evidence.planDigest !== planDigest || evidence.beforeFingerprint !== beforeFingerprint ||
        Date.now() - Date.parse(evidence.checkedAt) > 86400000)
        throw new Error('A matching recent rollback-only verification is required');
      if (!backup || backup.project !== project || !backup.authenticatedDecryption || !backup.archiveParsed ||
        Date.now() - Date.parse(backup.createdAt) > 86400000 ||
        JSON.stringify(backup.migrations) !== JSON.stringify(history.map(h => h.version)))
        throw new Error('A matching recent verified recovery archive is required');
    }
    for (const migration of pending) {
      for (const sql of migration.body) await client.query(sql);
      await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',
        [migration.version, migration.name, [migration.source]]);
    }
    if (mode === '--check') {
      await client.query('SAVEPOINT release_tests');
      await require('../tests/browser-first-database.cjs').verify(client);
      await require('../tests/agent-lifecycle-database.cjs').verify(client);
      await client.query('ROLLBACK TO SAVEPOINT release_tests');
      await client.query('RELEASE SAVEPOINT release_tests');
    }
    const report = await verify(client, source, baseline);
    if (report.gaps.length) {
      const error = new Error('Release schema verification failed');
      error.report = report;
      throw error;
    }
    if (mode === '--apply' && report.catalogFingerprint !== options.evidence.afterFingerprint)
      throw new Error('Applied catalog differs from rollback-only verification');
    await client.query("NOTIFY pgrst, 'reload schema'");
    const result = {
      project, status: 'PASS', checkedAt: new Date().toISOString(), planDigest,
      committed: mode === '--apply', beforeFingerprint, afterFingerprint: report.catalogFingerprint,
      migrations: pending.map(m => ({ file: m.file, sha256: m.sha256 })),
      report,
    };
    await client.query(mode === '--apply' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
async function main() {
  const mode = process.argv[2] || '--dry-run';
  if (!['--dry-run', '--check', '--apply'].includes(mode)) throw new Error('Unsupported mode');
  if (mode === '--dry-run') {
    console.log(JSON.stringify({ project, network: false,
      migrations: releasePlan().map(({ file, sha256 }) => ({ file, sha256 })) }, null, 2));
    return;
  }
  let evidence, backup;
  if (mode === '--apply') {
    evidence = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
    const manifestPath = path.resolve(process.argv[3] || '');
    if (path.dirname(manifestPath) !== path.join(root, 'generated-artifacts/database-recovery') ||
        !manifestPath.endsWith('.dump.aes.json')) throw new Error('Recovery manifest path rejected');
    backup = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const archive = path.resolve(root, backup.file);
    if (`${archive}.json` !== manifestPath) throw new Error('Recovery file binding mismatch');
    const actual = await verifyArchive(archive);
    if (actual.sha256 !== backup.sha256 || actual.bytes !== backup.bytes) throw new Error('Recovery archive integrity mismatch');
  }
  const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');
  const options = connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL);
  options.application_name = 'connectlive-reviewed-release';
  const client = new Client(options);
  client.on('error', () => {});
  try {
    await client.connect();
    const result = await apply(client, mode, { evidence, backup });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(mode === '--check' ? checkFile : path.join(directory, 'applied-release.json'),
      JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally { await client.end().catch(() => {}); }
}
if (require.main === module) main().catch(error => {
  // Do not print SQL, rows, connection strings or raw PostgreSQL errors.
  console.error(JSON.stringify({
    error: 'Database release stopped; the migration transaction was rolled back if still open.',
    code: error.code || 'validation_failed',
    gaps: error.report?.checks.filter(c => c.status === 'GAP'),
    assertion: error.code === 'ERR_ASSERTION' ? error.message : undefined,
  }, null, 2));
  process.exitCode = 1;
});
module.exports = { apply, historyCheck };
