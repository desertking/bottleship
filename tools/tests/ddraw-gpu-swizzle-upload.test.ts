import { describe, expect, test } from "bun:test";
import { uploadToGPUTexture } from "../../src/worker/modules/ddraw/gpu-texture-utils";
import { registerSwizzleUploadDevice, GPU_SWIZZLE_MIN_PIXELS } from "../../src/worker/backends/webgpu/shared/bgra-upload-swizzle";

const RA = 0x10;

type Tex = { width: number; height: number; format: GPUTextureFormat; usage: number; dimension: string; sampleCount: number; depthOrArrayLayers: number; texels: Uint8Array; destroy(): void; createView(): { tex: Tex } };

function makeTex(width: number, height: number, format: GPUTextureFormat, usage: number): Tex {
    const t: Tex = {
        width, height, format, usage, dimension: "2d", sampleCount: 1, depthOrArrayLayers: 1,
        texels: new Uint8Array(width * height * 4),
        destroy() { /* fake */ },
        createView() { return { tex: t }; },
    };
    return t;
}

function fakeDevice(swapInShader = false) {
    const stats = { cpuWrites: 0, stagingWrites: 0, draws: 0, submits: 0 };
    const queue = {
        writeTexture(dst: { texture: Tex; origin?: { x: number; y: number } }, data: Uint8Array,
            layout: { offset?: number; bytesPerRow: number }, size: { width: number; height: number }) {
            const t = dst.texture;
            if (t.format === "rgba8unorm") stats.stagingWrites++; else stats.cpuWrites++;
            const ox = dst.origin?.x ?? 0, oy = dst.origin?.y ?? 0, off = layout.offset ?? 0;
            for (let r = 0; r < size.height; r++) {
                const from = off + r * layout.bytesPerRow;
                t.texels.set(data.subarray(from, from + size.width * 4), ((oy + r) * t.width + ox) * 4);
            }
        },
        submit(cmds: Array<() => void>) { stats.submits++; for (const c of cmds) c(); },
    };
    const device = {
        queue,
        createShaderModule: () => ({}),
        createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
        createTexture: (d: { size: { width: number; height: number }; format: GPUTextureFormat; usage: number }) =>
            makeTex(d.size.width, d.size.height, d.format, d.usage),
        createBindGroup: (d: { entries: Array<{ resource: { tex: Tex } }> }) => ({ src: d.entries[0]!.resource.tex }),
        createCommandEncoder() {
            const ops: Array<() => void> = [];
            return {
                beginRenderPass(desc: { colorAttachments: Array<{ view: { tex: Tex }; loadOp: string }> }) {
                    const dst = desc.colorAttachments[0]!.view.tex;
                    expect(desc.colorAttachments[0]!.loadOp).toBe("load");
                    let src: Tex | null = null, sc = { x: 0, y: 0, w: dst.width, h: dst.height };
                    return {
                        setPipeline() { /* fake */ },
                        setBindGroup(_: number, g: { src: Tex }) { src = g.src; },
                        setScissorRect(x: number, y: number, w: number, h: number) { sc = { x, y, w, h }; },
                        draw() {
                            stats.draws++;
                            const s = src!, box = { ...sc };
                            ops.push(() => {
                                for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
                                    const si = (y * s.width + x) * 4, di = (y * dst.width + x) * 4;
                                    const r = s.texels[si]!, g = s.texels[si + 1]!, b = s.texels[si + 2]!, a = s.texels[si + 3]!;
                                    const [lr, lb] = swapInShader ? [b, r] : [r, b];
                                    dst.texels[di] = lb; dst.texels[di + 1] = g; dst.texels[di + 2] = lr; dst.texels[di + 3] = a;
                                }
                            });
                        },
                        end() { /* fake */ },
                    };
                },
                finish: () => () => ops.forEach((o) => o()),
            };
        },
    };
    return { device: device as unknown as GPUDevice, queue: queue as unknown as GPUQueue, stats };
}

function rgbaSurface(w: number, h: number, seed: number): Uint8Array {
    const d = new Uint8Array(w * h * 4);
    let s = seed >>> 0;
    for (let i = 0; i < d.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = s >>> 24; }
    return d;
}

function cpuReference(rgba: Uint8Array, w: number, h: number, before: Uint8Array,
    region?: { left: number; top: number; right: number; bottom: number }): Uint8Array {
    const out = before.slice();
    const x0 = region?.left ?? 0, y0 = region?.top ?? 0, x1 = region?.right ?? w, y1 = region?.bottom ?? h;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        out[i] = rgba[i + 2]!; out[i + 1] = rgba[i + 1]!; out[i + 2] = rgba[i]!; out[i + 3] = rgba[i + 3]!;
    }
    return out;
}

const ALL = 0x01 | 0x02 | 0x04 | RA;

describe("BGRA surface upload through a GPU swizzle pass", () => {
    test("whole-surface uploads go through the staging texture and match the CPU swizzle", () => {
        for (const [w, h] of [[640, 480], [800, 600], [100, 41], [1024, 768]] as const) {
            const f = fakeDevice();
            registerSwizzleUploadDevice(f.device);
            const tex = makeTex(w, h, "bgra8unorm", ALL);
            tex.texels.fill(7);
            const before = tex.texels.slice();
            const rgba = rgbaSurface(w, h, w + h);
            uploadToGPUTexture(f.queue, tex as unknown as GPUTexture, rgba, w, h, undefined, "bgra8unorm");
            expect(f.stats.draws).toBe(1);
            expect(f.stats.cpuWrites).toBe(0);
            expect(Buffer.from(tex.texels).equals(Buffer.from(cpuReference(rgba, w, h, before)))).toBe(true);
        }
    });

    test("dirty rectangles draw only inside the rectangle", () => {
        const f = fakeDevice();
        registerSwizzleUploadDevice(f.device);
        const regions = [
            { left: 10, top: 20, right: 138, bottom: 84 },
            { left: 0, top: 0, right: 640, bottom: 70 },
            { left: 500, top: 300, right: 640, bottom: 480 },
        ];
        const tex = makeTex(640, 480, "bgra8unorm", ALL);
        for (const region of regions) {
            const before = tex.texels.slice();
            const rgba = rgbaSurface(640, 480, region.left * 13 + region.top);
            uploadToGPUTexture(f.queue, tex as unknown as GPUTexture, rgba, 640, 480, undefined, "bgra8unorm", region);
            expect(Buffer.from(tex.texels).equals(Buffer.from(cpuReference(rgba, 640, 480, before, region)))).toBe(true);
        }
        expect(f.stats.draws).toBe(regions.length);
        expect(f.stats.cpuWrites).toBe(0);
    });

    test("small rectangles, textures without RENDER_ATTACHMENT, unknown queues and the kill switch stay on the CPU swizzle", () => {
        const f = fakeDevice();
        registerSwizzleUploadDevice(f.device);
        const small = { left: 0, top: 0, right: 32, bottom: 32 };
        expect(32 * 32).toBeLessThan(GPU_SWIZZLE_MIN_PIXELS);
        const cases: Array<() => void> = [
            () => uploadToGPUTexture(f.queue, makeTex(640, 480, "bgra8unorm", ALL) as unknown as GPUTexture, rgbaSurface(640, 480, 1), 640, 480, undefined, "bgra8unorm", small),
            () => uploadToGPUTexture(f.queue, makeTex(640, 480, "bgra8unorm", ALL & ~RA) as unknown as GPUTexture, rgbaSurface(640, 480, 2), 640, 480, undefined, "bgra8unorm"),
            () => uploadToGPUTexture(fakeDevice().queue, makeTex(640, 480, "bgra8unorm", ALL) as unknown as GPUTexture, rgbaSurface(640, 480, 3), 640, 480, undefined, "bgra8unorm"),
        ];
        for (const c of cases) c();
        (globalThis as { __noGpuSwizzleUpload?: boolean }).__noGpuSwizzleUpload = true;
        try {
            const tex = makeTex(640, 480, "bgra8unorm", ALL);
            const rgba = rgbaSurface(640, 480, 4);
            uploadToGPUTexture(f.queue, tex as unknown as GPUTexture, rgba, 640, 480, undefined, "bgra8unorm");
            expect(Buffer.from(tex.texels).equals(Buffer.from(cpuReference(rgba, 640, 480, new Uint8Array(640 * 480 * 4))))).toBe(true);
        } finally {
            delete (globalThis as { __noGpuSwizzleUpload?: boolean }).__noGpuSwizzleUpload;
        }
        expect(f.stats.draws).toBe(0);
        expect(f.stats.cpuWrites).toBe(3);
    });

    test("rgba8unorm textures keep the direct upload", () => {
        const f = fakeDevice();
        registerSwizzleUploadDevice(f.device);
        const tex = makeTex(640, 480, "rgba8unorm", ALL);
        const rgba = rgbaSurface(640, 480, 9);
        uploadToGPUTexture(f.queue, tex as unknown as GPUTexture, rgba, 640, 480, undefined, "rgba8unorm");
        expect(f.stats.draws).toBe(0);
        expect(Buffer.from(tex.texels).equals(Buffer.from(rgba))).toBe(true);
    });

    test("negative control: a pass that swaps channels is caught by the comparison", () => {
        const f = fakeDevice(true);
        registerSwizzleUploadDevice(f.device);
        const tex = makeTex(320, 240, "bgra8unorm", ALL);
        const rgba = rgbaSurface(320, 240, 5);
        uploadToGPUTexture(f.queue, tex as unknown as GPUTexture, rgba, 320, 240, undefined, "bgra8unorm");
        expect(f.stats.draws).toBe(1);
        expect(Buffer.from(tex.texels).equals(Buffer.from(cpuReference(rgba, 320, 240, new Uint8Array(320 * 240 * 4))))).toBe(false);
    });
});
