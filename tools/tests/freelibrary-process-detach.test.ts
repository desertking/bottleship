import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ModuleRegistry, type LoadedPEModule } from "../../src/worker/core/module-registry";
import { exports as api } from "../../src/worker/modules/kernel32/module/module";

const BASE = 0x24000000;
const ENTRY_RVA = 0x13a4;

async function cycle(initialized: boolean) {
    const system = System.getInstance();
    const previous = system.process;
    const registry = new ModuleRegistry();
    const mod: LoadedPEModule = {
        name: "unzdll.dll", path: "C:/data/unzdll.dll", baseAddress: BASE, size: 0x20000, entryPoint: ENTRY_RVA,
        exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized,
    };
    const calls: Array<{ fn: number; args: number[]; frame: number }> = [];
    const callbackManager = {
        saveSuspendedThunkContext: () => 77,
        invokeCallback: (fn: number, args: number[], _cleanup: number, _done: unknown, _x: boolean, _name: string, frame: number) => {
            calls.push({ fn, args, frame });
            return { callbackId: 5 };
        },
        abandonSuspendedFrame: () => true,
    };
    const loader = { peekLoadDll: () => ({ kind: "io" }), loadDll: async () => { registry.register(mod); return mod; }, getPendingDllInits: () => [] };
    system.process = { moduleRegistry: registry, loader, resetGeneration: 0, dispatcher: { callbackManager } } as never;
    const mem = new Uint8Array(0x1000);
    const name = "unzdll.dll";
    for (let i = 0; i < name.length; i++) mem[0x100 + i] = name.charCodeAt(i);
    try {
        await api["LoadLibraryA"]!({} as never, mem, [0x100]);
        const result = await api["FreeLibrary"]!({ esp: 0x1000 } as never, mem, [BASE]) as { value: number; suspendedForCallback?: boolean };
        return { result, calls, registered: registry.getByBase(BASE) };
    } finally {
        system.process = previous;
    }
}

test("the last FreeLibrary of an attached DLL runs DllMain(DLL_PROCESS_DETACH)", async () => {
    const { result, calls, registered } = await cycle(true);
    expect(registered).toBeUndefined();
    expect(result.value).toBe(1);
    expect(result.suspendedForCallback).toBe(true);
    expect(calls).toEqual([{ fn: BASE + ENTRY_RVA, args: [BASE, 0, 0], frame: 77 }]);
});

test("a DLL whose DllMain never ran is unloaded without a detach call", async () => {
    const { result, calls } = await cycle(false);
    expect(result.value).toBe(1);
    expect(result.suspendedForCallback).toBeUndefined();
    expect(calls).toEqual([]);
});
