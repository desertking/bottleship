import { afterEach, expect, test } from "bun:test";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { OpenGL32 } from "../../src/worker/modules/opengl32/index";
import { emitDrawCommandFlat } from "../../src/worker/modules/opengl32/immediate";
import { VERT_FLOATS } from "../../src/worker/modules/opengl32/context";

const G = globalThis as Record<string, unknown>;
G.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
G.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
G.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
G.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };
afterEach(() => { delete G.__glTrimPassState; });

let ids = 0;
function fakeObj(kind: string, extra: Record<string, unknown> = {}): any {
    const id = `${kind}#${++ids}`;
    return new Proxy({ __id: id, ...extra }, {
        get(t: any, p) {
            if (p in t) return t[p];
            if (p === "then" || typeof p === "symbol") return undefined;
            return (...a: unknown[]) => fakeObj(`${kind}.${String(p)}`, a[0] && typeof a[0] === "object" ? { ...(a[0] as object) } : {});
        },
    });
}

function frame(trim: boolean): string[] {
    G.__glTrimPassState = trim;
    ids = 0;
    const draws: string[] = [];
    const state: Record<string, string> = {};
    const pass = () => new Proxy({}, { get: (_t, p) => (...a: any[]) => {
        const name = String(p);
        const idOf = (x: any) => (x && x.__id) || JSON.stringify(x);
        if (name === "setPipeline") state.pipe = idOf(a[0]);
        else if (name === "setViewport") state.vp = JSON.stringify(a);
        else if (name === "setBindGroup") state.bg = idOf(a[1]) + "@" + JSON.stringify(a[2]);
        else if (name === "setVertexBuffer") state.vbOff = String(a[2] ?? 0);
        else if (name === "setIndexBuffer") state.ib = idOf(a[0]);
        else if (name === "setScissorRect") state.sc = JSON.stringify(a);
        else if (name === "draw") draws.push(JSON.stringify([state.pipe, state.vp, state.bg, state.sc, "v", Number(state.vbOff) / 60 + (a[2] ?? 0), a[0]]));
        else if (name === "drawIndexed") draws.push(JSON.stringify([state.pipe, state.vp, state.bg, state.sc, "i", state.ib, Number(state.vbOff) / 60 + (a[3] ?? 0), a[0]]));
        return undefined;
    } });
    const encoder = new Proxy({}, { get: (_t, p) => (...a: any[]) => String(p) === "beginRenderPass" ? pass() : fakeObj("enc." + String(p)) });
    const device = fakeObj("device", { createCommandEncoder: () => encoder, limits: { minUniformBufferOffsetAlignment: 256, maxTextureDimension2D: 8192 } });
    const queue = fakeObj("queue", { writeBuffer: () => undefined, writeTexture: () => undefined, submit: () => undefined });
    const context = fakeObj("ctx", { canvas: { width: 640, height: 480 }, getCurrentTexture: () => fakeObj("tex") });
    const backend = fakeObj("backend", { getDevice: () => device, getQueue: () => queue, getContext: () => context, getFormat: () => "bgra8unorm", drawTexture: () => undefined });
    const e = new OpenGLBackendExecutor(backend as any) as any;
    delete G.__glTrimPassState;
    e.getDrawableSize = () => [640, 480];
    const mem = new Uint8Array(1 << 16);
    const disp = { registerWriteBufferFunction: () => true, registerZeroArgWriteBufferFunction: () => true, registerPtrDerefWriteBufferFunction: () => true };
    const gl = new OpenGL32();
    gl.initialize({ getCurrentMemory: () => mem, dispatcher: disp } as any);
    const ctx = gl.getContext() as any;
    ctx.renderMode = 0x1C00;
    ctx.polygonModeFront = 0x1B02;
    for (let k = 0; k < 60; k++) {
        if (k % 7 === 0) ctx.enableFlags.add(0x0BE2); else ctx.enableFlags.delete(0x0BE2);
        if (k % 11 === 5) { ctx.viewportX = 10; ctx.viewportW = 320; } else { ctx.viewportX = 0; ctx.viewportW = 640; }
        const mode = k % 3 === 0 ? 0x0004 : 0x0007;
        const count = mode === 0x0004 ? 6 : 8;
        const data = new Float32Array(count * VERT_FLOATS).fill(0.25);
        for (let v = 0; v < count; v++) data[v * VERT_FLOATS + 3] = 1;
        emitDrawCommandFlat(ctx, mode, data, count, false, true);
    }
    e.executeFrame({ commands: ctx.commands, vertArena: ctx.vertArena.data, textures: new Map() });
    return draws;
}

test("trimmed pass state issues the same draws with the same bound state", () => {
    const on = frame(true);
    const off = frame(false);
    expect(off.length).toBeGreaterThan(10);
    expect(on).toEqual(off);
});
