import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { MemoryGuard } from "../../src/worker/core/memory/mem-guard";

const OFFSET = 0x4000;
const THUNK_BASE = 0x8000;
const THUNK_SIZE = 0x1000;

let saved: unknown;
let guest: Uint8Array;

beforeEach(() => {
    const system = System.getInstance() as any;
    saved = system.process;
    guest = new Uint8Array(new ArrayBuffer(OFFSET + 0x10000), OFFSET, 0x10000);
    system.process = {
        getCurrentMemory: () => guest,
        thunkMemoryManager: { getRegions: () => ({ thunkGeneratorBase: THUNK_BASE, thunkGeneratorSize: THUNK_SIZE }) },
    };
});

afterEach(() => {
    (System.getInstance() as any).process = saved;
});

test("a guest view placed inside a larger buffer is checked by guest address", () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    expect(MemoryGuard.writeBytes(guest, THUNK_BASE - OFFSET, bytes, "test")).toBe(4);
    expect([...guest.subarray(THUNK_BASE - OFFSET, THUNK_BASE - OFFSET + 4)]).toEqual([1, 2, 3, 4]);
});

test("a write into the thunk region is still refused", () => {
    expect(MemoryGuard.writeBytes(guest, THUNK_BASE + 0x10, Uint8Array.of(9), "test")).toBe(0);
    expect(guest[THUNK_BASE + 0x10]).toBe(0);
});
