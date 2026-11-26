import { expect, test } from "bun:test";
import { planPeAot, readPeAot, writePeAot, peAotCacheStats } from "../../src/worker/wwt/pe-aot-cache";
import { compileAbi11Pe, PeAotCompileTimeoutError, type PeAotCompileRequest } from "../../src/worker/wwt/pe-aot-compiler";
import { installFakeOpfs } from "./fixtures/fake-opfs";

async function withFakeOpfs(run: () => Promise<void>): Promise<void> {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
        installFakeOpfs();
        await run();
    } finally {
        if (previous) Object.defineProperty(globalThis, "navigator", previous);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
}

test("a cached translation is found whatever seeds the next run brings, and remembers its own seeds", async () => {
    await withFakeOpfs(async () => {
        const image = Uint8Array.of(7, 7, 7);
        expect(await readPeAot(image, "mode")).toBeNull();
        await writePeAot(image, "mode", Uint8Array.of(1, 2, 3), [0x401000, 0x401200]);
        const hit = await readPeAot(image, "mode");
        expect(hit?.bytes).toEqual(Uint8Array.of(1, 2, 3));
        expect(hit?.seeds).toEqual([0x401000, 0x401200]);
        expect(await readPeAot(image, "other-mode")).toBeNull();
        expect(await readPeAot(Uint8Array.of(8), "mode")).toBeNull();
    });
});

test("new seeds keep the cached translation in use and refresh it in the background when they can", () => {
    expect(planPeAot(null, [1], true)).toBe("rebuild");
    expect(planPeAot([1, 2], [2], true)).toBe("use");
    expect(planPeAot([1, 2], [], false)).toBe("use");
    expect(planPeAot([1], [1, 3], true)).toBe("use-and-refresh");
    expect(planPeAot([1], [1, 3], false)).toBe("rebuild");
});

test("a translation that outlives the budget still reaches the cache", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    let terminated = 0;
    class SlowWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: unknown = null;
        onmessageerror: unknown = null;
        postMessage(): void {
            setTimeout(() => this.onmessage?.({ data: { type: "done", wasm: Uint8Array.of(9, 9) } }), 40);
        }
        terminate(): void { terminated++; }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: SlowWorker });
    try {
        await withFakeOpfs(async () => {
            const image = Uint8Array.of(5);
            const before = peAotCacheStats().writes;
            let late: Promise<void> | undefined;
            const request = { module: {} as WebAssembly.Module, cacheId: "c", file: image, profile: [], guestLimit: 0 } as PeAotCompileRequest;
            await expect(compileAbi11Pe(request, undefined, wasm => { late = writePeAot(image, "mode", wasm, []); }, 5))
                .rejects.toBeInstanceOf(PeAotCompileTimeoutError);
            expect(terminated).toBe(0);
            await new Promise(resolve => setTimeout(resolve, 80));
            await late;
            expect(terminated).toBe(1);
            expect(peAotCacheStats().writes - before).toBe(1);
            expect((await readPeAot(image, "mode"))?.bytes).toEqual(Uint8Array.of(9, 9));
        });
    } finally {
        if (original) Object.defineProperty(globalThis, "Worker", original);
        else Reflect.deleteProperty(globalThis, "Worker");
    }
});
