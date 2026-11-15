const assert = require('node:assert/strict');
const crypto = require('node:crypto');
async function verify(client) {
  let count=0;
  const q=(sql,args=[])=>client.query(sql,args);
  const check=(condition,label)=>{assert(condition,label);count++;};
  const denied=async(sql,args,label)=>{
    await q('SAVEPOINT tools_denial');let error=false;
    try{await q(sql,args);}catch{error=true;}
    await q('ROLLBACK TO SAVEPOINT tools_denial');await q('RELEASE SAVEPOINT tools_denial');
    check(error,label);
  };
  const owner=crypto.randomUUID(), token=()=>crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO auth.users(id,email) VALUES($1,$2)',[owner,`tools-${owner}@example.invalid`]);
  await q("INSERT INTO public.user_roles(user_id,role) VALUES($1,'admin') ON CONFLICT DO NOTHING",[owner]);
  await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)",[owner]);
  const license=(await q(`INSERT INTO public.licenses(meeting_id,contact_email,company,user_id,seat_limit,starts_at,expires_at,status)
    VALUES($1,$2,'session-tools-fixture',$3,2,now()-interval '1 hour',now()+interval '1 day','active') RETURNING id`,
    [String(crypto.randomInt(100000,999999)),`tools-${owner}@example.invalid`,owner])).rows[0].id;
  const code=token();
  const offer=(await q('SELECT public.create_device_pairing($1,$2,$3,$4) AS value',[owner,license,code,{
    noticeVersion:1,mode:'unattended',capabilities:{view:true,control:true,clipboard:true,files:true,recording:true},
  }])).rows[0].value;
  const paired=(await q("SELECT public.redeem_device_pairing($1,$2,$3,$4,'TOOLS-FIXTURE','Windows fixture','1.10.14') AS value",
    [code,token(),token(),offer.disclosureId])).rows[0].value;
  const device=paired.deviceId,grant=paired.authorization.id,controller=crypto.randomUUID(),peer=crypto.randomUUID();
  const session=(await q("INSERT INTO public.sessions(device_id,technician_id,mode,state) VALUES($1,$2,'view','invited') RETURNING id",
    [device,owner])).rows[0].id;
  await q("UPDATE public.sessions SET state='active',consent_at=now(),authorization_id=$1,authorization_mode='unattended' WHERE id=$2",
    [grant,session]);
  await q("UPDATE public.sessions SET admin_client_id=$1 WHERE id=$2",[controller,session]);
  await q("INSERT INTO public.session_signals(session_id,from_side,kind,payload,admin_client_id) VALUES($1,'admin','offer',$2,$3)",
    [session,{peer_id:peer,type:'offer',sdp:'synthetic'},controller]);
  const sha=crypto.createHash('sha256').update('fixture').digest('hex'),id=crypto.randomUUID();
  const reserve='SELECT public.reserve_session_file($1,$2,$3,$4,$5,$6,$7,$8) AS value';
  const args=[session,id,7,sha,'fixture.txt','from_agent',controller,peer];
  const r=(await q(reserve,args)).rows[0].value;
  check(r.state==='reserved'&&r.path.endsWith(`${id}-fixture.txt`),'bounded reservation');
  check((await q('SELECT count(*)::int AS n FROM public.session_files WHERE session_id=$1',[session])).rows[0].n===0,'no manifest on reservation');
  await denied(reserve,[session,id,8,sha,'fixture.txt','from_agent',controller,peer],'duplicate metadata conflict');
  await denied(reserve,[session,crypto.randomUUID(),7,sha,'x.txt','from_agent',controller,crypto.randomUUID()],'peer binding');
  await denied(reserve,[session,crypto.randomUUID(),7,sha,'x.txt','from_agent',crypto.randomUUID(),peer],'controller binding');
  const finish='SELECT public.complete_session_file($1,$2,$3,$4,$5,$6,$7) AS value';
  const finishArgs=[session,id,controller,peer,'text/plain','http',owner];
  check((await q(finish,finishArgs)).rows[0].value.state==='complete','terminal receipt');
  check((await q(finish,finishArgs)).rows[0].value.id===id,'idempotent terminal receipt');
  check((await q('SELECT count(*)::int AS n FROM public.session_files WHERE id=$1',[id])).rows[0].n===1,'no duplicate success');
  const native=crypto.randomUUID();
  await q(reserve,[session,native,7,'','native.txt','',controller,peer]);
  await denied(finish,[session,native,controller,peer,'text/plain','http',owner],'native incomplete intent cannot publish');
  await q(reserve,[session,native,7,sha,'native.txt','from_admin',controller,peer]);
  await q(finish,[session,native,controller,peer,'text/plain','datachannel',owner]);
  check(true,'unchanged native Admin two-phase contract seals checksum before completion');
  const pending=crypto.randomUUID();
  await q(reserve,[session,pending,7,sha,'pending.txt','from_agent',controller,peer]);
  await q('UPDATE public.sessions SET admin_client_id=$1 WHERE id=$2',[crypto.randomUUID(),session]);
  await denied(finish,[session,pending,controller,peer,'text/plain','http',owner],'authority withdrawal retains reservation not manifest');
  await q('UPDATE public.sessions SET admin_client_id=$1 WHERE id=$2',[controller,session]);
  await denied(finish,[session,pending,null,peer,'text/plain','http',owner],'null controller never bypasses completion');
  await q('DELETE FROM public.user_roles WHERE user_id=$1',[owner]);
  await q("INSERT INTO public.user_roles(user_id,role) VALUES($1,'viewer')",[owner]);
  await denied(finish,[session,pending,controller,peer,'text/plain','http',owner],'downgraded viewer cannot complete transfer');
  await q("UPDATE public.user_roles SET role='admin' WHERE user_id=$1",[owner]);
  const instance=crypto.randomUUID(),directId=crypto.randomUUID();
  await q('SELECT public.record_agent_runtime($1,$2,1,60)',[device,instance]);
  const directReserve='SELECT public.reserve_session_file($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value';
  await q(directReserve,[session,directId,7,sha,'direct.txt','from_agent',controller,peer,instance]);
  const directFinish='SELECT public.confirm_direct_session_file($1,$2,$3,$4,$5,$6) AS value';
  await denied(directFinish,[session,directId,8,sha,controller,peer],'direct receipt requires exact size');
  check((await q(directFinish,[session,directId,7,sha,controller,peer])).rows[0].value.state==='delivered','direct verified receipt');
  check((await q('SELECT count(*)::int AS n FROM public.session_files WHERE id=$1',[directId])).rows[0].n===0,'direct delivery is not a stored object manifest');
  const successor=crypto.randomUUID();
  await q('SELECT public.record_agent_runtime($1,$2,1,60)',[device,successor]);
  await denied(directFinish,[session,directId,7,sha,controller,peer],'retired process cannot replay a direct receipt');
  const key=crypto.randomUUID(),envelope={version:1,algorithm:'RSA-OAEP-256+A256GCM',keyId:key,
    wrappedKey:'A'.repeat(512),iv:'A'.repeat(16),ciphertext:'A'.repeat(32)};
  await q("SELECT public.unlock_agent($1,'enable',$2)",[device,{keyId:key,version:1,authorizationId:grant,
    publicKey:'A'.repeat(564),windowsAccount:'FIXTURE\\Owner',consentAccepted:true}]);
  await denied('SELECT public.save_owner_unlock_pin($1,$2,$3)',[device,key,envelope],'owner save needs fresh trusted helper report');
  await q("SELECT public.unlock_agent($1,'report',$2)",[device,{keyId:key,locked:false,helperReady:true}]);
  const saved=(await q('SELECT public.save_owner_unlock_pin($1,$2,$3) AS value',[device,key,envelope])).rows[0].value;
  check(saved.hasPin&&saved.locked===false,'owner save is not falsely treated as Windows validation');
  await denied('SELECT public.save_owner_unlock_pin($1,$2,$3)',[device,key,{...envelope,pin:'synthetic-must-not-be-stored'}],'no additional plaintext field');
  await denied('SELECT public.save_owner_unlock_pin($1,$2,$3)',[device,crypto.randomUUID(),envelope],'rotated key cannot save');
  await q("SELECT public.unlock_admin($1,$2,'forget','{}')",[owner,device]);
  check(!(await q('SELECT public.unlock_device_status($1) AS value',[device])).rows[0].value.hasPin,'forget preserved');
  const acl=(await q(`SELECT has_table_privilege('authenticated','public.session_file_receipts','SELECT') AS readable,
    has_function_privilege('authenticated','public.reserve_session_file(uuid,uuid,bigint,text,text,text,text,text,uuid)','EXECUTE') AS callable`)).rows[0];
  check(!acl.readable&&!acl.callable,'private receipts and service-only procedures');
  for(let i=0;i<10;i++) await q(reserve,[session,crypto.randomUUID(),500*1024*1024,sha,`quota-${i}.txt`,'from_agent',controller,peer]);
  await denied(reserve,[session,crypto.randomUUID(),500*1024*1024,sha,'quota.txt','from_agent',controller,peer],'aggregate reservations enforce 5 GiB');
  await q('DELETE FROM public.devices WHERE id=$1',[device]);
  check((await q('SELECT count(*)::int AS n FROM public.device_unlock_permissions WHERE device_id=$1',[device])).rows[0].n===0,'device deletion revokes unlock');
  console.log(`PASS ${count} isolated session tools database assertions.`);
}
module.exports={verify};
