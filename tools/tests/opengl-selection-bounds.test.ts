import {describe,expect,test} from 'bun:test';
import {createOpenGLContext} from '../../src/worker/modules/opengl32/context';
import {createStateExports} from '../../src/worker/modules/opengl32/state';
import {createImmediateExports} from '../../src/worker/modules/opengl32/immediate';
import {createArrayExports} from '../../src/worker/modules/opengl32/arrays';
import {selectionArrayOutside} from '../../src/worker/modules/opengl32/selection';
import * as G from '../../src/worker/modules/opengl32/constants';
function setup(size=3){
 const mem=new Uint8Array(65536),f=new Float32Array(mem.buffer);
 const ctx=createOpenGLContext({getCurrentMemory:()=>mem,getModule:()=>({exports:api})} as never);
 const api={...createStateExports(ctx),...createImmediateExports(ctx),...createArrayExports(ctx)};
 const call=(name:string,...args:number[])=>api[name]!(null as never,mem,args) as number;
 call('glSelectBuffer',64,256);call('glVertexPointer',size,G.GL_FLOAT,16,4096);call('glEnableClientState',G.GL_VERTEX_ARRAY);
 const fill=(points:number[][])=>{points.forEach((p,i)=>f.set([p[0]!,p[1]!,p[2]!,1],1024+i*4));};
 const idx=Uint32Array.from({length:192},(_,i)=>i);
 const reject=()=>selectionArrayOutside(ctx,idx,192,f);
 const begin=()=>{call('glRenderMode',G.GL_SELECT);call('glPushName',17);};
 const end=()=>({hits:call('glRenderMode',G.GL_RENDER),words:Array.from(new Uint32Array(mem.buffer,256,64)),error:ctx.error});
 return {ctx,mem,f,call,fill,idx,reject,begin,end};
}
const points=(x:number)=>Array.from({length:192},(_,i)=>[x+(i%3)*.01,(i%7)*.01,(i%11)*.01]);
describe('selection client-array bounds',()=>{
 test('rejects outside geometry, re-reads mutable guest positions, preserves pending hits',()=>{
  const s=setup();s.fill(points(2));expect(s.reject()).toBe(true);s.f[1024]=0;expect(s.reject()).toBe(false);
  s.fill(points(0));s.begin();s.call('glDrawArrays',G.GL_TRIANGLES,0,192);
  const hit=[s.ctx.selectHit,s.ctx.selectMinZ,s.ctx.selectMaxZ];s.fill(points(2));s.call('glDrawArrays',G.GL_TRIANGLES,0,192);
  expect([s.ctx.selectHit,s.ctx.selectMinZ,s.ctx.selectMaxZ]).toEqual(hit);expect(s.end().hits).toBe(1);
 });
 test('boundaries, non-finite vertices and unsupported layouts retain exact clipping',()=>{
  const s=setup();s.fill(Array.from({length:192},()=>[1,0,0]));expect(s.reject()).toBe(false);
  s.fill(points(2));s.f[1024]=NaN;expect(s.reject()).toBe(false);
  s.f[1024]=Infinity;expect(s.reject()).toBe(false);
  s.fill(points(2));s.ctx.vertexArray.size=4;expect(s.reject()).toBe(false);
  s.ctx.vertexArray.size=3;s.ctx.vertexArray.pointer=4097;expect(s.reject()).toBe(false);
  s.ctx.vertexArray.pointer=4096;expect(selectionArrayOutside(s.ctx,s.idx,6,s.f)).toBe(false);
  expect(selectionArrayOutside(s.ctx,s.idx,192,null)).toBe(false);
 });
 test('all client arrays are validated before an outside rejection',()=>{
  const s=setup();s.fill(points(2));s.call('glColorPointer',4,G.GL_FLOAT,16,65520);s.call('glEnableClientState',G.GL_COLOR_ARRAY);
  s.begin();s.call('glDrawArrays',G.GL_TRIANGLES,0,192);expect(s.ctx.error).toBe(G.GL_INVALID_OPERATION);
 });
 test('normal rendering still emits off-volume draws for backend clipping',()=>{
  const s=setup();s.fill(points(2));s.call('glDrawArrays',G.GL_TRIANGLES,0,192);expect(s.ctx.commands.count).toBeGreaterThan(0);
 });
 test('indexed positions, changing transforms, reversed depth and culling match the exact four-component fallback',()=>{
  let seed=0x533aac;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
  for(let trial=0;trial<240;trial++){
   const p=Array.from({length:192},()=>[(rand()-.5)*8,(rand()-.5)*8,(rand()-.5)*8]);
   if(trial%3===0)for(const v of p)v[0]+=10;
   if(trial%17===0)p[0]![0]=NaN;
   const mv=new Float32Array(16),pr=new Float32Array(16);
   for(let i=0;i<16;i++){mv[i]=(rand()-.5)*4;pr[i]=(rand()-.5)*4;}
   if(trial%5===0){mv.fill(0);pr.fill(0);for(let i=0;i<4;i++){mv[i*5]=1;pr[i*5]=1;}}
   if(trial%13===0){mv[0]=1e30;pr[0]=1e-30;}
   const mode=trial%10,indices=Uint16Array.from({length:192},(_,i)=>(i*43)%192);
   const results=[];
   for(const size of [3,4]){
    const s=setup(size);s.fill(p);s.ctx.modelviewStack.stack[0]!.set(mv);s.ctx.projectionStack.stack[0]!.set(pr);
    if(trial%2===0){s.call('glEnable',G.GL_CULL_FACE);s.call('glCullFace',G.GL_BACK);}
    if(trial%4===0)s.call('glDepthRange',1,0);
    new Uint16Array(s.mem.buffer,16384,192).set(indices);
    s.begin();if(trial%2)s.call('glDrawElements',mode,192,G.GL_UNSIGNED_SHORT,16384);else s.call('glDrawArrays',mode,0,192);
    results.push(s.end());
   }
   expect(results[0]).toEqual(results[1]);
  }
 });
 test('repeated rejections allocate no frame vertices, commands or context state',()=>{
  const s=setup();s.fill(points(2));s.begin();const keys=Object.keys(s.ctx),arena=s.ctx.vertArena.data,commands=s.ctx.commands.i32,commandFloats=s.ctx.commands.f32;
  for(let i=0;i<20000;i++)s.call('glDrawArrays',G.GL_TRIANGLES,0,192);
  expect(s.ctx.vertArena.data).toBe(arena);expect(s.ctx.commands.i32).toBe(commands);expect(s.ctx.commands.f32).toBe(commandFloats);expect(Object.keys(s.ctx)).toEqual(keys);
  expect(s.ctx.vertArena.used).toBe(0);expect(s.ctx.commands.count).toBe(0);expect(s.end().hits).toBe(0);
 });
});
