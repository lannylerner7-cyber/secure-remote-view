const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const hash = () => crypto.randomBytes(32).toString('hex');

// Runs inside the upgrade runner's rollback-only transaction. No fixtures,
// grants, audit rows, device records or rate buckets are committed.
async function verify(client) {
  let checks = 0;
  const q = (sql, values = []) => client.query(sql, values).catch(error => {
    error.testQuery = sql.replace(/\s+/g, ' ').slice(0, 90);
    throw error;
  });
  async function denied(sql, values, label) {
    await q('SAVEPOINT expected_denial');
    let failed = false;
    try { await q(sql, values); } catch { failed = true; }
    await q('ROLLBACK TO SAVEPOINT expected_denial');
    await q('RELEASE SAVEPOINT expected_denial');
    assert(failed, label);
    checks++;
  }
  const owners = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const id of owners)
    await q(`INSERT INTO auth.users(id,email,raw_user_meta_data,raw_app_meta_data)
      VALUES ($1,$2,'{}','{"provider":"email","providers":["email"]}')`,
      [id, `pairing-check-${id}@example.invalid`]);
  for (const id of owners.slice(0, 2))
    await q("INSERT INTO public.user_roles(user_id,role) VALUES ($1,'admin') ON CONFLICT DO NOTHING", [id]);
  const licenses = [];
  for (let i = 0; i < owners.length; i++) {
    const result = await q(`INSERT INTO public.licenses(meeting_id,contact_email,company,user_id,seat_limit,
      starts_at,expires_at,status) VALUES ($1,$2,$3,$4,3,now()-interval '1 minute',now()+interval '1 day','active')
      RETURNING id`, [String(crypto.randomInt(100000, 999999)), `pairing-check-${owners[i]}@example.invalid`,
      `Pairing verification ${i}`, owners[i]]);
    licenses.push(result.rows[0].id);
  }
  await q("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true), set_config('request.jwt.claim.role','service_role',true)");
  const grant = { noticeVersion: 1, mode: 'unattended',
    capabilities: { view: true, control: true, clipboard: false, files: false, recording: false } };
  async function issue(owner = owners[0], license = licenses[0]) {
    const code = hash();
    const { rows } = await q('SELECT public.create_device_pairing($1,$2,$3,$4) AS offer',
      [owner, license, code, grant]);
    assert(rows[0].offer.organization && rows[0].offer.grant.capabilities.control === true, 'disclosed offer');
    return { code, ...rows[0].offer };
  }
  const redeemSql = "SELECT public.redeem_device_pairing($1,$2,$3,$4,'PAIRING-CHECK','Windows test','1.10.0') AS result";
  await denied('SELECT public.create_device_pairing($1,$2,$3,$4)',
    [owners[1], licenses[0], hash(), grant], 'cross-organization issue rejected');
  await denied('SELECT public.create_device_pairing($1,$2,$3,$4)',
    [owners[2], licenses[2], hash(), grant], 'viewer cannot issue even on owned license');
  await denied('SELECT public.create_device_pairing($1,$2,$3,$4)',
    [owners[0], licenses[0], hash(), { ...grant, capabilities: { ...grant.capabilities, view: false } }],
    'viewless pairing rejected');
  const first = await issue();
  const nonce = hash(), tokenHash = hash();
  await denied(redeemSql, [first.code, nonce, tokenHash, crypto.randomUUID()], 'disclosure mismatch rejected');
  const args = [first.code, nonce, tokenHash, first.disclosureId];
  const result = (await q(redeemSql, args)).rows[0].result;
  const device = (await q('SELECT id::text=device_id AS identity_matches, metadata->>\'token_hash\'=$2 AS token_matches FROM public.devices WHERE id=$1',
    [result.deviceId, tokenHash])).rows[0];
  assert(device.identity_matches && device.token_matches, 'gateway identity and token binding');
  assert(result.authorization.mode === 'unattended' && result.authorization.capabilities.files === false,
    'stored authorization matches disclosure');
  checks += 2;
  const retried = (await q(redeemSql, args)).rows[0].result;
  assert(retried.deviceId === result.deviceId && retried.authorization.id === result.authorization.id,
    'same attempt safely retries a lost response');
  checks++;
  await denied(redeemSql, [first.code, hash(), tokenHash, first.disclosureId], 'code replay rejected');
  await denied(redeemSql, [first.code, nonce, hash(), first.disclosureId], 'token replacement rejected');
  assert((await q('SELECT public.inspect_device_pairing($1) AS offer', [first.code])).rows[0].offer === null,
    'consumed code no longer inspectable');
  checks++;

  const expired = await issue();
  await q("UPDATE public.device_pairings SET created_at=now()-interval '20 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [expired.id]);
  await denied(redeemSql, [expired.code, hash(), hash(), expired.disclosureId], 'expired code rejected');
  const revoked = await issue();
  await denied('SELECT public.revoke_device_pairing($1,$2)', [owners[1], revoked.id], 'cross-org revoke rejected');
  await q('SELECT public.revoke_device_pairing($1,$2)', [owners[0], revoked.id]);
  await denied(redeemSql, [revoked.code, hash(), hash(), revoked.disclosureId], 'revoked code rejected');

  const changedOwner = await issue();
  await q('SAVEPOINT ownership_check');
  await q('UPDATE public.licenses SET user_id=$1 WHERE id=$2', [owners[1], licenses[0]]);
  await denied(redeemSql, [changedOwner.code, hash(), hash(), changedOwner.disclosureId], 'owner change invalidates pending code');
  await q('ROLLBACK TO SAVEPOINT ownership_check');
  await q('RELEASE SAVEPOINT ownership_check');
  await q('SAVEPOINT seat_check');
  await q('UPDATE public.licenses SET seat_limit=1 WHERE id=$1', [licenses[0]]);
  await denied(redeemSql, [changedOwner.code, hash(), hash(), changedOwner.disclosureId], 'seat limit enforced');
  await q('ROLLBACK TO SAVEPOINT seat_check');
  await q('RELEASE SAVEPOINT seat_check');

  const session = (await q(`INSERT INTO public.sessions(device_id,technician_id,mode,state,media_mode)
    VALUES ($1,$2,'view','invited','video') RETURNING id`, [result.deviceId, owners[0]])).rows[0].id;
  await denied("UPDATE public.sessions SET media_mode='legacy' WHERE id=$1", [session], 'media mode cannot downgrade');
  await denied("INSERT INTO public.session_frames(session_id,frame,width,height) VALUES ($1,'AA==',1,1)",
    [session], 'video sessions reject JPEG writes');
  await denied('SELECT public.revoke_managed_device_access($1,$2)', [owners[1], result.deviceId], 'cross-org access revoke rejected');
  await q('SELECT public.revoke_managed_device_access($1,$2)', [owners[0], result.deviceId]);
  await denied(redeemSql, args, 'retries cannot revive revoked device access');

  const bucket = `check:${hash()}`;
  for (let i = 1; i <= 31; i++)
    assert((await q('SELECT public.consume_pairing_attempt($1) AS allowed', [bucket])).rows[0].allowed === (i <= 30),
      'rate bucket enforces its limit');
  checks++;
  const acl = (await q(`SELECT
    has_table_privilege('authenticated','public.device_pairings','SELECT') AS table_read,
    has_function_privilege('anon','public.redeem_device_pairing(text,text,text,uuid,text,text,text)','EXECUTE') AS anonymous_rpc,
    has_function_privilege('authenticated','public.create_device_pairing(uuid,uuid,text,jsonb)','EXECUTE') AS user_rpc`)).rows[0];
  assert(!acl.table_read && !acl.anonymous_rpc && !acl.user_rpc, 'private pairing table and service-only RPCs');
  checks++;
  console.log(`PASS: ${checks} rollback-only pairing, authorization, identity, rate-limit and video-schema checks.`);
}
module.exports = { verify };
