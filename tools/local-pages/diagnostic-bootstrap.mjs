if(['localhost','127.0.0.1'].includes(location.hostname)&&new URLSearchParams(location.search).has('x87diag')){
 import('./x87res-diag.mjs').then(m=>m.installDiag()).catch(e=>{window.__x87diagError=String(e.message||e);});
}else if(['localhost','127.0.0.1'].includes(location.hostname)&&new URLSearchParams(location.search).has('x87ab')){
 import('./x87res-bot.mjs').then(m=>m.installBot()).catch(e=>{window.__x87botError=String(e.message||e);});
}else if(['localhost','127.0.0.1'].includes(location.hostname)&&!window.__x87resLoader){
 const button=document.createElement('button');button.id='x87res-launcher';button.type='button';
 button.textContent='x87-A/B · wartet auf Spielstart';
 button.style.cssText='position:fixed;right:12px;top:12px;z-index:2147483001;padding:9px 14px;border:1px solid #9c7a64;border-radius:8px;background:#483420;color:#fff;font:14px system-ui;cursor:pointer';
 document.body.append(button);
 let loading=false,timer=null;
 async function show(){
  if(window.__x87resPanel){button.hidden=true;return;}
  if(loading)return;
  if(window.scpTest?.phase!=='playing'||!window.__BS__?.harness){button.textContent='x87-A/B · zuerst Spiel starten';return;}
  loading=true;button.disabled=true;button.textContent='x87-A/B wird geladen …';
  try{const m=await import('./x87res-panel.mjs');await m.installX87ResPanel();button.hidden=true;}
  catch(e){button.textContent='x87-A/B erneut öffnen';button.title=e.message;console.warn('x87-A/B:',e.message);}
  finally{loading=false;button.disabled=false;}
 }
 async function ready(){
  if(window.__x87resPanel){button.hidden=true;return;}
  if(window.scpTest?.phase==='playing'){await show();return;}
  timer=setTimeout(ready,500);
 }
 button.addEventListener('click',()=>void show());
 window.__x87resLoader={show};
 addEventListener('pagehide',()=>clearTimeout(timer),{once:true});
 void ready();
}
{
 const p=new URLSearchParams(location.search);
 if(['localhost','127.0.0.1'].includes(location.hostname)&&p.has('thunkOpt')){
  const mask=Number(p.get('thunkOpt'))>>>0;
  const apply=async()=>{
   while(window.scpTest?.phase!=='playing'||!window.__BS__?.harness)await new Promise(r=>setTimeout(r,250));
   const r=await __BS__.harness.__runSteps([{cmd:'evalWorker',args:[`const d=System.getInstance().process.dispatcher;return {n:d.setOptMask(${mask}),mask:d.optMask};`]}]);
   window.__thunkOpt=r?.steps?.[0]?.result??r;
   document.title='[thunkOpt '+mask+'] '+document.title;
  };
  apply().catch(e=>{window.__thunkOpt={error:String(e.message||e)};});
 }
}
