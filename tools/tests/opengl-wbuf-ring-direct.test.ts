import { expect, test } from "bun:test";
import { registerWriteBufferGLStateFunctions } from "../../src/worker/modules/opengl32/wbuf-state";
import { createMatrixExports } from "../../src/worker/modules/opengl32/matrix";
import { createOpenGLContext, mat4Multiply } from "../../src/worker/modules/opengl32/context";

function harness(compiling: boolean) {
    const calls: string[] = [];
    const ctx = { compilingList: compiling ? 1 : null } as any;
    const raw: Record<string, any> = {};
    const wrapped: Record<string, any> = {};
    for (const n of ["glEnable", "glPushMatrix"]) {
        raw[n] = () => { calls.push("raw:" + n); return 0; };
        wrapped[n] = () => { calls.push("wrapped:" + n); return 0; };
    }
    const handlers: Record<string, (m8: Uint8Array, m32: Uint32Array, p: number) => void> = {};
    const dispatcher = {
        registerWriteBufferFunction: (_d: string, name: string, _a: number, h: any) => { handlers[name] = h; return true; },
        registerZeroArgWriteBufferFunction: (_d: string, name: string, h: any) => { handlers[name] = h; return true; },
    };
    registerWriteBufferGLStateFunctions(dispatcher, wrapped, raw, ctx);
    const m32 = new Uint32Array([0, 0x0b44]);
    handlers.glEnable!(new Uint8Array(m32.buffer), m32, 4);
    handlers.glPushMatrix!(new Uint8Array(m32.buffer), m32, 4);
    ctx.compilingList = compiling ? null : 1;
    handlers.glEnable!(new Uint8Array(m32.buffer), m32, 4);
    return calls;
}

test("ring handlers skip the display-list wrapper only while no list is compiling", () => {
    expect(harness(false)).toEqual(["raw:glEnable", "raw:glPushMatrix", "wrapped:glEnable"]);
    expect(harness(true)).toEqual(["wrapped:glEnable", "wrapped:glPushMatrix", "raw:glEnable"]);
});

test("glTranslatef in place equals the full matrix product; pushed levels do not alias", () => {
    const ctx = createOpenGLContext({ getCurrentMemory: () => new Uint8Array(16) } as any);
    const gl = createMatrixExports(ctx) as Record<string, any>;
    const top = () => ctx.modelviewStack.stack[ctx.modelviewStack.top]!;
    const f = (v: number) => { const b = new Float32Array([v]); return new Uint32Array(b.buffer)[0]!; };
    gl.glRotatef(null, null, [f(30), f(0.3), f(1), f(0.2)]);
    const before = Float32Array.from(top());
    const t = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.5, -7, 0.125, 1]);
    const expected = new Float32Array(16);
    mat4Multiply(expected, before, t);
    gl.glPushMatrix(null, null, []);
    gl.glTranslatef(null, null, [f(2.5), f(-7), f(0.125)]);
    expect(Array.from(top())).toEqual(Array.from(expected));
    gl.glPopMatrix(null, null, []);
    expect(Array.from(top())).toEqual(Array.from(before));
    gl.glPushMatrix(null, null, []);
    expect(Array.from(top())).toEqual(Array.from(before));
    expect(top()).not.toBe(ctx.modelviewStack.stack[0]);
});
