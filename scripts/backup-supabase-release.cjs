#!/usr/bin/env node
'use strict';

// A private, encrypted logical recovery archive. Never prints database rows,
// credentials, pg_dump stderr, or decrypted SQL. Not an object-file/PITR backup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createRequire } = require('node:module');
const { connectionOptions } = require('./supabase-fresh-install.cjs');
const root = path.resolve(__dirname, '..');
const magic = Buffer.from('CLDB001\n');
const schemas = ['public', 'auth', 'storage', 'supabase_migrations', 'connectlive_install'];
const directory = path.join(root, 'generated-artifacts/database-recovery');
const headerLength = magic.length + 32 + 12;

function keyFor(salt) {
  const secret = process.env.SESSION_SECRET_KEY;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Backup key unavailable');
  // Domain separation: never use the session encryption key directly as an
  // archive key. Preserve this secret until this recovery archive is retired.
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, 'connectlive-db-recovery-v1', 32));
}
function child(executable, args, env) {
  const process = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const done = new Promise((resolve, reject) => {
    process.once('error', () => reject(new Error('PostgreSQL client could not start')));
    process.once('close', code => code === 0 ? resolve() : reject(new Error('PostgreSQL client failed')));
  });
  // Callers still await the original promise; suppress an early unhandled reject.
  done.catch(() => {});
  return { process, done };
}
async function verifyArchive(file) {
  const size = fs.statSync(file).size;
  if (size <= headerLength + 16) throw new Error('Incomplete archive');
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(headerLength), tag = Buffer.alloc(16);
  try {
    fs.readSync(fd, header, 0, header.length, 0);
    fs.readSync(fd, tag, 0, tag.length, size - 16);
  } finally { fs.closeSync(fd); }
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Archive format mismatch');
  const key = keyFor(header.subarray(magic.length, magic.length + 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(-12));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  // Parse every archive section without connecting to any database or writing
  // plaintext to disk. This is an archive-integrity check, not a restore drill.
  const restore = child('pg_restore', ['--no-owner', '--file=/dev/null'], { PATH: process.env.PATH });
  restore.process.stdout.resume();
  try {
    await Promise.all([
      pipeline(fs.createReadStream(file, { start: headerLength, end: size - 17 }), decipher, restore.process.stdin),
      restore.done,
    ]);
  } finally { key.fill(0); restore.process.kill(); }
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return { sha256: digest.digest('hex'), bytes: size, authenticatedDecryption: true, archiveParsed: true };
}
async function main() {
  const mode = process.argv[2] || '--backup';
  if (mode === '--verify') {
    const file = path.resolve(process.argv[3] || '');
    if (path.dirname(file) !== directory) throw new Error('Recovery path rejected');
    console.log(JSON.stringify(await verifyArchive(file)));
    return;
  }
  if (mode !== '--backup' || process.argv.length > 3) throw new Error('Unsupported backup mode');
  const options = connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL);
  options.application_name = 'connectlive-encrypted-recovery';
  const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');
  const client = new Client(options);
  client.on('error', () => {});
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(12), key = keyFor(salt);
  const header = Buffer.concat([magic, salt, iv]);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const file = path.join(directory, `${stamp}-pre-release.dump.aes`);
  const partial = `${file}.partial`;
  let dump;
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const serverMajor = Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    const dumpVersion = execFileSync('pg_dump', ['--version'], { encoding: 'utf8' }).trim();
    const dumpMajor = Number(dumpVersion.match(/PostgreSQL\) (\d+)/)?.[1]);
    if (!dumpMajor || dumpMajor < serverMajor) throw new Error('pg_dump is older than the server');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const versions = (await client.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(r => r.version);
    const env = {
      PATH: process.env.PATH, PGHOST: options.host, PGPORT: String(options.port),
      PGUSER: options.user, PGPASSWORD: options.password, PGDATABASE: options.database,
      PGSSLMODE: 'verify-full', PGSSLROOTCERT: path.join(root, 'attached_assets/0_prod-ca-2021_1792610634463.crt'),
      PGCONNECT_TIMEOUT: '20', PGAPPNAME: 'connectlive-encrypted-recovery-dump',
      PGOPTIONS: '-c statement_timeout=110000 -c lock_timeout=5000',
    };
    fs.writeFileSync(partial, header, { flag: 'wx', mode: 0o600 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    dump = child('pg_dump', ['--no-password', '--format=custom', '--no-owner',
      '--lock-wait-timeout=5000', `--snapshot=${snapshot}`, ...schemas.map(s => `--schema=${s}`)], env);
    dump.process.stdin.end();
    await Promise.all([
      pipeline(dump.process.stdout, cipher, fs.createWriteStream(partial, { flags: 'a', mode: 0o600 })),
      dump.done,
    ]);
    fs.appendFileSync(partial, cipher.getAuthTag());
    const integrity = await verifyArchive(partial);
    fs.renameSync(partial, file);
    const manifest = {
      project: 'esjlqcfcwewymmeghbvj', createdAt: new Date().toISOString(),
      file: path.relative(root, file), schemas, serverMajor, dumpVersion, migrations: versions,
      encryption: 'AES-256-GCM; HKDF-SHA256 with unique salt and domain separation',
      keySecret: 'SESSION_SECRET_KEY', ...integrity,
      limitations: ['No object-storage file bytes or platform roles/configuration.',
        'Archive parsed and authenticated; full database restore not rehearsed.',
        'Keep the matching key secret and an independent provider/off-host backup.'],
    };
    fs.writeFileSync(`${file}.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await client.query('ROLLBACK');
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    key.fill(0);
    dump?.process.kill();
    fs.rmSync(partial, { force: true });
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}
if (require.main === module) main().catch(() => {
  console.error('Encrypted recovery backup stopped. No database changes made; sensitive diagnostics suppressed.');
  process.exitCode = 1;
});
module.exports = { verifyArchive };
