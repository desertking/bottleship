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
    held: 0,
    heldStore: 0,
    heldMultiply: 0,
    heldReleased: 0,
    heldCheckOk: 0,
    heldCheckDiff: 0,
    reset(): void {
        this.store = 0; this.restore = 0; this.multiply = 0; this.multiplyShader = 0;
        this.declinedValues = 0; this.checkOk = 0; this.checkDiff = 0;
        this.held = 0; this.heldStore = 0; this.heldMultiply = 0; this.heldReleased = 0;
        this.heldCheckOk = 0; this.heldCheckDiff = 0;
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

export interface TransformDevice {
    getTransform(state: number): Float32Array | null;
    setTransform(state: number, matrix: Float32Array): number;
    multiplyTransform(state: number, matrix: Float32Array): number;
    getVertexShaderConstants(start: number, vector4fCount: number): Float32Array;
    setVertexShaderConstantFFromArray(startRegister: number, data: Float32Array, mem: Uint8Array): number;
}

const NO_MEM = null as unknown as Uint8Array;
const HELD_CHECK_EVERY = 64;

export class HeldRestore {
    device: TransformDevice | null = null;
    shader = false;
    readonly bytes = new Uint8Array(STORE_SHADER_LEN);
    private readonly floats = new Float32Array(this.bytes.buffer);
    private readonly bank = new Float32Array(BANK_FLOATS);
    private readonly product = new Float32Array(BANK_FLOATS);
    private readonly world = new Float32Array(16);
    private checks = 0;

    constructor(private readonly multiplyMatrices: (a: Float32Array, b: Float32Array) => Float32Array) {}

    hold(device: TransformDevice, shader: boolean, mem: Uint8Array, buf: number): void {
        const len = shader ? STORE_SHADER_LEN : STORE_FFP_LEN;
        this.bytes.set(mem.subarray(buf, buf + len));
        this.device = device;
        this.shader = shader;
        transformCounters.held++;
    }

    release(): void {
        const device = this.device;
        if (!device) return;
        this.device = null;
        device.setTransform(WORLD, this.floats.subarray(0, 16));
        if (this.shader) {
            device.setVertexShaderConstantFFromArray(0, this.floats.subarray(16, 32), NO_MEM);
            device.setVertexShaderConstantFFromArray(8, this.floats.subarray(32, BANK_FLOATS), NO_MEM);
        }
        transformCounters.heldReleased++;
    }
    heldBank(device: TransformDevice): Float32Array {
        const bank = this.bank;
        bank.set(this.floats.subarray(16, 32), 0);
        bank.set(device.getVertexShaderConstants(4, 4), 16);
        bank.set(this.floats.subarray(32, BANK_FLOATS), 32);
        return bank;
    }
    multiply(m: Float32Array): boolean {
        const device = this.device;
        if (!device) return false;
        const world = this.multiplyMatrices(m, this.floats.subarray(0, 16));
        for (let i = 0; i < 16; i++) {
            if (!Number.isFinite(world[i]!)) { this.release(); return false; }
        }
        if (this.shader) multiplyBank(this.heldBank(device), m, this.product);
        if (this.checks++ % HELD_CHECK_EVERY === 0) {
            this.world.set(world);
            this.release();
            device.multiplyTransform(WORLD, m);
            let same = sameBits(device.getTransform(WORLD), this.world, 16);
            if (this.shader) {
                const now = new Float32Array(BANK_FLOATS);
                multiplyBank(device.getVertexShaderConstants(0, BANK_REGISTERS), m, now);
                device.setVertexShaderConstantFFromArray(0, now, NO_MEM);
                same = same && sameBits(now, this.product, BANK_FLOATS);
            }
            if (same) transformCounters.heldCheckOk++;
            else transformCounters.heldCheckDiff++;
            return true;
        }
        this.device = null;
        device.setTransform(WORLD, world);
        if (this.shader) device.setVertexShaderConstantFFromArray(0, this.product, NO_MEM);
        transformCounters.heldMultiply++;
        return true;
    }
}

function sameBits(a: Float32Array | null, b: Float32Array, n: number): boolean {
    if (!a || a.length < n) return false;
    const f = new Float32Array(2);
    const u = new Uint32Array(f.buffer);
    for (let i = 0; i < n; i++) {
        f[0] = a[i]!; f[1] = b[i]!;
        if (u[0] !== u[1]) return false;
    }
    return true;
}
