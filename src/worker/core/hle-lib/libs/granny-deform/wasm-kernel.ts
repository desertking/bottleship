/**
 * The skinning kernels as a WASM SIMD module running directly on guest memory
 * (tools/build-granny-kernel/lib.rs). The module imports the v86 memory, so nothing is
 * copied; it has no data, globals or stack of its own. Results are bit-identical to
 * kernel.ts / sse-kernel.ts, which stay the fallback whenever the module is absent, the
 * memory identity changed, or a call falls outside what the module handles.
 */

import type { ShadowView } from '../../types';
import {
    decodeArgs, deformCounters, deformVertex, dstStride, round24, srcStride,
    WEIGHT_SCALE_HI, WEIGHT_SCALE_LO,
} from './kernel';
import type { DeformViews } from './kernel';
import {
    decodeSseArgs, deformKernelSse, SSE_DST_STRIDE, SSE_FRAME_INDICES, SSE_FRAME_MATRICES, SSE_SRC_STRIDE,
} from './sse-kernel';

export const GRANNY_KERNEL_URL = '/granny-kernel.wasm';

const INDEX_TABLE_BYTES = 4 * 256;

interface AccelExports {
    deform_x87(base: number, limit: number, count: number, src: number, dst: number,
        indices: number, matrices: number, tail: number, c: number): number;
    deform_sse(base: number, limit: number, count: number, src: number, dst: number,
        frame: number, c: number): number;
}

export interface DeformAccel {
    memory: WebAssembly.Memory;
    api: AccelExports;
}

export const accelCounters = { x87Calls: 0, sseCalls: 0, declined: 0 };

let current: DeformAccel | null = null;
let loading: WebAssembly.Memory | null = null;
let failure: string | null = null;

export function instantiateDeformAccel(bytes: BufferSource, memory: WebAssembly.Memory): DeformAccel {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } });
    const api = instance.exports as unknown as AccelExports;
    if (typeof api.deform_x87 !== 'function' || typeof api.deform_sse !== 'function') {
        throw new Error('granny kernel: unexpected WASM ABI');
    }
    return { memory, api };
}

export function setDeformAccel(accel: DeformAccel | null): void {
    current = accel;
}

/** The module, when it is bound to the memory `mem` is a view of. */
export function deformAccelFor(mem: Uint8Array): DeformAccel | null {
    return current !== null && current.memory.buffer === mem.buffer ? current : null;
}

export function deformAccelState(): { ready: boolean; failure: string | null } & typeof accelCounters {
    return { ready: current !== null, failure, ...accelCounters };
}

/** Idempotent per memory object; a failure leaves the JS kernels in charge. */
export function loadDeformAccel(memory: WebAssembly.Memory | null | undefined, request: typeof fetch = fetch): void {
    if (!memory || typeof WebAssembly === 'undefined') return;
    if (current?.memory === memory || loading === memory) return;
    current = null;
    loading = memory;
    (async () => {
        const response = await request(GRANNY_KERNEL_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const accel = instantiateDeformAccel(await response.arrayBuffer(), memory);
        if (loading === memory) { current = accel; failure = null; }
    })().catch((error) => { failure = String(error); }).finally(() => { if (loading === memory) loading = null; });
}

export function resetDeformAccel(): void {
    current = null;
    loading = null;
    accelCounters.x87Calls = 0; accelCounters.sseCalls = 0; accelCounters.declined = 0;
}

/**
 * x87 variant in place on live memory. `view` must write to that same memory; it serves
 * the vertices outside the plain bound. Returns null when the call is not the module's.
 */
export function deformX87Accel(
    accel: DeformAccel, view: ShadowView, live: DeformViews, args: number[], scaleAddr: number,
): number | null {
    const a = decodeArgs(args);
    if (a.count <= 0) return a.dst;
    if (((a.src | a.dst | a.matrixIndices | a.matrices | scaleAddr) & 3) !== 0 || a.tail < 0) return null;
    const limit = live.f32.length * 4;
    const sStride = srcStride(a.tail);
    const dStride = dstStride(a.tail);
    if (scaleAddr + 4 > limit || a.src + a.count * sStride > limit || a.dst + a.count * dStride > limit
        || a.matrixIndices + INDEX_TABLE_BYTES > limit) {
        accelCounters.declined++;
        return null;
    }
    const c = live.f32[scaleAddr >>> 2];
    if (!(c >= WEIGHT_SCALE_LO && c <= WEIGHT_SCALE_HI)) return null;
    const census = (globalThis as { __grannyDeformCensus?: number[] }).__grannyDeformCensus;
    if (census) {
        const u8 = live.u8;
        for (let i = 0, w = a.src + 12; i < a.count; i++, w += sStride) {
            census[(u8[w] !== 0 ? 1 : 0) + (u8[w + 1] !== 0 ? 1 : 0) + (u8[w + 2] !== 0 ? 1 : 0) + (u8[w + 3] !== 0 ? 1 : 0)]++;
        }
    }
    const base = live.u8.byteOffset;
    let done = 0;
    let exactCount = 0;
    while (done < a.count) {
        const s = a.src + done * sStride;
        const d = a.dst + done * dStride;
        done += accel.api.deform_x87(base, limit, a.count - done, s, d, a.matrixIndices, a.matrices, a.tail, c);
        if (done < a.count) {
            deformVertex(view, a, a.src + done * sStride, a.dst + done * dStride, c, round24);
            exactCount++;
            done++;
        }
    }
    accelCounters.x87Calls++;
    deformCounters.calls++;
    deformCounters.vertices += a.count;
    deformCounters.exactVertices += exactCount;
    return (a.dst + a.count * dStride) >>> 0;
}

/** SSE variant in place on live memory, frame scratch included. */
export function deformSseAccel(accel: DeformAccel, live: DeformViews, args: number[], scaleAddr: number): number | null {
    const a = decodeSseArgs(args);
    if (a.count <= 0 || ((a.src | a.dst | a.frame | scaleAddr) & 3) !== 0) return null;
    const limit = live.f32.length * 4;
    if (scaleAddr + 4 > limit || a.frame + SSE_FRAME_INDICES + 4 > limit
        || a.src + a.count * SSE_SRC_STRIDE > limit || a.dst + a.count * SSE_DST_STRIDE > limit) {
        accelCounters.declined++;
        return null;
    }
    const matrices = live.u32[(a.frame + SSE_FRAME_MATRICES) >>> 2];
    const indices = live.u32[(a.frame + SSE_FRAME_INDICES) >>> 2];
    if (((matrices | indices) & 3) !== 0 || indices + INDEX_TABLE_BYTES > limit) {
        accelCounters.declined++;
        return null;
    }
    const done = accel.api.deform_sse(live.u8.byteOffset, limit, a.count, a.src, a.dst, a.frame, live.f32[scaleAddr >>> 2]);
    accelCounters.sseCalls++;
    if (done < a.count) {
        const rest = [a.count - done, a.src + done * SSE_SRC_STRIDE, a.dst + done * SSE_DST_STRIDE, a.frame];
        const eax = deformKernelSse(live, live, 0, live.f32.subarray(a.frame >>> 2, (a.frame >>> 2) + 8), rest, scaleAddr);
        deformCounters.vertices += done;
        return eax;
    }
    deformCounters.calls++;
    deformCounters.sseCalls++;
    deformCounters.vertices += a.count;
    return live.u8[a.src + (a.count - 1) * SSE_SRC_STRIDE + 0x0f];
}
