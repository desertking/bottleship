/**
 * Granny 2 software skinning kernel: four weighted bones, position + normal, with a
 * trailing run of dwords (texture coordinates and the like) copied through unchanged.
 * Pure and dependency-free so `bun test` can import it.
 *
 * SEMANTICS, read off the guest code (see descriptor.ts):
 *
 *   void deform(i32 count, const u8* src, u8* dst, const i32* matrixIndices,
 *               const f32* matrices4x4, i32 tailDwords)      // cdecl, EAX = dst cursor
 *
 *   src vertex: f32 P[3] | u8 W[4] | u8 I[4] | f32 N[3] | u32 tail[tailDwords]
 *   dst vertex: f32 P[3] | f32 N[3]                      | u32 tail[tailDwords]
 *
 * Per bone k: m = matrices + (matrixIndices[I[k]] << 6), w = W[k] * C with C the f32
 * constant 1/255 the code loads from .rdata. Each component is one dot product in the
 * exact operand order of the x87 sequence, scaled by w, and accumulated into the
 * destination float:
 *
 *   P.x += ((x*m0 + z*m8) + y*m4 + m12) * w      N.x += ((nx*m0 + nz*m8) + ny*m4) * w
 *   P.y += ((z*m9 + y*m5) + x*m1 + m13) * w      N.y += ((nz*m9 + ny*m5) + nx*m1) * w
 *   P.z += ((x*m2 + z*m10) + y*m6 + m14) * w     N.z += ((nx*m2 + nz*m10) + ny*m6) * w
 *
 * Bone 0 stores instead of accumulating. The accumulator round-trips through the f32
 * destination after every bone, and the fourth weight is spilled to an f32 slot before
 * use while the first three stay on the x87 stack. Every x87 multiply and add rounds its
 * result to the precision-control width — 24 bits under the single-precision word
 * Direct3D installs at device creation — exactly as the f64-backed x87 does, so the
 * result is bit-identical to the guest's.
 */

import type { ShadowView } from '../../types';

export const SRC_FIXED = 0x20;
export const DST_FIXED = 0x18;
export const MAX_TAIL_DWORDS = 64;
export const MAX_VERTICES = 1 << 20;

const fround = Math.fround;

export interface DeformArgs {
    count: number;
    src: number;
    dst: number;
    matrixIndices: number;
    matrices: number;
    tail: number;
}

export function decodeArgs(args: number[]): DeformArgs {
    return {
        count: args[0] | 0,
        src: args[1] >>> 0,
        dst: args[2] >>> 0,
        matrixIndices: args[3] >>> 0,
        matrices: args[4] >>> 0,
        tail: args[5] | 0,
    };
}

export const srcStride = (tail: number): number => SRC_FIXED + 4 * tail;
export const dstStride = (tail: number): number => DST_FIXED + 4 * tail;

/** Address of the 1/255 weight scale each copy reads, keyed by the copy's entry. */
const weightScales = new Map<number, number>();
export const setWeightScale = (entry: number, addr: number): void => { weightScales.set(entry >>> 0, addr >>> 0); };
export const getWeightScale = (entry: number): number | undefined => weightScales.get(entry >>> 0);
export const clearWeightScales = (): void => { weightScales.clear(); };

export const deformCounters = {
    calls: 0,
    vertices: 0,
    reset(): void { this.calls = 0; this.vertices = 0; },
};

const F32_MIN_NORMAL = 2 ** -126;
const F32_LIMIT = 2 ** 128;
const f64Bits = new DataView(new ArrayBuffer(8));

/** Round the significand to 24 bits keeping the f64 exponent (v86 fpu_round_significand). */
function roundSignificand24Slow(v: number): number {
    f64Bits.setFloat64(0, v, true);
    const bits = f64Bits.getBigUint64(0, true);
    const magnitude = bits & 0x7fff_ffff_ffff_ffffn;
    const exponent = magnitude >> 52n;
    if (exponent === 0x7ffn || magnitude === 0n) return v;
    let significant = 53n;
    if (exponent === 0n) significant = BigInt(magnitude.toString(2).length);
    const shift = significant > 24n ? significant - 24n : 0n;
    if (shift === 0n) return v;
    const mask = (1n << shift) - 1n;
    const halfway = 1n << (shift - 1n);
    const rounded = (magnitude + halfway - 1n + ((magnitude >> shift) & 1n)) & ~mask;
    f64Bits.setBigUint64(0, (bits & (1n << 63n)) | rounded, true);
    return f64Bits.getFloat64(0, true);
}

/** One x87 arithmetic result under precision control 00 (single). */
export function round24(v: number): number {
    if (v === 0) return v;
    const f = fround(v);
    const m = f < 0 ? -f : f;
    return m >= F32_MIN_NORMAL && m < F32_LIMIT ? f : roundSignificand24Slow(v);
}

const exact = (v: number): number => v;

export function deformKernel(view: ShadowView, args: number[], scaleAddr: number, singlePrecision: boolean): number {
    const a = decodeArgs(args);
    if (a.count <= 0) return a.dst;
    const r = singlePrecision ? round24 : exact;
    const c = view.readF32(scaleAddr);
    const sStride = srcStride(a.tail);
    const dStride = dstStride(a.tail);
    let s = a.src;
    let d = a.dst;
    for (let v = 0; v < a.count; v++) {
        const x = view.readF32(s), y = view.readF32(s + 4), z = view.readF32(s + 8);
        const nx = view.readF32(s + 0x14), ny = view.readF32(s + 0x18), nz = view.readF32(s + 0x1c);
        let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
        for (let k = 0; k < 4; k++) {
            const mi = view.readU32(a.matrixIndices + 4 * view.readU8(s + 0x10 + k));
            const m = (a.matrices + (mi << 6)) >>> 0;
            const b = view.readU8(s + 0x0c + k);
            const w = k === 3 ? fround(r(b * c)) : r(b * c);
            const m0 = view.readF32(m), m1 = view.readF32(m + 4), m2 = view.readF32(m + 8);
            const m4 = view.readF32(m + 0x10), m5 = view.readF32(m + 0x14), m6 = view.readF32(m + 0x18);
            const m8 = view.readF32(m + 0x20), m9 = view.readF32(m + 0x24), m10 = view.readF32(m + 0x28);
            const tx = r(r(r(r(r(x * m0) + r(z * m8)) + r(y * m4)) + view.readF32(m + 0x30)) * w);
            const ty = r(r(r(r(r(z * m9) + r(y * m5)) + r(x * m1)) + view.readF32(m + 0x34)) * w);
            const tz = r(r(r(r(r(x * m2) + r(z * m10)) + r(y * m6)) + view.readF32(m + 0x38)) * w);
            const ux = r(r(r(r(nx * m0) + r(nz * m8)) + r(ny * m4)) * w);
            const uy = r(r(r(r(nz * m9) + r(ny * m5)) + r(nx * m1)) * w);
            const uz = r(r(r(r(nx * m2) + r(nz * m10)) + r(ny * m6)) * w);
            if (k === 0) {
                px = fround(tx); py = fround(ty); pz = fround(tz);
                qx = fround(ux); qy = fround(uy); qz = fround(uz);
            } else {
                px = fround(r(tx + px)); py = fround(r(ty + py)); pz = fround(r(tz + pz));
                qx = fround(r(ux + qx)); qy = fround(r(uy + qy)); qz = fround(r(uz + qz));
            }
        }
        view.writeF32(d, px); view.writeF32(d + 4, py); view.writeF32(d + 8, pz);
        view.writeF32(d + 0x0c, qx); view.writeF32(d + 0x10, qy); view.writeF32(d + 0x14, qz);
        for (let t = 0; t < a.tail; t++) view.writeU32(d + DST_FIXED + 4 * t, view.readU32(s + SRC_FIXED + 4 * t));
        s = (s + sStride) >>> 0;
        d = (d + dStride) >>> 0;
    }
    deformCounters.calls++;
    deformCounters.vertices += a.count;
    return d;
}
