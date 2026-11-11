import { afterEach, expect, test } from "bun:test";
import { OpenGLBackendExecutor, openglVertexLayout } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { VERT_FLOATS } from "../../src/worker/modules/opengl32/context";

const GL_POINTS = 0x0000, GL_LINES = 0x0001, GL_LINE_LOOP = 0x0002, GL_LINE_STRIP = 0x0003, GL_TRIANGLES = 0x0004;
const GL_FILL = 0x1B02, GL_LINE = 0x1B01, GL_POINT = 0x1B00;

afterEach(() => { delete (globalThis as { __noGlDirectVertexUpload?: boolean }).__noGlDirectVertexUpload; });

function executor(direct: boolean): any {
    if (!direct) (globalThis as { __noGlDirectVertexUpload?: boolean }).__noGlDirectVertexUpload = true;
    const e = new OpenGLBackendExecutor({} as any);
    delete (globalThis as { __noGlDirectVertexUpload?: boolean }).__noGlDirectVertexUpload;
    return e;
}

function arena(count: number, seed: number): Float32Array {
    const a = new Float32Array((count + 3) * VERT_FLOATS);
    let s = seed;
    for (let i = 0; i < a.length; i++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        a[i] = (s / 4294967296) * 4 - 1.5;
    }
    return a;
}

const SIZES: Record<string, number> = { float32: 1, float32x2: 2, float32x4: 4 };

function decode(e: any, data: Float32Array, first: number, byteLength: number, count: number, direct: boolean): number[][] {
    const bytes = new Uint8Array(data.buffer, data.byteOffset + first * 4, byteLength).slice();
    const f = new Float32Array(bytes.buffer);
    const layout = openglVertexLayout(direct);
    expect(byteLength).toBe(count * layout.arrayStride);
    const out: number[][] = [];
    for (let v = 0; v < count; v++) {
        const row: number[] = [];
        for (const at of [...layout.attributes].sort((x, y) => x.shaderLocation - y.shaderLocation)) {
            const base = (v * layout.arrayStride + at.offset) / 4;
            for (let k = 0; k < SIZES[at.format]!; k++) {
                const x = f[base + k]!;
                row.push(at.shaderLocation === 1 ? Math.min(1, Math.max(0, x)) : x);
            }
        }
        out.push(row);
    }
    return out;
}

function gpuView(direct: boolean, src: Float32Array, offset: number, count: number, mode: number, polygonMode: number) {
    const e = executor(direct);
    const p = e.prepareDrawData(src, offset, count, mode, polygonMode);
    if (!p) return null;
    return { topology: p.topology, vertexCount: p.vertexCount, attrs: decode(e, p.data, p.first, p.byteLength, p.vertexCount, direct) };
}

test("the arena-direct vertex upload hands the shader the same attributes as the packed copy", () => {
    const cases: Array<[number, number, number, number]> = [
        [GL_TRIANGLES, GL_FILL, 0, 9],
        [GL_TRIANGLES, GL_FILL, 3, 6],
        [GL_TRIANGLES, GL_LINE, 1, 6],
        [GL_TRIANGLES, GL_POINT, 2, 3],
        [GL_LINES, GL_FILL, 2, 4],
        [GL_LINE_STRIP, GL_FILL, 0, 5],
        [GL_LINE_LOOP, GL_FILL, 1, 4],
        [GL_POINTS, GL_FILL, 0, 7],
    ];
    for (const [mode, poly, startVert, count] of cases) {
        const src = arena(startVert + count, mode * 31 + poly + count);
        const offset = startVert * VERT_FLOATS;
        const direct = gpuView(true, src, offset, count, mode, poly);
        const packed = gpuView(false, src, offset, count, mode, poly);
        expect(direct).not.toBeNull();
        expect(direct).toEqual(packed);
    }
});

test("the arena-direct path uploads straight out of the arena without a copy", () => {
    const e = executor(true);
    const src = arena(6, 3);
    const p = e.prepareDrawData(src, 2 * VERT_FLOATS, 3, GL_TRIANGLES, GL_FILL);
    expect(p.data).toBe(src);
    expect(p.first).toBe(2 * VERT_FLOATS);
});

test("the vertex shader clamps the primary colour per vertex", () => {
    const wgsl = (OpenGLBackendExecutor.prototype as unknown as { buildShaderCode(): string }).buildShaderCode.call({});
    expect(wgsl).toContain("out.color = clamp(input.color, vec4f(0.0), vec4f(1.0));");
});

test("an arena-direct upload writes the draw's own vertices, not the arena's head", () => {
    const e = executor(true);
    const src = arena(8, 5);
    const writes: Uint8Array[] = [];
    e.vertexBuffer = {};
    e.vertexBufferSize = 1 << 16;
    e.vertexUploadCursor = 0;
    const queue = { writeBuffer: (_b: unknown, _o: number, data: ArrayBuffer, off: number, size: number) => { writes.push(new Uint8Array(data, off, size).slice()); } };
    const p = e.prepareDrawData(src, 4 * VERT_FLOATS, 3, GL_TRIANGLES, GL_FILL);
    expect(e.uploadVertices(queue, p.data, p.first, p.byteLength)).toBe(0);
    expect(Array.from(new Float32Array(writes[0]!.buffer))).toEqual(Array.from(src.subarray(4 * VERT_FLOATS, 7 * VERT_FLOATS)));
});
