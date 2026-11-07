const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const hash = () => crypto.randomBytes(32).toString('hex');

// Called inside a rollback-only transaction; never uses a real PIN or device.
async function verify(client) {
  let count = 0;
  const q = (sql, args = []) => client.query(sql, args);
  const check = (value, label) => { assert(value, label); count++; };
  async function denied(sql, args, label, reason) {
    await q('SAVEPOINT unlock_denial');
    let rejected = false;
    try { await q(sql, args); } catch (error) { rejected = !reason || error.message.includes(reason); }
    await q('ROLLBACK TO SAVEPOINT unlock_denial');
    await q('RELEASE SAVEPOINT unlock_denial');
    check(rejected, label);
  }
  const owner = crypto.randomUUID(), outsider = crypto.randomUUID(), viewer = crypto.randomUUID();
  for (const [id, role] of [[owner, 'admin'], [outsider, 'admin'], [viewer, 'viewer']]) {
    await q("INSERT INTO auth.users(id,email) VALUES ($1,$2)", [id, `unlock-${id}@example.invalid`]);
    await q('DELETE FROM public.user_roles WHERE user_id=$1', [id]);
    await q('INSERT INTO public.user_roles(user_id,role) VALUES ($1,$2)', [id, role]);
  }
  await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)", [owner]);
  const license = (await q(`INSERT INTO public.licenses(meeting_id,contact_email,company,user_id,seat_limit,starts_at,expires_at,status)
    VALUES ($1,$2,'unlock-fixture',$3,3,now()-interval '1 minute',now()+interval '1 day','active') RETURNING id`,
    [String(crypto.randomInt(100000, 999999)), `unlock-${owner}@example.invalid`, owner])).rows[0].id;
  const code = hash(), deviceTokenHash = hash();
  const offer = (await q('SELECT public.create_device_pairing($1,$2,$3,$4) AS value', [owner, license, code, {
    noticeVersion: 1, mode: 'unattended', capabilities: { view: true, control: true, clipboard: false, files: false, recording: false },
  }])).rows[0].value;
  const paired = (await q(`SELECT public.redeem_device_pairing($1,$2,$3,$4,'UNLOCK-CHECK','Windows fixture','1.10.1') AS value`,
    [code, hash(), deviceTokenHash, offer.disclosureId])).rows[0].value;
  const device = paired.deviceId, grant = paired.authorization.id, key = crypto.randomUUID();
  const admin = async (action, body = {}, actor = owner) => (await q('SELECT public.unlock_admin($1,$2,$3,$4) AS value',
    [actor, device, action, body])).rows[0].value;
  const agent = async (action, body = {}) => (await q('SELECT public.unlock_agent($1,$2,$3) AS value',
    [device, action, { keyId: key, ...body }])).rows[0].value;
  check((await admin('status')).enabled === false, 'normal unattended pairing does not enable unlock');
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [outsider, device, 'status', {}], 'other organization cannot read unlock status');
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [owner, device, 'begin', {}], 'no helper grant cannot start');
  const publicKey = 'A'.repeat(564); // SQL-only shape fixture; API crypto validation is separately tested.
  await agent('enable', { version: 1, authorizationId: grant, publicKey, windowsAccount: 'FIXTURE\\Operator', consentAccepted: true });
  check((await admin('status')).enabled, 'explicit local permission is recorded');
  check((await admin('status')).canManage, 'owner can manage the vault');
  await agent('enable', { version: 1, authorizationId: grant, publicKey, windowsAccount: 'FIXTURE\\Operator', consentAccepted: true });
  check((await q('SELECT count(*)::int AS n FROM public.device_unlock_revocations WHERE key_id=$1', [key])).rows[0].n === 0,
    'idempotent local enrollment does not tombstone the live key');
  const envelope = { version: 1, algorithm: 'RSA-OAEP-256+A256GCM', keyId: key, wrappedKey: 'A'.repeat(512),
    iv: 'A'.repeat(16), ciphertext: 'A'.repeat(32) };
  await admin('save', { authorizationId: grant, sealedPin: envelope });
  let status = await admin('status');
  check(status.hasPin && !('sealedPin' in status) && !('pin' in status), 'status exposes presence, not credential content');
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [outsider, device, 'save', { authorizationId: grant, sealedPin: envelope }],
    'other organization cannot replace the PIN');
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [owner, device, 'save', {
    authorizationId: grant, sealedPin: { ...envelope, keyId: crypto.randomUUID() },
  }], 'wrong device key cannot receive a PIN');
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [owner, device, 'save', {
    authorizationId: grant, sealedPin: { ...envelope, plaintext: 'synthetic-not-a-pin' },
  }], 'unexpected credential fields are rejected');
  async function makeSession(actor) {
    const id = (await q(`INSERT INTO public.sessions(device_id,technician_id,state,mode,media_mode)
      VALUES ($1,$2,'invited','view','legacy') RETURNING id`, [device, actor])).rows[0].id;
    await q(`UPDATE public.sessions SET state='active',mode='control',consent_at=now(),
      authorization_id=$1,authorization_mode='unattended' WHERE id=$2`, [grant, id]);
    await q('UPDATE public.sessions SET admin_client_id=$1 WHERE id=$2', [crypto.randomUUID(), id]);
    return id;
  }
  const session = await makeSession(owner);
  const peer = crypto.randomUUID(), beginBody = { sessionId: session, peerId: peer };
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [owner, device, 'begin', beginBody], 'unknown helper/lock state is denied');
  await agent('report', { locked: true, helperReady: true });
  status = await admin('status');
  check(status.helperReady && status.locked === true, 'fresh locked helper is reported');
  const ticket = await admin('begin', beginBody);
  check(typeof ticket.requestId === 'string' && Date.parse(ticket.expiresAt) > Date.now(), 'short-lived request issued');
  check((await q('SELECT mode FROM public.sessions WHERE id=$1', [session])).rows[0].mode === 'view', 'unlock switches session to view-only');
  const binding = { requestId: ticket.requestId, sessionId: session, peerId: peer };
  await denied('SELECT public.unlock_agent($1,$2,$3)', [device, 'acquire', { keyId: key, ...binding, peerId: crypto.randomUUID() }],
    'cross-peer acquisition is denied');
  check((await agent('acquire', binding)).allowed, 'current Agent acquires the explicit request');
  await denied('SELECT public.unlock_agent($1,$2,$3)', [device, 'acquire', { keyId: key, ...binding }], 'acquisition is one-shot');
  check((await agent('permit', binding)).allowed, 'fresh attempt lease allowed');
  check((await agent('pin', binding)).sealedPin.ciphertext === envelope.ciphertext, 'only the authorized Agent retrieves ciphertext');
  await denied('SELECT public.unlock_agent($1,$2,$3)', [device, 'pin', { keyId: key, ...binding }], 'lost PIN retrieval is never retried');
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [owner, device, 'begin', beginBody], 'attempt spacing enforced', 'unlock_rate_limited');
  await admin('forget');
  check(!(await admin('status')).hasPin, 'forget removes active ciphertext');
  await denied('SELECT public.unlock_agent($1,$2,$3)', [device, 'permit', { keyId: key, ...binding }], 'forget ends active attempts');
  await q("UPDATE public.device_unlock_attempts SET created_at=clock_timestamp()-interval '31 seconds' WHERE id=$1", [ticket.requestId]);
  const viewerSession = await makeSession(viewer);
  await denied('SELECT public.unlock_admin($1,$2,$3,$4)', [viewer, device, 'begin', { ...beginBody, sessionId: viewerSession }],
    'viewer cannot unlock even when it owns a session');
  await admin('save', { authorizationId: grant, sealedPin: envelope });
  const another = await admin('begin', beginBody);
  const nextBinding = { requestId: another.requestId, sessionId: session, peerId: peer };
  await agent('acquire', nextBinding);
  await q('UPDATE public.sessions SET admin_client_id=$1 WHERE id=$2', [crypto.randomUUID(), session]);
  await denied('SELECT public.unlock_agent($1,$2,$3)', [device, 'permit', { keyId: key, ...nextBinding }], 'session takeover ends old operator authority');
  await admin('revoke');
  check(!(await admin('status')).enabled && !(await admin('status')).hasPin, 'revoke removes permission and PIN');
  check((await q('SELECT count(*)::int AS n FROM public.device_unlock_revocations WHERE key_id=$1', [key])).rows[0].n === 1,
    'revocation leaves only a cleanup receipt');
  const newKey = crypto.randomUUID();
  await agent('enable', { version: 1, keyId: newKey, authorizationId: grant, publicKey, windowsAccount: 'FIXTURE\\Operator', consentAccepted: true });
  await admin('save', { authorizationId: grant, sealedPin: { ...envelope, keyId: newKey } });
  await q('DELETE FROM public.devices WHERE id=$1', [device]);
  for (const table of ['device_unlock_permissions', 'device_unlock_credentials', 'device_unlock_attempts'])
    check((await q(`SELECT count(*)::int AS n FROM public.${table} WHERE device_id=$1`, [device])).rows[0].n === 0,
      `device removal deletes ${table}`);
  check((await q('SELECT count(*)::int AS n FROM public.device_unlock_revocations WHERE key_id=$1', [newKey])).rows[0].n === 1,
    'device removal leaves a token-hash-bound offline cleanup receipt');
  check((await q("SELECT bool_and(NOT has_table_privilege('authenticated',oid,'SELECT')) AS protected FROM pg_class WHERE relname LIKE 'device_unlock_%' AND relkind='r'")).rows[0].protected,
    'browser database role cannot directly read the vault or attempts');
  check((await q("SELECT NOT has_function_privilege('authenticated','public.unlock_agent(uuid,text,jsonb)','EXECUTE') AS denied")).rows[0].denied,
    'browser database role cannot call Agent RPCs');
  console.log(`Windows unlock database checks: ${count} passed (synthetic, rollback-only).`);
}
module.exports = { verify };
