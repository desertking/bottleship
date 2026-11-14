import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { netapi32Module } from "../../src/worker/api/netapi32.api";
import { Netapi32 } from "../../src/worker/modules/netapi32";

test("NetStatisticsGet has a five-argument stdcall return", () => {
    const registry = APIRegistry.getInstance();
    registry.registerModule(netapi32Module);
    expect(registry.getArgCount("netapi32", "NetStatisticsGet")).toBe(5);
    expect(registry.getStackCleanupBytes("netapi32", "NetStatisticsGet")).toBe(20);
});

test("statistics callers take the failure path without consuming or allocating a buffer", () => {
    const mod = new Netapi32();
    mod.initialize({ memory: {
        alloc: () => { throw new Error("statistics failure must not allocate"); },
        free: () => { throw new Error("statistics failure owns no buffer"); },
    } } as any);
    const mem = new Uint8Array(256), view = new DataView(mem.buffer);
    for (let i = 0; i < 50; i++) {
        view.setUint32(128, 0xdeadbeef, true);
        const status = mod.exports.NetStatisticsGet!({} as any, mem, [0, 32, 0, 0, 128]);
        expect(status).toBe(50);
        expect(status === 0).toBe(false); // the caller must not dereference the output
        expect(view.getUint32(128, true)).toBe(0xdeadbeef);
    }
    mod.reset();
    expect(mod.exports.NetStatisticsGet!({} as any, mem, [0, 0, 0, 0, 0])).toBe(50);
});
