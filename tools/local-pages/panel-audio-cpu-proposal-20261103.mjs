// Import-safe SOURCE proposal. Main owns the panel, exact-page guards and injection.
// This is a temporary CPU-work diagnostic, not merely mute or a production fix.
// Explicit user-controlled off/on: no automatic restoration timeout.
export function panelAudioCpuWorker(action,spec,System){
 const g=globalThis,key='__scpPanelAudioCpu20261103',sha='8b808c330b63a6e9e1843e1fa2895957267546ed6b14bcc2f2d80b03b495c20d';
 if(!['status','off','on'].includes(action)||!/^audio-panel-[a-z0-9-]{1,70}$/i.test(spec?.id??''))throw Error('Explicit panel action/id required');
 const sys=System.getInstance(),scheduler=sys.scheduler,v=sys.process?.v86,w=g.preemption?.getWasmExports?.();
 // In this pinned SCP build the mixer is the unique priority-15 CRT worker.
 // T8 uses the SAME CRT entry at priority 2: entry address alone is not identity.
 // Handles and thread IDs are session allocations, never build constants.
 const mixers=()=>[...scheduler.threads.values()].filter(t=>t.startAddress===9866191&&t.priority===15);
 const row=t=>t?{id:t.id,handle:t.handle,startAddress:t.startAddress,priority:t.priority,state:t.state,waitReason:t.waitInfo?.reason??null,suspendCount:t.suspendCount,kernelPinCount:t.kernelPinCount??0}:null;
 const snapshot=q=>({id:q?.id??null,active:q?.active??false,status:q?.status??'original',originalSuspendCount:q?.originalSuspendCount??null,
  schedulerThreadCount:scheduler.threads.size,originalSchedulerThreadCount:q?.originalSchedulerThreadCount??null,
  before:q?.before??null,current:row(q?scheduler.threads.get(q.before.id):mixers()[0]),t8:row(scheduler.threads.get(8)),
  startedMs:q?.startedMs??null,restoreRequestedAtMs:q?.restoreRequestedAtMs??null,
  autoRestoreAfterMs:null,restoreMode:'manual',restoration:q?.restoration??null,
  explicitTargets:q?[q.before.id]:[],t8ExplicitlyModified:false,audioMathOrGuestBytesChanged:false});
 if(action==='status')return snapshot(g[key]);
 if(g.__v86EngineLoad?.sha256!==sha||!v||typeof w?.trace2_enabled!=='function'||w.trace2_enabled()||typeof scheduler.suspendThread!=='function'||typeof scheduler.resumeThread!=='function')throw Error('CPU/scheduler/trace identity mismatch');
 const prior=g[key];
 if(action==='on'){
  if(!prior||prior.id!==spec.id)throw Error('No matching owned audio diagnostic');
  prior.restore('manual-on');return snapshot(prior);
 }
 if(prior?.active&&prior.id===spec.id)return {armed:true,...snapshot(prior)};
 if(prior?.active||g.__audioPauseTrial?.active)throw Error('Audio diagnostic already active; no overlapping suspension');
 if(g.__jitPublicationCapture||g.__wasmDump)throw Error('Capture active; coordinate first');
 const candidates=mixers(),t=candidates[0];
 if(candidates.length!==1||!Number.isInteger(t.id)||!Number.isInteger(t.handle)||t.handle<=0)throw Error('Unique original mixer role identity not established');
 if(t.suspendCount!==0||t.state!==3||t.waitInfo?.reason!==1||(t.kernelPinCount??0)>0||t.id===scheduler.currentThreadId)return {armed:false,reason:'Mixer not at safe WAITING/SLEEP boundary; no mutation',current:row(t),schedulerThreadCount:scheduler.threads.size};
 const engine=g.__v86EngineLoad,q={id:spec.id,active:true,status:'arming',originalSuspendCount:t.suspendCount,originalSchedulerThreadCount:scheduler.threads.size,before:row(t),startedMs:performance.now(),ownedIncrement:false,timer:null,restoration:null};
 q.restore=reason=>{
  if(!q.active)return;
  q.restoreRequestedAtMs=performance.now();clearTimeout(q.timer);q.timer=null;
  if(System.getInstance()!==sys||sys.scheduler!==scheduler||sys.process?.v86!==v||g.__v86EngineLoad!==engine||scheduler.threads.get(q.before.id)!==t||t.handle!==q.before.handle||t.id!==q.before.id){q.status='restore-blocked';q.restoration={reason,restored:false,error:'Exact original CPU/scheduler/thread replaced; no foreign resume'};return;}
  if(!q.ownedIncrement){
   if(t.suspendCount!==q.originalSuspendCount){q.status='restore-blocked';q.restoration={reason,restored:false,error:'Unexpected count without proven owned increment'};return;}
   q.active=false;q.status='original';q.restoration={reason,restored:true,noOwnedIncrement:true};return;
  }
  const before=t.suspendCount;
  // Release at most OUR one increment. Never force count=0 or consume a second
  // suspension. A foreign resume may already have brought the count to zero.
  if(!Number.isInteger(before)||before<0){q.status='restore-blocked';q.restoration={reason,restored:false,error:'Invalid suspend count'};return;}
  const previous=before>0?scheduler.resumeThread(t.handle):0;
  if(previous!==before||t.suspendCount!==Math.max(0,before-1)){q.status='restore-blocked';q.restoration={reason,restored:false,previous,count:t.suspendCount,error:'Canonical resume/count mismatch'};return;}
  q.ownedIncrement=false;q.active=false;
  q.status=t.suspendCount===q.originalSuspendCount?'original':'external-suspension-remains';
  q.restoration={reason,ownedIncrementReleased:true,previous,count:t.suspendCount,originalSuspendCount:q.originalSuspendCount,restored:t.suspendCount===q.originalSuspendCount,alreadyReleasedExternally:before===0};
 };
 g[key]=q;g.__audioPauseTrial=q;
 try{
  const previous=scheduler.suspendThread(t.handle);
  // Capture ownership before checking the ACK, so an unexpected return cannot
  // silently leave the observed increment without an automatic restore path.
  q.ownedIncrement=t.suspendCount===q.originalSuspendCount+1;
  if(previous!==q.originalSuspendCount||!q.ownedIncrement)throw Error('Canonical suspend/count mismatch');
  q.status='manual-mixer-cpu-off';return {armed:true,...snapshot(q)};
 }catch(error){q.error=String(error);q.restore('arm-failure');throw error;}
}
export const panelAudioCpuStep=(action,id)=>({cmd:'evalWorker',args:[`return (${panelAudioCpuWorker.toString()})(${JSON.stringify(action)},${JSON.stringify({id})},System);`]});
