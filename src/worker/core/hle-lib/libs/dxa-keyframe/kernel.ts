/**
 * Keyframed vertex decompression of a mingw-built Direct3D 9 title (x87).
 *
 *   void calc_vertices(Mesh* mesh, Vertex* out)                         // cdecl
 *
 *   mesh:  +0x28 u32 time   +0x38 Anim* anim
 *   anim:  +0x04 u8* data   +0x08 u32 vertexCount   +0x10 f32 P[10]
 *          +0x5c Frame* begin   +0x60 Frame* end
 *   frame: +0x00 u32 time   +0x04 u8 blend   +0x08 u32 blendTime   +0x0c u8* data
 *          +0x10 f32 P[10]                                              // 56 bytes
 *   data:  u8 pos[3] | u8 normal[3] | u8 uv[2]                          // per vertex
 *   out:   f32 pos[3] | f32 normal[3] | f32 uv[2]                       // per vertex
 *
 * P is { pos min xyz, pos max xyz, uv min, uv max }. One set decodes as, every operation
 * one x87 result,
 *
 *   pos  = (((max - min) * b) * (1/255)) + min        normal = (b * (2/255)) - 1
 *
 * No frames: the anim's own set. Time at or before the first frame, at or after the last
 * one, or outside the last frame's blend window: one frame's set. Otherwise the bracketing
 * frames A (earlier) and B (later) are mixed with t = (B.time - time) / B.blendTime held on
 * the x87 stack and w = f32(1 - t):  out = decode(B) * w + decode(A) * t.
 */

import type { DeformViews } from '../granny-deform/kernel';
import { round24 } from '../granny-deform/kernel';

const fround = Math.fround;

export const FRAME_SIZE = 56;
export const MAX_VERTICES = 1 << 16;
export const MAX_FRAMES = 1 << 12;
export const C1 = fround(1 / 255);
export const C2 = fround(2 / 255);

export const keyframeCounters = {
    calls: 0,
    vertices: 0,
    blendCalls: 0,
    exactCalls: 0,
    reset(): void { this.calls = 0; this.vertices = 0; this.blendCalls = 0; this.exactCalls = 0; },
};

export interface KeyframePlan {
    out: number;
    count: number;
    a: number;
    dataA: number;
    b: number;
    dataB: number;
    num: number;
    den: number;
}

const plan: KeyframePlan = { out: 0, count: 0, a: 0, dataA: 0, b: 0, dataB: 0, num: 0, den: 0 };

/**
 * Which sets a call decodes: `a` is the address the ten parameters are read from (+0x10),
 * `b` the second set of a blended call or 0. Null when the header is not one this kernel
 * takes. The returned object is reused by the next call.
 */
export function keyframePlan(src: DeformViews, mesh: number, out: number): KeyframePlan | null {
    const U = src.u32;
    const size = src.u8.length;
    if (((mesh | out) & 3) !== 0 || mesh === 0 || mesh + 0x3c > size) return null;
    const anim = U[(mesh + 0x38) >>> 2];
    const time = U[(mesh + 0x28) >>> 2];
    if ((anim & 3) !== 0 || anim === 0 || anim + 0x64 > size) return null;
    const count = U[(anim + 8) >>> 2];
    if (count > MAX_VERTICES) return null;
    const begin = U[(anim + 0x5c) >>> 2], end = U[(anim + 0x60) >>> 2];
    plan.out = out; plan.count = count; plan.b = 0; plan.dataB = 0; plan.num = 0; plan.den = 0;
    if (end === begin) {
        plan.a = anim; plan.dataA = U[(anim + 4) >>> 2];
        return plan;
    }
    const span = end - begin;
    if (span < 0 || span % FRAME_SIZE !== 0 || span > MAX_FRAMES * FRAME_SIZE) return null;
    if ((begin & 3) !== 0 || begin === 0 || end > size) return null;
    let first = begin, last = end - FRAME_SIZE;
    let firstT = U[first >>> 2], lastT = U[last >>> 2];
    if (time <= firstT) {
        plan.a = first; plan.dataA = U[(first + 0xc) >>> 2];
        return plan;
    }
    if (time >= lastT) {
        plan.a = last; plan.dataA = U[(last + 0xc) >>> 2];
        return plan;
    }
    let n = ((last - first) / FRAME_SIZE) | 0;
    while (n > 1) {
        const range = (lastT - firstT) >>> 0;
        if (range === 0) return null;
        let q = Math.floor((Math.imul(time - firstT, n) >>> 0) / range) | 0;
        if (q <= 0) q = 1;
        else if (q >= n) q = n - 1;
        const cand = first + q * FRAME_SIZE;
        const candT = U[cand >>> 2];
        if (candT > time) {
            last = cand; lastT = candT; n = q;
        } else {
            first = cand; firstT = candT; n -= q;
        }
    }
    plan.a = first; plan.dataA = U[(first + 0xc) >>> 2];
    const den = U[(last + 8) >>> 2];
    if (src.u8[last + 4] !== 0 && ((lastT - den) >>> 0) < time && time < lastT) {
        plan.b = last; plan.dataB = U[(last + 0xc) >>> 2];
        plan.num = (lastT - time) >>> 0; plan.den = den;
    }
    return plan;
}

const F32_INF_BITS = 0x7f800000;
const PLAIN_LO_BITS = 0x3a800000;
const PLAIN_HI_BITS = 0x49800000;

/** All ten parameters of a set are finite. */
export function paramsFinite(src: DeformViews, set: number): boolean {
    const U = src.u32;
    const p = (set + 0x10) >>> 2;
    let wild = 0;
    for (let i = 0; i < 10; i++) wild |= F32_INF_BITS - 1 - (U[p + i] & 0x7fffffff);
    return wild >= 0;
}

/**
 * Every parameter is zero or within [2^-10, 2^20): a difference is zero or at least 2^-33,
 * a decoded value zero or at least 2^-64, a weighted one at least 2^-88 with a unit in the
 * last place of 2^-111, and so is their sum; nothing is subnormal and nothing overflows, so
 * rounding each result to f32 equals the x87 single-precision significand rounding.
 */
function paramsPlain(U: Uint32Array, set: number): boolean {
    const p = (set + 0x10) >>> 2;
    for (let i = 0; i < 10; i++) {
        const m = U[p + i] & 0x7fffffff;
        if (m !== 0 && (m < PLAIN_LO_BITS || m >= PLAIN_HI_BITS)) return false;
    }
    return true;
}

const normalTable = new Float32Array(256);
for (let b = 0; b < 256; b++) normalTable[b] = fround(fround(b * C2) - 1);

const scratch = new ArrayBuffer(MAX_VERTICES * 32);
const scratchF32 = new Float32Array(scratch);

/** The vertices of the last keyframeKernel call that was given no `out` view. */
export const keyframeResult = new Uint8Array(scratch);

function decodePlain(F: Float32Array, B: Uint8Array, O: Float32Array, o: number, p: KeyframePlan): void {
    const a = (p.a + 0x10) >>> 2;
    const x0 = F[a], y0 = F[a + 1], z0 = F[a + 2], u0 = F[a + 6], v0 = F[a + 7];
    const dx = fround(F[a + 3] - x0), dy = fround(F[a + 4] - y0), dz = fround(F[a + 5] - z0);
    const du = fround(F[a + 8] - u0), dv = fround(F[a + 9] - v0);
    let s = p.dataA;
    for (let i = 0; i < p.count; i++, s += 8, o += 8) {
        O[o] = fround(fround(fround(dx * B[s]) * C1) + x0);
        O[o + 1] = fround(fround(fround(dy * B[s + 1]) * C1) + y0);
        O[o + 2] = fround(fround(fround(dz * B[s + 2]) * C1) + z0);
        O[o + 3] = normalTable[B[s + 3]];
        O[o + 4] = normalTable[B[s + 4]];
        O[o + 5] = normalTable[B[s + 5]];
        O[o + 6] = fround(fround(fround(du * B[s + 6]) * C1) + u0);
        O[o + 7] = fround(fround(fround(dv * B[s + 7]) * C1) + v0);
    }
}

function decodeExact(F: Float32Array, B: Uint8Array, O: Float32Array, o: number, p: KeyframePlan): void {
    const a = (p.a + 0x10) >>> 2;
    const x0 = F[a], y0 = F[a + 1], z0 = F[a + 2], u0 = F[a + 6], v0 = F[a + 7];
    const dx = round24(F[a + 3] - x0), dy = round24(F[a + 4] - y0), dz = round24(F[a + 5] - z0);
    const du = round24(F[a + 8] - u0), dv = round24(F[a + 9] - v0);
    let s = p.dataA;
    for (let i = 0; i < p.count; i++, s += 8, o += 8) {
        O[o] = round24(round24(round24(dx * B[s]) * C1) + x0);
        O[o + 1] = round24(round24(round24(dy * B[s + 1]) * C1) + y0);
        O[o + 2] = round24(round24(round24(dz * B[s + 2]) * C1) + z0);
        O[o + 3] = normalTable[B[s + 3]];
        O[o + 4] = normalTable[B[s + 4]];
        O[o + 5] = normalTable[B[s + 5]];
        O[o + 6] = round24(round24(round24(du * B[s + 6]) * C1) + u0);
        O[o + 7] = round24(round24(round24(dv * B[s + 7]) * C1) + v0);
    }
}

function blendPlain(F: Float32Array, B: Uint8Array, O: Float32Array, o: number, p: KeyframePlan): void {
    const a = (p.a + 0x10) >>> 2, b = (p.b + 0x10) >>> 2;
    const ax0 = F[a], ay0 = F[a + 1], az0 = F[a + 2], au0 = F[a + 6], av0 = F[a + 7];
    const adx = fround(F[a + 3] - ax0), ady = fround(F[a + 4] - ay0), adz = fround(F[a + 5] - az0);
    const adu = fround(F[a + 8] - au0), adv = fround(F[a + 9] - av0);
    const bx0 = F[b], by0 = F[b + 1], bz0 = F[b + 2], bu0 = F[b + 6], bv0 = F[b + 7];
    const bdx = fround(F[b + 3] - bx0), bdy = fround(F[b + 4] - by0), bdz = fround(F[b + 5] - bz0);
    const bdu = fround(F[b + 8] - bu0), bdv = fround(F[b + 9] - bv0);
    const t = fround(p.num / p.den);
    const w = fround(1 - t);
    let s = p.dataA, r = p.dataB;
    for (let i = 0; i < p.count; i++, s += 8, r += 8, o += 8) {
        O[o] = fround(fround(fround(fround(fround(bdx * B[r]) * C1) + bx0) * w)
            + fround(fround(fround(fround(adx * B[s]) * C1) + ax0) * t));
        O[o + 1] = fround(fround(fround(fround(fround(bdy * B[r + 1]) * C1) + by0) * w)
            + fround(fround(fround(fround(ady * B[s + 1]) * C1) + ay0) * t));
        O[o + 2] = fround(fround(fround(fround(fround(bdz * B[r + 2]) * C1) + bz0) * w)
            + fround(fround(fround(fround(adz * B[s + 2]) * C1) + az0) * t));
        O[o + 3] = fround(fround(normalTable[B[r + 3]] * w) + fround(normalTable[B[s + 3]] * t));
        O[o + 4] = fround(fround(normalTable[B[r + 4]] * w) + fround(normalTable[B[s + 4]] * t));
        O[o + 5] = fround(fround(normalTable[B[r + 5]] * w) + fround(normalTable[B[s + 5]] * t));
        O[o + 6] = fround(fround(fround(fround(fround(bdu * B[r + 6]) * C1) + bu0) * w)
            + fround(fround(fround(fround(adu * B[s + 6]) * C1) + au0) * t));
        O[o + 7] = fround(fround(fround(fround(fround(bdv * B[r + 7]) * C1) + bv0) * w)
            + fround(fround(fround(fround(adv * B[s + 7]) * C1) + av0) * t));
    }
}

function blendExact(F: Float32Array, B: Uint8Array, O: Float32Array, o: number, p: KeyframePlan): void {
    const a = (p.a + 0x10) >>> 2, b = (p.b + 0x10) >>> 2;
    const ax0 = F[a], ay0 = F[a + 1], az0 = F[a + 2], au0 = F[a + 6], av0 = F[a + 7];
    const adx = round24(F[a + 3] - ax0), ady = round24(F[a + 4] - ay0), adz = round24(F[a + 5] - az0);
    const adu = round24(F[a + 8] - au0), adv = round24(F[a + 9] - av0);
    const bx0 = F[b], by0 = F[b + 1], bz0 = F[b + 2], bu0 = F[b + 6], bv0 = F[b + 7];
    const bdx = round24(F[b + 3] - bx0), bdy = round24(F[b + 4] - by0), bdz = round24(F[b + 5] - bz0);
    const bdu = round24(F[b + 8] - bu0), bdv = round24(F[b + 9] - bv0);
    const t = round24(p.num / p.den);
    const w = fround(round24(1 - t));
    let s = p.dataA, r = p.dataB;
    for (let i = 0; i < p.count; i++, s += 8, r += 8, o += 8) {
        O[o] = round24(round24(round24(round24(round24(bdx * B[r]) * C1) + bx0) * w)
            + round24(round24(round24(round24(adx * B[s]) * C1) + ax0) * t));
        O[o + 1] = round24(round24(round24(round24(round24(bdy * B[r + 1]) * C1) + by0) * w)
            + round24(round24(round24(round24(ady * B[s + 1]) * C1) + ay0) * t));
        O[o + 2] = round24(round24(round24(round24(round24(bdz * B[r + 2]) * C1) + bz0) * w)
            + round24(round24(round24(round24(adz * B[s + 2]) * C1) + az0) * t));
        O[o + 3] = round24(round24(normalTable[B[r + 3]] * w) + round24(normalTable[B[s + 3]] * t));
        O[o + 4] = round24(round24(normalTable[B[r + 4]] * w) + round24(normalTable[B[s + 4]] * t));
        O[o + 5] = round24(round24(normalTable[B[r + 5]] * w) + round24(normalTable[B[s + 5]] * t));
        O[o + 6] = round24(round24(round24(round24(round24(bdu * B[r + 6]) * C1) + bu0) * w)
            + round24(round24(round24(round24(adu * B[s + 6]) * C1) + au0) * t));
        O[o + 7] = round24(round24(round24(round24(round24(bdv * B[r + 7]) * C1) + bv0) * w)
            + round24(round24(round24(round24(adv * B[s + 7]) * C1) + av0) * t));
    }
}

/** Decodes into `out`'s memory, or into keyframeResult when `out` is null. */
export function keyframeKernel(src: DeformViews, out: DeformViews | null, p: KeyframePlan): void {
    const O = out ? out.f32 : scratchF32;
    const o = out ? p.out >>> 2 : 0;
    const plain = paramsPlain(src.u32, p.a) && (p.b === 0 || paramsPlain(src.u32, p.b));
    if (p.b === 0) (plain ? decodePlain : decodeExact)(src.f32, src.u8, O, o, p);
    else (plain ? blendPlain : blendExact)(src.f32, src.u8, O, o, p);
    keyframeCounters.calls++;
    keyframeCounters.vertices += p.count;
    if (p.b !== 0) keyframeCounters.blendCalls++;
    if (!plain) keyframeCounters.exactCalls++;
}
