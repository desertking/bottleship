/**
 * libvorbis mdct_backward(init, in, out) served from the translation in lifted.ts.
 *
 * The translation runs on a private arena, never on guest memory: the lookup, the two
 * tables and the input are copied in, `in` and `out` keep their relation (the decoder
 * passes the same buffer for both), and the n output floats are handed back.
 *
 *   init: n at +0, log2(n) at +4, trig table (n + n/4 floats) at +8,
 *         bit reverse table (n/4 dwords) at +0xc, scale at +0x10
 */

import { mdctBackwardDouble, mdctBackwardSingle } from './lifted';

const MAX_N = 8192;
const INIT = 0x40;
const TRIG = 0x100;
const BITREV = TRIG + 5 * MAX_N;
const BUF_A = BITREV + MAX_N;
const BUF_B = BUF_A + 4 * MAX_N;
const STACK_TOP = BUF_B + 4 * MAX_N + 0x2000;
const ARENA_LEN = STACK_TOP + 0x100;

const arena = new Uint8Array(ARENA_LEN);
const I = new Int32Array(arena.buffer);
const F = new Float32Array(arena.buffer);

export const mdctCounters = {
    calls: 0,
    declined: 0,
    reset(): void { this.calls = 0; this.declined = 0; },
};

/** Block size of the lookup at `init`, or 0 when the call is outside the served shape. */
export function mdctShape(mem: Uint8Array, init: number, inp: number, out: number): number {
    const limit = mem.length;
    if (((init | inp | out) & 3) !== 0 || init === 0 || inp === 0 || out === 0) return 0;
    if (init + 0x14 > limit) return 0;
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const n = dv.getInt32(init, true);
    if (n < 64 || n > MAX_N || (n & (n - 1)) !== 0) return 0;
    if (dv.getInt32(init + 4, true) !== 31 - Math.clz32(n)) return 0;
    const trig = dv.getUint32(init + 8, true);
    const bitrev = dv.getUint32(init + 0xc, true);
    if ((trig & 3) !== 0 || trig === 0 || trig + 5 * n > limit) return 0;
    if ((bitrev & 3) !== 0 || bitrev === 0 || bitrev + n > limit) return 0;
    if (inp + 2 * n > limit || out + 4 * n > limit) return 0;
    if (inp !== out && inp < out + 4 * n && out < inp + 4 * n) return 0;
    return n;
}

/** The n output floats of a call mdctShape admitted with block size n. */
export function mdctBackward(
    mem: Uint8Array, init: number, inp: number, out: number, n: number, single: boolean,
): Uint8Array {
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const trig = dv.getUint32(init + 8, true);
    const bitrev = dv.getUint32(init + 0xc, true);
    arena.set(mem.subarray(init, init + 0x14), INIT);
    I[(INIT + 8) >> 2] = TRIG;
    I[(INIT + 0xc) >> 2] = BITREV;
    arena.set(mem.subarray(trig, trig + 5 * n), TRIG);
    arena.set(mem.subarray(bitrev, bitrev + n), BITREV);
    const outAt = inp === out ? BUF_A : BUF_B;
    arena.set(mem.subarray(out, out + 4 * n), outAt);
    if (inp !== out) arena.set(mem.subarray(inp, Math.min(inp + 4 * n, mem.length)), BUF_A);
    const esp = STACK_TOP;
    I[(esp + 4) >> 2] = INIT;
    I[(esp + 8) >> 2] = BUF_A;
    I[(esp + 12) >> 2] = outAt;
    if (single) mdctBackwardSingle(I, F, esp);
    else mdctBackwardDouble(I, F, esp);
    mdctCounters.calls++;
    return arena.subarray(outAt, outAt + 4 * n);
}
