import {captureTimeManager} from './x87res-tm.mjs';

const V6='1fc9d0efb6fa1338f3de3f2c588ce7015c39422013f3f234719ac5e89e121424';
const BASE_SHA='8b808c330b63a6e9e1843e1fa2895957267546ed6b14bcc2f2d80b03b495c20d';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export function installDiag(){
 const params=new URLSearchParams(location.search);
 const opt={thunks:params.get('diagThunks')!=='0',api:params.get('diagApi')!=='0',dispatch:params.get('diagDispatch')==='1'};
 document.title='[C Diagnose] '+document.title;
 const session='diag-'+new Date().toISOString().replace(/[:.]/g,'-');
 const box=document.createElement('div');box.id='x87diag-box';
 box.style.cssText='position:fixed;right:10px;bottom:46px;z-index:2147483002;background:#101820e6;color:#dff;font:12px ui-monospace,monospace;padding:6px 9px;border:1px solid #4a7090;border-radius:6px;white-space:pre;pointer-events:none';
 box.textContent='Diagnose: wartet auf Spielstart';document.body.append(box);
 let posted=0,failed=0,marks=0,lastFps=null,lastMark='';
 const post=async rec=>{try{const r=await fetch('x87res-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session,...rec})});if(r.ok)posted++;else failed++;}catch{failed++;}};
 const show=()=>{box.textContent=`[C Diagnose] ${lastFps==null?'—':lastFps.toFixed(1)} FPS\nLog: ${posted} ok, ${failed} Fehler · Marken ${marks}${lastMark?'\nletzte Marke: '+lastMark:''}\nF8 = Zeitmarke · Datei live-ab-logs/live-ab-${session}.jsonl`;};
 addEventListener('keydown',e=>{if(e.code==='F8'){e.preventDefault();e.stopPropagation();marks++;lastMark=new Date().toLocaleTimeString();void post({kind:'mark',n:marks,utc:new Date().toISOString(),t:performance.now()});show();}},true);
 const run=async(cmd,...args)=>{const r=await __BS__.harness.__runSteps([{cmd,args}]);if(!r.ok||!r.steps?.[0]?.ok)throw Error(r.steps?.[0]?.error?.message??'Testanfrage fehlgeschlagen');return r.steps[0].result;};
 const worker=code=>run('evalWorker',code);
 window.__x87diag={session,opt,state:'waiting'};
 (async()=>{
  while(window.scpTest?.phase!=='playing'||!window.__BS__?.harness)await sleep(250);
  const ident=await worker(`return {sha:globalThis.__v86EngineLoad?.sha256,mode:globalThis.preemption?.getWasmExports?.().get_jit_x87_mixed_residency?.()??null};`);
  let audio={armed:false};
  try{
   await worker(`const sys=System.getInstance(),d=sys.process.dispatcher,sch=sys.scheduler;if(!state.__audioObs){const o={counts:{},switches:{},orig:d.onThreadSwitch};d.onThreadSwitch=function(oldId,newId){const n=this.lastThunkNameAfterReturn||this.lastThunkName||'';o.switches[oldId]=(o.switches[oldId]||0)+1;if(/^dsound:/i.test(n))o.counts[oldId]=(o.counts[oldId]||0)+1;return o.orig.call(this,oldId,newId);};state.__audioObs=o;}return true;`);
   await sleep(3000);
   const obs=await worker(`const o=state.__audioObs,d=System.getInstance().process.dispatcher;d.onThreadSwitch=o.orig;delete state.__audioObs;return {counts:o.counts,switches:o.switches};`);audio.observed=obs.counts;audio.switchesOut=obs.switches;
   const ids=Object.entries(audio.observed).filter(([id,n])=>n>=3).map(([id])=>Number(id));
   audio.targets=ids;
   const t0=Date.now();
   while(Date.now()-t0<15000){
    const r=await worker(`const sch=System.getInstance().scheduler,ids=${JSON.stringify(ids)};state.__audioOff=state.__audioOff||{suspended:{}};const out=[];
     for(const id of ids){if(state.__audioOff.suspended[id]){out.push({id,done:true});continue;}const t=sch.threads.get(id);if(!t){out.push({id,missing:true});continue;}
      if(t.suspendCount===0&&t.state===3&&t.waitInfo?.reason===1&&(t.kernelPinCount??0)===0&&t.id!==sch.currentThreadId){const prev=sch.suspendThread(t.handle);if(prev===0&&t.suspendCount===1){state.__audioOff.suspended[id]={handle:t.handle,at:performance.now()};out.push({id,done:true});}else out.push({id,unexpected:prev,count:t.suspendCount});}
      else out.push({id,state:t.state,wait:t.waitInfo?.reason??null,susp:t.suspendCount});}
     return out;`);
    audio.last=r;if(r.length&&r.every(x=>x.done))break;await sleep(30);
   }
   audio.armed=!!ids.length&&audio.last.every(x=>x.done);
  }catch(e){audio.error=String(e.message||e);}
  await worker(`const sys=System.getInstance(),r=sys.services.render,w=globalThis.preemption.getWasmExports();
   if(!state.__diagPresent){const q={buf:new Float64Array(16384),n:0,orig:r.notifyCanvasPresent};r.notifyCanvasPresent=function(k){q.buf[q.n++&16383]=performance.now();return q.orig.call(this,k);};state.__diagPresent=q;}
   if(!state.__diagJit&&!globalThis.__jitPublicationCapture){const j={begun:0,published:0,failed:0,bytes:0,latMs:0,latMax:0,open:0,maxLatPage:0};
    globalThis.__jitPublicationCapture={begin(start,index,slot,code){const t=performance.now();j.begun++;j.open++;j.bytes+=code.length;return {published(){const d=performance.now()-t;j.published++;j.open--;j.latMs+=d;if(d>j.latMax){j.latMax=d;j.maxLatPage=start;}},failed(){j.failed++;j.open--;}};}};
    state.__diagJit=j;}
   const sch=sys.scheduler;if(!state.__diagSwitch&&typeof sch.performSwitch==='function'){const d={n:0,switched:0,orig:sch.performSwitch};sch.performSwitch=function(...a){d.n++;const r=d.orig.apply(this,a);if(r)d.switched++;return r;};state.__diagSwitch=d;}
   state.__diagRingRead=state.__diagRingRead||[w.diag_ring_n?.(0)??0,w.diag_ring_n?.(1)??0,w.diag_ring_n?.(2)??0];
   return true;`);
  if(opt.dispatch)await worker('const w=globalThis.preemption.getWasmExports();w.set_dispatch_stats(1);w.entry_eip_census_reset?.();return true;');
  if(opt.thunks)await run('perfProfile',{enable:true,reset:true}).catch(()=>{});
  if(opt.api)await run('apiCensus',{reset:true}).catch(()=>{});
  await post({kind:'start',utc:new Date().toISOString(),ident,opt,audio,userAgent:navigator.userAgent,url:location.href});
  window.__x87diag.state='logging';
  const code=`const sys=System.getInstance(),s=sys.scheduler,w=globalThis.preemption.getWasmExports(),q=state.__diagPresent,j=state.__diagJit;
   const from=state.__diagRead??q.n,n=q.n,times=[];for(let i=Math.max(from,n-16384);i<n;i++)times.push(q.buf[i&16383]);state.__diagRead=n;
   const tm=(${captureTimeManager.toString()})(System,'diag');
   const disp=${opt.dispatch}?Array.from({length:27},(_,i)=>w.profiler_dispatch_stat_get(i)):null;
   return {t:performance.now(),present:sys.services.render.getPresentSerial(),presentTimes:times,insns:s.getThreadRetiredInsns(),ms:s.getThreadCpuMs(),
    modules:w.jit_debug_module_count(),pages:w.jit_debug_page_count(),compiling:w.codegen_is_compiling(),finalizeFail:w.codegen_get_finalize_failure_count?.()??null,
    tier2:{promotions:w.jit_get_tier2_promotions?.()??null,evictions:w.jit_get_tier2_evictions?.()??null},
    jit:j?{...j}:null,disp,
    diag:typeof w.diag_get==='function'?(()=>{const rr=state.__diagRingRead,rings=[];for(let k=0;k<3;k++){const n=w.diag_ring_n(k),from=Math.max(rr[k],n-1024),vals=[];for(let i=from;i<n;i++)vals.push(w.diag_ring_at(k,i));rr[k]=n;rings.push(vals);}return {c:[0,1,2,3,4].map(i=>w.diag_get(i)),rings};})():null,
    sw:state.__diagSwitch?{n:state.__diagSwitch.n,switched:state.__diagSwitch.switched}:null,audioOff:!!state.__audioOff&&Object.keys(state.__audioOff.suspended).length>0&&Object.keys(state.__audioOff.suspended).every(id=>(sys.scheduler.threads.get(Number(id))?.suspendCount??0)>0),audioSuspended:state.__audioOff?Object.keys(state.__audioOff.suspended):[],paused:sys.isPaused,
    tm:{available:tm.available,time:tm.fields?.time20?.value,frame:tm.before?.frameCounter,lastLoops:tm.before?.lastLoopCount}};`;
  const compileCounts=new Map();
  let last=await worker(code),lastApi=null,lastThunks=null,lastFaultTs=0;
  const api=async()=>{if(!opt.api)return null;try{const r=await run('apiCensus');return new Map((r.calls??r).map(x=>[x.api,x.count+(x.fastPathCount||0)]));}catch{return null;}};
  const thunks=async()=>{if(!opt.thunks)return null;try{const r=await run('perfThunks',{top:40});return new Map((r.rows??r.thunks??[]).map(x=>[x.name??x.thunk??x.id,{ms:x.totalMs??0,calls:x.calls??x.count??0}]));}catch{return null;}};
  lastApi=await api();lastThunks=await thunks();
  let t0=performance.now(),k=0;
  while(true){
   k++;const wait=t0+k*1000-performance.now();if(wait>0)await sleep(wait);
   try{
    const s=await worker(code),wall=s.t-last.t;
    const iv=[];const all=[...(last.presentTimes.length?[last.presentTimes.at(-1)]:[]),...s.presentTimes];for(let i=1;i<all.length;i++)iv.push(all[i]-all[i-1]);
    const threads={};for(const id of Object.keys(s.insns))threads[id]={insns:(s.insns[id]??0)-(last.insns[id]??0),ms:+(((s.ms[id]??0)-(last.ms[id]??0)).toFixed(2))};
    const t1=threads[1]||{insns:0,ms:0};
    const curApi=await api(),curThunks=await thunks();
    const apiTop=curApi&&lastApi?[...curApi].map(([n,c])=>[n,c-(lastApi.get(n)??0)]).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]).slice(0,10):null;
    const thunkTop=curThunks&&lastThunks?[...curThunks].map(([n,v])=>[n,+(v.ms-(lastThunks.get(n)?.ms??0)).toFixed(2),v.calls-(lastThunks.get(n)?.calls??0)]).filter(x=>x[1]>0||x[2]>0).sort((a,b)=>b[1]-a[1]).slice(0,10):null;
    let faults=null;try{const f=await run('faults',32);const fresh=f.filter(x=>x.ts>lastFaultTs);if(f.length)lastFaultTs=Math.max(lastFaultTs,...f.map(x=>x.ts));faults={n:fresh.length,kinds:Object.entries(fresh.reduce((m,x)=>(m[x.kind]=(m[x.kind]||0)+1,m),{})),top:fresh.slice(0,3).map(x=>({eip:x.eip,addr:x.faultAddr,kind:x.kind,thunk:x.lastThunk}))};}catch{}
    const dj=s.jit&&last.jit?{begun:s.jit.begun-last.jit.begun,published:s.jit.published-last.jit.published,failed:s.jit.failed-last.jit.failed,bytes:s.jit.bytes-last.jit.bytes,latencyMsSum:+(s.jit.latMs-last.jit.latMs).toFixed(1),latencyMaxEver:+s.jit.latMax.toFixed(1),openAtSample:s.jit.open}:null;
    const rec={kind:'second',utc:new Date().toISOString(),k,wallMs:+wall.toFixed(1),presents:s.present-last.present,fps:(s.present-last.present)*1000/wall,maxFrameMs:iv.length?+Math.max(...iv).toFixed(1):null,
     lastLoopCount:s.tm.lastLoops,gameTimePerWall:(s.tm.time!=null&&last.tm.time!=null)?+((s.tm.time-last.tm.time)*1000/wall).toFixed(3):null,frameCounterDelta:(s.tm.frame!=null&&last.tm.frame!=null)?s.tm.frame-last.tm.frame:null,
     t1InsnsPerS:t1.insns*1000/wall,t1MsPerMillion:t1.insns>0?+(t1.ms*1e6/t1.insns).toFixed(2):null,threads,
     jit:{modulesNow:s.modules,modulesDelta:s.modules-last.modules,pagesNow:s.pages,compilingAtSample:s.compiling,...dj,modulesFreedEstimate:dj?Math.max(0,dj.published-(s.modules-last.modules)):null,finalizeFailDelta:s.finalizeFail!=null&&last.finalizeFail!=null?s.finalizeFail-last.finalizeFail:null,tier2PromotionsDelta:s.tier2.promotions!=null?s.tier2.promotions-last.tier2.promotions:null},
     diag:s.diag&&last.diag?(()=>{const top=(vals,k=10)=>Object.entries(vals.reduce((m,v)=>(m['0x'+(v>>>0).toString(16)]=(m['0x'+(v>>>0).toString(16)]||0)+1,m),{})).sort((a,b)=>b[1]-a[1]).slice(0,k);
      const totalInsns=Object.keys(s.insns).reduce((a,id)=>a+((s.insns[id]??0)-(last.insns[id]??0)),0),interp=s.diag.c[2]-last.diag.c[2];
      for(const p of s.diag.rings[1]){compileCounts.set(p,(compileCounts.get(p)||0)+1);}
      return {invalidations:s.diag.c[0]-last.diag.c[0],invalidationTopPages:top(s.diag.rings[0]),compiles:s.diag.c[1]-last.diag.c[1],compileTopPages:top(s.diag.rings[1]),
       recompiledPagesThisSecond:s.diag.rings[1].filter((p,i,a)=>a.indexOf(p)!==i).length,pagesCompiledBeforeAndAgain:[...new Set(s.diag.rings[1])].filter(p=>(compileCounts.get(p)||0)>1).map(p=>['0x'+(p>>>0).toString(16),compileCounts.get(p)]).slice(0,10),
       interpInsns:interp,totalRetiredInsns:totalInsns,interpShare:totalInsns>0?interp/totalInsns:null,dispatchEntries:s.diag.c[4]-last.diag.c[4],eipSampleTop10:top(s.diag.rings[2])};})():null,
     threadSwitches:s.sw&&last.sw?{calls:s.sw.n-last.sw.n,switched:s.sw.switched-last.sw.switched}:null,
     dispatch:s.disp&&last.disp?s.disp.map((v,i)=>v-last.disp[i]):null,faults,apiTop,thunkTop,audioOff:s.audioOff,audioSuspended:s.audioSuspended,paused:s.paused,visible:document.visibilityState};
    lastFps=rec.fps;void post(rec);show();
    last=s;lastApi=curApi??lastApi;lastThunks=curThunks??lastThunks;
   }catch(e){void post({kind:'error',utc:new Date().toISOString(),error:String(e.message||e)});}
  }
 })().catch(e=>{window.__x87diag.state='error';window.__x87diag.error=String(e.message||e);box.textContent='Diagnose-Fehler: '+window.__x87diag.error;});
}
