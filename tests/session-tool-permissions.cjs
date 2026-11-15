const assert=require('node:assert/strict');
const {test}=require('node:test');
const {randomUUID}=require('node:crypto');
const {createRequire}=require('node:module');
const path=require('node:path');
const {load}=require('./helpers/agent-http.cjs');
const requireApp=createRequire(path.resolve('package.json'));
function fixture(){
  const ids={sessionId:randomUUID(),deviceId:randomUUID(),authorizationId:randomUUID(),controllerId:randomUUID(),peerId:randomUUID()};
  const user=randomUUID(),instance=randomUUID(),license=randomUUID();
  const rows={
    sessions:[{id:ids.sessionId,device_id:ids.deviceId,authorization_id:ids.authorizationId,
      admin_client_id:ids.controllerId,technician_id:user,state:'active',mode:'view'}],
    user_roles:[{user_id:user,role:'technician'}],
    session_signals:[{session_id:ids.sessionId,from_side:'admin',kind:'offer',admin_client_id:ids.controllerId,payload:{peer_id:ids.peerId}}],
    agent_runtime:[{device_id:ids.deviceId,agent_instance:instance,agent_state:'running'}],
    licenses:[{id:license,status:'active'}],
  };
  const f={ids,user,instance,license,rows,allowed:true,licenseState:'active',fail:null,scopes:[]};
  f.db={from(table){
    const filters=[],query={
      select(){return this;},eq(key,value){filters.push([key,value]);return this;},order(){return this;},limit(){return this;},
      result(single){const values=(rows[table]??[]).filter(r=>filters.every(([k,v])=>r[k]===v));
        return {data:single?values[0]??null:values,error:f.fail===table?{}:null};},
      async maybeSingle(){return this.result(true);},then(a,b){return Promise.resolve(this.result(false)).then(a,b);},
    };return query;
  }};
  f.authorized=async(_,__,scope)=>{f.scopes.push(scope);return f.allowed;};
  return f;
}
test('screenshot authority requires current role, export grant, session, controller and peer',async()=>{
  const f=fixture();
  const createServerFn=()=>{let schema;return {middleware(){return this;},inputValidator(s){schema=s;return this;},
    handler(fn){return async args=>fn({...args,data:schema.parse(args.data)});}};};
  const mod=load('lib/screenshot.functions.ts',{
    '@tanstack/react-start':{createServerFn},zod:requireApp('zod'),
    '@/integrations/supabase/auth-middleware':{requireSupabaseAuth:{}},
    './authorization.server':{sessionAuthorized:f.authorized},
  });
  const call=(overrides={})=>mod.authorizeSessionScreenshot({data:{...f.ids,...overrides},context:{userId:f.user,supabase:f.db}});
  assert.equal((await call()).ok,true);assert(f.scopes.includes('recording'));
  await assert.rejects(call({controllerId:randomUUID()}));
  await assert.rejects(call({deviceId:randomUUID()}));
  await assert.rejects(call({authorizationId:randomUUID()}));
  await assert.rejects(call({peerId:randomUUID()}));
  f.rows.user_roles[0].role='viewer';await assert.rejects(call());f.rows.user_roles[0].role='technician';
  f.allowed=false;await assert.rejects(call());f.allowed=true;
  f.rows.sessions[0].state='ended';await assert.rejects(call());f.rows.sessions[0].state='active';
  f.fail='session_signals';await assert.rejects(call());
  f.fail=null;await assert.rejects(call({extraPrivilege:true}));
});
test('tool permissions fail closed on role, grant, license, process, peer and controller changes',async()=>{
  const f=fixture();
  const mod=load('routes/api/public/agent/session.$sessionId.permission.ts',{
    '@tanstack/react-router':{createFileRoute:()=>config=>config},
    '@/lib/agent-auth.server':{verifyDevice:async()=>({kind:'verified',admin:f.db,device:{id:f.ids.deviceId,license_id:f.license}}),
      deviceAuthFailure:()=>new Response(null,{status:401})},
    '@/lib/authorization.server':{sessionAuthorized:f.authorized},
    '@/shared/signaling-identity':load('shared/signaling-identity.ts'),
    '@/lib/licensing.server':{evaluateLicense:async()=>({state:f.licenseState})},
  },{URL});
  const call=(extra={})=>{
    const query=new URLSearchParams({mode:'view',authorization_id:f.ids.authorizationId,admin_client_id:f.ids.controllerId,
      instance:f.instance,peer_id:f.ids.peerId,tool_scope:'files',...extra});
    return mod.Route.server.handlers.GET({request:new Request(`https://fixture.invalid/permission?${query}`),params:{sessionId:f.ids.sessionId}});
  };
  assert.equal((await call()).status,200);assert(f.scopes.includes('files'));
  assert.equal((await call({tool_scope:'microphone'})).status,200);assert(f.scopes.includes('view'));
  for(const params of [{peer_id:randomUUID()},{admin_client_id:randomUUID()},{instance:randomUUID()},{authorization_id:randomUUID()}])
    assert.equal((await call(params)).status,409);
  assert.equal((await call({tool_scope:'arbitrary_privilege'})).status,400);
  f.rows.user_roles[0].role='viewer';assert.equal((await call()).status,403);
  f.rows.user_roles[0].role='technician';f.licenseState='expired';assert.equal((await call()).status,403);
  f.licenseState='active';f.allowed=false;assert.equal((await call()).status,403);
  f.allowed=true;f.fail='agent_runtime';assert.equal((await call()).status,503);
});
