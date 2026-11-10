/**
 * Granny 2 bounding-box transform (x87). Runs once per bone bound per frame in a title
 * that culls its skinned meshes on the CPU.
 *
 *   void transform(const f32 t[3], const f32 m[9], f32 min[3], f32 max[3])   // cdecl
 *
 * For each of the eight corners, z outermost, x innermost, every operation one x87 result:
 *
 *   X = f32((z*m2 + y*m1) + x*m0) + t0        Y = f32((x*m3 + z*m5) + y*m4) + t1
 *   Z = ((x*m6 + y*m7) + z*m8) + t2
 *
 * each stored as f32, then per component  lo = lo < v ? lo : v,  hi = hi > v ? hi : v,
 * starting from lo = FLT_MAX, hi = -FLT_MAX. min and max are written only after the last
 * corner. EAX returns the bits of the new max[0].
 */

import type { DeformViews } from './kernel';
import { deformCounters, round24 } from './kernel';

const fround = Math.fround;
const FLT_MAX = fround(3.4028234663852886e38);

export interface AabbArgs {
    t: number;
    m: number;
    min: number;
    max: number;
}

export function decodeAabbArgs(args: number[]): AabbArgs {
    return { t: args[0] >>> 0, m: args[1] >>> 0, min: args[2] >>> 0, max: args[3] >>> 0 };
}

const F32_INF_BITS = 0x7f800000;
const PLAIN_LIMIT_BITS = 0x5d5e0b6b;

/** Every input is finite. */
export function aabbInputsFinite(src: DeformViews, a: AabbArgs): boolean {
    const U = src.u32;
    const t = a.t >>> 2, m = a.m >>> 2, lo = a.min >>> 2, hi = a.max >>> 2;
    let wild = 0;
    for (let i = 0; i < 3; i++) {
        wild |= F32_INF_BITS - 1 - (U[t + i] & 0x7fffffff);
        wild |= F32_INF_BITS - 1 - (U[lo + i] & 0x7fffffff);
        wild |= F32_INF_BITS - 1 - (U[hi + i] & 0x7fffffff);
    }
    for (let i = 0; i < 9; i++) wild |= F32_INF_BITS - 1 - (U[m + i] & 0x7fffffff);
    return wild >= 0;
}

/**
 * Every input is zero or within [2^-63, 1e18): no product is subnormal and nothing overflows,
 * so rounding each result to f32 equals the x87 single-precision significand rounding.
 */
function inputsPlain(U: Uint32Array, t: number, m: number, lo: number, hi: number): boolean {
    let bad = 0;
    for (let i = 0; i < 3; i++) {
        const a = U[t + i] & 0x7fffffff, b = U[lo + i] & 0x7fffffff, c = U[hi + i] & 0x7fffffff;
        bad |= (PLAIN_LIMIT_BITS - 1 - a) | (((a >>> 29) - 1) & -a);
        bad |= (PLAIN_LIMIT_BITS - 1 - b) | (((b >>> 29) - 1) & -b);
        bad |= (PLAIN_LIMIT_BITS - 1 - c) | (((c >>> 29) - 1) & -c);
    }
    for (let i = 0; i < 9; i++) {
        const a = U[m + i] & 0x7fffffff;
        bad |= (PLAIN_LIMIT_BITS - 1 - a) | (((a >>> 29) - 1) & -a);
    }
    return bad >= 0;
}

const corner = new Float32Array(6);
const box = new Float32Array(6);
const boxBits = new Uint32Array(box.buffer);

/** The new min (bytes 0..11) and max (bytes 12..23) of the last aabbKernel call. */
export const aabbResult = new Uint8Array(box.buffer);

let variant = 0;

export function setAabbVariant(v: number): void {
    variant = v;
}

export function aabbVariant(): number {
    return variant;
}

function plainBoxB(
    t0: number, t1: number, t2: number,
    m0: number, m1: number, m2: number, m3: number, m4: number, m5: number, m6: number, m7: number, m8: number,
): void {
    let lx = FLT_MAX, ly = FLT_MAX, lz = FLT_MAX, hx = -FLT_MAX, hy = -FLT_MAX, hz = -FLT_MAX;
    for (let k = 0; k < 2; k++) {
        const z = corner[2 + 3 * k];
        const zm2 = fround(z * m2), zm5 = fround(z * m5), zm8 = fround(z * m8);
        for (let j = 0; j < 2; j++) {
            const y = corner[1 + 3 * j];
            const ym1 = fround(y * m1), ym4 = fround(y * m4), ym7 = fround(y * m7);
            const zy = fround(zm2 + ym1), zy4 = fround(zm5 + ym4);
            for (let i = 0; i < 2; i++) {
                const x = corner[3 * i];
                const vx = fround(fround(zy + fround(x * m0)) + t0);
                const vy = fround(fround(zy4 + fround(x * m3)) + t1);
                const vz = fround(fround(fround(fround(x * m6) + ym7) + zm8) + t2);
                if (!(lx < vx)) lx = vx;
                if (!(hx > vx)) hx = vx;
                if (!(ly < vy)) ly = vy;
                if (!(hy > vy)) hy = vy;
                if (!(lz < vz)) lz = vz;
                if (!(hz > vz)) hz = vz;
            }
        }
    }
    box[0] = lx; box[1] = ly; box[2] = lz; box[3] = hx; box[4] = hy; box[5] = hz;
}

function plainBox(
    t0: number, t1: number, t2: number,
    m0: number, m1: number, m2: number, m3: number, m4: number, m5: number, m6: number, m7: number, m8: number,
): void {
    let lx = FLT_MAX, ly = FLT_MAX, lz = FLT_MAX, hx = -FLT_MAX, hy = -FLT_MAX, hz = -FLT_MAX;
    for (let k = 0; k < 2; k++) {
        const z = corner[2 + 3 * k];
        const zm2 = fround(z * m2), zm5 = fround(z * m5), zm8 = fround(z * m8);
        for (let j = 0; j < 2; j++) {
            const y = corner[1 + 3 * j];
            const ym1 = fround(y * m1), ym4 = fround(y * m4), ym7 = fround(y * m7);
            const zy = fround(zm2 + ym1);
            for (let i = 0; i < 2; i++) {
                const x = corner[3 * i];
                const vx = fround(fround(zy + fround(x * m0)) + t0);
                const vy = fround(fround(fround(fround(x * m3) + zm5) + ym4) + t1);
                const vz = fround(fround(fround(fround(x * m6) + ym7) + zm8) + t2);
                if (!(lx < vx)) lx = vx;
                if (!(hx > vx)) hx = vx;
                if (!(ly < vy)) ly = vy;
                if (!(hy > vy)) hy = vy;
                if (!(lz < vz)) lz = vz;
                if (!(hz > vz)) hz = vz;
            }
        }
    }
    box[0] = lx; box[1] = ly; box[2] = lz; box[3] = hx; box[4] = hy; box[5] = hz;
}

/** Leaves the box in aabbResult, or writes it through `out` when given. Returns EAX. */
export function aabbKernel(src: DeformViews, out: DeformViews | null, args: number[]): number {
    const a = decodeAabbArgs(args);
    const F = src.f32;
    const t = a.t >>> 2, m = a.m >>> 2;
    const t0 = F[t], t1 = F[t + 1], t2 = F[t + 2];
    const m0 = F[m], m1 = F[m + 1], m2 = F[m + 2];
    const m3 = F[m + 3], m4 = F[m + 4], m5 = F[m + 5];
    const m6 = F[m + 6], m7 = F[m + 7], m8 = F[m + 8];
    corner[0] = F[a.min >>> 2]; corner[1] = F[(a.min >>> 2) + 1]; corner[2] = F[(a.min >>> 2) + 2];
    corner[3] = F[a.max >>> 2]; corner[4] = F[(a.max >>> 2) + 1]; corner[5] = F[(a.max >>> 2) + 2];
    box[0] = FLT_MAX; box[1] = FLT_MAX; box[2] = FLT_MAX;
    box[3] = -FLT_MAX; box[4] = -FLT_MAX; box[5] = -FLT_MAX;
    if (inputsPlain(src.u32, t, m, a.min >>> 2, a.max >>> 2)) {
        deformCounters.aabbPlain++;
        if (variant === 1) plainBoxB(t0, t1, t2, m0, m1, m2, m3, m4, m5, m6, m7, m8);
        else plainBox(t0, t1, t2, m0, m1, m2, m3, m4, m5, m6, m7, m8);
    } else {
        for (let k = 0; k < 2; k++) {
            const z = corner[2 + 3 * k];
            const zm2 = round24(z * m2), zm5 = round24(z * m5), zm8 = round24(z * m8);
            for (let j = 0; j < 2; j++) {
                const y = corner[1 + 3 * j];
                const ym1 = round24(y * m1), ym4 = round24(y * m4), ym7 = round24(y * m7);
                const zy = round24(zm2 + ym1);
                const zy4 = variant === 1 ? round24(zm5 + ym4) : 0;
                for (let i = 0; i < 2; i++) {
                    const x = corner[3 * i];
                    const vx = fround(round24(fround(round24(zy + round24(x * m0))) + t0));
                    const vy = variant === 1
                        ? fround(round24(fround(round24(zy4 + round24(x * m3))) + t1))
                        : fround(round24(fround(round24(round24(round24(x * m3) + zm5) + ym4)) + t1));
                    const vz = fround(round24(round24(round24(round24(x * m6) + ym7) + zm8) + t2));
                    if (!(box[0] < vx)) box[0] = vx;
                    if (!(box[3] > vx)) box[3] = vx;
                    if (!(box[1] < vy)) box[1] = vy;
                    if (!(box[4] > vy)) box[4] = vy;
                    if (!(box[2] < vz)) box[2] = vz;
                    if (!(box[5] > vz)) box[5] = vz;
                }
            }
        }
    }
    if (out) {
        const O = out.u32;
        const lo = a.min >>> 2, hi = a.max >>> 2;
        O[lo] = boxBits[0]; O[lo + 1] = boxBits[1]; O[lo + 2] = boxBits[2];
        O[hi] = boxBits[3]; O[hi + 1] = boxBits[4]; O[hi + 2] = boxBits[5];
    }
    deformCounters.aabbCalls++;
    return variant === 1 ? boxBits[2] : boxBits[3];
}
