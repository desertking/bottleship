import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { markSurfaceLost, markSurfaceRestored, resetDeviceLossContract } from "../../src/worker/core/gpu/gpu-device-loss-contract";
import { registerFastPathD3DFunctions } from "../../src/worker/modules/ddraw/d3d/index";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { DeferredUploadManager } from "../../src/worker/modules/ddraw/deferred-upload-manager";
import { uploadRGB565ToGPU } from "../../src/worker/modules/ddraw/gpu-texture-utils";
import { createSurfaceBltFlipExports } from "../../src/worker/modules/ddraw/surface-blt-flip";

type FastPath = (esp: number, view: DataView, mem8: Uint8Array) => number | null | undefined;

function fastPaths(): Map<string, FastPath> {
    const paths = new Map<string, FastPath>();
    const dispatcher = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => {
            if (prop === "registerFastPath") {
                return (_dll: string, name: string, fn: FastPath) => { paths.set(name, fn); };
            }
            return typeof prop === "string" && prop.startsWith("register") ? () => undefined : undefined;
        },
    });
    registerFastPathD3DFunctions(dispatcher as never, { resourceProvider: { getComObjectByAddress: () => null } } as never);
    return paths;
}

describe("IsLost answers without a thunk on every surface interface", () => {
    const lost = {};
    beforeEach(() => resetDeviceLossContract());
    afterEach(() => markSurfaceRestored(lost));

    for (const name of ["IDirectDrawSurface_IsLost", "IDirectDrawSurface4_IsLost", "IDirectDrawSurface7_IsLost"]) {
        test(name, () => {
            const fn = fastPaths().get(name);
            expect(fn).toBeDefined();
            const mem = new Uint8Array(64);
            expect(fn!(0, new DataView(mem.buffer), mem)).toBe(0);
            markSurfaceLost(lost);
            expect(fn!(0, new DataView(mem.buffer), mem)).toBeNull();
        });
    }
});

describe("RGB565 scanout upload reads the guest rows in place", () => {
    function capture() {
        const calls: Array<{ data: Uint8Array; layout: GPUImageDataLayout; size: GPUExtent3DDict }> = [];
        const queue = {
            writeTexture: (_dst: unknown, data: Uint8Array, layout: GPUImageDataLayout, size: GPUExtent3DDict) => {
                calls.push({ data, layout, size });
            },
        } as unknown as GPUQueue;
        return { calls, queue };
    }

    test("an 800-pixel row (1600 bytes) is uploaded at its own pitch, without a padded copy", () => {
        const mem = new Uint8Array(0x200000);
        const { calls, queue } = capture();
        uploadRGB565ToGPU(queue, {} as GPUTexture, mem, 0x1000, 800, 600, 1600);
        expect(calls.length).toBe(1);
        const { data, layout, size } = calls[0]!;
        expect(data.buffer).toBe(mem.buffer);
        expect(data.byteOffset).toBe(0x1000);
        expect(data.byteLength).toBe(1600 * 600);
        expect(layout.bytesPerRow).toBe(1600);
        expect(size).toEqual({ width: 800, height: 600 });
    });

    test("a padded pitch is passed through instead of compacting the rows", () => {
        const mem = new Uint8Array(0x200000);
        const { calls, queue } = capture();
        uploadRGB565ToGPU(queue, {} as GPUTexture, mem, 0x2000, 800, 600, 1664);
        const { data, layout } = calls[0]!;
        expect(data.buffer).toBe(mem.buffer);
        expect(data.byteOffset).toBe(0x2000);
        expect(data.byteLength).toBe(1664 * 599 + 1600);
        expect(layout.bytesPerRow).toBe(1664);
    });
});

describe("a CPU Blt does not queue its source for a GPU upload", () => {
    const SRC = 0x5000, DST = 0x6000;
    const W = 64, H = 32;

    function surface(ptr: number, gpuDirty: boolean) {
        const state: any = {
            surfaceType: "render_surface",
            mode: "CPU",
            width: W,
            height: H,
            pitch: W,
            caps: 0x40,
            surfacePtr: ptr,
            format: { flags: 0x20, bpp: 8, rMask: 0, gMask: 0, bMask: 0, aMask: 0 },
            gpuTexture: {},
            version: 2,
            lastUploadVersion: gpuDirty ? 1 : 2,
            gpuDirty,
            everLocked: true,
        };
        const obj = Object.create(DirectDrawSurfaceObject.prototype);
        Object.defineProperty(obj, "getState", { value: () => state });
        return { state, obj };
    }

    test("the back buffer copied to the screen by the CPU stays out of the upload batch", () => {
        const mem = new Uint8Array(0x20000);
        Mem.bind(() => mem);
        for (let i = 0; i < W * H; i++) mem[0x8000 + i] = (i * 7) & 0xff;
        const src = surface(0x8000, true);
        const dst = surface(0xa000, false);
        const deferredUploadManager = new DeferredUploadManager();
        const context: any = {
            resourceProvider: {
                getComObjectByAddress: (addr: number) => (addr === SRC ? src.obj : addr === DST ? dst.obj : null),
            },
            surfaces: {},
            backend: { getDevice: () => ({}), getQueue: () => ({}) },
            deferredUploadManager,
        };
        const blt = createSurfaceBltFlipExports(context).IDirectDrawSurface7_Blt!;
        expect(blt({ esp: 0 } as never, mem, [DST, 0, SRC, 0, 0, 0])).toBe(0);
        expect(mem.subarray(0xa000, 0xa000 + W * H)).toEqual(mem.subarray(0x8000, 0x8000 + W * H));
        expect(deferredUploadManager.getPendingCount()).toBe(0);
        expect(src.state.gpuDirty).toBe(true);
    });
});
