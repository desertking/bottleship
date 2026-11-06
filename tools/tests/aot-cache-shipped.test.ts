import { afterEach, describe, expect, test } from "bun:test";
import { aotCache, decodeAotPack, encodeAotPack } from "../../src/worker/core/cpu/aot-cache";

const PAGE = 4096;

const unit = (entryPage: number, len: number) => ({
    entryPage, tableIndex: 5, bytes: new Uint8Array(len).map((_, i) => (i * 7 + entryPage) & 0xff),
    pages: [{ physPage: entryPage, stateFlags: 0, entries: [[0, 1]] as Array<[number, number]>, sha: "ab" }],
});

function install(): void {
    const wasm = {
        jit_config_abi_version: () => 4,
        jit_config_supported_mask: () => 0xff,
        jit_codegen_fingerprint_lo: () => 11,
        jit_codegen_fingerprint_hi: () => 22,
        get_mem8_base: () => 0x1000,
    };
    const cpu = { mem8: new Uint8Array(PAGE * 4), memory_size: new Uint32Array([PAGE * 4]) };
    (globalThis as any).System = { getInstance: () => ({ process: { v86: { cpu } } }) };
    (globalThis as any).preemption = { getWasmExports: () => wasm };
    (aotCache as any).engineSha = null;
    aotCache.clear();
}

const saved = { fetch: globalThis.fetch, location: (globalThis as any).location };

afterEach(() => {
    globalThis.fetch = saved.fetch;
    (globalThis as any).location = saved.location;
    delete (globalThis as any).__v86EngineLoad;
    delete (globalThis as any).__aotNoShipped;
    (aotCache as any).engineSha = null;
    aotCache.clear();
});

describe("AOT unit packs", () => {
    test("encode and decode round-trip the units byte for byte", () => {
        const units = [unit(0x10, 300), unit(0x20, 17)];
        const pack = decodeAotPack(encodeAotPack({ abi: 6 }, units))!;
        expect(pack.version).toEqual({ abi: 6 });
        expect(pack.units.map((u) => [u.entryPage, u.bytes.length])).toEqual([[0x10, 300], [0x20, 17]]);
        expect(Buffer.from(pack.units[0]!.bytes).equals(Buffer.from(units[0]!.bytes))).toBe(true);
    });

    test("a truncated or foreign pack is refused", () => {
        const good = encodeAotPack({ abi: 6 }, [unit(1, 10)]);
        expect(decodeAotPack(good.subarray(0, good.length - 1))).toBeNull();
        expect(decodeAotPack(new TextEncoder().encode("not a pack at all"))).toBeNull();
    });
});

describe("engine identity", () => {
    test("comes from the bytes the worker instantiated, not from a second fetch", async () => {
        install();
        let fetched = 0;
        globalThis.fetch = (async () => { fetched++; return new Response(new Uint8Array(1)); }) as typeof fetch;
        (globalThis as any).__v86EngineLoad = { sha256: "f00d", error: null };
        const v = await aotCache.version();
        expect(v.engine).toBe("f00d");
        expect(fetched).toBe(0);
    });

    test("an engine whose bytes could not be captured has no identity", async () => {
        install();
        (globalThis as any).__v86EngineLoad = { sha256: null, error: "engine bytes not captured" };
        await expect(aotCache.version()).rejects.toThrow();
    });
});

describe("shipped units", () => {
    async function serve(pack: Uint8Array): Promise<string[]> {
        const urls: string[] = [];
        (globalThis as any).location = { href: "https://example.test/spieltests/x/assets/emulator.worker.js" };
        globalThis.fetch = (async (url: string) => { urls.push(url); return new Response(pack); }) as unknown as typeof fetch;
        return urls;
    }

    test("load from ../aot/<container>/<key>.bsaot beside the player when the identity matches", async () => {
        install();
        (globalThis as any).__v86EngineLoad = { sha256: "e1", error: null };
        const version = await aotCache.version();
        const urls = await serve(encodeAotPack(version, [unit(3, 40)]));
        const r = await aotCache.loadShipped("app:demo");
        expect("loaded" in r && r.loaded).toBe(1);
        expect(urls[0]).toMatch(/^https:\/\/example\.test\/spieltests\/x\/aot\/[^/]+\/[0-9a-f]{16}\.bsaot$/);
        expect(aotCache.getUnits().length).toBe(1);
    });

    test("a pack recorded under another engine is refused", async () => {
        install();
        (globalThis as any).__v86EngineLoad = { sha256: "e1", error: null };
        const version = await aotCache.version();
        await serve(encodeAotPack({ ...version, engine: "other" }, [unit(3, 40)]));
        const r = await aotCache.loadShipped("app:demo");
        expect("error" in r).toBe(true);
        expect(aotCache.getUnits().length).toBe(0);
    });

    test("__aotNoShipped turns it off", async () => {
        install();
        (globalThis as any).__v86EngineLoad = { sha256: "e1", error: null };
        (globalThis as any).__aotNoShipped = true;
        const urls = await serve(new Uint8Array(0));
        expect("error" in await aotCache.loadShipped("app:demo")).toBe(true);
        expect(urls.length).toBe(0);
    });
});
