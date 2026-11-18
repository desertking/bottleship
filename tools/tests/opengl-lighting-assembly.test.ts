import { describe, expect, test } from 'bun:test';
import { createOpenGLContext, VERT_FLOATS, CMD_I32, CMD_F32 } from '../../src/worker/modules/opengl32/context';
import { emitDrawCommandFlat, assembleFlatVerts, assembledVertCount, emitArenaDraw } from '../../src/worker/modules/opengl32/immediate';
import { restoreImmediateMaterials } from '../../src/worker/modules/opengl32/lighting';

function fixture(seed:number, twoSide=false) {
    const mem=new Uint8Array(4096),ctx=createOpenGLContext({getCurrentMemory:()=>mem} as never);
    ctx.enableFlags.add(0x0b50);ctx.enableFlags.add(0x0ba1);ctx.enableFlags.add(0x0b60);
    if(seed&1){ctx.enableFlags.add(0x0b57);ctx.colorMaterialParam=0x1602;}
    if(seed&2)ctx.hints.set(0x0b51,1);
    if(seed&4)ctx.hints.set(0x81f8,0x81fa);
    if(twoSide)ctx.hints.set(0x0b52,1);
    ctx.materialFrontSpecular.set([.3,.5,.7,1]);ctx.materialFrontShininess=seed*7;
    ctx.materialBackDiffuse.set([.1,.8,.2,.4]);ctx.materialBackEmission.set([.07,.03,.09,1]);
    ctx.modelviewStack.stack[0].set([1.2,0,.1,0, .2,.7,0,0, 0,.1,1.4,0, .2,-.3,-2,1]);
    ctx.projectionStack.stack[0][11]=-.2;
    ctx.enableFlags.add(0x0c60);ctx.enableFlags.add(0x0c61);
    ctx.texGenS.mode=0x2401;ctx.texGenT.mode=0x2400;
    ctx.texGenS.objectPlane.set([.3,.5,.1,.2]);ctx.texGenT.eyePlane.set([.7,.1,.4,.3]);
    for(let k=0;k<3;k++){
        ctx.enableFlags.add(0x4000+k);const l=ctx.lights[k];
        l.position.set([k-1,.3+k,3,k===0&&seed&1?0:1]);
        l.ambient.set([.05,.07,.09,1]);l.diffuse.set([.7,.6,.5,1]);l.specular.set([.3,.2,.4,1]);
        l.linearAttenuation=.03*k;l.quadraticAttenuation=.01;
        if(k===2&&seed&8){l.spotCutoff=55;l.spotExponent=3;l.spotDirection.set([0,0,-1]);}
    }
    return ctx;
}
function vertices(count:number,seed:number){
    const v=new Float32Array(count*VERT_FLOATS);
    for(let i=0;i<count;i++){const b=i*VERT_FLOATS;v.set([Math.sin(i+seed),Math.cos(i*.7),i*.01,1,.1+i*.01,.2,.4,.8,.3,.2,1,.2,.3,.4,.5,0,0,0],b);}
    return v;
}
function reset(ctx:ReturnType<typeof fixture>){ctx.commands.reset();ctx.vertArena.reset();}
function reference(ctx:ReturnType<typeof fixture>,mode:number,v:Float32Array,count:number){
    ctx.vertArena.reserve(assembledVertCount(mode,count));
    const n=assembleFlatVerts(v,count,mode,ctx.vertArena.data);
    emitArenaDraw(ctx,mode,0,n);
}
function snapshot(ctx:ReturnType<typeof fixture>){return {
    vertices:new Uint32Array(ctx.vertArena.data.buffer,0,ctx.vertArena.used).slice(),
    i32:ctx.commands.i32.slice(0,ctx.commands.count*CMD_I32),
    f32:new Uint32Array(ctx.commands.f32.buffer,0,ctx.commands.count*CMD_F32).slice(),
};}

describe('one-sided lighting before primitive expansion',()=>{
    test('bit-identical output to lighting each assembled vertex across state and topology',()=>{
        for(let seed=0;seed<16;seed++){
            const a=fixture(seed),b=fixture(seed);
            for(const mode of [5,6,8,9])for(const n of [4,7,29]){
                reset(a);reset(b);const v=vertices(n,seed);
                reference(a,mode,v,n);emitDrawCommandFlat(b,mode,v.slice(),n);
                expect(snapshot(b)).toEqual(snapshot(a));
            }
        }
    });
    test('two-sided strips keep per-triangle facing and do not modify source attributes',()=>{
        const a=fixture(7,true),b=fixture(7,true);
        for(const mode of [5,6,8,9]){
            reset(a);reset(b);const v=vertices(17,2),copy=v.slice();
            reference(a,mode,v,17);emitDrawCommandFlat(b,mode,copy,17);
            expect(snapshot(b)).toEqual(snapshot(a));expect(copy).toEqual(v);
        }
    });
    test('immediate material snapshots survive source-index replacement and shared vertices',()=>{
        const a=fixture(3),b=fixture(3),n=19,v=vertices(n,4);
        const mat=(r:number)=>[.1,.2,.3,1,r,.4,.5,.7,.3,.2,.1,1,.02,.03,.04,1,11];
        const snap={index:1,materials:[[...mat(.2),...mat(.6)],[...mat(.8),...mat(.4)]]};
        for(const ctx of [a,b]){ctx.immediateMode=true;ctx.immediateFlatCount=n;restoreImmediateMaterials(ctx,snap);}
        for(let i=0;i<n;i++)v[i*VERT_FLOATS+15]=i%2;
        reference(a,5,v,n);emitDrawCommandFlat(b,5,v.slice(),n,false,true);
        expect(snapshot(b)).toEqual(snapshot(a));
    });
    test('repeated owned-buffer reuse keeps output and resource identities stable',()=>{
        const a=fixture(9),b=fixture(9),src=vertices(37,4),owned=src.slice();
        reference(a,6,src,37);const expected=snapshot(a);
        emitDrawCommandFlat(b,6,owned,37);const arena=b.vertArena.data,commands=b.commands.i32,keys=Object.keys(b);
        for(let i=0;i<1000;i++){reset(b);owned.set(src);emitDrawCommandFlat(b,6,owned,37);}
        expect(snapshot(b)).toEqual(expected);expect(b.vertArena.data).toBe(arena);expect(b.commands.i32).toBe(commands);expect(Object.keys(b)).toEqual(keys);expect(src).toEqual(vertices(37,4));
    });
});
