import {panelAudioCpuWorker} from './panel-audio-cpu-proposal-20261103.mjs';
import {captureTimeManager} from './x87res-tm.mjs';

const V6='1fc9d0efb6fa1338f3de3f2c588ce7015c39422013f3f234719ac5e89e121424';
const BASE_SHA='8b808c330b63a6e9e1843e1fa2895957267546ed6b14bcc2f2d80b03b495c20d';
const MODES=[0,239,15];
const WINDOW_MS=5000;

export async function installX87ResPanel(){
 if(!['localhost','127.0.0.1'].includes(location.hostname)||!window.__BS__?.harness)throw Error('Nur lokaler Testplayer');
 if(window.__x87resPanel)return;
 const run=async(cmd,...args)=>{const r=await __BS__.harness.__runSteps([{cmd,args}]);if(!r.ok||!r.steps?.[0]?.ok)throw Error(r.steps?.[0]?.error?.message??'Testanfrage fehlgeschlagen');return r.steps[0].result;};
 const worker=code=>run('evalWorker',code);
 const ident=await worker(`const w=globalThis.preemption?.getWasmExports?.();return {sha:globalThis.__v86EngineLoad?.sha256,hasSwitch:typeof w?.set_jit_x87_mixed_residency==='function',mode:w?.get_jit_x87_mixed_residency?.()};`);
 if(ident.sha!==V6||!ident.hasSwitch)throw Error('Falscher CPU-Kern: '+ident.sha);
 await worker(`const r=System.getInstance().services.render;if(!state.__x87resPresent){const q={buf:new Float64Array(8192),n:0,orig:r.notifyCanvasPresent,owner:r};r.notifyCanvasPresent=function(k){q.buf[q.n++&8191]=performance.now();return q.orig.call(this,k);};state.__x87resPresent=q;}return true;`);
 const audioWorker=panelAudioCpuWorker.toString().replace(BASE_SHA,V6);
 const audioId='audio-panel-'+crypto.randomUUID();
 const audio=async a=>{
  const ask=action=>worker(`return (${audioWorker})(${JSON.stringify(action)},${JSON.stringify({id:audioId})},System);`);
  if(a==='on'){const s=await ask('status');return s.active?ask('on'):s;}
  if(a==='status')return ask('status');
  for(let i=0;i<10;i++){const r=await ask('off');if(r.armed)return r;await new Promise(r=>setTimeout(r,60));}
  throw Error('Mixer gerade beschäftigt; bitte erneut klicken.');
 };
 const session=new Date().toISOString().replace(/[:.]/g,'-')+'-'+Math.random().toString(36).slice(2,8);
 const post=async rec=>{try{const r=await fetch('x87res-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session,...rec})});return r.ok?await r.json():null;}catch{return null;}};
 const sampleCode=`const sys=System.getInstance(),s=sys.scheduler,w=globalThis.preemption.getWasmExports(),q=state.__x87resPresent;const from=state.__x87resPresentRead??q.n;const n=q.n,times=[];for(let i=Math.max(from,n-8192);i<n;i++)times.push(q.buf[i&8191]);state.__x87resPresentRead=n;const tm=(${captureTimeManager.toString()})(System,'x87res');return {t:performance.now(),sha:globalThis.__v86EngineLoad?.sha256,mode:w.get_jit_x87_mixed_residency(),present:sys.services.render.getPresentSerial(),presentTimes:times,insns:s.getThreadRetiredInsns(),ms:s.getThreadCpuMs(),modules:w.jit_debug_module_count(),compiling:w.codegen_is_compiling(),audioOff:!!globalThis.__scpPanelAudioCpu20261103?.active,paused:sys.isPaused,tm:{available:tm.available,time:tm.fields?.time20?.value,target:tm.fields?.target40?.value,step:tm.fields?.step30?.value,frame:tm.before?.frameCounter,lastLoops:tm.before?.lastLoopCount}};`;
 const stopped=()=>worker('const s=System.getInstance(),w=globalThis.preemption.getWasmExports();return {paused:s.isPaused,running:s.process.v86.is_running(),compiling:w.codegen_is_compiling(),staged:w.jit_aot_tx_staged_index?.(),mode:w.get_jit_x87_mixed_residency()};');
 let segment=0,currentMode=ident.mode,busy=false,last=null,lag=0,lagMax=0;
 async function switchMode(value){
  if(!MODES.includes(value))throw Error('Ungültiger Modus');
  const before=await stopped();let ownPause=false;
  try{
   if(!before.paused){await run('pause');ownPause=true;}
   let st;for(let n=0;n<60;n++){st=await stopped();if(st.paused&&!st.running&&!st.compiling)break;await new Promise(r=>setTimeout(r,100));}
   if(!st.paused||st.running||st.compiling||(st.staged!==undefined&&st.staged!==65535))throw Error('Kein sicherer Haltepunkt');
   const r=await worker(`const w=globalThis.preemption.getWasmExports();if(w.set_jit_x87_mixed_residency(${value})!==0)throw Error('Schalter abgelehnt');w.jit_clear_cache_js();return {mode:w.get_jit_x87_mixed_residency(),modules:w.jit_debug_module_count(),pages:w.jit_debug_page_count(),hidden:w.jit_debug_hidden_count(),compiling:w.codegen_is_compiling()};`);
   if(r.mode!==value||r.modules||r.pages||r.hidden||r.compiling)throw Error('Cache nach Umschalten nicht leer: '+JSON.stringify(r));
   currentMode=value;segment++;
   await post({kind:'switch',utc:new Date().toISOString(),mode:value,segment,cache:r});
   return r;
  }finally{if(ownPause)await run('resume');}
 }
 const aside=document.createElement('aside');aside.id='x87res-panel';
 const style=document.createElement('style');style.textContent=`#x87res-panel{position:fixed;left:8px;top:8px;width:300px;max-width:calc(100vw - 24px);z-index:2147483000;background:#2a1e14f2;color:#fbefe3;border:1px solid #8a6a4f;border-radius:12px;padding:12px;font:13px/1.4 system-ui,sans-serif}#x87res-panel button,#x87res-panel select{font:inherit;color:#fff;background:#4a3624;border:1px solid #9c7a64;border-radius:6px;padding:6px;margin:3px 0;width:100%;cursor:pointer}#x87res-panel small{display:block;color:#d9c3ad}#x87res-stat{white-space:pre-wrap;font:12px ui-monospace,monospace;margin-top:6px}#x87res-panel[data-folded=true] .x87res-c{display:none}`;
 aside.innerHTML=`<b>x87-Residenz · Live-A/B (v6)</b><button data-a="fold">Einklappen</button><div class="x87res-c"><small>Sitzung ${session}</small><label>Modus <select data-mode><option value="0">0 · AUS (Original)</option><option value="239">239 · AN (empfohlen)</option><option value="15">15 · AN (Basisklassen)</option></select></label><button data-a="auto">Auto-A/B starten (0/239 je 15 s, 6 Paare)</button><button data-a="stop">Auto-A/B stoppen</button><button data-a="audioOff">Audioberechnung AUS</button><button data-a="audioOn">Audioberechnung wieder AN</button><div id="x87res-stat">Bereit.</div></div>`;
 document.head.append(style);document.body.append(aside);
 aside.addEventListener('keydown',e=>e.stopPropagation());
 const el=s=>aside.querySelector(s),stat=t=>el('#x87res-stat').textContent=t;
 el('[data-mode]').value=String(currentMode);
 let auto=null;
 async function act(fn,label){if(busy)return;busy=true;try{await fn();stat(label);}catch(e){stat('Fehler: '+e.message);await post({kind:'error',utc:new Date().toISOString(),label,error:e.message});}finally{busy=false;el('[data-mode]').value=String(currentMode);}}
 aside.addEventListener('change',e=>{if(e.target.dataset.mode!==undefined)void act(()=>switchMode(Number(e.target.value)),'Modus '+e.target.value);});
 aside.addEventListener('click',e=>{const a=e.target.closest('[data-a]')?.dataset.a;if(!a)return;
  if(a==='fold'){aside.dataset.folded=aside.dataset.folded!=='true';return;}
  if(a==='audioOff')void act(async()=>{await audio('off');await post({kind:'audio',utc:new Date().toISOString(),off:true});},'Audio aus');
  if(a==='audioOn')void act(async()=>{await audio('on');await post({kind:'audio',utc:new Date().toISOString(),off:false});},'Audio an');
  if(a==='stop'&&auto){auto.stop=true;stat('Auto-A/B wird nach aktuellem Abschnitt beendet');}
  if(a==='auto'&&!auto){auto={stop:false};const plan=[];for(let i=0;i<6;i++){const on=Math.random()<0.5;plan.push(...(on?[239,0]:[0,239]));}
   void post({kind:'autoPlan',utc:new Date().toISOString(),plan});
   (async()=>{try{for(let i=0;i<plan.length&&!auto.stop;i++){await act(()=>switchMode(plan[i]),'Auto '+(i+1)+'/'+plan.length+' · Modus '+plan[i]);await new Promise(r=>setTimeout(r,15000));}}finally{await act(()=>switchMode(0),'Auto-A/B beendet · Modus 0');auto=null;}})();}
 });
 let lagT=performance.now();
 const lagTimer=setInterval(()=>{const now=performance.now(),d=now-lagT-100;lagT=now;if(d>0){lag+=d;lagMax=Math.max(lagMax,d);}},100);
 async function windowTick(){
  try{
   if(!busy){
    const s=await worker(sampleCode);
    if(last&&s.mode===last.mode){
     const wall=s.t-last.t,ins=(s.insns[1]??0)-(last.insns[1]??0),ms=(s.ms[1]??0)-(last.ms[1]??0);
     const times=s.presentTimes,iv=[];for(let i=1;i<times.length;i++)iv.push(times[i]-times[i-1]);
     if(last.presentTimes.length&&times.length)iv.unshift(times[0]-last.presentTimes.at(-1));
     const sorted=[...iv].sort((a,b)=>a-b),pct=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]:null;
     const rec={kind:'window',utc:new Date().toISOString(),segment,mode:s.mode,wallMs:wall,t1Insns:ins,t1Ms:ms,msPerMillionT1:ins>0?ms*1e6/ins:null,presents:s.present-last.present,presentFps:(s.present-last.present)*1000/wall,presentIntervalP50:pct(0.5),presentIntervalP95:pct(0.95),presentIntervalP99:pct(0.99),spikesOver100ms:iv.filter(x=>x>100).length,maxInterval:sorted.at(-1)??null,gameTimePerWall:(s.tm.time!=null&&last.tm.time!=null)?(s.tm.time-last.tm.time)*1000/wall:null,lastLoopCountSample:s.tm.lastLoops,frameCounterDelta:(s.tm.frame!=null&&last.tm.frame!=null)?s.tm.frame-last.tm.frame:null,modulesNow:s.modules,moduleGrowth:s.modules-last.modules,compiling:s.compiling,audioOff:s.audioOff,paused:s.paused,mainThreadTimerLagMs:lag,mainThreadTimerLagMaxMs:lagMax,visible:document.visibilityState,focused:document.hasFocus()};
     lag=0;lagMax=0;
     const resp=await post(rec);
     stat(`Modus ${rec.mode} · Abschnitt ${segment}\n${rec.presentFps.toFixed(1)} Presents/s · p95 ${rec.presentIntervalP95?.toFixed(0)} ms · >100ms ${rec.spikesOver100ms}\nT1 ${rec.msPerMillionT1?.toFixed(2)} ms/1M · Spielzeit/Wand ${rec.gameTimePerWall?.toFixed(3)}\nLoad ${resp?.hostLoad?.loadavg?.join(' ')??'?'}`);
    }
    last=s;
   }else last=null;
  }catch(e){stat('Messung: '+e.message);}
 }
 const timer=setInterval(()=>void windowTick(),WINDOW_MS);void windowTick();
 await post({kind:'start',utc:new Date().toISOString(),sha:ident.sha,mode:ident.mode,userAgent:navigator.userAgent,url:location.href});
 window.__x87resPanel={session,switchMode,audio,remove(){clearInterval(timer);clearInterval(lagTimer);aside.remove();style.remove();delete window.__x87resPanel;}};
}
