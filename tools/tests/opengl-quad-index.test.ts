import { afterEach, describe, expect, test } from "bun:test";
import { OpenGL32 } from "../../src/worker/modules/opengl32/index";
import { emitDrawCommandFlat } from "../../src/worker/modules/opengl32/immediate";
import {
    CMD_I32, CMD_F32, CI_TYPE, CI_VERT_OFFSET, CI_VERT_COUNT, CI_FLAGS, VERT_FLOATS, GLDrawCommandType,
    DF_QUADS_INDEXED,
} from "../../src/worker/modules/opengl32/context";
import { OpenGLBackendExecutor, quadIndexPattern } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";

const GL_TRIANGLES = 0x0004, GL_QUADS = 0x0007, GL_QUAD_STRIP = 0x0008, GL_POLYGON = 0x0009;
const GL_FILL = 0x1B02, GL_LINE = 0x1B01, GL_RENDER = 0x1C00;

afterEach(() => { delete (globalThis as { __noGlQuadIndex?: boolean }).__noGlQuadIndex; });

function newCtx(): any {
    const mem = new Uint8Array(1 << 16);
    const disp = {
        registerWriteBufferFunction: () => true,
        registerZeroArgWriteBufferFunction: () => true,
        registerPtrDerefWriteBufferFunction: () => true,
    };
    const gl = new OpenGL32();
    gl.initialize({ getCurrentMemory: () => mem, dispatcher: disp } as any);
    const ctx = gl.getContext() as any;
    ctx.renderMode = GL_RENDER;
    return ctx;
}

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

type Step = { mode: number; count: number; poly: number; tex: number; translate: number; data: Float32Array };

function script(seed: number, steps: number): Step[] {
    const r = rng(seed);
    const out: Step[] = [];
    for (let k = 0; k < steps; k++) {
        const p = r();
        const mode = p < 0.7 ? GL_QUADS : p < 0.8 ? GL_TRIANGLES : p < 0.9 ? GL_QUAD_STRIP : GL_POLYGON;
        const count = mode === GL_QUADS ? 4 * (1 + Math.floor(r() * 3)) + (r() < 0.15 ? Math.floor(r() * 3) : 0)
            : 3 + Math.floor(r() * 6);
        const data = new Float32Array(count * VERT_FLOATS);
        for (let i = 0; i < data.length; i++) data[i] = r() * 4 - 2;
        for (let v = 0; v < count; v++) data[v * VERT_FLOATS + 3] = 1;
        out.push({ mode, count, poly: r() < 0.1 ? GL_LINE : GL_FILL, tex: r() < 0.2 ? 0 : 5, translate: r() < 0.3 ? r() : 0, data });
    }
    return out;
}

function run(steps: Step[], indexed: boolean): any {
    (globalThis as { __noGlQuadIndex?: boolean }).__noGlQuadIndex = !indexed;
    const ctx = newCtx();
    ctx.enableFlags.add(0x0DE1);
    ctx.enableFlags.add(0x0B71);
    for (const s of steps) {
        ctx.polygonModeFront = s.poly;
        ctx.textureUnits[0].enabled2d = s.tex !== 0;
        ctx.textureUnits[0].boundTexture = s.tex;
        const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];
        mv[12] = s.translate;
        emitDrawCommandFlat(ctx, s.mode, new Float32Array(s.data), s.count, false, true);
    }
    delete (globalThis as { __noGlQuadIndex?: boolean }).__noGlQuadIndex;
    return ctx;
}

function expandDraws(ctx: any, pattern: (quads: number) => Uint32Array): { rec: number[]; recF: number[]; verts: number[] }[] {
    const s = ctx.commands, I = s.i32, F = s.f32, arena = ctx.vertArena.data;
    const out: { rec: number[]; recF: number[]; verts: number[] }[] = [];
    for (let c = 0; c < s.count; c++) {
        const i = c * CMD_I32;
        if (I[i + CI_TYPE] !== GLDrawCommandType.DRAW) continue;
        const off = I[i + CI_VERT_OFFSET], n = I[i + CI_VERT_COUNT];
        const flags = I[i + CI_FLAGS];
        const order: number[] = [];
        if (flags & DF_QUADS_INDEXED) for (const x of pattern(n >> 2)) order.push(x);
        else for (let v = 0; v < n; v++) order.push(v);
        const verts: number[] = [];
        for (const v of order) for (let k = 0; k < VERT_FLOATS; k++) verts.push(arena[off + v * VERT_FLOATS + k]);
        const rec = Array.from(I.subarray(i, i + CMD_I32));
        rec[CI_VERT_OFFSET] = 0;
        rec[CI_VERT_COUNT] = 0;
        rec[CI_FLAGS] = flags & ~DF_QUADS_INDEXED;
        out.push({ rec, recF: Array.from(F.subarray(c * CMD_F32, (c + 1) * CMD_F32)), verts });
    }
    return out;
}

describe("GL_QUADS as indexed triangles", () => {
    test("the GPU sees the same triangles, draws and state as the expanded quads", () => {
        for (const seed of [1, 2, 3, 99, 1234]) {
            const steps = script(seed, 400);
            const old = run(steps, false);
            const neu = run(steps, true);
            expect(expandDraws(neu, quadIndexPattern)).toEqual(expandDraws(old, quadIndexPattern));
            expect(neu.frameSnapshot.drawCalls).toBe(old.frameSnapshot.drawCalls);
            expect(neu.vertArena.used).toBeLessThan(old.vertArena.used);
        }
    });

    test("a quad costs four vertices instead of six", () => {
        const steps: Step[] = [];
        for (let k = 0; k < 100; k++) {
            const data = new Float32Array(4 * VERT_FLOATS).fill(0.5);
            steps.push({ mode: GL_QUADS, count: 4, poly: GL_FILL, tex: 5, translate: 0, data });
        }
        const old = run(steps, false);
        const neu = run(steps, true);
        expect(old.vertArena.used).toBe(100 * 6 * VERT_FLOATS);
        expect(neu.vertArena.used).toBe(100 * 4 * VERT_FLOATS);
        expect(neu.commands.count).toBe(1);
        expect(neu.commands.i32[CI_FLAGS] & DF_QUADS_INDEXED).toBe(DF_QUADS_INDEXED);
    });

    test("negative: a wireframe quad keeps its expanded triangles", () => {
        const data = new Float32Array(4 * VERT_FLOATS).fill(0.25);
        const ctx = run([{ mode: GL_QUADS, count: 4, poly: GL_LINE, tex: 0, translate: 0, data }], true);
        expect(ctx.commands.i32[CI_FLAGS] & DF_QUADS_INDEXED).toBe(0);
        expect(ctx.commands.i32[CI_VERT_COUNT]).toBe(6);
    });

    test("negative control: a wrong index order is caught", () => {
        const steps = script(7, 200);
        const old = run(steps, false);
        const neu = run(steps, true);
        const wrong = (quads: number) => {
            const p = quadIndexPattern(quads);
            for (let o = 0; o < p.length; o += 6) { const t = p[o + 4]!; p[o + 4] = p[o + 5]!; p[o + 5] = t; }
            return p;
        };
        expect(expandDraws(neu, wrong)).not.toEqual(expandDraws(old, quadIndexPattern));
    });
});

describe("WebGPU quad index buffer", () => {
    test("the index pattern splits each quad along its 0-2 diagonal", () => {
        expect(Array.from(quadIndexPattern(2))).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    });

    test("the buffer is sized before encoding for the largest indexed draw and only grows", () => {
        const e = new OpenGLBackendExecutor({} as any) as any;
        const created: number[] = [];
        const written: Uint32Array[] = [];
        const device = { createBuffer: (d: { size: number }) => { created.push(d.size); return { destroy() {} }; } };
        const queue = { writeBuffer: (_b: unknown, _o: number, buf: ArrayBuffer, off: number, len: number) => {
            written.push(new Uint32Array(buf.slice(off, off + len)));
        } };
        const ctx = newCtx();
        const data = new Float32Array(4 * 3000 * VERT_FLOATS).fill(0.5);
        emitDrawCommandFlat(ctx, GL_QUADS, data, 4 * 3000, false, true);
        expect(e.maxIndexedQuads(ctx.commands)).toBe(3000);
        const g = globalThis as { GPUBufferUsage?: unknown };
        const had = "GPUBufferUsage" in g;
        if (!had) g.GPUBufferUsage = { INDEX: 0x10, COPY_DST: 0x8 };
        try {
            e.ensureQuadIndexCapacity(device, queue, 3000);
            expect(e.quadIndexCapacity).toBe(4096);
            expect(created).toEqual([4096 * 6 * 4]);
            expect(Array.from(written[0]!)).toEqual(Array.from(quadIndexPattern(4096)));
            e.ensureQuadIndexCapacity(device, queue, 100);
            expect(created.length).toBe(1);
        } finally {
            if (!had) delete g.GPUBufferUsage;
        }
    });

    test("negative: a frame without indexed quads needs no index buffer", () => {
        const e = new OpenGLBackendExecutor({} as any) as any;
        (globalThis as { __noGlQuadIndex?: boolean }).__noGlQuadIndex = true;
        const ctx = newCtx();
        const data = new Float32Array(8 * VERT_FLOATS).fill(0.5);
        emitDrawCommandFlat(ctx, GL_QUADS, data, 8, false, true);
        expect(e.maxIndexedQuads(ctx.commands)).toBe(0);
    });
});
