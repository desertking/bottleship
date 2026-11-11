import { expect, test } from "bun:test";
import { createOpenGLContext, GLCapSet, VERT_FLOATS } from "../../src/worker/modules/opengl32/context";
import { createImmediateExports, assembleFlatVerts, transformFlatVerts } from "../../src/worker/modules/opengl32/immediate";
import { createMatrixExports } from "../../src/worker/modules/opengl32/matrix";

const bits = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0]!;

test("GLCapSet answers like a Set inside and outside the byte table", () => {
    const s = new GLCapSet();
    s.add(0x0B44); s.add(0x12345); s.add(0x0B60);
    s.delete(0x0B60);
    expect(s.has(0x0B44)).toBe(true);
    expect(s.has(0x0B60)).toBe(false);
    expect(s.has(0x12345)).toBe(true);
    expect([...s].sort()).toEqual([0x0B44, 0x12345].sort());
    expect(s.size).toBe(2);
    s.clear();
    expect(s.has(0x0B44)).toBe(false);
    expect(s.size).toBe(0);
});

test("glEnd transforms before assembling and produces the same clip-space vertices", () => {
    const ctx = createOpenGLContext({ getCurrentMemory: () => new Uint8Array(16) } as any);
    const gl = { ...createMatrixExports(ctx), ...createImmediateExports(ctx) } as Record<string, any>;
    ctx.enableFlags.add(0x0B60);
    gl.glRotatef(null, null, [bits(25), bits(0), bits(1), bits(0.5)]);
    gl.glTranslatef(null, null, [bits(1.5), bits(-2), bits(-9)]);
    gl.glBegin(null, null, [7]);
    const src: number[][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0.5], [0, 1, 0.25]];
    for (const [x, y, z] of src) gl.glVertex3f(null, null, [bits(x!), bits(y!), bits(z!)]);
    const flat = new Float32Array(ctx.immediateFlatBuf.subarray(0, 4 * VERT_FLOATS));
    gl.glEnd(null, null, []);
    const expected = new Float32Array(4 * VERT_FLOATS);
    assembleFlatVerts(flat, 4, 0x0004, expected, 0);
    expected.set(flat.subarray(3 * VERT_FLOATS, 4 * VERT_FLOATS), 3 * VERT_FLOATS);
    transformFlatVerts(ctx, expected, 0, 4);
    expect(Array.from(ctx.vertArena.data.subarray(0, 4 * VERT_FLOATS))).toEqual(Array.from(expected));
    expect(ctx.commands.count).toBe(1);
});
