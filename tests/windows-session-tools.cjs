const assert=require('node:assert/strict');
const {test}=require('node:test');
const crypto=require('node:crypto');
const fs=require('node:fs');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const {load,routeFixture}=require('./helpers/agent-http.cjs');
const appRequire=createRequire(path.resolve('package.json'));
const common={Blob,File,ArrayBuffer,Uint8Array,DataView,Buffer,TextEncoder,TextDecoder,AbortController,
  DOMException,crypto:crypto.webcrypto,URL,setTimeout:(fn,ms)=>{const id=setTimeout(fn,ms);id.unref();return id;},
  clearTimeout,setInterval,clearInterval,queueMicrotask};
const shared=load('shared/session-tools.ts');
const spool=load('lib/file-spool.server.ts',Object.fromEntries(
  ['node:fs','node:fs/promises','node:os','node:path','node:crypto'].map(name=>[name,require(name)])),{console});
const safeName=name=>(name||'file').replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180);
function uploadFixture(options={}) {
  const objects=new Map(),receipts=new Map(),manifests=[],removed=[],uploads=[];
  let allowed=true;
  const session=crypto.randomUUID(),device=crypto.randomUUID(),controller=crypto.randomUUID(),peer=crypto.randomUUID();
  const id=crypto.randomUUID(),bytes=Buffer.alloc(4*1024*1024+7,0x45),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  const bucket={
    async upload(key,blob){uploads.push(key);if(objects.has(key))return {error:{message:'exists'}};
      objects.set(key,new Blob([await blob.arrayBuffer()]));return {error:null};},
    async download(key){
      if(options.readFailure&&key.endsWith('/000000'))return {data:null,error:{}};
      if(options.revokeOnRead)allowed=false;
      const data=objects.get(key);return {data,error:data?null:{}};
    },
    async list(prefix){
      if(options.listFailure)return {data:null,error:{}};
      let data=[...objects.keys()].filter(key=>key.startsWith(prefix+'/')).map(key=>({name:key.slice(prefix.length+1)})).sort((a,b)=>a.name.localeCompare(b.name));
      if(options.missingPart)data=data.filter(row=>row.name!=='000000');
      return {data,error:null};
    },
    async remove(paths){removed.push(...paths);paths.forEach(p=>objects.delete(p));return {error:null};},
  };
  const db={
    from(){return {select(){return this;},eq(){return this;},async maybeSingle(){
      return {data:{id:session,device_id:device,admin_client_id:controller},error:null};
    }};},
    storage:{from:()=>bucket},
    async rpc(name,args){
      if(!allowed)return {data:null,error:{code:'42501'}};
      if(name==='reserve_session_file'){
        const old=receipts.get(args._id);
        if(old&&old.sha!==args._sha)return {error:{}};
        const row=old??{state:'reserved',id:args._id,path:`${session}/${args._id}-${args._name}`,sha:args._sha};
        receipts.set(args._id,row);return {data:row,error:null};
      }
      if(name==='complete_session_file'){
        if(options.receiptFailure)return {error:{}};
        const row=receipts.get(args._id);row.state='complete';manifests.push(row);return {data:row,error:null};
      }
      throw Error('Unexpected fixture RPC');
    },
  };
  const handler=load('lib/agent-file-upload.server.ts',{
    './authorization.server':{sessionAuthorized:async()=>allowed},
    './session-files.server':{BUCKET:'files',MAX_FILE_BYTES:shared.MAX_FILE_BYTES,safeName},
    './file-spool.server':spool,
  },common).receiveAgentFile;
  return {objects,receipts,manifests,removed,uploads,bytes,id,session,peer,controller,setAllowed:value=>allowed=value,
    async call(seq,eof,body=bytes.subarray(seq*4*1024*1024,(seq+1)*4*1024*1024),override={}){
      const request=new Request(`https://fixture.invalid/api/file?fileId=${id}&seq=${seq}${eof?'&eof=1':''}`,{
        method:'POST',body,headers:{'x-file-size':String(bytes.length),'x-file-sha256':sha,
          'x-file-name':'fixture.bin','x-file-controller':controller,'x-file-peer':peer,...override},
      });
      return handler(request,session,db,device);
    },
  };
}
test('HTTP completes only with exact length, complete sequence and checksum; duplicate EOF is safe',async()=>{
  const f=uploadFixture();
  assert.equal((await f.call(0,false)).status,200);
  const response=await f.call(1,true),receipt=await response.json();
  assert.equal(receipt.state,'complete');assert.equal(receipt.size,f.bytes.length);
  assert.equal(f.manifests.length,1);assert.equal(f.removed.length,2);
  assert.deepEqual(Buffer.from(await f.objects.get(receipt.path).arrayBuffer()),f.bytes);
  assert.equal((await (await f.call(1,true)).json()).state,'complete');
  assert.equal(f.manifests.length,1);
});
for(const [name,option] of [['listing failure','listFailure'],['missing part','missingPart'],['failed read','readFailure'],
  ['authority loss during assembly','revokeOnRead'],['uncertain manifest','receiptFailure']])
test(`HTTP ${name} preserves recoverable parts and never reports completion`,async()=>{
  const f=uploadFixture({[option]:true});await f.call(0,false);
  const response=await f.call(1,true),body=await response.json();
  assert.equal(body.ok,false);assert.equal(f.manifests.length,0);assert.equal(f.removed.length,0);
  assert(f.objects.size>=2);assert.notEqual(body.state,'complete');
});
test('HTTP rejects wrong lengths, skipped sequence, checksum corruption and withdrawn authority',async()=>{
  let f=uploadFixture();
  assert.equal((await f.call(0,false,Buffer.from('short'))).status,409);
  assert.equal((await f.call(1,false)).status,400);
  f=uploadFixture();await f.call(0,false);f.objects.set(`${f.session}/parts/${f.id}/000000`,new Blob([Buffer.alloc(4*1024*1024)]));
  assert.equal((await (await f.call(1,true)).json()).error,'file_integrity_failed');
  assert.equal(f.manifests.length,0);assert.equal(f.removed.length,0);
  f.setAllowed(false);assert.equal((await (await f.call(1,true)).json()).error,'authorization_changed');
});
const integrityPromise=import(pathToFileURL(appRequire.resolve('@noble/hashes/sha2.js')).href).then(hash=>load('lib/file-integrity.ts',{
  '@noble/hashes/sha2.js':hash,'@/shared/session-tools':shared,
},common));
test('actual TypeScript file protocol rejects sequence gaps, duplicates, overrun and bad digest',async()=>{
  const m=await integrityPromise,bytes=new TextEncoder().encode('fixture');
  const info={id:crypto.randomUUID(),name:'fixture.txt',size:bytes.length,mime:'text/plain',sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  const f=new m.FileIntegrity(info),packet=m.decodeFileChunk(m.encodeFileChunk(info.id,0,bytes.buffer));
  assert.equal(packet.id,info.id);assert.equal(packet.sequence,0);f.append(0,packet.bytes);f.finish(1,info.sha256);
  assert.throws(()=>m.decodeFileChunk(new ArrayBuffer(43)));
  assert.throws(()=>new m.FileIntegrity(info).append(1,bytes));
  const duplicate=new m.FileIntegrity({...info,size:bytes.length*2});duplicate.append(0,bytes);assert.throws(()=>duplicate.append(0,bytes));
  assert.throws(()=>new m.FileIntegrity(info).append(0,new Uint8Array(100)));
  assert.throws(()=>new m.FileIntegrity(info).finish(0,info.sha256));
});
test('actual browser receiver has no complete event on truncated or cancelled transfer',async()=>{
  const integrity=await integrityPromise;
  const binding={deviceId:crypto.randomUUID(),sessionId:crypto.randomUUID(),authorizationId:crypto.randomUUID(),
    controllerId:crypto.randomUUID(),peerId:crypto.randomUUID()};
  const mod=load('lib/browser-file-channel.ts',{'./file-integrity':integrity,'@/shared/session-tools':shared},{...common,navigator:{storage:{}}});
  for(const truncated of [false,true]){
    const channel={readyState:'open',send(){},close(){this.readyState='closed';}},events=[];
    const client=mod.createBrowserFileChannel(channel,binding,()=>true,event=>events.push(event));
    const send=(type,value)=>channel.onmessage({data:JSON.stringify({version:1,binding,type,value})});
    send('ready',{protocol:2});await new Promise(r=>setImmediate(r));
    const id=crypto.randomUUID(),bytes=new TextEncoder().encode('fixture'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
    const received=client.expect(id);void received.catch(()=>{});
    send('begin',{id,name:'fixture.txt',mime:'text/plain',size:bytes.length,sha256:sha});
    await new Promise(r=>setImmediate(r));
    if(!truncated)channel.onmessage({data:integrity.encodeFileChunk(id,0,bytes.buffer)});
    send('end',{id,chunks:1,sha256:sha});
    if(truncated){await assert.rejects(received);assert(!events.some(e=>e.kind==='complete'));}
    else{assert.equal(await (await received).text(),'fixture');assert(events.some(e=>e.kind==='complete'));}
    client.close();
  }
});
test('microphone and verification actions are explicit, bound and do not replay on close',async()=>{
  const binding={deviceId:crypto.randomUUID(),sessionId:crypto.randomUUID(),authorizationId:crypto.randomUUID(),
    controllerId:crypto.randomUUID(),peerId:crypto.randomUUID()};
  const sent=[],audio={muted:true,play:async()=>{},pause(){},srcObject:null};
  let connected=true,prepared=0;
  const channel={readyState:'open',close(){this.readyState='closed';},send(raw){
    const request=JSON.parse(raw);sent.push(request);
    let action=request.action,value={};
    if(action==='status')value={roots:[],microphoneAllowed:true,setup:null};
    if(action.startsWith('microphone_')){action='microphone';value={phase:request.action==='microphone_off'?'off':'sharing'};}
    if(action==='verification_begin'){action='verification';value={phase:'approval_required'};}
    queueMicrotask(()=>channel.onmessage?.({data:JSON.stringify({version:1,binding,requestId:request.requestId,action,ok:true,value})}));
  }};
  const module=load('lib/browser-session-tools.ts',{'@/shared/session-tools':shared},common);
  const tools=module.createSessionToolsClient(channel,binding,()=>connected,{expect:async()=>new Blob(),cancel(){}},async()=>{prepared++;},audio);
  await tools.refresh();assert.equal(tools.state().microphone,'off');assert(!sent.some(r=>r.action==='microphone_on'));
  await tools.microphone(true);assert.equal(tools.state().microphone,'sharing');assert.equal(audio.muted,false);
  await tools.microphone(false);assert.equal(tools.state().microphone,'off');assert.equal(audio.muted,true);
  await tools.verifyOnDevice('passkey');assert.equal(prepared,1);assert.equal(tools.state().verification,'approval_required');
  assert(!sent.some(r=>/pin|credential/.test(r.action)));tools.finishVerification();
  assert.equal(tools.state().verification,'result_unconfirmed');
  const before=sent.filter(r=>r.action==='microphone_on').length;
  tools.close();connected=false;assert.equal(sent.filter(r=>r.action==='microphone_on').length,before);
});
test('pending verification cancellation and delayed microphone receipts cannot restart sharing',async()=>{
  const binding={deviceId:crypto.randomUUID(),sessionId:crypto.randomUUID(),authorizationId:crypto.randomUUID(),
    controllerId:crypto.randomUUID(),peerId:crypto.randomUUID()};
  const sent=[],audio={muted:true,play:async()=>{},pause(){}};
  const channel={readyState:'open',close(){this.readyState='closed';},send(raw){sent.push(JSON.parse(raw));}};
  let prepare;
  const mod=load('lib/browser-session-tools.ts',{'@/shared/session-tools':shared},common);
  const tools=mod.createSessionToolsClient(channel,binding,()=>true,{cancel(){}},()=>new Promise(resolve=>prepare=resolve),audio);
  const receive=(request,action,value)=>channel.onmessage({data:JSON.stringify({version:1,binding,requestId:request.requestId,action,ok:true,value})});
  const status=tools.refresh();receive(sent.at(-1),'status',{roots:[],microphoneAllowed:true});await status;
  const listening=tools.microphone(true),on=sent.at(-1);
  const stopping=tools.microphone(false),off=sent.at(-1);
  assert.notEqual(on.requestId,off.requestId);
  receive(off,'microphone',{phase:'off'});await stopping;
  receive(on,'microphone',{phase:'sharing'});await listening;
  assert.equal(tools.state().microphone,'off');assert.equal(audio.muted,true);
  const verifying=tools.verifyOnDevice('passkey');tools.cancelVerification();prepare();
  await assert.rejects(verifying);assert.equal(tools.state().verification,'cancelled');
  assert(!sent.some(request=>request.action==='verification_begin'));tools.close();
});
test('screenshot exports native surface only and rejects stale, protected or changed identity',async()=>{
  let clicks=0,drawn=null,width=0;
  const module=load('lib/session-screenshot.ts',{},{
    ...common,document:{createElement(tag){
      if(tag==='a')return {click(){clicks++;}};
      return {set width(value){if(value)width=value;},set height(value){},getContext(){return {drawImage(...args){drawn=args;}};},
        toBlob(cb){cb(new Blob(['synthetic-png'],{type:'image/png'}));}};
    }},
  });
  const source={},surface={source,width:1366,height:768,presentedAt:Date.now(),identity:'peer'};
  await module.downloadPresentedScreenshot({sessionId:crypto.randomUUID(),authorize:async()=>{},surface:()=>surface,current:()=>true});
  assert.equal(width,1366);assert.equal(drawn[0],source);assert.equal(clicks,1);
  await assert.rejects(module.downloadPresentedScreenshot({sessionId:'id',authorize:async()=>{},surface:()=>({...surface,presentedAt:Date.now()-5000}),current:()=>true}));
  let allowed=true;
  await assert.rejects(module.downloadPresentedScreenshot({sessionId:'id',authorize:async()=>{allowed=false;},surface:()=>surface,current:()=>allowed}));
  let identity='peer';
  await assert.rejects(module.downloadPresentedScreenshot({sessionId:'id',authorize:async()=>{identity='replacement';},surface:()=>({...surface,identity}),current:()=>true}));
  assert.equal(clicks,1);
});
test('retired-peer microphone receipts cannot revive a closed client or satisfy its replacement',async()=>{
  const binding={deviceId:crypto.randomUUID(),sessionId:crypto.randomUUID(),authorizationId:crypto.randomUUID(),
    controllerId:crypto.randomUUID(),peerId:crypto.randomUUID()};
  const module=load('lib/browser-session-tools.ts',{'@/shared/session-tools':shared},common);
  function create(current) {
    const sent=[],audio={muted:true,play:async()=>{},pause(){}};
    const channel={readyState:'open',send(raw){sent.push(JSON.parse(raw));},close(){this.readyState='closed';}};
    const tools=module.createSessionToolsClient(channel,current,()=>true,{cancel(){}},async()=>{},audio);
    const receive=(id,action,value,from=current)=>channel.onmessage({data:JSON.stringify({
      version:1,binding:from,requestId:id,action,ok:true,value,
    })});
    return {tools,channel,sent,audio,receive};
  }
  const first=create(binding),initial=first.tools.refresh();
  first.receive(first.sent.at(-1).requestId,'status',{roots:[],microphoneAllowed:true});await initial;
  const pending=first.tools.microphone(true),oldId=first.sent.at(-1).requestId;
  const rejected=assert.rejects(pending);first.tools.close();await rejected;
  first.receive(oldId,'microphone',{phase:'sharing'});
  assert.notEqual(first.tools.state().microphone,'sharing');assert.equal(first.audio.muted,true);
  const nextBinding={...binding,peerId:crypto.randomUUID()},next=create(nextBinding),status=next.tools.refresh();
  next.receive(next.sent.at(-1).requestId,'status',{roots:[],microphoneAllowed:true});await status;
  assert.equal(next.tools.state().microphone,'off');
  assert(!next.sent.some(request=>request.action==='microphone_on'));
  const listening=next.tools.microphone(true),id=next.sent.at(-1).requestId;
  next.receive(id,'microphone',{phase:'sharing'},binding);
  assert.equal(next.tools.state().microphone,'requesting');assert.equal(next.audio.muted,true);
  next.receive(id,'microphone',{phase:'sharing'});await listening;
  assert.equal(next.tools.state().microphone,'sharing');next.tools.close();
});
test('optional command lookup deadline retains authority and does not dispatch missing commands',async()=>{
  const f=routeFixture('heartbeat',{stall:'commands_lookup'});
  const pending=f.call();for(let n=0;n<120;n++)await Promise.resolve();
  f.advance(1000);
  const response=await pending,body=await response.json();
  assert.equal(response.status,200);assert(body.is_session_active);assert(body.reporting_warnings.includes('commands_deferred'));
  assert.deepEqual(body.power_commands,[]);assert(!f.writes.some(w=>w.table==='power_commands'));
});
test('legacy grant parser stays exact and new capabilities use a separate versioned channel',()=>{
  const grant=fs.readFileSync('agent/src/AuthorizationGrant.cs','utf8');
  assert(!grant.includes('microphone'));assert(!grant.includes('Folders'));
  const tools=fs.readFileSync('agent/src/WebRtcSession.Tools.cs','utf8');
  assert(tools.includes('session-tools-v1')&&tools.includes('files-v2'));
  const verification=fs.readFileSync('agent/src/SessionToolsConnection.cs','utf8');
  assert(!verification.includes('OpenPin')&&!verification.includes('sealedPin'));
});
