import { describe, expect, test } from 'bun:test';
import { lightingVectorLength, applyLightingFlat } from '../../src/worker/modules/opengl32/lighting';
import { createOpenGLContext, VERT_FLOATS } from '../../src/worker/modules/opengl32/context';

describe('lighting vector length',()=>{
    test('preserves robust zero, underflow, overflow and nonfinite behavior',()=>{
        for(const v of [[0,-0,0],[1e-300,2e-300,3e-300],[1e300,2e300,3e300],
            [Number.MAX_VALUE,Number.MAX_VALUE,0],[Infinity,NaN,1],[NaN,1,2],[-Infinity,2,3]]) {
            expect(lightingVectorLength(...v as [number,number,number])).toBe(Math.hypot(...v));
        }
    });
    test('has double precision relative accuracy over the finite exponent range',()=>{
        for(let exponent=-500;exponent<=500;exponent+=5)for(let i=1;i<=31;i++) {
            const scale=2**exponent,x=Math.sin(i)*scale,y=Math.cos(i)*scale,z=(i/31)*scale;
            const expected=Math.hypot(x,y,z);
            expect(Math.abs(lightingVectorLength(x,y,z)/expected-1)).toBeLessThan(5e-16);
        }
    });
});

test('zero-specular lights preserve diffuse/ambient and separate primary colors',()=>{
    const ctx=createOpenGLContext({getCurrentMemory:()=>new Uint8Array(0)} as never);
    ctx.enableFlags.add(0x0b50);ctx.enableFlags.add(0x0ba1);ctx.enableFlags.add(0x4000);
    ctx.hints.set(0x81f8,0x81fa);
    ctx.lightModelAmbient.fill(0);ctx.materialFrontAmbient.fill(0.5);
    ctx.materialFrontDiffuse.set([0.6,0.4,0.2,0.7]);ctx.materialFrontSpecular.fill(1);
    ctx.materialFrontShininess=128;
    const l=ctx.lights[0];l.position.set([0,0,4,1]);l.ambient.fill(0.2);l.diffuse.fill(0.5);l.specular.fill(0);
    const input=new Float32Array(VERT_FLOATS);input[3]=1;input[10]=2;
    const a=input.slice();applyLightingFlat(ctx,a,0,1,0);
    expect(Array.from(a.slice(4,8))).toEqual(new Array(0.4,0.3,0.2,0.7).map(Math.fround));
    expect(Array.from(a.slice(15,18))).toEqual([0,0,0]);
    l.specular.fill(1);const b=input.slice();applyLightingFlat(ctx,b,0,1,0);
    expect(b.slice(4,8)).toEqual(a.slice(4,8));expect(Array.from(b.slice(15,18))).toEqual([1,1,1]);
    l.specular.fill(0);const c=input.slice();applyLightingFlat(ctx,c,0,1,0);
    expect(c).toEqual(a); // consecutive draws must observe changed light state
});
