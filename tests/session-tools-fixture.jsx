// DEVELOPMENT TEST ENTRY ONLY. No Supabase calls, credentials or customer sessions.
// Actual production components and browser protocols; only host/transport effects
// and fixture role selection are simulated. Not a Windows acceptance result.
import React, {useEffect,useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {SessionFilesMenu} from "../src/components/console/SessionFilesMenu";
import {RemoteFilesPanel} from "../src/components/console/RemoteFilesPanel";
import {SessionToolControls} from "../src/components/console/SessionToolControls";
import {SessionToolNav} from "../src/components/console/SessionToolNav";
import {createBrowserFileChannel} from "../src/lib/browser-file-channel";
import {createSessionToolsClient} from "../src/lib/browser-session-tools";
import {createBrowserActions} from "../src/lib/browser-actions";
import {downloadPresentedScreenshot} from "../src/lib/session-screenshot";
import {hashBlob,encodeFileChunk,decodeFileChunk,FileIntegrity,fileDescription} from "../src/lib/file-integrity";
import "../src/styles.css";

if(!import.meta.env.DEV) throw Error("This fixture is development-only.");
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ids={deviceId:crypto.randomUUID(),sessionId:crypto.randomUUID(),authorizationId:crypto.randomUUID(),controllerId:crypto.randomUUID()};
class Channel {
  readyState="open"; bufferedAmount=0; binaryType="arraybuffer"; onmessage=null; onopen=null; onclose=null;
  constructor(handle){this.handle=handle;}
  send(value){if(this.readyState!=="open")throw Error("Closed");queueMicrotask(()=>{void this.handle(value);});}
  receive(value){if(this.readyState==="open")this.onmessage?.({data:value});}
  close(){if(this.readyState==="closed")return;this.readyState="closed";this.onclose?.();}
}
function makePeer(role,settings,onChange){
  const binding={...ids,peerId:crypto.randomUUID()},events=new Set(),listeners=new Set();
  const peer={binding,role,active:true,protected:false,mic:false,micId:null,verification:null,
    cancelled:new Set(),curtain:false,paused:true,epoch:crypto.randomUUID(),revision:1,mode:"view",
    frames:0,presentedAt:0,received:[],sent:[],outgoing:null,ack:-2,lastInfo:null,corrupt:false};
  const canvas=document.createElement("canvas");canvas.width=1280;canvas.height=720;
  const stream=canvas.captureStream(12),video=document.createElement("video");
  video.muted=true;video.playsInline=true;video.srcObject=stream;void video.play();
  const frame=()=>({kind:"permission_status",session_id:ids.sessionId,authorization_id:ids.authorizationId,
    peer_id:binding.peerId,controller_id:binding.controllerId,process_id:binding.peerId,
    mode:peer.mode,permission_refresh_supported:true,curtain_supported:true,curtain_active:peer.curtain,
    input_pause_supported:true,input_pause_protocol:1,input_paused:peer.paused,input_epoch:peer.epoch,
    input_revision:peer.revision,input_release_confirmed:true});
  let actions;
  const input=new Channel(raw=>{
    const {kind,payload={}}=JSON.parse(raw);peer.sent.push(kind);
    if(kind==="permission_refresh"){peer.mode=payload.mode;actions.receive(JSON.stringify({...frame(),request_id:payload.request_id,status:"applied"}));}
    if(["curtain_on","curtain_off","curtain_renew"].includes(kind)){
      if(kind!=="curtain_renew")peer.curtain=kind==="curtain_on";
      actions.receive(JSON.stringify({...frame(),kind:"action_status",action:kind,request_id:payload.request_id,status:"applied",active:peer.curtain}));
    }
    if(kind==="input_pause"){
      peer.paused=payload.paused;peer.epoch=crypto.randomUUID();peer.revision++;
      actions.receive(JSON.stringify({...frame(),kind:"input_pause_status",action:kind,request_id:payload.request_id,status:"applied"}));
    }
    onChange();
  });
  actions=createBrowserActions(ids.sessionId,ids.authorizationId,()=>input,()=>peer.active,()=>peer.close(),
    {peerId:binding.peerId,controllerId:binding.controllerId});
  actions.receive(JSON.stringify(frame()));
  const fileWire=new Channel(async raw=>{
    if(typeof raw!=="string"){
      const packet=decodeFileChunk(raw);
      try{peer.incoming.integrity.append(packet.sequence,packet.bytes);
        sendFile("chunk_ack",{id:packet.id,sequence:packet.sequence});}
      catch{sendFile("error",{id:packet.id});}return;
    }
    const {type,value}=JSON.parse(raw);
    if(type==="hello")sendFile("ready",{protocol:settings.legacy?1:2});
    if(type==="begin"){const info=fileDescription(value);peer.incoming={info,integrity:new FileIntegrity(info)};
      sendFile("accepted",{id:info.id});}
    if(type==="end"){
      try{peer.incoming.integrity.finish(value.chunks,value.sha256);const info=peer.incoming.info;
        peer.received.push(info.name);sendFile("complete",{id:info.id,size:info.size,sha256:info.sha256});onChange();}
      catch{sendFile("error",{id:value.id});}
    }
    if(type==="accepted")peer.ack=-1;
    if(type==="chunk_ack")peer.ack=value.sequence;
    if(type==="complete"){peer.outgoing=null;peer.completed=true;}
    if(type==="error"||type==="cancel"){peer.cancelled.add(value.id);peer.outgoing=null;sendFile("cancelled",{id:value.id});}
  });
  const sendFile=(type,value)=>fileWire.receive(JSON.stringify({version:1,binding,type,value}));
  const files=createBrowserFileChannel(fileWire,binding,()=>peer.active,event=>{for(const cb of events)cb(event);},()=>!peer.protected&&role==="technician");
  async function transfer(id,entry){
    peer.outgoing=id;peer.ack=-2;
    const blob=entry.name==="large.bin"?new Blob([new Uint8Array(8*1024*1024).fill(37)]):new Blob(["hello\n"]);
    const sha=await hashBlob(blob,()=>peer.active&&!peer.cancelled.has(id));
    sendFile("begin",{id,name:entry.name,size:blob.size,sha256:sha,mime:"application/octet-stream"});
    let sequence=0;
    async function receipt(n){for(let t=0;peer.active&&!peer.cancelled.has(id)&&peer.ack<n&&t<200;t++)await wait(10);
      if(!peer.active||peer.cancelled.has(id)||peer.ack<n)throw Error("cancelled");}
    try{
      await receipt(-1);
      for(let start=0;start<blob.size;start+=16384){
        await wait(entry.name==="large.bin"?15:0);
        if(peer.cancelled.has(id)||!peer.active)throw Error("cancelled");
        const bytes=await blob.slice(start,start+16384).arrayBuffer();
        if(settings.corrupt&&sequence===0)new Uint8Array(bytes)[0]^=1;
        fileWire.receive(encodeFileChunk(id,sequence,bytes));await receipt(sequence++);
      }
      sendFile("end",{id,chunks:sequence,sha256:sha});
    }catch{sendFile("error",{id,reason:"file_cancelled"});}
  }
  const entries=[{name:"Reports",path:"Reports",directory:true,size:0,revision:"dir"},
    {name:"hello.txt",path:"hello.txt",directory:false,size:6,revision:"1"},
    {name:"large.bin",path:"large.bin",directory:false,size:8*1024*1024,revision:"1"}];
  const reply=(request,action,value,ok=true,error)=>toolsWire.receive(JSON.stringify({version:1,binding,requestId:request.requestId,action,ok,value,error}));
  const toolsWire=new Channel(async raw=>{
    const request=JSON.parse(raw),{action,requestId:id,payload={}}=request;peer.sent.push(action);
    if(action==="microphone_off"){peer.cancelled.add(peer.micId);peer.micId=null;peer.mic=false;
      reply(request,"microphone",{phase:"off"});onChange();return;}
    if(action==="verification_cancel"||action==="verification_finish"){
      peer.cancelled.add(id);peer.verification=null;peer.protected=false;
      reply(request,"verification",{phase:action==="verification_cancel"?"cancelled":"result_unconfirmed"});return;}
    if(action==="download_cancel"){peer.cancelled.add(payload.transferId);return;}
    if(settings.legacy){reply(request,action,null,false,"unsupported_agent");return;}
    if(role!=="technician"){reply(request,action,null,false,"permission_denied");return;}
    if(action==="status")reply(request,"status",{roots:[{id:"documents",name:"Owner-approved Documents"}],
      microphoneAllowed:settings.micConsent,setup:{localApproval:"required",helperInstallation:"unavailable",
        protectedIdentity:"unavailable",encryptionEnrollment:"unconfirmed",savedCredential:"unconfirmed",
        connectivity:"ready",lockScreen:"not_locked",appVerification:"on_device_only"}});
    if(action==="list"){
      if(settings.denyFiles){reply(request,"list",null,false,"permission_denied");return;}
      reply(request,"list",{rootId:payload.rootId,path:payload.path,
        entries:payload.path==="Reports"?[{...entries[1],path:"Reports/hello.txt"}]:payload.cursor?entries.slice(2):entries.slice(0,2),
        next:payload.path||payload.cursor?null:"second-page"});
    }
    if(action==="download"){
      if(settings.denyFiles){reply(request,"download",null,false,"permission_denied");return;}
      const entry=entries.find(e=>payload.path.endsWith(e.name));
      reply(request,"download",{transferId:payload.transferId,state:"accepted"});void transfer(payload.transferId,entry);
    }
    if(action==="microphone_on"){
      peer.micId=id;await wait(650);
      if(peer.micId!==id)return reply(request,action,null,false,"request_cancelled");
      peer.mic=settings.micConsent;reply(request,"microphone",{phase:peer.mic?"sharing":"permission_denied"});onChange();
    }
    if(action==="microphone_renew"&&peer.mic&&peer.micId===id)reply(request,"microphone",{phase:"sharing"});
    if(action==="verification_begin"){peer.verification=id;peer.protected=true;peer.mic=false;peer.micId=null;
      peer.mode="view";peer.paused=true;reply(request,"verification",{phase:"approval_required"});onChange();}
  });
  const audio=document.createElement("audio");
  // Synthetic audio only: never call getUserMedia or connect a real microphone.
  const audioContext=new AudioContext(),oscillator=audioContext.createOscillator(),destination=audioContext.createMediaStreamDestination();
  oscillator.frequency.value=220;const gain=audioContext.createGain();gain.gain.value=.005;
  oscillator.connect(gain);gain.connect(destination);oscillator.start();audio.srcObject=destination.stream;
  const tools=createSessionToolsClient(toolsWire,binding,()=>peer.active,files,async()=>{
    if(peer.curtain)throw Error("Turn the curtain off explicitly first.");
    peer.protected=true;files.suspend();await tools.microphone(false);peer.mode="view";peer.paused=true;onChange();
  },audio);
  tools.onState(state=>{peer.toolState=state;peer.protected=["in_progress","approval_required"].includes(state.verification);onChange();});
  const draw=setInterval(()=>{
    if(!peer.active||peer.freeze||peer.protected)return;
    peer.frames++;const c=canvas.getContext("2d");c.fillStyle="#142b48";c.fillRect(0,0,1280,720);
    c.fillStyle="#fff";c.font="30px sans-serif";c.fillText("SYNTHETIC REMOTE DISPLAY — NO WINDOWS HOST",45,85);
    c.fillText(`Frame ${peer.frames} | Control ${peer.paused?"paused":"active"}`,45,145);
    c.fillStyle="#4f7cff";c.fillRect(peer.frames*15%1100,280,100,100);
  },80);
  let presented;
  function presentation(){peer.presentedAt=Date.now();presented=video.requestVideoFrameCallback(presentation);}
  presented=video.requestVideoFrameCallback(presentation);
  peer.live={sessionId:ids.sessionId,peerId:()=>binding.peerId,onFile:cb=>{events.add(cb);return()=>events.delete(cb);},
    video,filesReady:files.ready,sendFile:files.sendFile};
  Object.assign(peer,{tools,files,actions,video,audioContext,localStop(){
    const id=peer.micId;peer.micId=null;peer.mic=false;if(id)reply({requestId:id},"microphone",{phase:"locally_stopped"});onChange();
  },close(){
    if(!peer.active)return;tools.close();files.close();actions.dispose();peer.active=false;peer.mic=false;peer.curtain=false;peer.paused=true;
    clearInterval(draw);video.cancelVideoFrameCallback(presented);stream.getTracks().forEach(t=>t.stop());
    oscillator.stop();void audioContext.close();onChange();
  }});
  fileWire.onopen?.();void tools.refresh().catch(()=>{});return peer;
}
function App(){
  const [role,setRole]=useState(null),[peer,setPeer]=useState(null),[,render]=useState(0),[tool,setTool]=useState("screen"),
    [mode,setMode]=useState("browse"),[message,setMessage]=useState(""),[fullscreen,setFullscreen]=useState(false);
  const container=useRef(null),videoHost=useRef(null),settings=useRef({micConsent:true,legacy:false,corrupt:false,denyFiles:false});
  useEffect(()=>{if(peer&&videoHost.current){videoHost.current.replaceChildren(peer.video);peer.video.style="width:100%;height:100%;object-fit:contain";}},[peer]);
  useEffect(()=>()=>peer?.close(),[peer]);
  useEffect(()=>{const listener=()=>setFullscreen(!!document.fullscreenElement);document.addEventListener("fullscreenchange",listener);
    return()=>document.removeEventListener("fullscreenchange",listener);},[]);
  const connect=nextRole=>{peer?.close();setRole(nextRole);const p=makePeer(nextRole,settings.current,()=>render(n=>n+1));setPeer(p);
    window.sessionToolsFixture=p;setMessage("");};
  const protectedMedia=!!peer?.protected,allowed=role==="technician"&&peer?.active;
  const act=fn=>void Promise.resolve().then(fn).catch(e=>setMessage(e.message));
  async function screenshot(){
    await downloadPresentedScreenshot({sessionId:ids.sessionId,authorize:async()=>{
      if(!allowed||protectedMedia)throw Error("Screenshot permission denied.");
    },surface:()=>peer?.active?{source:peer.video,width:peer.video.videoWidth,height:peer.video.videoHeight,
      identity:peer.binding.peerId,presentedAt:peer.presentedAt}:null,current:()=>peer?.active&&!peer.protected&&role==="technician"});
    setMessage("PNG downloaded at the presented 1280 × 720 resolution.");
  }
  return <div ref={container} style={{minHeight:"100vh",background:"#080f1d",color:"white",padding:16,fontFamily:"sans-serif",overflow:"auto"}}>
    <style>{`button.fixture{background:#263951;color:white;border:1px solid #50637b;padding:7px 10px;margin:3px;border-radius:5px}
      .fixture-grid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:18px}.fixture-view{height:420px;background:#020608}
      @media(max-width:760px){.fixture-grid{display:block}.fixture-view{height:250px}}`}</style>
    <h1 style={{fontSize:20}}>Isolated session tools verification</h1>
    <p style={{fontSize:12,marginBottom:12}}>Synthetic role login, files, audio and host receipts. No shared database, customer session or Windows hardware.</p>
    {!role?<div><button className="fixture" onClick={()=>connect("technician")}>Sign in as synthetic technician</button>
      <button className="fixture" onClick={()=>connect("viewer")}>Sign in as synthetic viewer</button></div>:<>
      <p data-testid="fixture-role">Signed in: {role}</p>
      <button className="fixture" onClick={()=>{peer.close();setRole(null);setPeer(null);}}>Sign out</button>
      <button className="fixture" onClick={()=>connect(role)}>Disconnect and reconnect</button>
      <button className="fixture" onClick={()=>peer.localStop()}>Simulate local microphone stop</button>
      <button className="fixture" onClick={()=>{peer.freeze=!peer.freeze;setMessage(peer.freeze?"Frame source frozen":"Frames resumed");}}>Freeze or resume frames</button>
      <button className="fixture" onClick={()=>act(async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await container.current.requestFullscreen();})}>Fullscreen</button>
      <div>{[["micConsent","Owner microphone consent"],["legacy","Older Agent"],["denyFiles","Deny remote files"],["corrupt","Corrupt next download"]].map(([key,label])=>
        <label key={key} style={{display:"inline-block",fontSize:12,margin:6}}><input type="checkbox" defaultChecked={settings.current[key]}
          onChange={e=>{settings.current[key]=e.target.checked;void peer.tools.refresh().catch(()=>{});}}/> {label}</label>)}</div>
      <p role="status" data-testid="fixture-message">{message}</p>
      <div className="fixture-grid"><main>
        <div ref={videoHost} className="fixture-view"/>
        <p data-testid="fixture-capture">Frames {peer.frames} · Curtain {peer.curtain?"on":"off"} · Input {peer.paused?"paused":"active"} · Host mic {peer.mic?"active":"off"}</p>
        <button className="fixture" disabled={!allowed||protectedMedia} onClick={()=>act(async()=>{
          await peer.actions.refreshMode("control",new AbortController().signal);
          await peer.actions.inputPause.setPaused(false);
        })}>Explicitly resume control</button>
        <button className="fixture" disabled={!allowed||protectedMedia} onClick={()=>act(()=>peer.actions.inputPause.setPaused(true))}>Pause input only</button>
        <button className="fixture" disabled={!allowed||protectedMedia} onClick={()=>act(()=>peer.actions.setCurtain(!peer.curtain))}>Toggle curtain explicitly</button>
        {tool==="files"&&mode==="browse"&&<RemoteFilesPanel tools={peer.tools} live={peer.live} allowed={allowed&&!protectedMedia}/>}
        {tool==="files"&&mode==="send"&&<section><h2>Send synthetic files</h2><input aria-label="Select files to send" type="file" disabled={!allowed||protectedMedia}
          onChange={e=>{const file=e.target.files?.[0];if(file)act(async()=>{await peer.files.sendFile(file);setMessage(`Agent verified ${file.name}`);});}}/></section>}
        {tool==="files"&&mode==="history"&&<section><h2>Transfer history</h2><p>Verified synthetic uploads: {peer.received.join(", ")||"None"}</p></section>}
      </main><aside>
        <SessionFilesMenu filesDisabled={!allowed||protectedMedia} screenshotDisabled={!allowed||protectedMedia}
          portalContainer={fullscreen?container.current:null}
          onBrowse={()=>{setMode("browse");setTool("files");}} onSend={()=>{setMode("send");setTool("files");}}
          onHistory={()=>{setMode("history");setTool("files");}} onScreenshot={()=>act(screenshot)}/>
        <SessionToolNav value={tool} onChange={setTool}/>
        <SessionToolControls tools={peer.tools} allowed={allowed} protectedMedia={protectedMedia}
          onBeginVerification={async()=>{if(peer.curtain)throw Error("Turn the curtain off explicitly first.");peer.paused=true;peer.mode="view";}}/>
      </aside></div>
    </>}
  </div>;
}
createRoot(document.getElementById("root")).render(<App/>);
