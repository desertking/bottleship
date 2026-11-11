import { describe, expect, test } from "bun:test";
import { uploadToGPUTexture } from "../../src/worker/modules/ddraw/gpu-texture-utils";

type Layout = { offset?: number; bytesPerRow: number; rowsPerImage?: number };
type Dst = { texture: unknown; origin?: { x: number; y: number; z: number } };

function simulatedTexture(width: number, height: number, format: GPUTextureFormat) {
    const texels = new Uint8Array(width * height * 4);
    let uploads = 0;
    let unpadded = 0;
    const queue = {
        writeTexture: (dst: Dst, data: Uint8Array, layout: Layout, size: { width: number; height: number }) => {
            uploads++;
            if (layout.bytesPerRow === size.width * 4 || layout.bytesPerRow % 256 !== 0) unpadded++;
            const ox = dst.origin?.x ?? 0, oy = dst.origin?.y ?? 0, offset = layout.offset ?? 0;
            expect(offset + layout.bytesPerRow * (size.height - 1) + size.width * 4).toBeLessThanOrEqual(data.byteLength);
            for (let row = 0; row < size.height; row++) {
                const from = offset + row * layout.bytesPerRow;
                texels.set(data.subarray(from, from + size.width * 4), ((oy + row) * width + ox) * 4);
            }
        },
    } as unknown as GPUQueue;
    return { texels, queue, texture: { format } as unknown as GPUTexture, uploads: () => uploads, unpadded: () => unpadded };
}

function rgbaSurface(width: number, height: number, seed: number): Uint8Array {
    const data = new Uint8Array(width * height * 4);
    let s = seed >>> 0;
    for (let i = 0; i < data.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        data[i] = s >>> 24;
    }
    return data;
}

function expected(rgba: Uint8Array, width: number, height: number, format: GPUTextureFormat,
    before: Uint8Array, region?: { left: number; top: number; right: number; bottom: number }): Uint8Array {
    const out = before.slice();
    const x0 = region?.left ?? 0, y0 = region?.top ?? 0, x1 = region?.right ?? width, y1 = region?.bottom ?? height;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 4;
            const bgra = format === "bgra8unorm";
            out[i] = rgba[i + (bgra ? 2 : 0)];
            out[i + 1] = rgba[i + 1];
            out[i + 2] = rgba[i + (bgra ? 0 : 2)];
            out[i + 3] = rgba[i + 3];
        }
    }
    return out;
}

const SIZES: Array<[number, number]> = [[640, 480], [800, 600], [100, 37], [1, 1], [65, 3], [320, 1]];
const FORMATS: GPUTextureFormat[] = ["rgba8unorm", "bgra8unorm"];

describe("DirectDraw surface upload layout", () => {
    test("whole-surface uploads land texel for texel in both formats, without padded rows", () => {
        for (const [w, h] of SIZES) {
            for (const format of FORMATS) {
                const rgba = rgbaSurface(w, h, w * 31 + h);
                const sim = simulatedTexture(w, h, format);
                const before = sim.texels.slice();
                uploadToGPUTexture(sim.queue, sim.texture, rgba, w, h, new Uint8Array(w * h * 4 + 4096), format);
                expect(sim.uploads()).toBe(1);
                expect(sim.unpadded()).toBe(1);
                expect(Buffer.from(sim.texels).equals(Buffer.from(expected(rgba, w, h, format, before)))).toBe(true);
            }
        }
    });

    test("dirty-rectangle uploads touch only the rectangle and read the rows in place", () => {
        const regions = [
            { left: 10, top: 20, right: 74, bottom: 52 },
            { left: 0, top: 0, right: 1, bottom: 1 },
            { left: 600, top: 400, right: 640, bottom: 480 },
            { left: 3, top: 479, right: 200, bottom: 480 },
        ];
        for (const format of FORMATS) {
            for (const region of regions) {
                const rgba = rgbaSurface(640, 480, region.left * 7 + region.top);
                const sim = simulatedTexture(640, 480, format);
                sim.texels.fill(0x5a);
                const before = sim.texels.slice();
                uploadToGPUTexture(sim.queue, sim.texture, rgba, 640, 480, new Uint8Array(640 * 480 * 4), format, region);
                expect(sim.uploads()).toBe(1);
                expect(Buffer.from(sim.texels).equals(Buffer.from(expected(rgba, 640, 480, format, before, region)))).toBe(true);
            }
        }
    });

    test("negative control: the simulator catches a wrong row stride and a missing swizzle", () => {
        const rgba = rgbaSurface(100, 37, 5);
        const sim = simulatedTexture(100, 37, "rgba8unorm");
        const before = sim.texels.slice();
        sim.queue.writeTexture({ texture: sim.texture }, rgba, { bytesPerRow: 99 * 4, rowsPerImage: 37 }, { width: 99, height: 37 });
        expect(Buffer.from(sim.texels).equals(Buffer.from(expected(rgba, 100, 37, "rgba8unorm", before)))).toBe(false);
        const sim2 = simulatedTexture(100, 37, "bgra8unorm");
        const before2 = sim2.texels.slice();
        uploadToGPUTexture(sim2.queue, sim2.texture, rgba, 100, 37, undefined, "rgba8unorm");
        expect(Buffer.from(sim2.texels).equals(Buffer.from(expected(rgba, 100, 37, "bgra8unorm", before2)))).toBe(false);
    });
});
