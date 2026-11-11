import { afterEach, expect, test } from "bun:test";
import { OpenGL32 } from "../../src/worker/modules/opengl32/index";
import { fastPathFromExport, registerFastPathGLFunctions, GL_FAST_FUNCTIONS } from "../../src/worker/modules/opengl32/fast-draw";
import { CMD_I32, VERT_FLOATS } from "../../src/worker/modules/opengl32/context";

const GL_TRIANGLES = 0x0004, GL_FLOAT = 0x1406, GL_UNSIGNED_SHORT = 0x1403, GL_VERTEX_ARRAY = 0x8074, GL_RENDER = 0x1C00;
const VERTS = 0x1000, IDX = 0x2000, MAT = 0x3000, ESP = 0x8000;

afterEach(() => { delete (globalThis as { __noGlFastDraw?: boolean }).__noGlFastDraw; });

function setup() {
    const mem = new Uint8Array(1 << 16);
    const dv = new DataView(mem.buffer);
    const regs: Record<string, (...a: unknown[]) => unknown> = {};
    const disp = {
        registerWriteBufferFunction: () => true,
        registerZeroArgWriteBufferFunction: () => true,
        registerPtrDerefWriteBufferFunction: () => true,
        registerFastPath: (_dll: string, fn: string, impl: (...a: unknown[]) => unknown) => { regs[fn] = impl; },
    };
    const gl = new OpenGL32();
    gl.initialize({ getCurrentMemory: () => mem, dispatcher: disp } as any);
    const ctx = gl.getContext() as any;
    ctx.renderMode = GL_RENDER;
    const exp = (gl as any).exports as Record<string, (...a: unknown[]) => unknown>;
    for (let v = 0; v < 6; v++) for (let k = 0; k < 3; k++) dv.setFloat32(VERTS + (v * 3 + k) * 4, v * 1.5 + k * 0.25 - 2, true);
    [0, 1, 2, 3, 4, 5, 2, 1, 0].forEach((x, i) => dv.setUint16(IDX + i * 2, x, true));
    for (let i = 0; i < 16; i++) dv.setFloat32(MAT + i * 4, i % 5 === 0 ? 1 : 0.125 * i, true);
    exp.glVertexPointer({}, mem, [3, GL_FLOAT, 0, VERTS]);
    exp.glEnableClientState({}, mem, [GL_VERTEX_ARRAY]);
    return { mem, dv, ctx, exp, regs };
}

function stdcall(dv: DataView, args: number[]): void {
    dv.setUint32(ESP, 0x401000, true);
    args.forEach((a, i) => dv.setUint32(ESP + 4 + i * 4, a >>> 0, true));
}

function frame(ctx: any) {
    return {
        cmds: Array.from(ctx.commands.i32.subarray(0, ctx.commands.count * CMD_I32)),
        verts: Array.from(ctx.vertArena.data.subarray(0, ctx.vertArena.used)),
        mv: Array.from(ctx.modelviewStack.stack[ctx.modelviewStack.top]),
    };
}

test("the draw-path entry points are registered on the fast path from the wrapped export table", () => {
    const { regs } = setup();
    for (const [name] of GL_FAST_FUNCTIONS) expect(typeof regs[name]).toBe("function");
});

test("a fast-path draw produces the same frame as the trapping export", () => {
    const a = setup();
    a.exp.glLoadMatrixf({}, a.mem, [MAT]);
    a.exp.glDrawElements({}, a.mem, [GL_TRIANGLES, 9, GL_UNSIGNED_SHORT, IDX]);
    a.exp.glDrawArrays({}, a.mem, [GL_TRIANGLES, 0, 6]);
    const b = setup();
    stdcall(b.dv, [MAT]);
    expect(b.regs.glLoadMatrixf!(ESP, b.dv, b.mem, null, null)).toBe(0);
    stdcall(b.dv, [GL_TRIANGLES, 9, GL_UNSIGNED_SHORT, IDX]);
    expect(b.regs.glDrawElements!(ESP, b.dv, b.mem, null, null)).toBe(0);
    stdcall(b.dv, [GL_TRIANGLES, 0, 6]);
    expect(b.regs.glDrawArrays!(ESP, b.dv, b.mem, null, null)).toBe(0);
    expect(frame(b.ctx)).toEqual(frame(a.ctx));
    expect(b.ctx.vertArena.used).toBe(15 * VERT_FLOATS);
});

test("negative: arguments are read in stdcall order and a throw never falls through to a second run", () => {
    const seen: number[][] = [];
    const mem = new Uint8Array(0x100);
    const dv = new DataView(mem.buffer);
    [0, 11, 22, 33].forEach((v, i) => dv.setUint32(0x10 + i * 4, v, true));
    const ok = fastPathFromExport("x", (_c, _m, args) => { seen.push([...(args as number[])]); return 7; }, 3);
    expect(ok(0x10, dv, mem, null as never, null)).toBe(7);
    expect(seen).toEqual([[11, 22, 33]]);
    const boom = fastPathFromExport("y", () => { throw new Error("x"); }, 1);
    expect(boom(0x10, dv, mem, null as never, null)).toBe(0);
    expect(ok(mem.length - 8, dv, mem, null as never, null)).toBeNull();
});

test("negative: the kill switch leaves every draw on the trap", () => {
    (globalThis as { __noGlFastDraw?: boolean }).__noGlFastDraw = true;
    const { regs } = setup();
    for (const [name] of GL_FAST_FUNCTIONS) expect(regs[name]).toBeUndefined();
    expect(registerFastPathGLFunctions({}, {})).toBe(0);
});
