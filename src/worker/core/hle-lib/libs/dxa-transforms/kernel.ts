/**
 * World-transform save / restore / multiply of a mingw-built Direct3D 9 title's effect
 * manager. Each of the three guest functions is a fixed sequence of device calls:
 *
 *   store(buf)      GetTransform(WORLD, buf); in shader mode also
 *                   GetVertexShaderConstantF(0, buf+0x40, 4) and (8, buf+0x80, 21)
 *   restore(buf)    the same three with Set*
 *   multiply(M)     MultiplyTransform(WORLD, M); in shader mode, for the 4-vector blocks
 *                   at registers 0, 8, 12, 16, 20, 24 and the single vector at 28:
 *                   Get, out[r][c] = ((M[c][0]*G[r][0] + M[c][1]*G[r][1]) + M[c][2]*G[r][2])
 *                   + M[c][3]*G[r][3], Set
 *
 * "Shader mode" is one integer of the renderer's capability block being above 0x31.
 * The arithmetic runs on the x87 with precision control single, so every product and
 * sum is rounded to 24 bits; with operands confined to PLAIN_LO..PLAIN_HI no result can
 * leave the normal f32 range and Math.fround per operation is bit-identical.
 */

export const WORLD = 0x100;
export const BANK_REGISTERS = 29;
export const BANK_FLOATS = BANK_REGISTERS * 4;
export const STORE_FFP_LEN = 0x40;
export const STORE_SHADER_LEN = 0x1d0;
export const SHADER_MODE_ABOVE = 0x31;
export const PLAIN_LO = 2 ** -50;
export const PLAIN_HI = 2 ** 30;

const BLOCKS: ReadonlyArray<readonly [number, number]> = [
    [0, 4], [8, 4], [12, 4], [16, 4], [20, 4], [24, 4], [28, 1],
];

export const transformCounters = {
    store: 0,
    restore: 0,
    multiply: 0,
    multiplyShader: 0,
    declinedValues: 0,
    checkOk: 0,
    checkDiff: 0,
    reset(): void {
        this.store = 0; this.restore = 0; this.multiply = 0; this.multiplyShader = 0;
        this.declinedValues = 0; this.checkOk = 0; this.checkDiff = 0;
    },
};

export function plainFloats(v: ArrayLike<number>, from: number, to: number): boolean {
    for (let i = from; i < to; i++) {
        const x = v[i]!;
        if (x === 0) continue;
        const a = x < 0 ? -x : x;
        if (!(a >= PLAIN_LO && a <= PLAIN_HI)) return false;
    }
    return true;
}

/** Every bank register multiply() reads holds a plain value. */
export function plainBank(bank: ArrayLike<number>): boolean {
    return plainFloats(bank, 0, 16) && plainFloats(bank, 32, BANK_FLOATS);
}

/** `out` receives the registers multiply() rewrites; the untouched ones (4..7) are copied. */
export function multiplyBank(bank: Float32Array, m: Float32Array, out: Float32Array): void {
    const f = Math.fround;
    for (let i = 16; i < 32; i++) out[i] = bank[i]!;
    for (const [reg, vectors] of BLOCKS) {
        for (let r = 0; r < vectors; r++) {
            const g = (reg + r) * 4;
            const g0 = bank[g]!, g1 = bank[g + 1]!, g2 = bank[g + 2]!, g3 = bank[g + 3]!;
            for (let c = 0; c < 4; c++) {
                const k = c * 4;
                out[g + c] = f(f(f(f(m[k]! * g0) + f(m[k + 1]! * g1)) + f(m[k + 2]! * g2)) + f(m[k + 3]! * g3));
            }
        }
    }
}

/** Bit compare over the registers multiply() rewrites. */
export function sameBank(a: Float32Array, b: Float32Array): boolean {
    const x = new Uint32Array(a.buffer, a.byteOffset, BANK_FLOATS);
    const y = new Uint32Array(b.buffer, b.byteOffset, BANK_FLOATS);
    for (let i = 0; i < BANK_FLOATS; i++) {
        if (i >= 16 && i < 32) continue;
        if (x[i] !== y[i]) return false;
    }
    return true;
}
