import { afterEach, describe, expect, test } from "bun:test";
import { Logger, LogCategory, LogLevel } from "../../src/worker/core/logger";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { DeferredUploadManager } from "../../src/worker/modules/ddraw/deferred-upload-manager";
import { createSurfaceBltFlipExports } from "../../src/worker/modules/ddraw/surface-blt-flip";
import { createSurfaceExports } from "../../src/worker/modules/ddraw/surface";
import { TextureConverter } from "../../src/worker/backends/webgpu/shared/texture-converter";

const W = 64, H = 32;

function surface(ptr: number, extra: Record<string, unknown> = {}) {
    const state: any = {
        surfaceType: "render_surface",
        mode: "CPU",
        width: W,
        height: H,
        pitch: W * 2,
        caps: 0x40,
        surfacePtr: ptr,
        format: { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x001f, aMask: 0 },
        gpuTexture: {},
        version: 2,
        lastUploadVersion: 1,
        gpuDirty: true,
        everLocked: true,
        writeGeneration: 0,
        ...extra,
    };
    const obj = Object.create(DirectDrawSurfaceObject.prototype);
    Object.defineProperty(obj, "getState", { value: () => state });
    return { state, obj };
}

describe("per-frame DirectDraw calls build no log text while DDRAW logging is off", () => {
    const original = { verbose: Logger.verbose, log: Logger.log };
    afterEach(() => {
        Logger.verbose = original.verbose;
        Logger.log = original.log;
    });

    test("a CPU Blt and a v1 Lock/Unlock pass no message to the logger", () => {
        const mem = new Uint8Array(0x40000);
        Mem.bind(() => mem);
        Logger.setCategoryLevel(LogCategory.DDRAW, LogLevel.NORMAL);
        const messages: string[] = [];
        Logger.verbose = ((_c: LogCategory, m: string) => { messages.push(m); }) as typeof Logger.verbose;
        Logger.log = ((_c: LogCategory, m: string) => { messages.push(m); }) as typeof Logger.log;

        const SRC = 0x5000, DST = 0x6000, DESC = 0x7000;
        const src = surface(0x8000);
        const dst = surface(0x10000, { gpuDirty: false, lastUploadVersion: 2 });
        const context: any = {
            resourceProvider: { getComObjectByAddress: (a: number) => (a === SRC ? src.obj : a === DST ? dst.obj : null) },
            surfaces: {},
            backend: { getDevice: () => ({}), getQueue: () => ({}) },
            deferredUploadManager: new DeferredUploadManager(),
        };
        const blt = createSurfaceBltFlipExports(context).IDirectDrawSurface7_Blt!;
        expect(blt({ esp: 0 } as never, mem, [DST, 0, SRC, 0, 0, 0])).toBe(0);

        const surf = createSurfaceExports(context);
        new DataView(mem.buffer).setUint32(DESC, 108, true);
        expect(surf.IDirectDrawSurface_Lock!({ esp: 0 } as never, mem, [SRC, 0, DESC, 0])).toBe(0);
        expect(surf.IDirectDrawSurface_Unlock!({ esp: 0 } as never, mem, [SRC, 0])).toBe(0);

        expect(messages.filter((m) => /IDirectDrawSurface7?_(Blt|Lock|Flip)/.test(m))).toEqual([]);
    });
});

describe("Lock snapshots reuse their buffer", () => {
    test("two writable Locks of one texture copy into the same buffer", () => {
        const mem = new Uint8Array(0x40000);
        Mem.bind(() => mem);
        const THIS = 0x5000, DESC = 0x7000;
        const tex = surface(0x8000, { caps: 0x1000 });
        const context: any = {
            resourceProvider: { getComObjectByAddress: (a: number) => (a === THIS ? tex.obj : null) },
            surfaces: {},
            deferredUploadManager: new DeferredUploadManager(),
        };
        const surf = createSurfaceExports(context);
        new DataView(mem.buffer).setUint32(DESC, 108, true);
        const snapshots: Uint8Array[] = [];
        for (let i = 0; i < 2; i++) {
            expect(surf.IDirectDrawSurface_Lock!({ esp: 0 } as never, mem, [THIS, 0, DESC, 0])).toBe(0);
            snapshots.push(tex.state.activeLeaseSnapshot);
            mem[0x8000 + i] = 0x55;
            expect(surf.IDirectDrawSurface_Unlock!({ esp: 0 } as never, mem, [THIS, 0])).toBe(0);
        }
        expect(snapshots[0]).toBeDefined();
        expect(snapshots[1]!.buffer).toBe(snapshots[0]!.buffer);
    });
});

describe("the deferred upload converts into a reused buffer", () => {
    test("two frames of a re-locked surface upload from the same RGBA buffer", async () => {
        const mem = new Uint8Array(0x40000);
        Mem.bind(() => mem);
        const s = surface(0x8000);
        const sources: unknown[] = [];
        const queue = {
            writeTexture: (_d: unknown, data: Uint8Array) => { sources.push(data.buffer); },
        } as unknown as GPUQueue;
        const manager = new DeferredUploadManager();
        for (let frame = 0; frame < 2; frame++) {
            s.state.rgbaScratch = undefined;
            s.state.rgbaScratchVersion = undefined;
            s.state.gpuDirty = true;
            s.state.version = 3 + frame;
            manager.markDirty(s.state);
            await manager.flushAll(queue, mem);
        }
        expect(sources.length).toBe(2);
        expect(sources[1]).toBe(sources[0]);
    });
});

describe("the palette converter reuses its GPU buffers after a submit", () => {
    test("a second frame creates no new buffers", () => {
        const globals = globalThis as any;
        const oldUsage = globals.GPUBufferUsage;
        const oldStage = globals.GPUShaderStage;
        globals.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
        globals.GPUShaderStage ??= { COMPUTE: 4 };
        let created = 0;
        const fake = () => ({ destroy() { /* gpu stub */ } });
        const device = new Proxy({} as Record<string, unknown>, {
            get: (_t, prop) => {
                if (prop === "createBuffer") return () => { created++; return fake(); };
                if (typeof prop === "string" && prop.startsWith("create")) return () => fake();
                return undefined;
            },
        }) as unknown as GPUDevice;
        const queue = { writeBuffer() { /* gpu stub */ }, writeTexture() { /* gpu stub */ } } as unknown as GPUQueue;
        const encoder = {
            beginComputePass: () => ({ setPipeline() { /* stub */ }, setBindGroup() { /* stub */ }, dispatchWorkgroups() { /* stub */ }, end() { /* stub */ } }),
            copyBufferToTexture() { /* stub */ },
        } as unknown as GPUCommandEncoder;
        const converter = new TextureConverter(device, queue);
        const mem = new Uint8Array(0x10000);
        const palette = new Uint32Array(256);
        const format = { flags: 0x20, bpp: 8, rMask: 0, gMask: 0, bMask: 0, aMask: 0 };
        const counts: number[] = [];
        for (let frame = 0; frame < 2; frame++) {
            const before = created;
            converter.convertToTexture(encoder, mem, 0x1000, 64, 32, 64, format as never, {} as GPUTexture, undefined, "rgba8unorm", palette);
            converter.destroyPendingAfterSubmit();
            counts.push(created - before);
        }
        globals.GPUBufferUsage = oldUsage;
        globals.GPUShaderStage = oldStage;
        if (oldUsage === undefined) delete globals.GPUBufferUsage;
        if (oldStage === undefined) delete globals.GPUShaderStage;
        expect(counts[0]).toBeGreaterThan(0);
        expect(counts[1]).toBe(0);
    });
});
