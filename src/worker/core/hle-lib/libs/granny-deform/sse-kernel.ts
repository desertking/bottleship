/**
 * Granny 2 software skinning, SSE variant of the four-bone position+normal kernel. The
 * deformer wrapper takes this one when the destination and the matrix array are both
 * 16-byte aligned, and the x87 one in kernel.ts otherwise.
 *
 *   void deform(i32 count, const u8* src, u8* dst, Frame* frame)   // cdecl
 *
 *   frame:      f32 scratch[8] | f32* matrices4x4 @ +0x20 | i32* matrixIndices @ +0x24
 *   src vertex: f32 P[3] | u8 W[4] | u8 I[4] | f32 N[3] | u32 T[2]     (0x28 bytes)
 *   dst vertex: f32 P[3] | f32 N[3] | u32 T[2]                         (0x20 bytes)
 *
 * Per bone k: m = matrices + (matrixIndices[I[k]] << 6), w = f32(W[k]) * C. Every lane is
 * one packed single-precision operation, in this order:
 *
 *   Pk = ((row3 + x*row0) + y*row1) + z*row2        Nk = (nx*row0 + ny*row1) + nz*row2
 *   A  = P0*w0 + P1*w1                              B  = P2*w2 + P3*w3
 *   P' = B + A
 *
 * The first pair's sums, all four lanes, are parked in frame.scratch between the pairs and
 * stay there after the last vertex.
 *
 * A bone with weight byte 0 contributes a signed zero when its matrix and the vertex are
 * finite, and a signed zero only matters where a result is itself zero. Such bones are
 * skipped, and a vertex whose skipped result has a zero lane is computed in full.
 */

import type { DeformViews } from './kernel';
import { deformCounters } from './kernel';

export const SSE_SRC_STRIDE = 0x28;
export const SSE_DST_STRIDE = 0x20;
export const SSE_SCRATCH_LEN = 0x20;
export const SSE_FRAME_MATRICES = 0x20;
export const SSE_FRAME_INDICES = 0x24;

const fround = Math.fround;
const SKIP_LIMIT = 2 ** 30;

const slotState = new Uint8Array(256);

function matrixBounded(F: Float32Array, m: number): boolean {
    if (m + 15 >= F.length) return false;
    for (let i = 0; i < 15; i++) {
        if ((i & 3) !== 3 && !(Math.abs(F[m + i]) < SKIP_LIMIT)) return false;
    }
    return true;
}

export interface SseDeformArgs {
    count: number;
    src: number;
    dst: number;
    frame: number;
}

export function decodeSseArgs(args: number[]): SseDeformArgs {
    return { count: args[0] | 0, src: args[1] >>> 0, dst: args[2] >>> 0, frame: args[3] >>> 0 };
}

/**
 * `out` receives the destination vertices at `dst + outDelta`; `scratch` receives the
 * frame's eight scratch floats. Returns EAX, the last vertex's fourth weight byte.
 */
export function deformKernelSse(
    src: DeformViews, out: DeformViews, outDelta: number, scratch: Float32Array,
    args: number[], scaleAddr: number,
): number {
    const a = decodeSseArgs(args);
    const F = src.f32, U = src.u32, B = src.u8;
    const OF = out.f32, OU = out.u32;
    const c = F[scaleAddr >>> 2];
    const matrices = U[(a.frame + SSE_FRAME_MATRICES) >>> 2];
    const indices = U[(a.frame + SSE_FRAME_INDICES) >>> 2] >>> 2;
    let s = a.src;
    let e = (a.dst + outDelta) >>> 2;
    const last = a.count - 1;
    const skipping = c > 0 && c < 1;
    let skipped = 0;
    slotState.fill(0);
    for (let v = 0; v <= last; v++, s += SSE_SRC_STRIDE, e += 8) {
        const o = s >>> 2;
        const x = F[o], y = F[o + 1], z = F[o + 2];
        const nx = F[o + 5], ny = F[o + 6], nz = F[o + 7];
        let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
        let fx = 0, fy = 0, fz = 0, gx = 0, gy = 0, gz = 0;
        const weights = U[o + 3];
        if (skipping && v !== last && ((weights - 0x01010101) & ~weights & 0x80808080) !== 0
            && Math.abs(x) < SKIP_LIMIT && Math.abs(y) < SKIP_LIMIT && Math.abs(z) < SKIP_LIMIT
            && Math.abs(nx) < SKIP_LIMIT && Math.abs(ny) < SKIP_LIMIT && Math.abs(nz) < SKIP_LIMIT) {
            let ok = true;
            for (let k = 0; k < 4; k++) {
                const slot = B[s + 0x10 + k];
                const m = ((matrices + (U[indices + slot] << 6)) >>> 0) >>> 2;
                let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
                const wb = B[s + 0x0c + k];
                if (wb === 0) {
                    if (slotState[slot] === 0) slotState[slot] = matrixBounded(F, m) ? 1 : 2;
                    if (slotState[slot] !== 1) { ok = false; break; }
                } else {
                    const w = fround(wb * c);
                    const m0 = F[m], m1 = F[m + 1], m2 = F[m + 2];
                    const m4 = F[m + 4], m5 = F[m + 5], m6 = F[m + 6];
                    const m8 = F[m + 8], m9 = F[m + 9], m10 = F[m + 10];
                    px = fround(fround(fround(fround(F[m + 12] + fround(x * m0)) + fround(y * m4)) + fround(z * m8)) * w);
                    py = fround(fround(fround(fround(F[m + 13] + fround(x * m1)) + fround(y * m5)) + fround(z * m9)) * w);
                    pz = fround(fround(fround(fround(F[m + 14] + fround(x * m2)) + fround(y * m6)) + fround(z * m10)) * w);
                    qx = fround(fround(fround(fround(nx * m0) + fround(ny * m4)) + fround(nz * m8)) * w);
                    qy = fround(fround(fround(fround(nx * m1) + fround(ny * m5)) + fround(nz * m9)) * w);
                    qz = fround(fround(fround(fround(nx * m2) + fround(ny * m6)) + fround(nz * m10)) * w);
                }
                if ((k & 1) === 0) {
                    ax = px; ay = py; az = pz; bx = qx; by = qy; bz = qz;
                } else {
                    ax = fround(ax + px); ay = fround(ay + py); az = fround(az + pz);
                    bx = fround(bx + qx); by = fround(by + qy); bz = fround(bz + qz);
                    if (k === 1) { fx = ax; fy = ay; fz = az; gx = bx; gy = by; gz = bz; }
                }
            }
            if (ok) {
                const rx = fround(ax + fx), ry = fround(ay + fy), rz = fround(az + fz);
                const sx = fround(bx + gx), sy = fround(by + gy), sz = fround(bz + gz);
                const all = rx * ry * rz * sx * sy * sz;
                if (all !== 0 && all === all) {
                    OF[e] = rx; OF[e + 1] = ry; OF[e + 2] = rz;
                    OF[e + 3] = sx; OF[e + 4] = sy; OF[e + 5] = sz;
                    OU[e + 6] = U[o + 8]; OU[e + 7] = U[o + 9];
                    skipped++;
                    continue;
                }
            }
        }
        for (let k = 0; k < 4; k++) {
            const m = ((matrices + (U[indices + B[s + 0x10 + k]] << 6)) >>> 0) >>> 2;
            const w = fround(B[s + 0x0c + k] * c);
            const m0 = F[m], m1 = F[m + 1], m2 = F[m + 2];
            const m4 = F[m + 4], m5 = F[m + 5], m6 = F[m + 6];
            const m8 = F[m + 8], m9 = F[m + 9], m10 = F[m + 10];
            const px = fround(fround(fround(fround(F[m + 12] + fround(x * m0)) + fround(y * m4)) + fround(z * m8)) * w);
            const py = fround(fround(fround(fround(F[m + 13] + fround(x * m1)) + fround(y * m5)) + fround(z * m9)) * w);
            const pz = fround(fround(fround(fround(F[m + 14] + fround(x * m2)) + fround(y * m6)) + fround(z * m10)) * w);
            const qx = fround(fround(fround(fround(nx * m0) + fround(ny * m4)) + fround(nz * m8)) * w);
            const qy = fround(fround(fround(fround(nx * m1) + fround(ny * m5)) + fround(nz * m9)) * w);
            const qz = fround(fround(fround(fround(nx * m2) + fround(ny * m6)) + fround(nz * m10)) * w);
            if ((k & 1) === 0) {
                ax = px; ay = py; az = pz; bx = qx; by = qy; bz = qz;
                if (v === last && k === 0) {
                    scratch[3] = fround(fround(fround(fround(F[m + 15] + fround(x * F[m + 3])) + fround(y * F[m + 7])) + fround(z * F[m + 11])) * w);
                    scratch[7] = fround(fround(fround(fround(nx * F[m + 3]) + fround(ny * F[m + 7])) + fround(nz * F[m + 11])) * w);
                }
                continue;
            }
            ax = fround(ax + px); ay = fround(ay + py); az = fround(az + pz);
            bx = fround(bx + qx); by = fround(by + qy); bz = fround(bz + qz);
            if (k === 1) {
                fx = ax; fy = ay; fz = az; gx = bx; gy = by; gz = bz;
                if (v === last) {
                    const pw = fround(fround(fround(fround(F[m + 15] + fround(x * F[m + 3])) + fround(y * F[m + 7])) + fround(z * F[m + 11])) * w);
                    const qw = fround(fround(fround(fround(nx * F[m + 3]) + fround(ny * F[m + 7])) + fround(nz * F[m + 11])) * w);
                    scratch[0] = fx; scratch[1] = fy; scratch[2] = fz; scratch[3] = fround(scratch[3] + pw);
                    scratch[4] = gx; scratch[5] = gy; scratch[6] = gz; scratch[7] = fround(scratch[7] + qw);
                }
            }
        }
        OF[e] = ax + fx; OF[e + 1] = ay + fy; OF[e + 2] = az + fz;
        OF[e + 3] = bx + gx; OF[e + 4] = by + gy; OF[e + 5] = bz + gz;
        OU[e + 6] = U[o + 8]; OU[e + 7] = U[o + 9];
    }
    deformCounters.calls++;
    deformCounters.sseCalls++;
    deformCounters.sseSkipVertices += skipped;
    deformCounters.vertices += a.count;
    return B[a.src + last * SSE_SRC_STRIDE + 0x0f];
}
