import { afterEach, expect, test } from "bun:test";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { VERT_FLOATS } from "../../src/worker/modules/opengl32/context";

const GL_TRIANGLES = 0x0004, GL_FILL = 0x1B02, GL_LINE = 0x1B01;
const g = globalThis as { __glCoalesceVertexUploads?: boolean };

afterEach(() => { delete g.__glCoalesceVertexUploads; });

function arena(count: number): Float32Array {
    const a = new Float32Array(count * VERT_FLOATS);
    for (let i = 0; i < a.length; i++) a[i] = (i % 97) / 13 - 2;
    return a;
}

function setup(src: Float32Array) {
    const e = new OpenGLBackendExecutor({} as any) as any;
    e.vertexBuffer = {};
    e.vertexBufferSize = 1 << 20;
    e.vertexUploadCursor = 0;
    e.frameArena = src;
    const gpu = new Uint8Array(1 << 20);
    const writes: Array<[number, number]> = [];
    const queue = { writeBuffer: (_b: unknown, o: number, data: ArrayBuffer, off: number, size: number) => { gpu.set(new Uint8Array(data, off, size), o); writes.push([o, size]); } };
    return { e, gpu, writes, queue };
}

function draws(e: any, queue: unknown, src: Float32Array, list: Array<[number, number, number]>): number[] {
    const offs: number[] = [];
    for (const [start, count, poly] of list) {
        const p = e.prepareDrawData(src, start * VERT_FLOATS, count, GL_TRIANGLES, poly);
        offs.push(e.uploadVertices(queue, p.data, p.first, p.byteLength));
    }
    e.flushVertexUploads(queue);
    return offs;
}

test("consecutive arena draws reach the GPU buffer in one write with the same bytes", () => {
    const src = arena(64);
    const list: Array<[number, number, number]> = [[0, 6, GL_FILL], [6, 9, GL_FILL], [15, 3, GL_FILL]];
    const a = setup(src);
    const offsA = draws(a.e, a.queue, src, list);
    g.__glCoalesceVertexUploads = false;
    const b = setup(src);
    const offsB = draws(b.e, b.queue, src, list);
    expect(offsA).toEqual(offsB);
    expect(a.gpu).toEqual(b.gpu);
    expect(a.writes.length).toBe(1);
    expect(b.writes.length).toBe(3);
});

test("a gap in the arena or a scratch-built draw splits the write and keeps the bytes", () => {
    const src = arena(64);
    const list: Array<[number, number, number]> = [[0, 6, GL_FILL], [12, 3, GL_FILL], [15, 6, GL_LINE], [21, 3, GL_FILL], [24, 3, GL_FILL]];
    const a = setup(src);
    const offsA = draws(a.e, a.queue, src, list);
    g.__glCoalesceVertexUploads = false;
    const b = setup(src);
    const offsB = draws(b.e, b.queue, src, list);
    expect(offsA).toEqual(offsB);
    expect(a.gpu).toEqual(b.gpu);
    expect(a.writes.length).toBe(4);
    expect(b.writes.length).toBe(5);
});
