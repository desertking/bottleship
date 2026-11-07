import { afterEach, expect, test } from "bun:test";
import { copyTransformFlatVerts, transformFlatVerts } from "../../src/worker/modules/opengl32/immediate";
import { VERT_FLOATS } from "../../src/worker/modules/opengl32/context";
import { GL_FOG } from "../../src/worker/modules/opengl32/constants";

afterEach(() => { delete (globalThis as { __glFusedQuadTransform?: boolean }).__glFusedQuadTransform; });

function rnd(n: number, seed: number): Float32Array {
    const a = new Float32Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; a[i] = (s / 4294967296) * 6 - 3; }
    return a;
}

function ctxWith(fog: boolean): any {
    return {
        modelviewStack: { stack: [rnd(16, 7)], top: 0 },
        projectionStack: { stack: [rnd(16, 11)], top: 0 },
        enableFlags: new Set(fog ? [GL_FOG] : []),
        viewportX: 0, viewportY: 0, viewportW: 640, viewportH: 480,
    };
}

for (const fog of [false, true]) {
    test(`fused copy+transform equals copy then transform (fog ${fog})`, () => {
        const ctx = ctxWith(fog);
        const count = 12;
        const src = rnd(count * VERT_FLOATS, 3);
        const base = 2 * VERT_FLOATS;
        const a = rnd(base + count * VERT_FLOATS + VERT_FLOATS, 5);
        const b = a.slice();
        b.set(src, base);
        transformFlatVerts(ctx, b, base, count);
        transformFlatVerts(ctx, b.slice(), base, count);
        copyTransformFlatVerts(ctx, src, a, base, count);
        expect(Array.from(a)).toEqual(Array.from(b));
    });
}

import { OpenGL32 } from "../../src/worker/modules/opengl32/index";
import { emitDrawCommandFlat } from "../../src/worker/modules/opengl32/immediate";

function realCtx(): any {
    const mem = new Uint8Array(1 << 16);
    const disp = { registerWriteBufferFunction: () => true, registerZeroArgWriteBufferFunction: () => true, registerPtrDerefWriteBufferFunction: () => true };
    const gl = new OpenGL32();
    gl.initialize({ getCurrentMemory: () => mem, dispatcher: disp } as any);
    const ctx = gl.getContext() as any;
    ctx.renderMode = 0x1C00;
    ctx.polygonModeFront = 0x1B02;
    return ctx;
}

function drive(fused: boolean, fog: boolean): any {
    (globalThis as { __glFusedQuadTransform?: boolean }).__glFusedQuadTransform = fused;
    const ctx = realCtx();
    if (fog) ctx.enableFlags.add(GL_FOG);
    const warm = rnd(3 * VERT_FLOATS, 1);
    transformFlatVerts(ctx, warm, 0, 3);
    transformFlatVerts(ctx, warm, 0, 3);
    for (let k = 0; k < 200; k++) {
        const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];
        mv.set(rnd(16, 100 + k));
        const count = 4 * (1 + (k % 3)) + (k % 5 === 0 ? 2 : 0);
        emitDrawCommandFlat(ctx, 0x0007, rnd(count * VERT_FLOATS, 500 + k), count, false, true);
    }
    return { arena: Array.from(ctx.vertArena.data.subarray(0, ctx.vertArena.used)), cmds: Array.from(ctx.commands.i32.subarray(0, ctx.commands.count * 64)) };
}

for (const fog of [false, true]) {
    test(`GL_QUADS through the fused path leave the same arena and draws (fog ${fog})`, () => {
        const on = drive(true, fog);
        const off = drive(false, fog);
        expect(on.arena.length).toBeGreaterThan(0);
        expect(on.arena).toEqual(off.arena);
        expect(on.cmds).toEqual(off.cmds);
    });
}
