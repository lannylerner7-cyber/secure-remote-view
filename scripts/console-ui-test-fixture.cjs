#!/usr/bin/env node
'use strict';

// Extends a disposable identity created by browser-first-test-fixture.cjs.
// Workspace-only operator tool: uses the original lib/db pg dependency.
// This never enrolls an actual Agent or sends notifications/device commands.
// Stop --heartbeat before using that script's guarded --cleanup command.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { connectionOptions } = require('./supabase-fresh-install.cjs');
const root = path.resolve(__dirname, '..');
const { Client } = createRequire(path.join(root, 'lib/db/package.json'))('pg');

function readFixture(file) {
  if (!/^\/tmp\/connectlive-browser-first-fixture-[a-f0-9]{16}\.json$/.test(file || ''))
    throw new Error('Unexpected fixture file');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^browser-pairing-[a-f0-9]{16}@example\.invalid$/.test(value.email || ''))
    throw new Error('Not a disposable identity');
  return value;
}

async function guard(client, fixture) {
  const { rowCount } = await client.query(`SELECT l.id FROM public.licenses l
    JOIN auth.users u ON u.id=l.user_id
    WHERE l.id=$1 AND l.user_id=$2 AND l.company=$3 AND u.email=$4`,
  [fixture.licenseId, fixture.userId, fixture.company, fixture.email]);
  if (rowCount !== 1) throw new Error('Fixture ownership guard failed');
}

async function main() {
  const [mode, file, role] = process.argv.slice(2);
  if (!['--seed', '--heartbeat', '--role', '--inspect'].includes(mode))
    throw new Error('Unsupported operation');
  const fixture = readFixture(file);
  const client = new Client(connectionOptions(process.env.SUPABASE_MIGRATION_DATABASE_URL));
  client.on('error', () => {});
  try {
    await client.connect();
    await guard(client, fixture);
    if (mode === '--heartbeat') {
      if (!fixture.consoleUi?.onlineIds?.length) throw new Error('Seed first');
      console.log('Synthetic UI heartbeat started; only guarded fixture devices are updated.');
      // Finite run, no open transaction and no process startup/OS command.
      for (let i = 0; i < 180; i++) {
        const r = await client.query(`UPDATE public.devices SET last_seen_at=now(),status='online'
          WHERE id=ANY($1::uuid[]) AND license_id=$2 AND metadata->>'console_ui_fixture'=$3`,
        [fixture.consoleUi.onlineIds, fixture.licenseId, fixture.consoleUi.marker]);
        if (r.rowCount !== fixture.consoleUi.onlineIds.length) break;
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      return;
    }
    if (mode === '--inspect') {
      const { rows } = await client.query(`SELECT
        (SELECT count(*)::int FROM public.devices WHERE license_id=$1) devices,
        (SELECT count(*)::int FROM public.sessions WHERE technician_id=$2) sessions,
        (SELECT count(*)::int FROM public.sessions WHERE technician_id=$2 AND state='invited') invitations,
        (SELECT count(*)::int FROM public.power_commands WHERE device_id IN
          (SELECT id FROM public.devices WHERE license_id=$1)) power_commands`,
      [fixture.licenseId, fixture.userId]);
      console.log(JSON.stringify({ syntheticOnly: true, ...rows[0] }));
      return;
    }
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true), set_config('request.jwt.claim.role','service_role',true)");
      if (mode === '--role') {
        if (!['admin', 'super_admin', 'viewer'].includes(role)) throw new Error('Unsupported fixture role');
        await client.query('DELETE FROM public.user_roles WHERE user_id=$1', [fixture.userId]);
        await client.query('INSERT INTO public.user_roles(user_id,role) VALUES ($1,$2)', [fixture.userId, role]);
        await client.query('COMMIT');
        console.log(JSON.stringify({ syntheticOnly: true, role }));
        return;
      }
      if (fixture.consoleUi) throw new Error('Already seeded');
      const marker = crypto.randomBytes(6).toString('hex');
      const prefix = `UI Verify ${marker.slice(0, 6)}`;
      const definitions = [
        { name: 'Workstation', platform: 'windows', status: 'online', age: 0, version: '0.1.0' },
        { name: 'Tablet', platform: 'android', status: 'offline', age: 86400, version: '0.1.0' },
        { name: 'Offline PC', platform: 'windows', status: 'offline', age: 7200, version: '1.10.1' },
        { name: 'Stopped PC', platform: 'windows', status: 'stopped', age: 300, version: '1.10.1' },
      ];
      const devices = [];
      for (const d of definitions) {
        const id = crypto.randomUUID();
        const name = `${prefix} ${d.name}`;
        await client.query(`INSERT INTO public.devices
          (id,device_id,display_name,hostname,platform,os,license_id,status,last_seen_at,metadata)
          VALUES($1::uuid,$1::text,$2,$3,$4,$5,$6,$7,now()-($8::integer*interval '1 second'),$9::jsonb)`,
        [id, name, `UI-${marker}-${d.platform}`, d.platform,
          d.platform === 'android' ? 'Android test fixture' : 'Windows test fixture',
          fixture.licenseId, d.status, d.age,
          JSON.stringify({ console_ui_fixture: marker, agent_version: d.version,
            agent_runtime_protocol: 0, browser_video: d.platform === 'windows' ? 1 : 0 })]);
        devices.push({ id, name, platform: d.platform, status: d.status });
      }
      // Let the real UI create an invitation. Never manufacture a terminal or
      // authorized session: database transition guards apply to fixtures too.
      await client.query('COMMIT');
      fixture.consoleUi = {
        marker, prefix, devices,
        onlineIds: devices.filter(d => d.status === 'online').map(d => d.id),
      };
      fs.writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
      console.log(JSON.stringify({ seeded: true, syntheticOnly: true, devices: devices.length, file }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    await client.end().catch(() => {});
  }
}
main().catch(error => {
  // Never emit credentials, SQL parameters, application rows or raw PG errors.
  console.error(JSON.stringify({ error: 'Synthetic console fixture stopped', code: error.code || 'fixture_failed' }));
  process.exitCode = 1;
});
