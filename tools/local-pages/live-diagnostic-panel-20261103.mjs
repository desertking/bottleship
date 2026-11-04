// Private local diagnostic UI. No page reload, game patch, persistence or auto-input.
export function panelCpu(action,patch,System,state){
 const s=System.getInstance(),v=s.process?.v86,w=globalThis.preemption?.getWasmExports();
 if(globalThis.__v86EngineLoad?.sha256!=='8b808c330b63a6e9e1843e1fa2895957267546ed6b14bcc2f2d80b03b495c20d'||!w||!v)throw Error('Unerwarteter Emulator');
 const read=()=>({1:w.get_jit_config(1),10:w.get_jit_config(10),13:w.get_jit_config(13)});
 const q=state.__suManualPanelCpu??=( {original:read(),v,w} );
 if(q.v!==v||q.w!==w)throw Error('Spielinstanz geändert');
 if(action==='read')return {values:read(),original:q.original,paused:s.isPaused};
 if(action!=='set'&&action!=='reset')throw Error('Unbekannte Aktion');
 if(!s.isPaused||v.is_running()||w.codegen_is_compiling()||state.__scpAotVariantsV1||globalThis.__jitPublicationCapture)throw Error('CPU noch beschäftigt; bitte erneut versuchen');
 const changes=action==='reset'?q.original:patch;
 for(const [k,val]of Object.entries(changes))if(!(['1','10','13'].includes(k))||!(k==='1'?[1,3]:[0,1]).includes(val))throw Error('Ungültige CPU-Einstellung');
 const before=read();
 try{
  for(const[k,val]of Object.entries(changes))if(w.set_jit_config(Number(k),val)!==0)throw Error('CPU-Schalter abgelehnt');
  w.jit_clear_cache_js();
  if([w.jit_debug_module_count(),w.jit_debug_page_count(),w.jit_debug_hidden_count()].some(Boolean))throw Error('Codecache nicht leer');
  const values=read();for(const[k,val]of Object.entries(changes))if(values[k]!==val)throw Error('CPU-Rückmeldung stimmt nicht');
  return {values,original:q.original,paused:s.isPaused};
 }catch(e){for(const[k,val]of Object.entries(before))w.set_jit_config(Number(k),val);w.jit_clear_cache_js();throw e;}
}

export async function installDiagnosticPanel(cpuFn,audioFn){
 if(!['localhost','127.0.0.1'].includes(location.hostname)||!window.__BS__?.harness)throw Error('Nur lokaler Testplayer');
 if(window.__suDiagnosticPanel)return {alreadyInstalled:true};
 const run=async(cmd,...args)=>{const r=await __BS__.harness.__runSteps([{cmd,args}]);if(!r.ok||!r.steps?.[0]?.ok)throw Error(r.steps?.[0]?.error?.message??'Testanfrage fehlgeschlagen');return r.steps[0].result;};
 const cpu=(a,p={})=>run('evalWorker',`return (${cpuFn.toString()})(${JSON.stringify(a)},${JSON.stringify(p)},System,state);`);
 const audioId='audio-panel-'+crypto.randomUUID();
 const audio=async a=>{
  if(!audioFn)throw Error('Audiotest wird noch vorbereitet');
  const ask=action=>run('evalWorker',`return (${audioFn.toString()})(${JSON.stringify(action)},${JSON.stringify({id:audioId})},System);`);
  if(a==='restore'){const s=await ask('status');return s.active?ask('on'):s;}
  if(a==='status')return ask('status');
  for(let i=0;i<10;i++){const r=await ask('off');if(r.armed)return r;await new Promise(r=>setTimeout(r,60));}
  throw Error('Mixer gerade beschäftigt; bitte erneut klicken.');
 };
 const originalCpu=await cpu('read');
 const quality=await run('dbgCall','quality').catch(()=>null);
 const gpu=await run('gpuToggle').catch(()=>null);
 const scrubRaw=await run('drawScrub').catch(()=>null);
 const scrub=scrubRaw?.devices?.length===1?scrubRaw.devices[0]:(scrubRaw?.devices?null:scrubRaw);
 if(scrub&&typeof scrub.target==='string')scrub.target=Number(scrub.target);
 const hostMuted=__BS__.audioEngine.muted;
 const aside=document.createElement('aside');aside.id='su-diagnostic-panel';
 const style=document.createElement('style');style.textContent=`
 #su-diagnostic-panel{position:fixed;right:8px;top:8px;bottom:44px;width:278px;max-width:calc(100vw - 24px);z-index:2147483000;background:#14212ef5;color:#e9f1fa;border:1px solid #536a81;border-radius:12px;padding:14px;box-sizing:border-box;overflow:auto;font:13px/1.4 system-ui,sans-serif;box-shadow:0 5px 24px #0006}
 #su-diagnostic-panel *{box-sizing:border-box}#su-diagnostic-panel h2{font-size:17px;margin:0 0 6px}#su-diagnostic-panel h3{font-size:13px;color:#a8c9eb;margin:16px 0 7px}#su-diagnostic-panel p{font-size:12px;color:#bdcbd9;margin:6px 0}#su-diagnostic-panel button,#su-diagnostic-panel select{font:inherit;color:#edf5ff;background:#293f54;border:1px solid #647d94;border-radius:6px;padding:6px;cursor:pointer}#su-diagnostic-panel button{margin:3px 0;width:100%}#su-diagnostic-panel label{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:8px 0}#su-diagnostic-panel input{accent-color:#57c4ff}#su-diagnostic-panel small{display:block;color:#b2c0ce;font-size:11px}#su-diag-fps{font-size:27px;font-weight:700;color:#74d6ab}#su-diag-status{min-height:32px;white-space:pre-wrap}#su-diag-history{font-size:11px;max-height:100px;overflow:auto;white-space:pre-wrap}#su-diagnostic-panel[data-folded=true]{bottom:auto;width:150px}#su-diagnostic-panel[data-folded=true] .su-diag-content{display:none}`;
 aside.innerHTML=`<h2>SCP · Diagnose</h2><button data-action="fold">Panel einklappen</button><div class="su-diag-content"><div id="su-diag-fps">— FPS</div><small>Letzte 0,5–1 s · keine Benchmark-Wertung</small><p>ESC gibt die Maus frei. Eine Änderung nach der anderen. Nur diese Sitzung.</p><h3>Audio</h3><button data-action="audio">Audioberechnung ausschalten</button><button data-action="audioOn">Audioberechnung wieder an</button><small>Stoppt testweise den Mixer, nicht nur die Lautstärke. Bleibt aus, bis du wieder einschaltest.</small><label>Ton hörbar <input type="checkbox" data-hostsound></label><h3>Grafik · Ausschlusstests</h3><div data-gpu></div><div data-quality></div><div data-draw></div><small>Bildfehler/fehlende Flächen sind bei Ausschlusstests beabsichtigt. Kein separater Schatten-Schalter belegt.</small><h3>CPU · vorhandene JIT-Schalter</h3><label>Codeblockgröße<select data-cpu="1"><option value="3">Standard (3 Seiten)</option><option value="1">Klein (1 Seite)</option></select></label><label>Gleitkomma lokal puffern<input type="checkbox" data-cpu="10"></label><label>Rücksprünge optimieren<input type="checkbox" data-cpu="13"></label><small>CPU-Wechsel leert den Codecache: anfängliches Ruckeln ist Aufwärmen, kein Ergebnis.</small><button data-action="reset">Alles auf Ausgangswerte</button><p id="su-diag-status" role="status">Bereit.</p><div id="su-diag-history"></div></div>`;
 document.head.append(style);document.body.append(aside);
 aside.addEventListener('keydown',e=>e.stopPropagation());
 const el=s=>aside.querySelector(s),status=t=>el('#su-diag-status').textContent=t;
 const logs=[],changedGpu=new Map();let busy=false,previous=null,lastFps=null,stopped=false,previousDraw=null;
 function log(label){logs.push({utc:new Date().toISOString(),label,fps:lastFps});if(logs.length>200)logs.shift();el('#su-diag-history').textContent=logs.slice(-5).map(x=>`${x.utc.slice(11,19)} ${x.label}`).join('\n');}
 const syncCpu=r=>{for(const c of aside.querySelectorAll('[data-cpu]'))if(c.type==='checkbox')c.checked=!!r.values[c.dataset.cpu];else c.value=r.values[c.dataset.cpu];};syncCpu(originalCpu);
 el('[data-hostsound]').checked=!hostMuted;
 const gpuLabels={forceDisableZTest:'Tiefentest aus',forceDisableStencil:'Stencil aus',forceDisableAlphaTest:'Transparenztest aus',forceDisableAlphaBlend:'Transparenzmischung aus',forceCullNone:'Rückseiten-Ausblendung aus'};
 if(gpu)for(const[name,label]of Object.entries(gpuLabels)){
  const vals=Object.values(gpu).filter(f=>f&&typeof f[name]==='boolean').map(f=>f[name]);
  if(!vals.length||vals.some(x=>x!==vals[0]))continue;
  const row=document.createElement('label');row.textContent=label;const input=document.createElement('input');input.type='checkbox';input.dataset.gpu=name;input.checked=vals[0];row.append(input);el('[data-gpu]').append(row);changedGpu.set(name,vals[0]);
 }
 if(quality){el('[data-quality]').innerHTML='<label>Render-Auflösung<select data-quality="internalScale"><option value="0">Automatisch</option><option value="1">Original / nativ</option><option value="2">Doppelt (Lasttest)</option></select></label><button data-action="neutral">Zusätzliche Bildeffekte aus</button>';el('[data-quality="internalScale"]').value=quality.internalScale;}
 if(scrub)el('[data-draw]').innerHTML='<label>3D-Zeichnen unterdrücken<input type="checkbox" data-draw-off></label><small>Bild wird leer/bleibt stehen; Spiellogik läuft weiter. FPS zählen Presents, nicht sichtbare Bilder.</small>';
 async function changeCpu(action,patch){
  const before=await cpu('read');if(!before.paused)await run('pause');
  try{for(let i=0;i<20;i++){const ready=await run('evalWorker','const s=System.getInstance();return !s.process.v86.is_running();');if(ready)break;if(i===19)throw Error('Pause dauert zu lange');await new Promise(r=>setTimeout(r,25));}syncCpu(await cpu(action,patch));}
  finally{if(!before.paused)await run('resume');}
 }
 async function reset(){
  if(audioFn)await audio('restore');
  for(const[name,value]of changedGpu){await run('gpuToggle',name,value);el(`[data-gpu="${name}"]`).checked=value;}
  if(scrub){await run('drawScrub',scrub.min??0,scrub.max??-1,scrub.target??0,scrub.exclude===true);el('[data-draw-off]').checked=false;}
  if(quality){await run('dbgCall','quality',quality);el('[data-quality="internalScale"]').value=quality.internalScale;}
  await changeCpu('reset');__BS__.audioEngine.setMuted(hostMuted);el('[data-hostsound]').checked=!hostMuted;
 }
 async function act(fn,label){if(busy)return;busy=true;for(const c of aside.querySelectorAll('input,select,button'))if(c.dataset.action!=='fold')c.disabled=true;status('Wird umgestellt …');try{await fn();log(label);status(label+' · aktiv');previous=null;}catch(e){status('Prüfung fehlgeschlagen: '+e.message);log('FEHLER: '+e.message);try{syncCpu(await cpu('read'));}catch{}}finally{busy=false;for(const c of aside.querySelectorAll('input,select,button'))c.disabled=false;}}
 aside.addEventListener('change',e=>{const t=e.target;if(t.dataset.cpu)void act(()=>changeCpu('set',{[t.dataset.cpu]:t.type==='checkbox'?Number(t.checked):Number(t.value)}),'CPU '+t.dataset.cpu+' = '+(t.type==='checkbox'?Number(t.checked):t.value));else if(t.dataset.gpu)void act(()=>run('gpuToggle',t.dataset.gpu,t.checked),gpuLabels[t.dataset.gpu]+': '+t.checked);else if(t.dataset.quality)void act(()=>run('dbgCall','quality',{[t.dataset.quality]:Number(t.value)}),'Render-Auflösung '+t.value);else if(t.hasAttribute('data-draw-off'))void act(()=>run('drawScrub',t.checked?2147483647:(scrub.min??0),t.checked?-1:(scrub.max??-1),t.checked?0:(scrub.target??0),false),'3D-Zeichnen '+(t.checked?'AUS':'AN'));else if(t.hasAttribute('data-hostsound'))__BS__.audioEngine.setMuted(!t.checked);});
 aside.addEventListener('click',e=>{const a=e.target.closest('[data-action]')?.dataset.action;if(a==='fold'){aside.dataset.folded=aside.dataset.folded!=='true';e.target.textContent=aside.dataset.folded==='true'?'Diagnose öffnen':'Panel einklappen';return;}if(a==='reset')void act(reset,'Ausgangswerte wiederhergestellt');if(a==='audio'||a==='audioOn')void act(()=>audio(a==='audio'?'off':'restore'),a==='audio'?'Audiomixer aus':'Audiomixer an');if(a==='neutral')void act(()=>run('dbgCall','quality',{postAA:'off',tonemap:'off',vignette:0,crt:false,scanlines:false,msaa:1,anisotropy:1,forceTrilinear:false}),'Zusätzliche Bildeffekte aus');});
 async function poll(){if(stopped)return;try{if(!busy){const r=await run('state',['screen']),now=performance.now(),serial=r.screen.presentSerial;if(previous&&serial>=previous.serial){lastFps=(serial-previous.serial)*1000/(now-previous.time);el('#su-diag-fps').textContent=lastFps.toFixed(1).replace('.',',')+' FPS';}previous={time:now,serial};if(audioFn){const a=await audio('status');el('[data-action="audio"]').textContent=a.active?'Mixer AUS · bleibt ausgeschaltet':'Audioberechnung ausschalten';if(a.status==='restore-blocked'||a.status==='external-suspension-remains')status('Audio-Rücksetzung prüfen: '+a.status);}}}catch(e){status('Messung: '+e.message);}finally{if(!stopped)setTimeout(poll,500);}}
 window.__suDiagnosticPanel={logs,reset:()=>act(reset,'Ausgangswerte wiederhergestellt'),state:()=>({busy,lastFps,quality,gpu,scrub,originalCpu}),remove:async()=>{await reset();stopped=true;aside.remove();style.remove();delete window.__suDiagnosticPanel;}};
 void poll();return {installed:true,audioAvailable:!!audioFn,gpuFlags:[...changedGpu.keys()],qualityAvailable:!!quality,drawScrubAvailable:!!scrub};
}
