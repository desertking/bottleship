import { describe, expect, test } from "bun:test";
import { decodeCursorResource } from "../../src/worker/modules/user32/resource-cursor";

function monoCursor(xorBit: number, andBit: number): DataView {
    const w = 32, h = 32, stride = 4;
    const size = 4 + 40 + 8 + stride * h * 2;
    const v = new DataView(new ArrayBuffer(size));
    v.setUint16(0, 3, true);
    v.setUint16(2, 5, true);
    v.setUint32(4, 40, true);
    v.setInt32(8, w, true);
    v.setInt32(12, h * 2, true);
    v.setUint16(16, 1, true);
    v.setUint16(18, 1, true);
    v.setUint32(44, 0x000000, true);
    v.setUint32(48, 0xffffff, true);
    const xor = 4 + 40 + 8, and = xor + stride * h;
    for (let i = 0; i < stride * h; i++) {
        v.setUint8(xor + i, xorBit ? 0xff : 0);
        v.setUint8(and + i, andBit ? 0xff : 0);
    }
    return v;
}

const alphaCount = (p: Uint8Array) => p.filter((_, i) => i % 4 === 3 && p[i] > 0).length;

describe("application cursor resources", () => {
    test("a cursor whose AND mask covers everything is fully transparent", () => {
        const v = monoCursor(0, 1);
        const c = decodeCursorResource(v, 0, v.byteLength)!;
        expect([c.width, c.height, c.xHotspot, c.yHotspot]).toEqual([32, 32, 3, 5]);
        expect(alphaCount(c.pixels)).toBe(0);
    });

    test("negative control: an opaque white cursor stays visible", () => {
        const v = monoCursor(1, 0);
        const c = decodeCursorResource(v, 0, v.byteLength)!;
        expect(alphaCount(c.pixels)).toBe(32 * 32);
        expect(Array.from(c.pixels.slice(0, 4))).toEqual([255, 255, 255, 255]);
    });
});
