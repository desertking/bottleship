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
const g = globalThis as { __hleScanIlOnly?: boolean; __noNativeLeaves?: boolean };

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

function writePe(clrFlags: number | null): void {
    const dv = new DataView(mem.buffer);
    mem[BASE] = 0x4d; mem[BASE + 1] = 0x5a;
    dv.setUint32(BASE + 0x3c, 0x80, true);
    const nt = BASE + 0x80;
    dv.setUint32(nt, 0x00004550, true);
    const opt = nt + 0x18;
    dv.setUint16(opt, 0x10b, true);
    dv.setUint32(opt + 0x5c, 16, true);
    if (clrFlags !== null) {
        dv.setUint32(opt + 0x60 + 14 * 8, 0x3000, true);
        dv.setUint32(opt + 0x60 + 14 * 8 + 4, 0x48, true);
        dv.setUint32(BASE + 0x3000, 0x48, true);
        dv.setUint32(BASE + 0x3000 + 0x10, clrFlags, true);
    }
}

describe("IL-only managed images skip the native library scan", () => {
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
        delete g.__hleScanIlOnly;
        delete g.__noNativeLeaves;
        cfg.enable = saved.enable;
        cfg.logOnly = saved.logOnly;
        libRegistry.clear();
    });

    test("an IL-only assembly is not scanned", () => {
        writePe(0x1);
        libHleManager.onModuleLoaded(mkModule());
        expect(scans).toBe(0);
    });

    test("a native image and a mixed-mode image are still scanned", () => {
        writePe(null);
        libHleManager.onModuleLoaded(mkModule());
        expect(scans).toBeGreaterThan(0);
        scans = 0;
        writePe(0x0);
        libHleManager.onModuleLoaded(mkModule());
        expect(scans).toBeGreaterThan(0);
    });

    test("switch on scans IL-only images again", () => {
        writePe(0x1);
        g.__hleScanIlOnly = true;
        libHleManager.onModuleLoaded(mkModule());
        expect(scans).toBeGreaterThan(0);
    });
});
