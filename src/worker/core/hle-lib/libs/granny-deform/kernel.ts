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
    sseCalls: 0,
    aabbCalls: 0,
    worldPoseCalls: 0,
    worldPoseBones: 0,
    worldPosePlain: 0,
    vertices: 0,
    exactVertices: 0,
    reset(): void {
        this.calls = 0; this.sseCalls = 0; this.aabbCalls = 0; this.worldPoseCalls = 0; this.worldPoseBones = 0; this.worldPosePlain = 0;
        this.vertices = 0; this.exactVertices = 0;
    },
};

const F32_MIN_NORMAL = 2 ** -126;
const F32_LIMIT = 2 ** 128;
const f64Bits = new DataView(new ArrayBuffer(8));

/** Round the significand to 24 bits keeping the f64 exponent (v86 fpu_round_significand). */
function roundSignificand24Subnormal(v: number): number {
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

const f64Value = new Float64Array(1);
const f64Words = new Uint32Array(f64Value.buffer);

function roundSignificand24Slow(v: number): number {
    f64Value[0] = v;
    const high = f64Words[1], low = f64Words[0];
    const exponent = (high >>> 20) & 0x7ff;
    if (exponent === 0x7ff) return v;
    if (exponent === 0) return roundSignificand24Subnormal(v);
    const rest = low & 0x1fffffff;
    let kept = low >>> 29;
    if (rest > 0x10000000 || (rest === 0x10000000 && (kept & 1) !== 0)) kept++;
    f64Words[0] = (kept << 29) >>> 0;
    if (kept === 8) f64Words[1] = high + 1;
    return f64Value[0];
}

/** One x87 arithmetic result under precision control 00 (single). */
export function round24(v: number): number {
    if (v === 0) return v;
    const f = fround(v);
    const m = f < 0 ? -f : f;
    return m > F32_MIN_NORMAL && m < F32_LIMIT ? f : roundSignificand24Slow(v);
}

const exact = (v: number): number => v;

function deformVertex(
    view: ShadowView, a: DeformArgs, s: number, d: number, c: number, r: (v: number) => number,
): void {
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
}

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
        deformVertex(view, a, s, d, c, r);
        s = (s + sStride) >>> 0;
        d = (d + dStride) >>> 0;
    }
    deformCounters.calls++;
    deformCounters.vertices += a.count;
    deformCounters.exactVertices += a.count;
    return d;
}

/**
 * When single-rounded f32 arithmetic IS the precision-control result. round24 hands every
 * value to Math.fround except a subnormal or overflowing one, so a vertex may take the plain
 * path when no intermediate can be either. With vmin the smallest nonzero vertex component
 * and mmin the smallest nonzero entry of a matrix, vmin * mmin >= 2^-72 and mmin >= 2^-72
 * make every product and translation zero or at least 2^-72, hence every sum a multiple of
 * 2^-95; a weight is zero or at least 2^-8 (the scale is held to [2^-8, 2^-7]), so every
 * weighted term is zero or at least 2^-103 with a unit in the last place of at least 2^-126,
 * and so is every accumulator. Magnitudes up to 2^30 keep everything far below overflow.
 * A vertex or matrix outside that takes the exact path.
 */
const PRODUCT_LO = 2 ** -72;
const PLAIN_HI = 2 ** 30;
const WEIGHT_SCALE_LO = 2 ** -8;
const WEIGHT_SCALE_HI = 2 ** -7;
const MATRIX_ENTRIES = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
const MATRIX_EXACT = -1;
const matrixSlotAddr = new Int32Array(256);
const matrixSlotKnown = new Uint8Array(256);
const matrixSlotMin = new Float64Array(256);

function smallestMatrixEntry(F: Float32Array, i: number): number {
    let min = Infinity;
    for (let j = 0; j < MATRIX_ENTRIES.length; j++) {
        const v = F[i + MATRIX_ENTRIES[j]];
        if (v === 0) continue;
        const m = v < 0 ? -v : v;
        if (!(m <= PLAIN_HI)) return MATRIX_EXACT;
        if (m < min) min = m;
    }
    return min >= PRODUCT_LO ? min : MATRIX_EXACT;
}

export interface DeformViews {
    u8: Uint8Array;
    u32: Uint32Array;
    f32: Float32Array;
}

export function deformViews(mem: Uint8Array): DeformViews | null {
    if ((mem.byteOffset & 3) !== 0) return null;
    return {
        u8: mem,
        u32: new Uint32Array(mem.buffer, mem.byteOffset, mem.byteLength >>> 2),
        f32: new Float32Array(mem.buffer, mem.byteOffset, mem.byteLength >>> 2),
    };
}

/**
 * The same kernel over dword views of guest memory. `out` receives the destination vertices
 * at `address + outDelta`, which lets a validation run aim them at its scratch copy of the
 * destination range; `view` serves the vertices that need the exact path.
 */
export function deformKernelDirect(
    view: ShadowView, src: DeformViews, out: DeformViews, outDelta: number,
    args: number[], scaleAddr: number,
): number {
    const a = decodeArgs(args);
    if (a.count <= 0) return a.dst;
    if (((a.src | a.dst | a.matrixIndices | a.matrices | scaleAddr | outDelta) & 3) !== 0) {
        return deformKernel(view, args, scaleAddr, true);
    }
    const F = src.f32, U = src.u32, B = src.u8;
    const OF = out.f32, OU = out.u32;
    const c = F[scaleAddr >>> 2];
    if (!(c >= WEIGHT_SCALE_LO && c <= WEIGHT_SCALE_HI)) return deformKernel(view, args, scaleAddr, true);
    const sStride = srcStride(a.tail);
    const dStride = dstStride(a.tail);
    const indices = a.matrixIndices >>> 2;
    const matrixLimit = F.length - 16;
    const tail = a.tail;
    matrixSlotKnown.fill(0);
    let s = a.src;
    let d = a.dst;
    let exactCount = 0;
    for (let v = 0; v < a.count; v++, s = (s + sStride) >>> 0, d = (d + dStride) >>> 0) {
        const o = s >>> 2;
        const x = F[o], y = F[o + 1], z = F[o + 2];
        const nx = F[o + 5], ny = F[o + 6], nz = F[o + 7];
        let vmin = Infinity, vmax = 0;
        let g = x < 0 ? -x : x;
        if (g !== 0) { if (g < vmin) vmin = g; if (!(g <= vmax)) vmax = g; }
        g = y < 0 ? -y : y;
        if (g !== 0) { if (g < vmin) vmin = g; if (!(g <= vmax)) vmax = g; }
        g = z < 0 ? -z : z;
        if (g !== 0) { if (g < vmin) vmin = g; if (!(g <= vmax)) vmax = g; }
        g = nx < 0 ? -nx : nx;
        if (g !== 0) { if (g < vmin) vmin = g; if (!(g <= vmax)) vmax = g; }
        g = ny < 0 ? -ny : ny;
        if (g !== 0) { if (g < vmin) vmin = g; if (!(g <= vmax)) vmax = g; }
        g = nz < 0 ? -nz : nz;
        if (g !== 0) { if (g < vmin) vmin = g; if (!(g <= vmax)) vmax = g; }
        let plain = vmax <= PLAIN_HI;
        let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
        for (let k = 0; plain && k < 4; k++) {
            const mi = U[indices + B[s + 0x10 + k]];
            const m = (a.matrices + (mi << 6)) >>> 0;
            const i = m >>> 2;
            const slot = mi & 255;
            if (matrixSlotKnown[slot] === 0 || matrixSlotAddr[slot] !== (m | 0)) {
                matrixSlotMin[slot] = i <= matrixLimit ? smallestMatrixEntry(F, i) : MATRIX_EXACT;
                matrixSlotAddr[slot] = m | 0;
                matrixSlotKnown[slot] = 1;
            }
            if (!(vmin * matrixSlotMin[slot] >= PRODUCT_LO)) { plain = false; break; }
            const w = fround(B[s + 0x0c + k] * c);
            const m0 = F[i], m1 = F[i + 1], m2 = F[i + 2];
            const m4 = F[i + 4], m5 = F[i + 5], m6 = F[i + 6];
            const m8 = F[i + 8], m9 = F[i + 9], m10 = F[i + 10];
            const tx = fround(fround(fround(fround(fround(x * m0) + fround(z * m8)) + fround(y * m4)) + F[i + 12]) * w);
            const ty = fround(fround(fround(fround(fround(z * m9) + fround(y * m5)) + fround(x * m1)) + F[i + 13]) * w);
            const tz = fround(fround(fround(fround(fround(x * m2) + fround(z * m10)) + fround(y * m6)) + F[i + 14]) * w);
            const ux = fround(fround(fround(fround(nx * m0) + fround(nz * m8)) + fround(ny * m4)) * w);
            const uy = fround(fround(fround(fround(nz * m9) + fround(ny * m5)) + fround(nx * m1)) * w);
            const uz = fround(fround(fround(fround(nx * m2) + fround(nz * m10)) + fround(ny * m6)) * w);
            if (k === 0) {
                px = tx; py = ty; pz = tz; qx = ux; qy = uy; qz = uz;
            } else {
                px = fround(tx + px); py = fround(ty + py); pz = fround(tz + pz);
                qx = fround(ux + qx); qy = fround(uy + qy); qz = fround(uz + qz);
            }
        }
        if (!plain) {
            deformVertex(view, a, s, d, c, round24);
            exactCount++;
            continue;
        }
        const e = (d + outDelta) >>> 2;
        OF[e] = px; OF[e + 1] = py; OF[e + 2] = pz;
        OF[e + 3] = qx; OF[e + 4] = qy; OF[e + 5] = qz;
        for (let t = 0; t < tail; t++) OU[e + 6 + t] = U[o + 8 + t];
    }
    deformCounters.calls++;
    deformCounters.vertices += a.count;
    deformCounters.exactVertices += exactCount;
    return d;
}

export class ShiftedWriteView implements ShadowView {
    private target: DataView;
    constructor(private base: ShadowView, bytes: Uint8Array, private delta: number) {
        this.target = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    readU8(a: number): number { return this.base.readU8(a); }
    readU16(a: number): number { return this.base.readU16(a); }
    readU32(a: number): number { return this.base.readU32(a); }
    readF32(a: number): number { return this.base.readF32(a); }
    readF64(a: number): number { return this.base.readF64(a); }
    readBytes(a: number, len: number): Uint8Array { return this.base.readBytes(a, len); }
    writeU8(a: number, v: number): void { this.target.setUint8(a + this.delta, v & 0xFF); }
    writeU16(a: number, v: number): void { this.target.setUint16(a + this.delta, v & 0xFFFF, true); }
    writeU32(a: number, v: number): void { this.target.setUint32(a + this.delta, v >>> 0, true); }
    writeF32(a: number, v: number): void { this.target.setFloat32(a + this.delta, v, true); }
    writeF64(a: number, v: number): void { this.target.setFloat64(a + this.delta, v, true); }
    writeBytes(a: number, bytes: Uint8Array): void {
        new Uint8Array(this.target.buffer, this.target.byteOffset, this.target.byteLength).set(bytes, a + this.delta);
    }
}
