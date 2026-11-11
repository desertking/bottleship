export const GPU_SWIZZLE_MIN_PIXELS = 4096;

export const SWIZZLE_UPLOAD_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    return textureLoad(src, vec2i(pos.xy), 0)SWIZZLE;
}
`;

export interface SwizzleRect { x: number; y: number; w: number; h: number }

export interface BgraSwizzleUploader {
    upload(texture: GPUTexture, rgba: Uint8Array, offset: number, bytesPerRow: number, rect: SwizzleRect): boolean;
    uploads: number;
}

const usageRenderAttachment = (): number =>
    (globalThis as { GPUTextureUsage?: { RENDER_ATTACHMENT: number } }).GPUTextureUsage?.RENDER_ATTACHMENT ?? 0x10;
const usageStaging = (): number => {
    const u = (globalThis as { GPUTextureUsage?: { COPY_DST: number; TEXTURE_BINDING: number } }).GPUTextureUsage;
    return (u?.COPY_DST ?? 0x02) | (u?.TEXTURE_BINDING ?? 0x04);
};

export function createBgraSwizzleUploader(device: GPUDevice, fragmentSwizzle = ""): BgraSwizzleUploader {
    const module = device.createShaderModule({ code: SWIZZLE_UPLOAD_WGSL.replace("SWIZZLE", fragmentSwizzle) });
    const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "bgra8unorm" }] },
        primitive: { topology: "triangle-list" },
    });
    let staging: GPUTexture | null = null;
    let bindGroup: GPUBindGroup | null = null;
    const views = new WeakMap<GPUTexture, GPUTextureView>();

    const stagingFor = (w: number, h: number): GPUBindGroup => {
        if (!staging || staging.width < w || staging.height < h) {
            const nw = Math.max(w, staging?.width ?? 0), nh = Math.max(h, staging?.height ?? 0);
            staging?.destroy();
            staging = device.createTexture({ size: { width: nw, height: nh }, format: "rgba8unorm", usage: usageStaging() });
            bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: staging.createView() }],
            });
        }
        return bindGroup!;
    };

    const self: BgraSwizzleUploader = {
        uploads: 0,
        upload(texture, rgba, offset, bytesPerRow, rect) {
            const { x, y, w, h } = rect;
            const group = stagingFor(texture.width, texture.height);
            device.queue.writeTexture(
                { texture: staging!, origin: { x, y, z: 0 } },
                rgba as GPUAllowSharedBufferSource,
                { offset, bytesPerRow, rowsPerImage: h },
                { width: w, height: h },
            );
            let view = views.get(texture);
            if (!view) {
                view = texture.createView({ baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 });
                views.set(texture, view);
            }
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.setScissorRect(x, y, w, h);
            pass.draw(3);
            pass.end();
            device.queue.submit([encoder.finish()]);
            self.uploads++;
            return true;
        },
    };
    return self;
}

const devicesByQueue = new WeakMap<GPUQueue, GPUDevice>();
const uploaders = new WeakMap<GPUDevice, BgraSwizzleUploader | null>();

export function registerSwizzleUploadDevice(device: GPUDevice): void {
    devicesByQueue.set(device.queue, device);
}

function gpuSwizzleEnabled(): boolean {
    return !(globalThis as { __noGpuSwizzleUpload?: boolean }).__noGpuSwizzleUpload;
}

export function tryGpuSwizzleUpload(
    queue: GPUQueue,
    texture: GPUTexture,
    rgba: Uint8Array,
    offset: number,
    bytesPerRow: number,
    rect: SwizzleRect,
): boolean {
    if (rect.w * rect.h < GPU_SWIZZLE_MIN_PIXELS || !gpuSwizzleEnabled()) return false;
    const t = texture as Partial<GPUTexture>;
    if (t.format !== "bgra8unorm" || t.dimension !== "2d" || t.sampleCount !== 1 || t.depthOrArrayLayers !== 1) return false;
    if (((t.usage ?? 0) & usageRenderAttachment()) === 0) return false;
    if ((t.width ?? 0) < rect.x + rect.w || (t.height ?? 0) < rect.y + rect.h) return false;
    const device = devicesByQueue.get(queue);
    if (!device) return false;
    let uploader = uploaders.get(device);
    if (uploader === undefined) {
        try {
            uploader = createBgraSwizzleUploader(device);
        } catch {
            uploader = null;
        }
        uploaders.set(device, uploader);
    }
    if (!uploader) return false;
    return uploader.upload(texture, rgba, offset, bytesPerRow, rect);
}
