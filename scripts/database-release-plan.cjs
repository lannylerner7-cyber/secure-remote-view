'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { statements } = require('./supabase-fresh-install.cjs');
const root = path.resolve(__dirname, '..');
const files = [
  '20261022000000_retarget_legacy_reconcile_cron.sql',
  '20261022001000_allow_recorded_control_transition.sql',
  '20261022002000_reconcile_recorded_control_guard.sql',
  '20261103000000_disclosed_device_pairing.sql',
  '20261103001000_browser_video_sessions.sql',
  '20261103002000_signed_agent_update_channel.sql',
  '20261103003000_agent_lifecycle.sql',
  '20261103004000_release_database_hardening.sql',
];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function releasePlan() {
  return files.map(file => {
    const source = fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8');
    const parts = statements(source);
    const plain = value => value.replace(/--[^\n]*/g, '').trim();
    const wrapped = /^BEGIN;$/i.test(plain(parts[0])) && /^COMMIT;$/i.test(plain(parts.at(-1)));
    const body = wrapped ? parts.slice(1, -1) : parts;
    if (file.startsWith('20261103') && (!wrapped || body.some(sql =>
      /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i.test(plain(sql))))) throw new Error('Unexpected transaction boundary');
    return { file, version: file.slice(0, 14), name: file.slice(15, -4), source, sha256: digest(source), body };
  });
}
module.exports = { releasePlan, digest };
