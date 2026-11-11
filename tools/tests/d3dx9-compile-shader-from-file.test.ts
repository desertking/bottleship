import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { CallbackManager } from "../../src/worker/core/thunking/callback-manager";
import { createCompileShaderExports, resetCompileShaderState } from "../../src/worker/modules/d3dx9/compile-shader";

const system = System.getInstance();
const saved = { process: system.process, scheduler: system.scheduler, isExiting: system.isExiting };
const ENTRY = 0xc000, RETURN = 0x1000, PATH = 0x3000, OUT = 0x3100, HEAP = 0x20000;
const API: Record<string, number> = {
    "kernel32:CreateFileA": 0x1100, "kernel32:GetFileSize": 0x1110, "kernel32:ReadFile": 0x1120,
    "kernel32:CloseHandle": 0x1130, "kernel32:LoadLibraryA": 0x1140, "kernel32:GetProcAddress": 0x1150,
};
const D3DCOMPILE = 0x1160;
const SOURCE = "float4 main() : COLOR { return 1; }";
let mem: Uint8Array, cpu: any, manager: CallbackManager, next: number, exports: Record<string, any>;

beforeEach(() => {
    (globalThis as any).__noImageIatBinding = true;
    mem = new Uint8Array(0x40000);
    Mem.bind(() => mem);
    cpu = { reg32: new Int32Array(8), instruction_pointer: new Int32Array(1), is_jumping: false };
    cpu.reg32[4] = ENTRY;
    new DataView(mem.buffer).setUint32(ENTRY, RETURN, true);
    system.scheduler = { getCurrentThreadId: () => 1, getThreadStackBounds: () => ({ base: 0xa000, top: 0xd000 }) } as any;
    manager = new CallbackManager({ cpu }, {} as any, () => mem);
    next = HEAP;
    const process: any = {
        resetGeneration: 0,
        dispatcher: { callbackManager: manager, thunkGenerator: { getExportAddress: (n: string) => API[n] } },
        addressSpace: { validateRange: (p: number, n: number, perms: string) => p > 0 && p + n <= mem.length && (!perms.includes("x") || (p >= RETURN && p < 0x2000)) },
        memory: { alloc: (n: number) => { const p = next; next += (n + 15) & ~15; return p; }, free: () => {} },
    };
    system.process = process;
    system.isExiting = false;
    manager.initialize({ getRegions: () => ({ callbackStubPoolBase: 0x4000, callbackStubPoolSize: 0x4000 }) } as any);
    resetCompileShaderState();
    exports = createCompileShaderExports(process);
    mem.set(new TextEncoder().encode("C:\\fx\\a.psh\0"), PATH);
});

afterEach(() => {
    delete (globalThis as any).__noImageIatBinding;
    manager.reset();
    Object.assign(system, saved);
});

function pending() {
    const id = [...(manager as any).pendingCallbacks.keys()][0] as number;
    return { id, call: manager.getPendingCallback(id)! };
}
function finish(id: number, value: number): void {
    const call = manager.getPendingCallback(id)!;
    cpu.reg32[4] = call.espBeforeInvoke! - 4;
    new DataView(mem.buffer).setUint32(cpu.reg32[4], value, true);
    manager.handleCallbackReturn(id);
}
function args(call: any, n: number): number[] {
    return (call.args as number[]).slice(0, n).map((a) => a >>> 0);
}

test("D3DXCompileShaderFromFileA reads the file through kernel32 and compiles its text", () => {
    const view = new DataView(mem.buffer);
    exports["D3DXCompileShaderFromFileA"]({ esp: ENTRY }, mem, [PATH, 0, 0, 0, 0, 0, OUT, 0, 0]);
    let p = pending();
    expect(p.call.callbackAddress).toBe(API["kernel32:CreateFileA"]);
    expect(args(p.call, 1)[0]).toBe(PATH);
    finish(p.id, 0x44);
    p = pending();
    expect(p.call.callbackAddress).toBe(API["kernel32:GetFileSize"]);
    finish(p.id, SOURCE.length);
    p = pending();
    expect(p.call.callbackAddress).toBe(API["kernel32:ReadFile"]);
    const [handle, buffer, size, readOut] = args(p.call, 4);
    expect([handle, size]).toEqual([0x44, SOURCE.length]);
    mem.set(new TextEncoder().encode(SOURCE), buffer!);
    view.setUint32(readOut!, SOURCE.length, true);
    finish(p.id, 1);
    p = pending();
    expect(p.call.callbackAddress).toBe(API["kernel32:CloseHandle"]);
    finish(p.id, 1);
    p = pending();
    expect(p.call.callbackAddress).toBe(API["kernel32:LoadLibraryA"]);
    finish(p.id, 0x7000000);
    p = pending();
    finish(p.id, D3DCOMPILE);
    p = pending();
    expect(p.call.callbackAddress).toBe(D3DCOMPILE);
    const [src, len] = args(p.call, 2);
    expect(len).toBe(SOURCE.length);
    expect(new TextDecoder().decode(mem.subarray(src!, src! + len!))).toBe(SOURCE);
    finish(p.id, 0);
    expect(cpu.reg32[0]).toBe(0);
    expect(manager.getPendingCount()).toBe(0);
});

test("a missing file fails with HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) and closes nothing", () => {
    exports["D3DXCompileShaderFromFileA"]({ esp: ENTRY }, mem, [PATH, 0, 0, 0, 0, 0, OUT, 0, 0]);
    const p = pending();
    finish(p.id, 0xffffffff);
    expect(cpu.reg32[0] >>> 0).toBe(0x80070002);
    expect(manager.getPendingCount()).toBe(0);
});
