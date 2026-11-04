import {panelAudioCpuWorker} from './panel-audio-cpu-proposal-20261103.mjs';
import {captureTimeManager} from './x87res-tm.mjs';
import {makePairs} from './x87pairs-core.mjs';

const V6='1fc9d0efb6fa1338f3de3f2c588ce7015c39422013f3f234719ac5e89e121424';
const BASE_SHA='8b808c330b63a6e9e1843e1fa2895957267546ed6b14bcc2f2d80b03b495c20d';
const VARIANTS={A:0,B:239};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export const SCRIPT_VERSION=2;
export function inputScript(durationMs){
 const ev=[{t:0,cmd:'key',args:[0x57,{down:true}]}];
 const turns=[[8000,-25,8],[20000,-25,16],[35000,-25,16],[50000,-25,16],[65000,-25,16],[80000,-25,16]];
 for(const [t0,dx,n] of turns)for(let k=0;k<n;k++)if(t0+k*125<durationMs)ev.push({t:t0+k*125,cmd:'moveRelative',args:[dx,0]});
 for(const [t0,dy] of [[28000,10],[30000,-10],[58000,10],[60000,-10]])for(let k=0;k<8;k++)if(t0+k*125<durationMs)ev.push({t:t0+k*125,cmd:'moveRelative',args:[0,dy]});
 for(const s of [14,44,74])if(s*1000<durationMs)ev.push({t:s*1000,cmd:'key',args:[0x41,{down:true}]},{t:s*1000+800,cmd:'key',args:[0x41,{up:true}]});
 ev.push({t:durationMs,cmd:'key',args:[0x57,{up:true}]});
 return ev.sort((a,b)=>a.t-b.t);
}

export function installBot(){
 const params=new URLSearchParams(location.search),variant=params.get('x87ab');
 if(!VARIANTS.hasOwnProperty(variant))throw Error('x87ab=A|B erwartet');
 const mode=VARIANTS[variant];
 document.title=`[${variant} x87=${mode}] `+document.title;
 const run=async(cmd,...args)=>{const r=await __BS__.harness.__runSteps([{cmd,args}]);if(!r.ok||!r.steps?.[0]?.ok)throw Error(r.steps?.[0]?.error?.message??'Testanfrage fehlgeschlagen');return r.steps[0].result;};
 const worker=code=>run('evalWorker',code);
 const post=async rec=>{try{const r=await fetch('x87res-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(rec)});return r.ok?await r.json():null;}catch{return null;}};
 const bot={variant,mode,state:'waiting',prepared:null,result:null,error:null};
 window.__x87bot=bot;
 bot.prepare=async()=>{
  bot.state='preparing';
  const ident=await worker(`const w=globalThis.preemption?.getWasmExports?.();return {sha:globalThis.__v86EngineLoad?.sha256,hasSwitch:typeof w?.set_jit_x87_mixed_residency==='function'};`);
  if(ident.sha!==V6||!ident.hasSwitch)throw Error('Falscher CPU-Kern '+ident.sha);
  await worker(`const r=System.getInstance().services.render;if(!state.__x87resPresent){const q={buf:new Float64Array(16384),n:0,orig:r.notifyCanvasPresent};r.notifyCanvasPresent=function(k){q.buf[q.n++&16383]=performance.now();return q.orig.call(this,k);};state.__x87resPresent=q;}return true;`);
  const audioWorker=panelAudioCpuWorker.toString().replace(BASE_SHA,V6),audioId='audio-panel-'+crypto.randomUUID();
  let audio=null;for(let i=0;i<40&&!audio?.armed;i++){audio=await worker(`return (${audioWorker})('off',${JSON.stringify({id:audioId})},System);`);if(!audio.armed)await sleep(100);}
  if(!audio?.armed)throw Error('Audio konnte nicht ausgeschaltet werden');
  const stopped=()=>worker('const s=System.getInstance(),w=globalThis.preemption.getWasmExports();return {paused:s.isPaused,running:s.process.v86.is_running(),compiling:w.codegen_is_compiling(),staged:w.jit_aot_tx_staged_index?.()};');
  await run('pause');
  let st;
  try{
   for(let n=0;n<100;n++){st=await stopped();if(st.paused&&!st.running&&!st.compiling)break;await sleep(50);}
   if(!st.paused||st.running||st.compiling||(st.staged!==undefined&&st.staged!==65535))throw Error('Kein sicherer Haltepunkt');
   bot.switch=await worker(`const w=globalThis.preemption.getWasmExports();if(w.set_jit_x87_mixed_residency(${mode})!==0)throw Error('Schalter abgelehnt');w.jit_clear_cache_js();return {mode:w.get_jit_x87_mixed_residency(),modules:w.jit_debug_module_count(),pages:w.jit_debug_page_count(),hidden:w.jit_debug_hidden_count(),flags:Array.from({length:32},(_,i)=>w.get_jit_config(i)>>>0)};`);
   if(bot.switch.mode!==mode||bot.switch.modules||bot.switch.pages||bot.switch.hidden)throw Error('Umschalten nicht bestätigt');
  }finally{await run('resume');}
  bot.prepared={utc:new Date().toISOString(),audio:{armed:audio.armed,status:audio.status},switch:bot.switch};
  bot.state='ready';return bot.prepared;
 };
 const timeCode=`const tm=(${captureTimeManager.toString()})(System,'x87gt');return tm.available?tm.fields?.time20?.value:null;`;
 bot.runGame=async({gameSeconds=60,events=[],label='',maxWallMs=600000}={})=>{
  if(bot.state!=='ready')throw Error('Nicht bereit: '+bot.state);
  bot.state='running';
  const hostBefore=await post({kind:'hostLoadProbe',session:'bot',variant,label});
  await worker('state.__x87resRead=state.__x87resPresent.n;return true;');
  const first=await worker(sampleCode);const g0=first.tm.time;if(!(typeof g0==='number'))throw Error('Spielzeit nicht lesbar');
  const samples=[{...first,presentTimes:[]}],evs=[...events].sort((x,y)=>x.g-y.g);
  let idx=0,inputErrors=0,g=g0,lastSample=performance.now();const t0=performance.now();
  try{
   while(true){
    g=await worker(timeCode);
    if(typeof g!=='number'){inputErrors++;await sleep(20);continue;}
    bot.gameElapsed=g-g0;
    while(idx<evs.length&&evs[idx].g<=g-g0){const e=evs[idx++];try{await run(e.cmd,...e.args);}catch{inputErrors++;}}
    if(performance.now()-lastSample>=1000){samples.push(await worker(sampleCode));lastSample=performance.now();}
    if(g-g0>=gameSeconds)break;
    if(performance.now()-t0>maxWallMs)throw Error('Wanduhr-Limit');
    await sleep(15);
   }
  }finally{for(const vk of [0x57,0x41,0x44,0x53])await run('key',vk,{up:true}).catch(()=>{});}
  samples.push(await worker(sampleCode));
  const a=samples[0],b=samples.at(-1),wall=b.t-a.t;
  const times=samples.flatMap(x=>x.presentTimes),iv=[];for(let i=1;i<times.length;i++)iv.push(times[i]-times[i-1]);
  const sorted=[...iv].sort((x,y)=>x-y),pct=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]:null;
  const perSecond=[];for(let i=1;i<samples.length;i++)perSecond.push((samples[i].present-samples[i-1].present)*1000/(samples[i].t-samples[i-1].t));
  const result={kind:'run',coupling:'game-time',session:'bot',variant,mode,label,utc:new Date().toISOString(),gameSeconds:b.tm.time-a.tm.time,wallMsForGameTime:wall,
   avgFps:(b.present-a.present)*1000/wall,presents:b.present-a.present,frameTimeP50:pct(0.5),frameTimeP95:pct(0.95),frameTimeP99:pct(0.99),framesOver100ms:iv.filter(x=>x>100).length,
   secondsUnder10Fps:perSecond.filter(x=>x<10).length,perSecondFps:perSecond,gameTimePerWall:(b.tm.time-a.tm.time)*1000/wall,
   msPerMillionT1:(b.insns>a.insns)?(b.ms-a.ms)*1e6/(b.insns-a.insns):null,t1Insns:b.insns-a.insns,t1Ms:b.ms-a.ms,
   moduleGrowth:b.modules-a.modules,modeConstant:samples.every(x=>x.mode===mode),audioOffConstant:samples.every(x=>x.audioOff),neverPaused:samples.every(x=>!x.paused),
   inputEvents:idx,inputEventsPlanned:evs.length,inputErrors,hostLoadBefore:hostBefore?.hostLoad??null,endPosition:'nicht auslesbar',prepared:bot.prepared,visible:document.visibilityState};
  bot.result=result;bot.state='done';
  result.hostLoadAfter=(await post(result))?.hostLoad??null;
  return result;
 };
 const sampleCode=`const sys=System.getInstance(),s=sys.scheduler,w=globalThis.preemption.getWasmExports(),q=state.__x87resPresent;const from=state.__x87resRead??q.n;const n=q.n,times=[];for(let i=Math.max(from,n-16384);i<n;i++)times.push(q.buf[i&16383]);state.__x87resRead=n;const tm=(${captureTimeManager.toString()})(System,'x87bot');return {t:performance.now(),mode:w.get_jit_x87_mixed_residency(),present:sys.services.render.getPresentSerial(),presentTimes:times,insns:s.getThreadRetiredInsns()[1]??null,ms:s.getThreadCpuMs()[1]??null,modules:w.jit_debug_module_count(),audioOff:!!globalThis.__scpPanelAudioCpu20261103?.active,paused:sys.isPaused,tm:{available:tm.available,time:tm.fields?.time20?.value,frame:tm.before?.frameCounter,lastLoops:tm.before?.lastLoopCount}};`;
 bot.run=async({durationMs=90000,label=''}={})=>{
  if(bot.state!=='ready')throw Error('Nicht bereit: '+bot.state);
  bot.state='running';
  const hostBefore=await post({kind:'hostLoadProbe',session:'bot',variant,label});
  const script=inputScript(durationMs),samples=[];
  await worker('state.__x87resRead=state.__x87resPresent.n;return true;');
  const first=await worker(sampleCode);samples.push({...first,presentTimes:[]});
  const t0=performance.now();let k=0,inputErrors=0;
  const inputLoop=(async()=>{for(const e of script){const wait=t0+e.t-performance.now();if(wait>0)await sleep(wait);try{await run(e.cmd,...e.args);}catch{inputErrors++;}k++;}})();
  const sampleLoop=(async()=>{for(let s=1;s<=Math.ceil(durationMs/1000);s++){const wait=t0+s*1000-performance.now();if(wait>0)await sleep(wait);samples.push(await worker(sampleCode));}})();
  try{await Promise.all([inputLoop,sampleLoop]);}
  finally{for(const vk of [0x57,0x41,0x44])await run('key',vk,{up:true}).catch(()=>{});}
  const a=samples[0],b=samples.at(-1),wall=b.t-a.t;
  const times=samples.flatMap(x=>x.presentTimes),iv=[];for(let i=1;i<times.length;i++)iv.push(times[i]-times[i-1]);
  const sorted=[...iv].sort((x,y)=>x-y),pct=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]:null;
  const perSecond=[];for(let i=1;i<samples.length;i++)perSecond.push((samples[i].present-samples[i-1].present)*1000/(samples[i].t-samples[i-1].t));
  const result={kind:'run',session:'bot',variant,mode,label,utc:new Date().toISOString(),durationMs:wall,
   avgFps:(b.present-a.present)*1000/wall,frameTimeP50:pct(0.5),frameTimeP95:pct(0.95),frameTimeP99:pct(0.99),framesOver100ms:iv.filter(x=>x>100).length,
   secondsUnder10Fps:perSecond.filter(x=>x<10).length,perSecondFps:perSecond,
   gameTimePerWall:(a.tm.time!=null&&b.tm.time!=null)?(b.tm.time-a.tm.time)*1000/wall:null,
   msPerMillionT1:(b.insns>a.insns)?(b.ms-a.ms)*1e6/(b.insns-a.insns):null,t1Insns:b.insns-a.insns,
   lastLoopCountSamples:samples.map(x=>x.tm.lastLoops),moduleGrowth:b.modules-a.modules,modeConstant:samples.every(x=>x.mode===mode),audioOffConstant:samples.every(x=>x.audioOff),neverPaused:samples.every(x=>!x.paused),
   inputEvents:k,inputErrors,scriptVersion:SCRIPT_VERSION,hostLoadBefore:hostBefore?.hostLoad??null,endPosition:'nicht auslesbar (keine belegte Positionsadresse)',prepared:bot.prepared,visible:document.visibilityState};
  bot.result=result;bot.state='done';
  result.hostLoadAfter=(await post(result))?.hostLoad??null;
  return result;
 };
 bot.startPairs=({loadId,n=30,seed=1}={})=>{
  bot.pairsState={state:'settling',done:0,n};
  (async()=>{
   try{
    await sleep(20000);bot.pairsState.state='running';
    const pairs=makePairs({run,worker,post:rec=>post({...rec,session:'pairs-'+loadId}),game:'scp-still',mainThread:1,on:239,off:0,gameTimeCode:`const tm=(${captureTimeManager.toString()})(System,'pairs');return tm.available?tm.fields?.time20?.value:null;`});
    const ok=await pairs({loadId,n,seed,status:(d)=>{bot.pairsState.done=d;}});
    bot.pairsState.state='done';bot.pairsState.okPairs=ok;
   }catch(e){bot.pairsState.state='error';bot.pairsState.error=String(e.message||e);}
  })();
  return true;
 };
 (async()=>{
  try{
   while(window.scpTest?.phase!=='playing'||!window.__BS__?.harness)await sleep(250);
   await bot.prepare();
  }catch(e){bot.state='error';bot.error=String(e.message||e);}
 })();
 return bot;
}
