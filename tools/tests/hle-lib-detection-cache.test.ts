import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { libHleManager } from "../../src/worker/core/hle-lib/lib-hle-manager";
import { libRegistry } from "../../src/worker/core/hle-lib/lib-registry";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import type { LoadedPEModule } from "../../src/worker/core/module-registry";
import type { LibDescriptor } from "../../src/worker/core/hle-lib/types";

const BASE = 0x400000;
const MARKER = "libfoo 1.2.3";
const PROLOGUE = [0x55, 0x8b, 0xec, 0x83, 0xec, 0x38, 0x56];
const g = globalThis as { __hleDetectCache?: boolean; __noNativeLeaves?: boolean };

let mem: Uint8Array;
let scans = 0;
const realReadBytes = Mem.readBytes;

function mkModule(): LoadedPEModule {
    return {
        name: "engine.dll", path: "C:\\engine.dll", baseAddress: BASE, size: 0x10000, entryPoint: 0,
        exports: new Map(), ordinalExports: new Map(), isRealDll: true, initialized: false,
        sections: [
            { name: ".text", virtualAddress: 0x1000, virtualSize: 0x100, rawSize: 0x100, characteristics: 0 },
            { name: ".rdata", virtualAddress: 0x2000, virtualSize: 0x100, rawSize: 0x100, characteristics: 0 },
        ],
    };
}

function mkDescriptor(): LibDescriptor {
    return {
        id: "libfoo-cache-test", displayName: "libfoo", minConfidence: 100,
        signatures: {
            versionString: { kind: "ascii", text: MARKER, weight: 60 },
            decodePrologue: { kind: "prologue", pattern: new Uint8Array(PROLOGUE), mask: "xxxxxxx", weight: 50 },
        },
        functions: {}, handlers: {},
    };
}

function plant(): void {
    mem.fill(0);
    for (let i = 0; i < MARKER.length; i++) mem[BASE + 0x2020 + i] = MARKER.charCodeAt(i);
    for (let i = 0; i < PROLOGUE.length; i++) mem[BASE + 0x1040 + i] = PROLOGUE[i]!;
}

function report(): string {
    return JSON.stringify(libHleManager.getReport());
}

describe("static-library detection is remembered per image", () => {
    let cfg: { enable: boolean; logOnly: boolean };
    let saved: { enable: boolean; logOnly: boolean };
    beforeEach(() => {
        mem = new Uint8Array(BASE + 0x10000);
        Mem.bind(() => mem);
        (Mem as any).readBytes = (a: number, n: number) => { scans++; return realReadBytes.call(Mem, a, n); };
        scans = 0;
        g.__noNativeLeaves = true;
        cfg = EmulatorConfig.getInstance().hleLibs as unknown as { enable: boolean; logOnly: boolean };
        saved = { enable: cfg.enable, logOnly: cfg.logOnly };
        cfg.enable = true;
        cfg.logOnly = true;
        libRegistry.clear();
        libRegistry.register(mkDescriptor());
        libHleManager.initialize({ dispatcher: {} as any, thunkGenerator: {} as any, getCpu: () => null, getMemory: () => mem });
        plant();
    });
    afterEach(() => {
        (Mem as any).readBytes = realReadBytes;
        delete g.__hleDetectCache;
        delete g.__noNativeLeaves;
        cfg.enable = saved.enable;
        cfg.logOnly = saved.logOnly;
        libRegistry.clear();
    });

    test("reloading the same image reuses the detection and reaches the same match", () => {
        const before = { ...libHleManager.detectionCacheStats };
        libHleManager.onModuleLoaded(mkModule());
        const first = report();
        const scansFirst = scans;
        expect(scansFirst).toBeGreaterThan(0);
        libHleManager.onModuleLoaded(mkModule());
        expect(scans).toBe(scansFirst);
        expect(report()).toBe(first);
        expect(libHleManager.detectionCacheStats.hits - before.hits).toBe(1);
    });

    test("a changed image is scanned again", () => {
        libHleManager.onModuleLoaded(mkModule());
        const s1 = scans;
        mem[BASE + 0x3000] ^= 1;
        libHleManager.onModuleLoaded(mkModule());
        expect(scans).toBeGreaterThan(s1);
    });

    test("switch off scans every load", () => {
        g.__hleDetectCache = false;
        libHleManager.onModuleLoaded(mkModule());
        const s1 = scans;
        libHleManager.onModuleLoaded(mkModule());
        expect(scans).toBe(s1 * 2);
    });
});
