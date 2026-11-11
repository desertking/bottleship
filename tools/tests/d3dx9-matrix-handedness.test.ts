import { beforeEach, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { createMathExports } from "../../src/worker/modules/d3dx9/math";

let mem: Uint8Array;
let view: DataView;
const math = createMathExports();
const OUT = 0x100, EYE = 0x200, AT = 0x210, UP = 0x220;
const bits = (x: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, x, true); return v.getUint32(0, true); };
const vec = (addr: number, x: number, y: number, z: number) => { view.setFloat32(addr, x, true); view.setFloat32(addr + 4, y, true); view.setFloat32(addr + 8, z, true); };
const matrix = () => Array.from({ length: 16 }, (_, i) => Math.round(view.getFloat32(OUT + i * 4, true) * 1e6) / 1e6 + 0);

beforeEach(() => {
    mem = new Uint8Array(0x1000);
    view = new DataView(mem.buffer);
    Mem.bind(() => mem, (a, s) => a >= 0 && a + s <= mem.length);
});

test("LookAtLH looks down +z from a camera behind the origin", () => {
    vec(EYE, 0, 0, -5); vec(AT, 0, 0, 0); vec(UP, 0, 1, 0);
    expect(math["D3DXMatrixLookAtLH"]!({} as never, mem, [OUT, EYE, AT, UP])).toBe(OUT);
    expect(matrix()).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
});

test("LookAtRH looks down -z from a camera in front of the origin", () => {
    vec(EYE, 0, 0, 5); vec(AT, 0, 0, 0); vec(UP, 0, 1, 0);
    expect(math["D3DXMatrixLookAtRH"]!({} as never, mem, [OUT, EYE, AT, UP])).toBe(OUT);
    expect(matrix()).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1]);
});

test("Ortho maps depth to [0,1] with the handedness sign", () => {
    math["D3DXMatrixOrthoLH"]!({} as never, mem, [OUT, bits(4), bits(2), bits(1), bits(3)]);
    expect(matrix()).toEqual([0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, -0.5, 1]);
    math["D3DXMatrixOrthoRH"]!({} as never, mem, [OUT, bits(4), bits(2), bits(1), bits(3)]);
    expect(matrix()).toEqual([0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.5, 0, 0, 0, -0.5, 1]);
    math["D3DXMatrixOrthoOffCenterLH"]!({} as never, mem, [OUT, bits(0), bits(640), bits(480), bits(0), bits(0), bits(1)]);
    expect(matrix()).toEqual([0.003125, 0, 0, 0, 0, -0.004167, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]);
});

test("MatrixInverse inverts a translate-scale and reports the determinant", () => {
    const M = 0x300, DET = 0x380;
    const src = [2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 3, -2, 5, 1];
    src.forEach((v, i) => view.setFloat32(M + i * 4, v, true));
    expect(math["D3DXMatrixInverse"]!({} as never, mem, [OUT, DET, M])).toBe(OUT);
    expect(matrix()).toEqual([0.5, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, -1.5, 0.5, -5, 1]);
    expect(view.getFloat32(DET, true)).toBe(8);
    for (let i = 0; i < 16; i++) view.setFloat32(M + i * 4, 0, true);
    expect(math["D3DXMatrixInverse"]!({} as never, mem, [OUT, 0, M])).toBe(0);
});
