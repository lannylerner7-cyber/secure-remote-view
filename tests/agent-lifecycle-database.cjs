const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const hash = () => crypto.randomBytes(32).toString('hex');

// Transaction-scoped synthetic records; caller always rolls verification back.
async function verify(client) {
  let count = 0;
  const q = (sql, args = []) => client.query(sql, args);
  const check = (value, label) => { assert(value, label); count++; };
  async function denied(sql, args, label, reason) {
    await q('SAVEPOINT lifecycle_denial');
    let rejected = false;
    try { await q(sql, args); } catch (error) { rejected = !reason || error.message.includes(reason); }
    await q('ROLLBACK TO SAVEPOINT lifecycle_denial');
    await q('RELEASE SAVEPOINT lifecycle_denial');
    check(rejected, label);
  }
  await q('RESET ROLE');
  await q(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
    set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true)`);
  const owner = crypto.randomUUID(), outsider = crypto.randomUUID();
  for (const actor of [owner, outsider]) {
    await q(`INSERT INTO auth.users(id,email,raw_user_meta_data,raw_app_meta_data) VALUES ($1,$2,'{}','{}')`,
      [actor, `lifecycle-${actor}@example.invalid`]);
    await q("INSERT INTO public.user_roles(user_id,role) VALUES ($1,'admin') ON CONFLICT DO NOTHING", [actor]);
  }
  const license = (await q(`INSERT INTO public.licenses(meeting_id,contact_email,company,user_id,seat_limit,starts_at,expires_at,status)
    VALUES ($1,$2,'Lifecycle fixture',$3,3,now()-interval '1 minute',now()+interval '1 day','active') RETURNING id`,
    [String(crypto.randomInt(100000, 999999)), `lifecycle-${owner}@example.invalid`, owner])).rows[0].id;
  const code = hash();
  const offer = (await q('SELECT public.create_device_pairing($1,$2,$3,$4) AS value', [owner, license, code, {
    noticeVersion: 1, mode: 'unattended', capabilities: { view: true, control: true, clipboard: false, files: false, recording: false },
  }])).rows[0].value;
  const paired = (await q(`SELECT public.redeem_device_pairing($1,$2,$3,$4,'LIFECYCLE-CHECK','Windows fixture','1.10.1') AS value`,
    [code, hash(), hash(), offer.disclosureId])).rows[0].value;
  const device = paired.deviceId, grant = paired.authorization.id;
  const first = crypto.randomUUID(), second = crypto.randomUUID(), watch = crypto.randomUUID();
  let sequence = 0;
  const heartbeat = async (instance, seq) => (await q('SELECT public.record_agent_runtime($1,$2,$3,60) AS value', [device, instance, seq])).rows[0].value;
  const report = async extra => (await q('SELECT public.report_agent_watch($1,$2) AS value', [device, {
    instance: watch, sequence: ++sequence, authorization_id: grant, agent_instance: first,
    startup_enabled: true, state: 'running', ...extra,
  }])).rows[0].value;
  const runtime = async () => (await q('SELECT * FROM public.agent_runtime WHERE device_id=$1', [device])).rows[0];
  const request = async (actor = owner) => (await q('SELECT public.request_agent_relaunch($1,$2) AS value', [actor, device])).rows[0].value;
  check(await heartbeat(first, 1), 'first heartbeat accepted');
  check(await heartbeat(first, 1), 'idempotent heartbeat retry');
  const before = (await runtime()).agent_seen_at.toISOString();
  check((await report({})).authorized, 'disclosed grant + enabled Watch authorized');
  check((await runtime()).agent_seen_at.toISOString() === before, 'Watch cannot freshen Agent heartbeat');
  await denied('SELECT public.request_agent_relaunch($1,$2)', [outsider, device], 'other organization denied');
  const command = await request();
  check((await request()).id === command.id, 'duplicate clicks reuse pending command');
  check((await report({ state: 'stopped' })).command.id === command.id, 'Watch claims durable command');
  check(!await heartbeat(first, 2), 'late stopped-process heartbeat cannot resurrect');
  await denied('SELECT public.report_agent_watch($1,$2)', [device, {
    instance: watch, sequence: ++sequence, authorization_id: grant, agent_instance: first,
    startup_enabled: true, state: 'running', command_id: command.id, command_state: 'healthy',
  }], 'Process.Start without new heartbeat is not healthy');
  check(await heartbeat(second, 1), 'replacement heartbeat accepted');
  await report({ state: 'stopped', agent_instance: first });
  check((await runtime()).agent_state === 'running', 'late old-process stop cannot stop replacement');
  await report({ agent_instance: second, command_id: command.id, command_state: 'healthy' });
  check((await q('SELECT state FROM public.agent_lifecycle_commands WHERE id=$1', [command.id])).rows[0].state === 'healthy',
    'matching new heartbeat confirms relaunch');
  await q("UPDATE public.devices SET metadata=metadata||'{\"agent_runtime_protocol\":0}'::jsonb WHERE id=$1", [device]);
  await denied('SELECT public.request_agent_relaunch($1,$2)', [owner, device], 'legacy rollback is not offered unsupported recovery', 'updated_agent_required');
  await q("UPDATE public.devices SET metadata=metadata||'{\"agent_runtime_protocol\":1}'::jsonb WHERE id=$1", [device]);
  const mismatched = await report({ authorization_id: crypto.randomUUID(), startup_enabled: false, state: 'disabled', agent_instance: second });
  check(mismatched.error === 'authorization_changed', 'obsolete grant cannot overwrite current runtime');
  await denied('SELECT public.request_agent_relaunch($1,$2)', [owner, device], 'request cooldown enforced');
  await q("UPDATE public.agent_lifecycle_commands SET requested_at=clock_timestamp()-interval '30 seconds' WHERE id=$1", [command.id]);
  const expires = await request();
  await q("UPDATE public.agent_lifecycle_commands SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expires.id]);
  check(!(await report({ agent_instance: second })).command, 'expired command never dispatched');
  check((await q('SELECT state FROM public.agent_lifecycle_commands WHERE id=$1', [expires.id])).rows[0].state === 'expired', 'expired state recorded');
  const replacementWatch = crypto.randomUUID();
  await report({ instance: replacementWatch, sequence: 1, agent_instance: second });
  check(!(await report({ agent_instance: second })).authorized, 'retired Watch cannot overwrite successor');
  const stop = await report({ instance: replacementWatch, sequence: 2, agent_instance: second,
    startup_enabled: false, state: 'disabled', detail_code: 'local_withdrawal' });
  check(!stop.authorized, 'local withdrawal is authoritative');
  check(!await heartbeat(second, 2), 'withdrawn process cannot revive status');
  await denied('SELECT public.request_agent_relaunch($1,$2)', [owner, device], 'relaunch cannot override withdrawal');
  await q("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.role','authenticated',true)",
    [JSON.stringify({ sub: outsider, role: 'authenticated' }), outsider]);
  await q('SET LOCAL ROLE authenticated');
  check((await q('SELECT * FROM public.agent_runtime WHERE device_id=$1', [device])).rowCount === 0, 'cross-organization runtime RLS');
  await denied('SELECT public.record_agent_runtime($1,$2,1,60)', [device, crypto.randomUUID()], 'browser cannot spoof heartbeat RPC');
  await q('RESET ROLE');
  await q("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",
    [JSON.stringify({ sub: owner, role: 'authenticated' }), owner]);
  await q('SET LOCAL ROLE authenticated');
  check((await q('SELECT * FROM public.agent_runtime WHERE device_id=$1', [device])).rowCount === 1, 'owner can read status');
  await denied("UPDATE public.agent_runtime SET startup_enabled=true WHERE device_id=$1", [device], 'browser cannot enable local startup');
  await q('RESET ROLE');
  await q(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
    set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true)`);
  await q('UPDATE public.device_authorizations SET revoked_at=clock_timestamp() WHERE id=$1', [grant]);
  check(!(await report({ instance: replacementWatch, sequence: 3, startup_enabled: true, agent_instance: second })).authorized,
    'server revocation defeats a locally enabled Watch');
  console.log(`${count} lifecycle SQL checks passed using actual pairing, authorization, RLS and lifecycle functions.`);
}
module.exports = { verify };
