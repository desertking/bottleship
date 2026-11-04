const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export function makePairs({run,worker,post,gameTimeCode=null,mainThread=null,on=239,off=0,game}){
 const sample=`const sys=System.getInstance(),s=sys.scheduler,w=globalThis.preemption.getWasmExports(),q=state.__pairsPresent;const from=state.__pairsRead??q.n,n=q.n,times=[];for(let i=Math.max(from,n-16384);i<n;i++)times.push(q.buf[i&16383]);state.__pairsRead=n;${gameTimeCode?`let g=null;try{g=(function(){${gameTimeCode}})();}catch{}`:'const g=null;'}return {t:performance.now(),present:sys.services.render.getPresentSerial(),times,insns:s.getThreadRetiredInsns(),ms:s.getThreadCpuMs(),mode:w.get_jit_x87_mixed_residency(),modules:w.jit_debug_module_count(),paused:sys.isPaused,g};`;
 const hook=`const r=System.getInstance().services.render;if(!state.__pairsPresent){const q={buf:new Float64Array(16384),n:0,orig:r.notifyCanvasPresent};r.notifyCanvasPresent=function(k){q.buf[q.n++&16383]=performance.now();return q.orig.call(this,k);};state.__pairsPresent=q;}return true;`;
 const stopped=()=>worker('const s=System.getInstance(),w=globalThis.preemption.getWasmExports();return {paused:s.isPaused,running:s.process.v86.is_running(),compiling:w.codegen_is_compiling(),staged:w.jit_aot_tx_staged_index?.()};');
 async function setMode(mode){
  for(let attempt=0;attempt<5;attempt++){
   await run('pause');let st,ok=false,res=null;
   try{
    for(let n=0;n<200;n++){st=await stopped();if(st.paused&&!st.running&&!st.compiling)break;await sleep(25);}
    if(st.paused&&!st.running&&!st.compiling&&(st.staged===undefined||st.staged===65535)){
     res=await worker(`const w=globalThis.preemption.getWasmExports();if(w.set_jit_x87_mixed_residency(${mode})!==0)throw Error('abgelehnt');w.jit_clear_cache_js();return {mode:w.get_jit_x87_mixed_residency(),modules:w.jit_debug_module_count(),pages:w.jit_debug_page_count(),hidden:w.jit_debug_hidden_count()};`);
     ok=res.mode===mode&&!res.modules&&!res.pages&&!res.hidden;
    }
   }finally{await run('resume');}
   if(ok)return res;
   await sleep(200);
  }
  throw Error('Kein sicherer Umschaltpunkt');
 }
 async function window_(meta,mode,discardMs,measureMs){
  const sw=await setMode(mode);const tSwitch=performance.now();
  await sleep(discardMs);
  await worker('state.__pairsRead=state.__pairsPresent.n;return true;');
  const a=await worker(sample),utcStart=new Date().toISOString();
  await sleep(measureMs);
  const b=await worker(sample);
  const wall=b.t-a.t,iv=[];for(let i=1;i<b.times.length;i++)iv.push(b.times[i]-b.times[i-1]);
  const sorted=[...iv].sort((x,y)=>x-y),pct=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]:null;
  const ids=Object.keys(b.insns);const main=mainThread??ids.map(Number).sort((x,y)=>((b.insns[y]-(a.insns[y]??0))-(b.insns[x]-(a.insns[x]??0))))[0];
  const ins=b.insns[main]-(a.insns[main]??0),ms=b.ms[main]-(a.ms[main]??0);
  const rec={kind:'window',game,...meta,mode,utcStart,utcEnd:new Date().toISOString(),discardMs,wallMs:wall,presents:b.present-a.present,fps:(b.present-a.present)*1000/wall,
   frameP50:pct(0.5),frameP95:pct(0.95),frameP99:pct(0.99),mainThread:main,mainInsns:ins,mainMs:ms,mainMsPerMillion:ins>0?ms*1e6/ins:null,
   gameTimePerWall:(a.g!=null&&b.g!=null)?(b.g-a.g)*1000/wall:null,moduleGrowth:b.modules-a.modules,modeOk:a.mode===mode&&b.mode===mode,neverPaused:!a.paused&&!b.paused,switch:sw,switchToMeasureMs:performance.now()-tSwitch-measureMs};
  await post(rec);return rec;
 }
 return async function pairs({loadId,n=30,aaEvery=5,discardMs=10000,measureMs=20000,seed=1,status}={}){
  await worker(hook);
  let s=seed>>>0||1;const rnd=()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};
  const out=[];
  for(let p=0;p<n;p++){
   const aa=aaEvery>0&&p%aaEvery===aaEvery-1;
   const order=aa?[off,off]:(rnd()<0.5?[off,on]:[on,off]);
   const meta={loadId,pair:p,aa,order:order.join('/')};
   try{
    const w1=await window_({...meta,pos:0},order[0],discardMs,measureMs);
    const w2=await window_({...meta,pos:1},order[1],discardMs,measureMs);
    out.push([w1,w2]);
   }catch(e){await post({kind:'pairError',game,...meta,error:String(e.message||e),utc:new Date().toISOString()});}
   if(status)status(p+1,n);
  }
  await setMode(off).catch(()=>{});
  return out.length;
 };
}
