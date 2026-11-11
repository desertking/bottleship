import { afterEach, describe, expect, test } from "bun:test";
import { aotCache } from "../../src/worker/core/cpu/aot-cache";

const PAGE = 4096;

async function sha(bytes: Uint8Array): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const MODULE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);

function install(mem: Uint8Array) {
    const calls: string[] = [];
    const wasm: Record<string, (...a: number[]) => number> = {
        jit_config_abi_version: () => 4,
        jit_config_supported_mask: () => 0xff,
        jit_codegen_fingerprint_lo: () => 1,
        jit_codegen_fingerprint_hi: () => 2,
        get_mem8_base: () => 0,
        jit_aot_tx_begin: () => { calls.push("begin"); return 0; },
        jit_aot_tx_page_begin: () => 0,
        jit_aot_tx_entry_push: () => 0,
        jit_aot_tx_page_finish: () => 0,
        jit_aot_tx_prepare_finish: () => 0,
        jit_aot_tx_commit: () => { calls.push("commit"); return 0; },
        jit_aot_tx_abort: () => 0,
        jit_aot_flush_tlb: () => 0,
    };
    const table = { set: () => undefined, get: () => null };
    const cpu = { mem8: mem, memory_size: new Uint32Array([mem.length]), wm: { wasm_table: table }, jit_imports: {} };
    (globalThis as any).System = { getInstance: () => ({ process: { v86: { cpu } } }) };
    (globalThis as any).preemption = { getWasmExports: () => wasm };
    (globalThis as any).__v86EngineLoad = { sha256: "e", error: null };
    (aotCache as any).engineSha = null;
    aotCache.clear();
    return calls;
}

afterEach(() => {
    delete (globalThis as any).__v86EngineLoad;
    delete (globalThis as any).__aotNoRetry;
    aotCache.clear();
});

async function boot(mem: Uint8Array, later: Uint8Array): Promise<void> {
    const version = await aotCache.version();
    (aotCache as any).units = [{
        entryPage: 1, tableIndex: 5, bytes: MODULE,
        pages: [{ physPage: 1, stateFlags: 0, entries: [[0, 0]], sha: await sha(later) }],
    }];
    (aotCache as any).loadedVersion = version;
    const r = await aotCache.replay();
    expect(r.registered).toBe(0);
    expect(r.refused["content-mismatch"]).toBe(1);
}

describe("AOT late publish", () => {
    test("a unit whose page arrives after boot is published once it matches", async () => {
        const mem = new Uint8Array(PAGE * 4);
        const calls = install(mem);
        const later = new Uint8Array(PAGE).fill(0x90);
        await boot(mem, later);
        expect(aotCache.pendingRetries()).toBe(1);
        mem.set(later, PAGE);
        await (aotCache as any).retryPending();
        expect(calls).toEqual(["begin", "commit"]);
        expect(aotCache.pendingRetries()).toBe(0);
        expect(aotCache.retryStats.published).toBeGreaterThanOrEqual(1);
    });

    test("a page that still differs stays pending and is not published", async () => {
        const mem = new Uint8Array(PAGE * 4);
        const calls = install(mem);
        await boot(mem, new Uint8Array(PAGE).fill(0x90));
        await (aotCache as any).retryPending();
        expect(calls).toEqual([]);
        expect(aotCache.pendingRetries()).toBe(1);
    });

    test("__aotNoRetry keeps the boot refusal final", async () => {
        const mem = new Uint8Array(PAGE * 4);
        (globalThis as any).__aotNoRetry = true;
        install(mem);
        await boot(mem, new Uint8Array(PAGE).fill(0x90));
        expect(aotCache.pendingRetries()).toBe(0);
    });
});
