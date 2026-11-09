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

export const AABB_INPUT_LIMIT = 1e18;

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

const bound = (v: number): boolean => v > -AABB_INPUT_LIMIT && v < AABB_INPUT_LIMIT;

/** Every input is finite and small enough that no intermediate can overflow an f32. */
export function aabbInputsPlain(src: DeformViews, a: AabbArgs): boolean {
    const F = src.f32;
    const t = a.t >>> 2, m = a.m >>> 2, lo = a.min >>> 2, hi = a.max >>> 2;
    for (let i = 0; i < 3; i++) {
        if (!bound(F[t + i]) || !bound(F[lo + i]) || !bound(F[hi + i])) return false;
    }
    for (let i = 0; i < 9; i++) {
        if (!bound(F[m + i])) return false;
    }
    return true;
}

const corner = new Float32Array(6);
const box = new Float32Array(6);
const boxBits = new Uint32Array(box.buffer);

/** The new min (bytes 0..11) and max (bytes 12..23) of the last aabbKernel call. */
export const aabbResult = new Uint8Array(box.buffer);

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
    for (let k = 0; k < 2; k++) {
        const z = corner[2 + 3 * k];
        const zm2 = round24(z * m2), zm5 = round24(z * m5), zm8 = round24(z * m8);
        for (let j = 0; j < 2; j++) {
            const y = corner[1 + 3 * j];
            const ym1 = round24(y * m1), ym4 = round24(y * m4), ym7 = round24(y * m7);
            const zy = round24(zm2 + ym1);
            for (let i = 0; i < 2; i++) {
                const x = corner[3 * i];
                const vx = fround(round24(fround(round24(zy + round24(x * m0))) + t0));
                const vy = fround(round24(fround(round24(round24(round24(x * m3) + zm5) + ym4)) + t1));
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
    if (out) {
        const O = out.u32;
        const lo = a.min >>> 2, hi = a.max >>> 2;
        O[lo] = boxBits[0]; O[lo + 1] = boxBits[1]; O[lo + 2] = boxBits[2];
        O[hi] = boxBits[3]; O[hi + 1] = boxBits[4]; O[hi + 2] = boxBits[5];
    }
    deformCounters.aabbCalls++;
    return boxBits[3];
}
