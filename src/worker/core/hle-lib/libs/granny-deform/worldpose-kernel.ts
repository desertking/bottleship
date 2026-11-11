/**
 * Granny 2 world-pose build (x87). Walks a bone range once per animated model per frame:
 *
 *   void build(skeleton*, int first, int count, local_pose*, const f32 offset[16], world_pose*)   // cdecl
 *
 *   skeleton   +8  bones, 0x9c bytes each: +4 parent index, +0x4c inverse world 4x4
 *   local_pose +0  bone count, +4 entries, 0x50 bytes each, the transform at +8:
 *              +0 flags (bit 2: has scale/shear), +4 position[3], +0x10 quaternion[4], +0x20 scale[9]
 *   world_pose +0  bone count, +4 world 4x4 array, +8 composite 4x4 array
 *
 * Per bone, every operation one x87 result, every stored value an f32:
 *
 *   R  = rotation of the quaternion           M = flags & 4 ? R * scale : R
 *   T  = M transposed into a 4x4 with the position as its last row
 *   world     = root ? (offset ? T * offset : T) : T * world[parent]
 *   composite = inverseWorld * world
 *
 * The guest walks roots until the first bone with a parent and treats every bone after
 * it as parented; `worldPosePlan` accepts only ranges where that is what the bones say.
 * The function also bumps a call counter and adds rdtsc deltas to two profiling
 * accumulators; the caller of this kernel owns the counter, the time sums stay as they are.
 */

import type { DeformViews } from './kernel';
import { deformCounters, round24 } from './kernel';

export const MAX_BONES = 1024;
export const BONE_STRIDE = 0x9c;
export const LOCAL_STRIDE = 0x50;

const INDEFINITE = 0xffc00000;
const SMALLEST_NORMAL = 2 ** -126;

export interface WorldPoseArgs {
    skeleton: number;
    first: number;
    count: number;
    localPose: number;
    offset: number;
    worldPose: number;
}

export function decodeWorldPoseArgs(args: number[]): WorldPoseArgs {
    return {
        skeleton: args[0] >>> 0, first: args[1] | 0, count: args[2] | 0,
        localPose: args[3] >>> 0, offset: args[4] >>> 0, worldPose: args[5] >>> 0,
    };
}

export interface WorldPosePlan {
    bones: number;
    local: number;
    world: number;
    composite: number;
    offset: number;
    first: number;
    count: number;
}

const mag = (v: number): number => (v === 0 ? Infinity : v < 0 ? -v : v);
const overlap = (a: number, al: number, b: number, bl: number): boolean => a < b + bl && b < a + al;

/**
 * The arrays a call touches, or null when the guest would take an error path, an input
 * is unaligned, out of bounds, aliased or not finite, or a bone names no earlier parent.
 */
export function worldPosePlan(src: DeformViews, a: WorldPoseArgs): WorldPosePlan | null {
    const U = src.u32, limit = src.u8.length;
    const ok = (addr: number, len: number): boolean => addr > 0 && (addr & 3) === 0 && addr + len <= limit;
    if (a.count <= 0 || a.count > MAX_BONES || a.first < 0) return null;
    if (!ok(a.skeleton, 12) || !ok(a.localPose, 8) || !ok(a.worldPose, 12)) return null;
    if (a.offset !== 0 && !ok(a.offset, 64)) return null;
    const end = a.first + a.count;
    if (end > (U[a.localPose >>> 2] | 0) || end > (U[a.worldPose >>> 2] | 0)) return null;
    const bones = (U[(a.skeleton >>> 2) + 2] + a.first * BONE_STRIDE) >>> 0;
    const local = (U[(a.localPose >>> 2) + 1] + a.first * LOCAL_STRIDE + 8) >>> 0;
    const worldBase = U[(a.worldPose >>> 2) + 1];
    const world = (worldBase + (a.first << 6)) >>> 0;
    const composite = (U[(a.worldPose >>> 2) + 2] + (a.first << 6)) >>> 0;
    const bonesLen = a.count * BONE_STRIDE, localLen = a.count * LOCAL_STRIDE, outLen = a.count << 6;
    if (!ok(bones, bonesLen) || !ok(local, localLen) || !ok(world, outLen) || !ok(composite, outLen)) return null;
    if (!ok(worldBase, end << 6)) return null;
    if (overlap(world, outLen, composite, outLen) || overlap(world, outLen, bones, bonesLen)
        || overlap(world, outLen, local, localLen) || overlap(composite, outLen, bones, bonesLen)
        || overlap(composite, outLen, local, localLen)) return null;
    if (a.offset !== 0 && (overlap(a.offset, 64, world, outLen) || overlap(a.offset, 64, composite, outLen))) return null;
    let wild = 0;
    let parented = false;
    for (let i = 0; i < a.count; i++) {
        const b = (bones + i * BONE_STRIDE) >>> 2;
        const parent = U[b + 1] | 0;
        if (parent === -1) {
            if (parented) return null;
        } else {
            if (parent < 0 || parent >= a.first + i) return null;
            parented = true;
            if (parent < a.first) {
                const p = (worldBase >>> 2) + (parent << 4);
                for (let k = 0; k < 15; k++) { const m = U[p + k] & 0x7fffffff; wild |= 0x7f7fffff - m; }
            }
        }
        for (let k = 19; k < 34; k++) { const m = U[b + k] & 0x7fffffff; wild |= 0x7f7fffff - m; }
        const t = (local + i * LOCAL_STRIDE) >>> 2;
        for (let k = 1; k < 8; k++) { const m = U[t + k] & 0x7fffffff; wild |= 0x7f7fffff - m; }
        if (U[t] & 4) for (let k = 8; k < 17; k++) { const m = U[t + k] & 0x7fffffff; wild |= 0x7f7fffff - m; }
    }
    if (a.offset !== 0) for (let k = 0; k < 15; k++) { const m = U[(a.offset >>> 2) + k] & 0x7fffffff; wild |= 0x7f7fffff - m; }
    if (wild < 0) return null;
    return { bones, local, world, composite, offset: a.offset, first: a.first, count: a.count };
}

const W = new Float32Array(MAX_BONES * 16);
const C = new Float32Array(MAX_BONES * 16);
const WU = new Uint32Array(W.buffer);
const CU = new Uint32Array(C.buffer);
const T = new Float32Array(32);
const TU = new Uint32Array(T.buffer);

/** World (bytes 0..) and composite matrices of the last worldPoseKernel call, 64 bytes per bone. */
export const worldPoseWorld = new Uint8Array(W.buffer);
export const worldPoseComposite = new Uint8Array(C.buffer);

/** The smallest nonzero magnitude, +inf when every value is zero, NaN when one is. */
function smallest9(
    a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number,
): number {
    return Math.min(mag(a), mag(b), mag(c), mag(d), mag(e), mag(f), mag(g), mag(h), mag(i));
}

function smallest12(M: Float32Array, m: number): number {
    return Math.min(
        mag(M[m]), mag(M[m + 1]), mag(M[m + 2]), mag(M[m + 4]), mag(M[m + 5]), mag(M[m + 6]),
        mag(M[m + 8]), mag(M[m + 9]), mag(M[m + 10]), mag(M[m + 12]), mag(M[m + 13]), mag(M[m + 14]),
    );
}

/** One bone with every operation rounded the way the x87 does at precision control 00. */
function exactBone(src: DeformViews, p: WorldPosePlan, i: number): void {
    const F = src.f32, U = src.u32;
    const r = round24;
    const worldBase = (p.world >>> 2) - (p.first << 4);
    {
        const b = (p.bones + i * BONE_STRIDE) >>> 2;
        const t = (p.local + i * LOCAL_STRIDE) >>> 2;
        const qx = F[t + 4], qy = F[t + 5], qz = F[t + 6], qw = F[t + 7];
        const xx = r(qx * qx), yy = r(qy * qy), zz = r(qz * qz), xy = r(qy * qx);
        T[0] = r(qz * qx); T[1] = r(qz * qy); T[2] = r(qw * qx); T[3] = r(qy * qw);
        const xz = T[0], yz = T[1], wx = T[2], wy = T[3];
        const wz = r(qz * qw);
        let s = r(zz + yy); s = r(s + s); T[4] = r(1 - s);
        s = r(xy - wz); T[5] = r(s + s);
        s = r(wy + xz); T[6] = r(s + s);
        s = r(wz + xy); T[7] = r(s + s);
        s = r(zz + xx); s = r(s + s); T[8] = r(1 - s);
        s = r(yz - wx); T[9] = r(s + s);
        s = r(xz - wy); T[10] = r(s + s);
        s = r(wx + yz); T[11] = r(s + s);
        s = r(yy + xx); s = r(s + s); T[12] = r(1 - s);
        let a0 = T[4], a1 = T[5], a2 = T[6], a3 = T[7], a4 = T[8], a5 = T[9], a6 = T[10], a7 = T[11], a8 = T[12];
        if (U[t] & 4) {
            const b0 = F[t + 8], b1 = F[t + 9], b2 = F[t + 10], b3 = F[t + 11], b4 = F[t + 12];
            const b5 = F[t + 13], b6 = F[t + 14], b7 = F[t + 15], b8 = F[t + 16];
            T[4] = r(r(r(a0 * b0) + r(a2 * b6)) + r(a1 * b3));
            T[5] = r(r(r(a1 * b4) + r(b1 * a0)) + r(a2 * b7));
            T[6] = r(r(r(a2 * b8) + r(a1 * b5)) + r(b2 * a0));
            T[7] = r(r(r(a5 * b6) + r(a4 * b3)) + r(a3 * b0));
            T[8] = r(r(r(a4 * b4) + r(a5 * b7)) + r(a3 * b1));
            T[9] = r(r(r(a5 * b8) + r(a3 * b2)) + r(a4 * b5));
            T[10] = r(r(r(b6 * a8) + r(a7 * b3)) + r(b0 * a6));
            T[11] = r(r(r(a7 * b4) + r(b7 * a8)) + r(b1 * a6));
            T[12] = r(r(r(b8 * a8) + r(b2 * a6)) + r(a7 * b5));
            a0 = T[4]; a1 = T[5]; a2 = T[6]; a3 = T[7]; a4 = T[8]; a5 = T[9]; a6 = T[10]; a7 = T[11]; a8 = T[12];
        }
        const t0 = a0, t1 = a3, t2 = a6, t4 = a1, t5 = a4, t6 = a7, t8 = a2, t9 = a5, t10 = a8;
        const t12 = F[t + 1], t13 = F[t + 2], t14 = F[t + 3];
        const o = i << 4;
        const parent = U[b + 1] | 0;
        let B: Float32Array | null = null;
        let m = 0;
        if (parent !== -1) {
            if (parent >= p.first) { B = W; m = (parent - p.first) << 4; } else { B = F; m = worldBase + (parent << 4); }
        } else if (p.offset !== 0) {
            B = F; m = p.offset >>> 2;
        }
        if (B === null) {
            W[o] = t0; W[o + 1] = t1; W[o + 2] = t2; W[o + 3] = 0;
            W[o + 4] = t4; W[o + 5] = t5; W[o + 6] = t6; W[o + 7] = 0;
            W[o + 8] = t8; W[o + 9] = t9; W[o + 10] = t10; W[o + 11] = 0;
            W[o + 12] = t12; W[o + 13] = t13; W[o + 14] = t14; W[o + 15] = 1;
        } else {
            const b0 = B[m], b1 = B[m + 1], b2 = B[m + 2], b4 = B[m + 4], b5 = B[m + 5], b6 = B[m + 6];
            const b8 = B[m + 8], b9 = B[m + 9], b10 = B[m + 10], b12 = B[m + 12], b13 = B[m + 13], b14 = B[m + 14];
            W[o] = r(r(r(t0 * b0) + r(t2 * b8)) + r(t1 * b4));
            W[o + 1] = r(r(r(t1 * b5) + r(b1 * t0)) + r(t2 * b9));
            W[o + 2] = r(r(r(t2 * b10) + r(t1 * b6)) + r(b2 * t0));
            W[o + 3] = 0;
            W[o + 4] = r(r(r(t6 * b8) + r(t5 * b4)) + r(t4 * b0));
            W[o + 5] = r(r(r(t5 * b5) + r(t6 * b9)) + r(t4 * b1));
            W[o + 6] = r(r(r(t6 * b10) + r(t4 * b2)) + r(t5 * b6));
            W[o + 7] = 0;
            W[o + 8] = r(r(r(b8 * t10) + r(t9 * b4)) + r(b0 * t8));
            W[o + 9] = r(r(r(t9 * b5) + r(b9 * t10)) + r(b1 * t8));
            W[o + 10] = r(r(r(b10 * t10) + r(b2 * t8)) + r(t9 * b6));
            W[o + 11] = 0;
            W[o + 12] = r(r(r(r(t14 * b8) + r(t12 * b0)) + r(b4 * t13)) + b12);
            W[o + 13] = r(r(r(r(t14 * b9) + r(t12 * b1)) + r(t13 * b5)) + b13);
            W[o + 14] = r(r(r(r(b6 * t13) + r(b10 * t14)) + r(b2 * t12)) + b14);
            W[o + 15] = 1;
        }
        const v = b + 19;
        const v0 = F[v], v1 = F[v + 1], v2 = F[v + 2], v4 = F[v + 4], v5 = F[v + 5], v6 = F[v + 6];
        const v8 = F[v + 8], v9 = F[v + 9], v10 = F[v + 10], v12 = F[v + 12], v13 = F[v + 13], v14 = F[v + 14];
        const w0 = W[o], w1 = W[o + 1], w2 = W[o + 2], w4 = W[o + 4], w5 = W[o + 5], w6 = W[o + 6];
        const w8 = W[o + 8], w9 = W[o + 9], w10 = W[o + 10], w12 = W[o + 12], w13 = W[o + 13], w14 = W[o + 14];
        C[o] = r(r(r(v0 * w0) + r(v2 * w8)) + r(v1 * w4));
        C[o + 1] = r(r(r(v1 * w5) + r(w1 * v0)) + r(v2 * w9));
        C[o + 2] = r(r(r(v2 * w10) + r(v1 * w6)) + r(w2 * v0));
        C[o + 3] = 0;
        C[o + 4] = r(r(r(v6 * w8) + r(v5 * w4)) + r(v4 * w0));
        C[o + 5] = r(r(r(v5 * w5) + r(v6 * w9)) + r(v4 * w1));
        C[o + 6] = r(r(r(v6 * w10) + r(v4 * w2)) + r(v5 * w6));
        C[o + 7] = 0;
        C[o + 8] = r(r(r(w8 * v10) + r(v9 * w4)) + r(w0 * v8));
        C[o + 9] = r(r(r(v9 * w5) + r(w9 * v10)) + r(w1 * v8));
        C[o + 10] = r(r(r(w10 * v10) + r(w2 * v8)) + r(v9 * w6));
        C[o + 11] = 0;
        C[o + 12] = r(r(r(r(v14 * w8) + r(v12 * w0)) + r(w4 * v13)) + w12);
        C[o + 13] = r(r(r(r(v14 * w9) + r(v12 * w1)) + r(v13 * w5)) + w13);
        C[o + 14] = r(r(r(r(w6 * v13) + r(w10 * v14)) + r(w2 * v12)) + w14);
        C[o + 15] = 1;
    }
    const n = (i + 1) << 4;
    for (let k = i << 4; k < n; k++) {
        if (W[k] !== W[k]) WU[k] = INDEFINITE;
        if (C[k] !== C[k]) CU[k] = INDEFINITE;
    }
}

/**
 * Whether no product of the bone just computed by `plainPass` landed below the smallest
 * normal f32: each group of products is bounded by the smallest nonzero magnitude on
 * either side. Reads the rotation before and after scaling from T[16..24] and T[4..12].
 */
function productsNormal(F: Float32Array, t: number, v: number, o: number, scaled: boolean, B: Float32Array | null, m: number): boolean {
    const q = Math.min(mag(F[t + 4]), mag(F[t + 5]), mag(F[t + 6]), mag(F[t + 7]));
    if (!(q * q >= SMALLEST_NORMAL)) return false;
    if (scaled && !(smallest9(T[16], T[17], T[18], T[19], T[20], T[21], T[22], T[23], T[24])
        * smallest9(F[t + 8], F[t + 9], F[t + 10], F[t + 11], F[t + 12], F[t + 13], F[t + 14], F[t + 15], F[t + 16]) >= SMALLEST_NORMAL)) return false;
    if (B !== null) {
        const left = Math.min(smallest9(T[4], T[5], T[6], T[7], T[8], T[9], T[10], T[11], T[12]), mag(F[t + 1]), mag(F[t + 2]), mag(F[t + 3]));
        if (!(left * smallest12(B, m) >= SMALLEST_NORMAL)) return false;
    }
    return smallest12(W, o) * smallest12(F, v) >= SMALLEST_NORMAL;
}

/**
 * The walk with plain f32 rounding, bone by bone. A sum of two f32 values is the same in
 * both arithmetics; a product is unless it lands below the smallest normal f32, where the
 * x87 keeps 24 bits and f32 does not. While every nonzero factor is at least 2^-63 that
 * cannot happen; a bone with a smaller one is checked product group by product group, and
 * a bone that fails, overflows or meets a NaN is redone exactly. Returns the bones redone.
 */
function plainPass(src: DeformViews, p: WorldPosePlan): number {
    const F = src.f32, U = src.u32;
    const r = Math.fround;
    let redone = 0;
    const worldBase = (p.world >>> 2) - (p.first << 4);
    for (let i = 0; i < p.count; i++) {
        const b = (p.bones + i * BONE_STRIDE) >>> 2;
        const t = (p.local + i * LOCAL_STRIDE) >>> 2;
        const qx = F[t + 4], qy = F[t + 5], qz = F[t + 6], qw = F[t + 7];
        let tiny = 0;
        for (let k = 1; k < 8; k++) { const n = U[t + k] & 0x7fffffff; tiny |= ((n >>> 29) - 1) & -n; }
        const xx = r(qx * qx), yy = r(qy * qy), zz = r(qz * qz), xy = r(qy * qx);
        T[0] = r(qz * qx); T[1] = r(qz * qy); T[2] = r(qw * qx); T[3] = r(qy * qw);
        const xz = T[0], yz = T[1], wx = T[2], wy = T[3];
        const wz = r(qz * qw);
        let s = r(zz + yy); s = r(s + s); T[4] = r(1 - s);
        s = r(xy - wz); T[5] = r(s + s);
        s = r(wy + xz); T[6] = r(s + s);
        s = r(wz + xy); T[7] = r(s + s);
        s = r(zz + xx); s = r(s + s); T[8] = r(1 - s);
        s = r(yz - wx); T[9] = r(s + s);
        s = r(xz - wy); T[10] = r(s + s);
        s = r(wx + yz); T[11] = r(s + s);
        s = r(yy + xx); s = r(s + s); T[12] = r(1 - s);
        let a0 = T[4], a1 = T[5], a2 = T[6], a3 = T[7], a4 = T[8], a5 = T[9], a6 = T[10], a7 = T[11], a8 = T[12];
        const scaled = (U[t] & 4) !== 0;
        if (scaled) {
            for (let k = 4; k < 13; k++) { const n = TU[k] & 0x7fffffff; tiny |= ((n >>> 29) - 1) & -n; T[k + 12] = T[k]; }
            for (let k = 8; k < 17; k++) { const n = U[t + k] & 0x7fffffff; tiny |= ((n >>> 29) - 1) & -n; }
            const b0 = F[t + 8], b1 = F[t + 9], b2 = F[t + 10], b3 = F[t + 11], b4 = F[t + 12];
            const b5 = F[t + 13], b6 = F[t + 14], b7 = F[t + 15], b8 = F[t + 16];
            T[4] = r(r(r(a0 * b0) + r(a2 * b6)) + r(a1 * b3));
            T[5] = r(r(r(a1 * b4) + r(b1 * a0)) + r(a2 * b7));
            T[6] = r(r(r(a2 * b8) + r(a1 * b5)) + r(b2 * a0));
            T[7] = r(r(r(a5 * b6) + r(a4 * b3)) + r(a3 * b0));
            T[8] = r(r(r(a4 * b4) + r(a5 * b7)) + r(a3 * b1));
            T[9] = r(r(r(a5 * b8) + r(a3 * b2)) + r(a4 * b5));
            T[10] = r(r(r(b6 * a8) + r(a7 * b3)) + r(b0 * a6));
            T[11] = r(r(r(a7 * b4) + r(b7 * a8)) + r(b1 * a6));
            T[12] = r(r(r(b8 * a8) + r(b2 * a6)) + r(a7 * b5));
            a0 = T[4]; a1 = T[5]; a2 = T[6]; a3 = T[7]; a4 = T[8]; a5 = T[9]; a6 = T[10]; a7 = T[11]; a8 = T[12];
        }
        for (let k = 4; k < 13; k++) { const n = TU[k] & 0x7fffffff; tiny |= ((n >>> 29) - 1) & -n; }
        const t0 = a0, t1 = a3, t2 = a6, t4 = a1, t5 = a4, t6 = a7, t8 = a2, t9 = a5, t10 = a8;
        const t12 = F[t + 1], t13 = F[t + 2], t14 = F[t + 3];
        const o = i << 4;
        const parent = U[b + 1] | 0;
        let B: Float32Array | null = null;
        let m = 0;
        if (parent !== -1) {
            if (parent >= p.first) { B = W; m = (parent - p.first) << 4; } else { B = F; m = worldBase + (parent << 4); }
        } else if (p.offset !== 0) {
            B = F; m = p.offset >>> 2;
        }
        if (B === null) {
            W[o] = t0; W[o + 1] = t1; W[o + 2] = t2; W[o + 3] = 0;
            W[o + 4] = t4; W[o + 5] = t5; W[o + 6] = t6; W[o + 7] = 0;
            W[o + 8] = t8; W[o + 9] = t9; W[o + 10] = t10; W[o + 11] = 0;
            W[o + 12] = t12; W[o + 13] = t13; W[o + 14] = t14; W[o + 15] = 1;
        } else {
            const BU = B === W ? WU : U;
            for (let k = 0; k < 15; k++) { const n = BU[m + k] & 0x7fffffff; tiny |= ((n >>> 29) - 1) & -n; }
            const b0 = B[m], b1 = B[m + 1], b2 = B[m + 2], b4 = B[m + 4], b5 = B[m + 5], b6 = B[m + 6];
            const b8 = B[m + 8], b9 = B[m + 9], b10 = B[m + 10], b12 = B[m + 12], b13 = B[m + 13], b14 = B[m + 14];
            W[o] = r(r(r(t0 * b0) + r(t2 * b8)) + r(t1 * b4));
            W[o + 1] = r(r(r(t1 * b5) + r(b1 * t0)) + r(t2 * b9));
            W[o + 2] = r(r(r(t2 * b10) + r(t1 * b6)) + r(b2 * t0));
            W[o + 3] = 0;
            W[o + 4] = r(r(r(t6 * b8) + r(t5 * b4)) + r(t4 * b0));
            W[o + 5] = r(r(r(t5 * b5) + r(t6 * b9)) + r(t4 * b1));
            W[o + 6] = r(r(r(t6 * b10) + r(t4 * b2)) + r(t5 * b6));
            W[o + 7] = 0;
            W[o + 8] = r(r(r(b8 * t10) + r(t9 * b4)) + r(b0 * t8));
            W[o + 9] = r(r(r(t9 * b5) + r(b9 * t10)) + r(b1 * t8));
            W[o + 10] = r(r(r(b10 * t10) + r(b2 * t8)) + r(t9 * b6));
            W[o + 11] = 0;
            W[o + 12] = r(r(r(r(t14 * b8) + r(t12 * b0)) + r(b4 * t13)) + b12);
            W[o + 13] = r(r(r(r(t14 * b9) + r(t12 * b1)) + r(t13 * b5)) + b13);
            W[o + 14] = r(r(r(r(b6 * t13) + r(b10 * t14)) + r(b2 * t12)) + b14);
            W[o + 15] = 1;
        }
        const v = b + 19;
        const v0 = F[v], v1 = F[v + 1], v2 = F[v + 2], v4 = F[v + 4], v5 = F[v + 5], v6 = F[v + 6];
        const v8 = F[v + 8], v9 = F[v + 9], v10 = F[v + 10], v12 = F[v + 12], v13 = F[v + 13], v14 = F[v + 14];
        const w0 = W[o], w1 = W[o + 1], w2 = W[o + 2], w4 = W[o + 4], w5 = W[o + 5], w6 = W[o + 6];
        const w8 = W[o + 8], w9 = W[o + 9], w10 = W[o + 10], w12 = W[o + 12], w13 = W[o + 13], w14 = W[o + 14];
        for (let k = 0; k < 15; k++) { const n = U[v + k] & 0x7fffffff; tiny |= ((n >>> 29) - 1) & -n; const w = WU[o + k] & 0x7fffffff; tiny |= ((w >>> 29) - 1) & -w; }
        C[o] = r(r(r(v0 * w0) + r(v2 * w8)) + r(v1 * w4));
        C[o + 1] = r(r(r(v1 * w5) + r(w1 * v0)) + r(v2 * w9));
        C[o + 2] = r(r(r(v2 * w10) + r(v1 * w6)) + r(w2 * v0));
        C[o + 3] = 0;
        C[o + 4] = r(r(r(v6 * w8) + r(v5 * w4)) + r(v4 * w0));
        C[o + 5] = r(r(r(v5 * w5) + r(v6 * w9)) + r(v4 * w1));
        C[o + 6] = r(r(r(v6 * w10) + r(v4 * w2)) + r(v5 * w6));
        C[o + 7] = 0;
        C[o + 8] = r(r(r(w8 * v10) + r(v9 * w4)) + r(w0 * v8));
        C[o + 9] = r(r(r(v9 * w5) + r(w9 * v10)) + r(w1 * v8));
        C[o + 10] = r(r(r(w10 * v10) + r(w2 * v8)) + r(v9 * w6));
        C[o + 11] = 0;
        C[o + 12] = r(r(r(r(v14 * w8) + r(v12 * w0)) + r(w4 * v13)) + w12);
        C[o + 13] = r(r(r(r(v14 * w9) + r(v12 * w1)) + r(v13 * w5)) + w13);
        C[o + 14] = r(r(r(r(w6 * v13) + r(w10 * v14)) + r(w2 * v12)) + w14);
        C[o + 15] = 1;
        const sum = w0 + w1 + w2 + w4 + w5 + w6 + w8 + w9 + w10 + w12 + w13 + w14
            + C[o] + C[o + 1] + C[o + 2] + C[o + 4] + C[o + 5] + C[o + 6] + C[o + 8] + C[o + 9] + C[o + 10] + C[o + 12] + C[o + 13] + C[o + 14];
        if (sum * 0 !== 0 || (tiny < 0 && !productsNormal(F, t, v, o, scaled, B, m))) { exactBone(src, p, i); redone++; }
    }
    return redone;
}

/** Leaves both arrays in the result buffers and, when `out` is given, writes them through it. */
export function worldPoseKernel(src: DeformViews, out: DeformViews | null, p: WorldPosePlan): void {
    const redone = plainPass(src, p);
    if (redone === 0) deformCounters.worldPosePlain++;
    deformCounters.worldPoseExactBones += redone;
    const n = p.count << 4;
    if (out) {
        out.u32.set(WU.subarray(0, n), p.world >>> 2);
        out.u32.set(CU.subarray(0, n), p.composite >>> 2);
    }
    deformCounters.worldPoseCalls++;
    deformCounters.worldPoseBones += p.count;
}
