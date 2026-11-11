import { afterEach, expect, test } from "bun:test";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { CMD_I32, CMD_F32 } from "../../src/worker/modules/opengl32/context";

const g = globalThis as { __glCoalesceUniformUploads?: boolean };
afterEach(() => { delete g.__glCoalesceUniformUploads; });

function run(coalesce: boolean): { gpu: Uint8Array; writes: number } {
    g.__glCoalesceUniformUploads = coalesce;
    const e = new OpenGLBackendExecutor({} as any) as any;
    delete g.__glCoalesceUniformUploads;
    e.uniformBuffer = {};
    e.uniformCapacity = 64;
    e.uniformCursor = 0;
    e.uniformStagingActive = e.coalesceUniformUploads;
    e.uniformStagingHi = 0;
    const gpu = new Uint8Array(64 * 256);
    let writes = 0;
    const queue = { writeBuffer: (_b: unknown, o: number, data: ArrayBuffer, off: number, size: number) => { gpu.set(new Uint8Array(data, off, size), o); writes++; } };
    const draws = 20;
    const I = new Int32Array(draws * CMD_I32);
    const F = new Float32Array(draws * CMD_F32);
    for (let k = 0; k < I.length; k++) I[k] = (k * 2654435761) & 0x7;
    for (let k = 0; k < F.length; k++) F[k] = Math.sin(k);
    for (let d = 0; d < draws; d++) {
        const off = e.allocateUniformSlot();
        e.writeUniforms(queue, off, 640, 480, I, F, d * CMD_I32, d * CMD_F32, d % 2 === 0, d % 3 === 0, 0, 0);
    }
    e.flushUniformUploads(queue);
    return { gpu, writes };
}

test("per-draw uniform blocks reach the GPU buffer in one write with the same bytes", () => {
    const on = run(true);
    const off = run(false);
    expect(off.writes).toBe(20);
    expect(on.writes).toBe(1);
    for (let d = 0; d < 20; d++) {
        expect(Array.from(on.gpu.subarray(d * 256, d * 256 + 144))).toEqual(Array.from(off.gpu.subarray(d * 256, d * 256 + 144)));
    }
});
