import { expect, test } from "bun:test";
import { sha256Hex } from "../../src/worker/savestate/chunk-store";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { peAotKey } from "../../src/worker/wwt/pe-aot-cache";
import { WwtCompiler } from "../../src/worker/wwt/translator";
import { WwtWarmPackage } from "../../src/worker/wwt/warm-package";

function frame(header: object, module: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    const meta = new TextEncoder().encode(JSON.stringify(header));
    const bytes = new Uint8Array(8 + meta.length + module.length);
    const sizes = new DataView(bytes.buffer);
    sizes.setUint32(0, meta.length, true);
    sizes.setUint32(4, module.length, true);
    bytes.set(meta, 8);
    bytes.set(module, 8 + meta.length);
    return bytes;
}

test("a first launch reuses exact server Wasm and falls back after a guest code edit", async () => {
    const bytes = await Bun.file(new URL("../../public/wwt-provider/wwt_abi11.wasm", import.meta.url)).arrayBuffer();
    const compiler = await WwtCompiler.fromBytes(bytes, true);
    const guestLimit = 4 << 20;
    const address = 0x20000;
    const code = Uint8Array.of(0xb8, 42, 0, 0, 0, 0xc3);
    const flags = compiler.flags(guestLimit) >>> 0;
    const demand = compiler.translate(code, address, [], guestLimit, false, 0);
    const demandPack = frame({ kind: "demand", address, length: code.length, known: [], flags, opt: 0,
        code: await sha256Hex(code), sha256: await sha256Hex(demand) }, demand);
    const demandSha = await sha256Hex(demandPack);
    const peInput = Uint8Array.of(42);
    const peKey = await peAotKey(peInput, "mode");
    const peSha = await sha256Hex(demand);
    const originalImageHash = "c".repeat(64);
    const manifest = {
        version: 1,
        pe: { [peKey]: { size: demand.length, sha256: peSha, seeds: [address] } },
        demand: { size: demandPack.length, sha256: demandSha },
        profile: { [originalImageHash]: [123] },
    };
    const location = Object.getOwnPropertyDescriptor(globalThis, "location");
    const originalFetch = globalThis.fetch;
    const fetched: string[] = [];
    const expected = `/game/wwt/${compiler.cacheId}/`;
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://game.test/engine/worker.js") });
    globalThis.fetch = (async (input: URL) => {
        const path = input.pathname;
        fetched.push(path);
        if (path === expected + "index.json") return Response.json(manifest);
        if (path === expected + `demand-${demandSha}.bin`) return new Response(demandPack);
        if (path === expected + `${peKey}-${peSha}.wasm`) return new Response(demand);
        return new Response(null, { status: 404 });
    }) as typeof fetch;
    const machine = new BottleShipMachine(compiler, guestLimit, 4096, 0);
    const server = new WwtWarmPackage("https://game.test/game/wwt", compiler.cacheId);
    try {
        await server.ready;
        expect(server.profile(originalImageHash)).toEqual([123]);
        expect(await server.pe(peKey)).toEqual({ bytes: demand, seeds: [address] });
        expect(await server.pe(await peAotKey(Uint8Array.of(43), "mode"))).toBeNull();
        expect(await server.pe(await peAotKey(peInput, "other-flags"))).toBeNull();
        expect(server.lookupDemand(address, code, [address + 2], flags, 0)).toBeUndefined();
        expect(server.lookupDemand(address, code, [], flags + 1, 0)).toBeUndefined();
        expect(server.lookupDemand(address, code, [], flags, 1)).toBeUndefined();
        server.close();

        const otherCompiler = new WwtWarmPackage("/game/wwt/", "1".repeat(64));
        await otherCompiler.ready;
        expect(await otherCompiler.pe(peKey)).toBeNull();
        expect(fetched).toContain("/game/wwt/" + "1".repeat(64) + "/index.json");
        otherCompiler.close();

        await machine.init();
        await machine.prepareWarmPackage("/game/wwt/");
        for (let i = 0; i < 100 && !machine.warmStats()?.demandPrepared; i++) await Bun.sleep(5);
        expect(machine.warmStats()?.demandPrepared).toBe(1);
        machine.codeEnd = () => address + code.length;
        const ram = new Uint8Array(machine.memory.buffer);
        const view = new DataView(machine.memory.buffer);
        ram.set(code, address);
        const cpu = machine.newCpu();
        const stack = 0x40000;
        const a = machine.abi.cpu;
        const run = () => {
            view.setUint32(cpu + a.GPR + 16, stack, true);
            view.setUint32(stack, machine.stopAddress, true);
            expect(machine.run(cpu, address)).toBe(machine.stopAddress);
            return view.getUint32(cpu + a.GPR, true);
        };
        expect(run()).toBe(42);
        expect(machine.warmStats()?.demandHits).toBe(1);
        expect(machine.translationStats.compiled).toBe(0);
        machine.invalidateTranslationPages(address >>> 12, (address >>> 12) + 1);
        ram[address + 1] = 43;
        expect(run()).toBe(43);
        expect(machine.translationStats.compiled).toBe(1);
        expect(machine.warmStats()?.demandHits).toBe(1);
    } finally {
        machine.dispose();
        server.close();
        globalThis.fetch = originalFetch;
        if (location) Object.defineProperty(globalThis, "location", location);
        else Reflect.deleteProperty(globalThis, "location");
    }
});
