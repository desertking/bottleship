import { describe, expect, test } from "bun:test";
import { changedLockByteSpan } from "../../src/worker/backends/webgpu/d3d9/lock-byte-span";
import { VertexBufferStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

const SIZE = 128 * 1024;
function setup() {
    const store = new VertexBufferStore();
    const index = store.create(17, SIZE, 0, 1024);
    const device: any = Object.create(D3D9Device.prototype);
    device.vertexBuffers = store;
    device.vbLastLockFlags = new Map([[index, 0x1000]]);
    return { store, index, device };
}
function exact(a: Uint8Array, b: Uint8Array): [number, number] {
    let lo = 0, hi = a.length;
    while (lo < hi && a[lo] === b[lo]) lo++;
    while (hi > lo && a[hi - 1] === b[hi - 1]) hi--;
    return [lo, hi];
}

describe("exact bounded SIMD byte span", () => {
    test("arbitrary offsets, bit patterns, boundaries, equal and dense edits agree with a byte oracle", () => {
        let seed = 126782;
        const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
        for (let n = 0; n < 128; n++) {
            const size = n === 127 ? 524288 : 65536 + rnd() % 4096;
            const a = new Uint8Array(size + 7).subarray(3, size + 3);
            const b = new Uint8Array(size + 11).subarray(5, size + 5);
            for (let i = 0; i < size; i++) a[i] = rnd() & 255;
            b.set(a);
            if (n % 4) {
                b[n % 17] ^= 128; b[size - 1 - n % 17] ^= 1;
                if (n % 3 === 0) for (let i = 0; i < size; i++) b[i] ^= 255;
            }
            expect(changedLockByteSpan(a, b)).toEqual(exact(a, b));
        }
    });
    test("bounds leave short, oversized, and mismatched buffers on the full path", () => {
        for (const n of [0, 17, 65535, 524289]) expect(changedLockByteSpan(new Uint8Array(n), new Uint8Array(n))).toBeNull();
        expect(changedLockByteSpan(new Uint8Array(65536), new Uint8Array(65537))).toBeNull();
    });
    test("a single changed byte including sign-bit and NaN payload bytes is never omitted", () => {
        const a = new Uint8Array(SIZE).fill(255), b = a.slice();
        for (const p of [0, 1, 15, 16, 17, 65535, 65536, SIZE - 1]) {
            b[p] ^= 128;
            expect(changedLockByteSpan(a, b)).toEqual([p, p + 1]);
            b[p] ^= 128;
            expect(changedLockByteSpan(a, b)).toEqual([SIZE, SIZE]);
        }
    });
});

describe("split vertex lock deltas", () => {
    test("capture precedes shadow commit and returns a guest view at a relative offset", () => {
        const { store, index, device } = setup();
        store.lock(index, 64, SIZE - 64);
        const guest = new Uint8Array(SIZE - 64); guest[19] = 42; guest[67] = 99;
        const delta = device.captureLockedVertexDelta(17, guest);
        expect(delta.offset).toBe(19);
        expect(delta.bytes.buffer).toBe(guest.buffer);
        expect(delta.bytes).toEqual(guest.subarray(19, 68));
        device.unlockVertexBufferSpan(17, delta.offset, delta.bytes);
        expect(store.getData(index)!.subarray(64)).toEqual(guest);
        expect(store.lockedRange(index)).toBeNull();
    });
    test("DISCARD, plain, mixed DISCARD/NOOVERWRITE, invalid and unlocked handles use full transfer", () => {
        const { store, index, device } = setup();
        store.lock(index, 0, SIZE);
        for (const flags of [0, 0x2000, 0x3000]) {
            device.vbLastLockFlags.set(index, flags);
            expect(device.captureLockedVertexDelta(17, new Uint8Array(SIZE))).toBeNull();
        }
        expect(device.captureLockedVertexDelta(999, new Uint8Array(SIZE))).toBeNull();
        store.unlockFromBytes(index, new Uint8Array(SIZE));
        device.vbLastLockFlags.set(index, 0x1000);
        expect(device.captureLockedVertexDelta(17, new Uint8Array(SIZE))).toBeNull();
    });
    test("partial deltas union with earlier dirty ranges while preserving untouched shadow bytes", () => {
        const { store, index } = setup();
        store.getData(index)!.fill(31); store.setDirty(index, false);
        store.lock(index, 128, 65536);
        store.unlockSpanFromBytes(index, 10, new Uint8Array([4, 5]));
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([138, 140]);
        store.lock(index, 64, 65536);
        store.unlockSpanFromBytes(index, 20, new Uint8Array([6]));
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([84, 140]);
        expect([...store.getData(index)!.subarray(137, 141)]).toEqual([31, 4, 5, 31]);
        expect(store.takeLockedSinceUpload(index)).toBe(2 * 65536);
    });
    test("empty deltas consume each nested lock and do not dirty a clean shadow", () => {
        const { store, index } = setup(); store.setDirty(index, false);
        store.lock(index, 40, 65536); store.lock(index, 0, 65536);
        store.unlockSpanFromBytes(index, 65576, new Uint8Array());
        expect(store.lockedRange(index)).toEqual({ offset: 0, size: 65576 });
        expect(store.isDirty(index)).toBe(false);
        store.unlockSpanFromBytes(index, 0, new Uint8Array());
        expect(store.lockedRange(index)).toBeNull();
        expect(store.isDirty(index)).toBe(false);
    });
    test("initial upload and forced reset/rewind upload stay whole despite empty or small deltas", () => {
        const { store, index } = setup();
        store.lock(index, 128, 65536); store.unlockSpanFromBytes(index, 65536, new Uint8Array());
        expect(store.isDirty(index)).toBe(true);
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([0, SIZE]);
        store.setDirty(index, false); store.setGpuBuffer(index, { destroy() {} } as GPUBuffer);
        store.dropGpuResources();
        store.lock(index, 128, 65536); store.unlockSpanFromBytes(index, 5, new Uint8Array([2]));
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([0, SIZE]);
    });
    test("invalid span cannot partially commit or consume its lock", () => {
        const { store, index } = setup(); store.setDirty(index, false);
        store.lock(index, 0, 100);
        for (const offset of [-1, 100, NaN, 0.5]) expect(() => store.unlockSpanFromBytes(index, offset, new Uint8Array([1]))).toThrow();
        expect(store.lockedRange(index)).toEqual({ offset: 0, size: 100 });
        expect(store.isDirty(index)).toBe(false);
    });
    test("released and reused slots cannot inherit a prior lock or shadow", () => {
        const { store, index } = setup(); store.lock(index, 0, SIZE); store.release(17);
        expect(store.getIndex(17)).toBeNull();
        const next = store.create(18, 32, 0, 2048);
        expect(next).toBe(index); expect(store.lockedRange(next)).toBeNull();
        store.unlockSpanFromBytes(next, 0, new Uint8Array([99]));
        expect(store.getData(next)).toEqual(new Uint8Array(32));
        expect([store.getDirtyStart(next), store.getDirtyEnd(next)]).toEqual([0, 32]);
    });
});
