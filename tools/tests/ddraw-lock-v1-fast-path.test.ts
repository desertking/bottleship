import { describe, expect, test } from "bun:test";
import { DirectDrawSurfaceObject } from "../../src/worker/modules/ddraw/com-objects";
import { registerFastPathSurfaceFunctions } from "../../src/worker/modules/ddraw/surface";

type FastPath = (esp: number, view: DataView, mem8: Uint8Array) => number | null | undefined;

function setup(state: Record<string, unknown>) {
    const obj = Object.create(DirectDrawSurfaceObject.prototype);
    Object.defineProperty(obj, "getState", { value: () => state });
    const paths = new Map<string, FastPath>();
    const calls: Array<[string, number[]]> = [];
    const exports: Record<string, (ctx: unknown, mem: Uint8Array, args: number[]) => number> = {
        IDirectDrawSurface_Lock: (_c, _m, args) => { calls.push(["lock", args]); return 0; },
        IDirectDrawSurface_Unlock: (_c, _m, args) => { calls.push(["unlock", args]); return 0; },
    };
    registerFastPathSurfaceFunctions({
        registerFastPath: (_dll: string, name: string, fn: FastPath) => { paths.set(name, fn); },
    } as never, { resourceProvider: { getComObjectByAddressFast: (a: number) => (a === 0x5000 ? obj : null) } } as never, exports as never);
    const mem = new Uint8Array(0x10000);
    const view = new DataView(mem.buffer);
    [0, 0x5000, 0x1000, 0x2000, 1, 0].forEach((v, i) => view.setUint32(0x800 + i * 4, v, true));
    return { paths, calls, mem, view };
}

const cpuSurface = {
    surfaceType: "render_surface", mode: "CPU", width: 8, height: 8, pitch: 16, caps: 0x200, surfacePtr: 0x3000,
    format: { flags: 0x40, bpp: 16, rMask: 0xf800, gMask: 0x07e0, bMask: 0x1f, aMask: 0 },
    version: 3, lastUploadVersion: 3, gpuDirty: false,
};

describe("IDirectDrawSurface (v1) Lock/Unlock skip the slow thunk path", () => {
    test("a CPU-current surface locks and unlocks through the fast path with the guest's arguments", () => {
        const { paths, calls, mem, view } = setup({ ...cpuSurface });
        expect(paths.get("IDirectDrawSurface_Lock")!(0x800, view, mem)).toBe(0);
        expect(paths.get("IDirectDrawSurface_Unlock")!(0x800, view, mem)).toBe(0);
        expect(calls).toEqual([["lock", [0x5000, 0x1000, 0x2000, 1, 0]], ["unlock", [0x5000, 0x1000]]]);
    });

    test("a surface whose pixels are only on the GPU defers to the slow path", () => {
        const { paths, calls, mem, view } = setup({ ...cpuSurface, mode: "GPU_ONLY", gpuTexture: {}, version: 4, gpuWrittenVersion: 4, cpuSyncedVersion: 1 });
        expect(paths.get("IDirectDrawSurface_Lock")!(0x800, view, mem)).toBeNull();
        expect(calls).toEqual([]);
    });
});
