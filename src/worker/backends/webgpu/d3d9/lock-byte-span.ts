import { LOCK_SPAN_SIMD } from "./lock-byte-span-simd";

const HALF = 512 * 1024;
type Kernel = { memory: WebAssembly.Memory; prefix(a: number, b: number, n: number): number; suffix(a: number, b: number, n: number): number };
// Both input spans are overwritten before every scan; no guest pointers or earlier contents.
// @transient(Fixed 1 MiB worker scratch with no session-dependent contents or resource history)
let scratch: { api: Kernel; bytes: Uint8Array } | false | undefined;

/** Exact unequal byte span, never a hash. The fixed arena bounds retained memory to 1 MiB
 * per worker, independent of resource count, resets, and games. Small/oversized locks and
 * engines without SIMD retain the original full transfer. Calls are synchronous and cannot
 * interleave; neither input is retained. Both staging copies are part of the measured cost. */
export function changedLockByteSpan(a: Uint8Array, b: Uint8Array): [number, number] | null {
    if (a.length < 64 * 1024 || a.length > HALF || a.length !== b.length) return null;
    if (scratch === undefined) {
        try {
            const api = new WebAssembly.Instance(new WebAssembly.Module(LOCK_SPAN_SIMD)).exports as unknown as Kernel;
            scratch = { api, bytes: new Uint8Array(api.memory.buffer) };
        } catch { scratch = false; }
    }
    if (!scratch) return null;
    const { api, bytes } = scratch;
    bytes.set(a, 0);
    bytes.set(b, HALF);
    const first = api.prefix(0, HALF, a.length);
    const last = first + api.suffix(first, HALF + first, a.length - first);
    return [first, last];
}
