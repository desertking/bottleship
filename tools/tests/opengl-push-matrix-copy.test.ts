import { afterEach, expect, test } from "bun:test";
import { OpenGL32 } from "../../src/worker/modules/opengl32/index";
import { createMatrixExports } from "../../src/worker/modules/opengl32/matrix";

afterEach(() => { delete (globalThis as { __glPushMatrixSet?: boolean }).__glPushMatrixSet; });

function setup(): { ctx: any; ex: any } {
    const mem = new Uint8Array(1 << 16);
    const disp = { registerWriteBufferFunction: () => true, registerZeroArgWriteBufferFunction: () => true, registerPtrDerefWriteBufferFunction: () => true };
    const gl = new OpenGL32();
    gl.initialize({ getCurrentMemory: () => mem, dispatcher: disp } as any);
    const ctx = gl.getContext() as any;
    return { ctx, ex: createMatrixExports(ctx) };
}

function trace(setMode: boolean): number[][] {
    if (setMode) (globalThis as { __glPushMatrixSet?: boolean }).__glPushMatrixSet = true;
    const { ctx, ex } = setup();
    const out: number[][] = [];
    for (let k = 0; k < 40; k++) {
        const m = ctx.currentMatrix();
        for (let i = 0; i < 16; i++) m[i] = Math.sin(k * 16 + i);
        ex.glPushMatrix(null, null, []);
        const top = ctx.currentMatrix();
        out.push(Array.from(top));
        top[3] = 99;
        if (k % 3 === 2) { ex.glPopMatrix(null, null, []); ex.glPopMatrix(null, null, []); }
        out.push(Array.from(ctx.currentMatrix()));
    }
    return out;
}

test("glPushMatrix copies the matrix into the new top without aliasing it", () => {
    const fast = trace(false);
    const viaSet = trace(true);
    expect(fast).toEqual(viaSet);
    const { ctx, ex } = setup();
    const m = ctx.currentMatrix();
    m[5] = 7;
    ex.glPushMatrix(null, null, []);
    ex.glPushMatrix(null, null, []);
    ex.glPopMatrix(null, null, []);
    ctx.currentMatrix()[5] = 1;
    expect(ctx.currentStack().stack[ctx.currentStack().top - 1][5]).toBe(7);
});
