import { expect, test } from "bun:test";
import { mat4Multiply } from "../../src/worker/modules/opengl32/context";

function reference(out: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
            out[col * 4 + row] = sum;
        }
    }
}

test("mat4Multiply is bit-identical to the column-major dot-product loop", () => {
    let seed = 12345;
    const next = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * 2 - 1;
    const a = new Float32Array(16), b = new Float32Array(16), x = new Float32Array(16), y = new Float32Array(16);
    for (let n = 0; n < 20000; n++) {
        const scale = [1, 1e-3, 1e3, 1e30][n & 3]!;
        for (let k = 0; k < 16; k++) { a[k] = next() * scale; b[k] = next(); }
        if (n % 7 === 0) b[3] = NaN;
        reference(x, a, b);
        mat4Multiply(y, a, b);
        expect(Array.from(y)).toEqual(Array.from(x));
    }
});

test("mat4Multiply may write over its right operand", () => {
    const a = Float32Array.from({ length: 16 }, (_, i) => i * 0.5 - 3);
    const b = Float32Array.from({ length: 16 }, (_, i) => 1 / (i + 1));
    const expected = new Float32Array(16);
    reference(expected, a, b);
    mat4Multiply(b, a, b);
    expect(Array.from(b)).toEqual(Array.from(expected));
});
