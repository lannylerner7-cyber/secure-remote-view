#!/usr/bin/env node
// Isolated, explicitly disposable browser-test data. Never targets real devices.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { connectionOptions } = require('./supabase-fresh-install.cjs');
const root = path.resolve(__dirname, '..');
const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');
const origin = 'https://esjlqcfcwewymmeghbvj.supabase.co';
async function auth(pathname, method, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.SUPABASE_URL?.replace(/\/$/, '') !== origin) throw new Error('Fixture target not confirmed');
  const response = await fetch(`${origin}/auth/v1${pathname}`, {
    method, headers: { apikey: key, ...(key.split('.').length === 3 ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fixture auth operation failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
async function create() {
  const suffix = crypto.randomBytes(8).toString('hex');
  const email = `browser-pairing-${suffix}@example.invalid`;
  const password = `Test!${crypto.randomBytes(24).toString('base64url')}`;
  const company = `Browser verification ${suffix}`;
  const userResult = await auth('/admin/users', 'POST', { email, password, email_confirm: true });
  const userId = userResult.user?.id ?? userResult.id;
  if (!userId) throw new Error('No test identity returned');
  const client = new Client(connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL));
  let committed = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM public.user_roles WHERE user_id=$1', [userId]);
    await client.query("INSERT INTO public.user_roles(user_id,role) VALUES ($1,'admin')", [userId]);
    const { rows } = await client.query(`INSERT INTO public.licenses(meeting_id,contact_email,company,user_id,
      seat_limit,starts_at,expires_at,status) VALUES ($1,$2,$3,$4,5,now()-interval '1 minute',now()+interval '2 hours','active')
      RETURNING id`, [String(crypto.randomInt(100000, 999999)), email, company, userId]);
    const file = `/tmp/connectlive-browser-first-fixture-${suffix}.json`;
    fs.writeFileSync(file, JSON.stringify({ email, password, userId, licenseId: rows[0].id, company }), { mode: 0o600 });
    await client.query('COMMIT');
    committed = true;
    console.log(JSON.stringify({ file, created: true, purpose: 'Synthetic browser test only; do not print its credentials.' }));
  } finally {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => {});
      await auth(`/admin/users/${userId}`, 'DELETE').catch(() => {});
    }
    await client.end().catch(() => {});
  }
}
async function cleanup(file) {
  if (!/^\/tmp\/connectlive-browser-first-fixture-[a-f0-9]{16}\.json$/.test(file || ''))
    throw new Error('Unexpected fixture path');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = await auth(`/admin/users/${fixture.userId}`, 'GET');
  const user = result.user ?? result;
  if (user.email !== fixture.email || !/^browser-pairing-[a-f0-9]{16}@example\.invalid$/.test(user.email))
    throw new Error('Fixture identity guard failed');
  const client = new Client(connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL));
  try {
    await client.connect();
    await client.query('BEGIN');
    const { rowCount } = await client.query('SELECT id FROM public.licenses WHERE id=$1 AND user_id=$2 AND company=$3 FOR UPDATE',
      [fixture.licenseId, fixture.userId, fixture.company]);
    if (rowCount !== 1) throw new Error('Fixture license guard failed');
    await client.query('DELETE FROM public.sessions WHERE device_id IN (SELECT id FROM public.devices WHERE license_id=$1)', [fixture.licenseId]);
    await client.query("DELETE FROM public.audit_logs WHERE device_id IN (SELECT id FROM public.devices WHERE license_id=$1) OR detail->>'license_id'=$1::text OR detail->>'actor'=$2::text",
      [fixture.licenseId, fixture.userId]);
    await client.query('DELETE FROM public.device_pairings WHERE license_id=$1', [fixture.licenseId]);
    await client.query('DELETE FROM public.devices WHERE license_id=$1', [fixture.licenseId]);
    await client.query('DELETE FROM public.licenses WHERE id=$1', [fixture.licenseId]);
    await client.query('DELETE FROM public.login_attempts WHERE identifier = ANY($1::text[])',
      [[fixture.email.toLowerCase(), `tech-${fixture.userId}@connectlive.internal`]]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await client.end().catch(() => {}); }
  await auth(`/admin/users/${fixture.userId}`, 'DELETE');
  fs.unlinkSync(file);
  console.log(JSON.stringify({ cleaned: true }));
}
const mode = process.argv[2];
(mode === '--create' ? create() : mode === '--cleanup' ? cleanup(process.argv[3]) :
  Promise.reject(new Error('Use --create or --cleanup <private-fixture-file>')))
  .catch(error => {
    console.error(JSON.stringify({ error: 'Synthetic fixture operation stopped', code: error.code || 'fixture_failed' }));
    process.exitCode = 1;
  });
