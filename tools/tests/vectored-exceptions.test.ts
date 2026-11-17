import { afterEach, describe, expect, it } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';
import { ThunkMemoryManager } from '../../src/worker/core/thunking/thunk-memory-manager';
import { SEH_SCRATCH_LAYOUT as L, VEH_STUB_OFFSET } from '../../src/worker/core/thunking/seh-layout';
import { System } from '../../src/worker/core/system';
import { exports as kernel } from '../../src/worker/modules/kernel32/exception';
import { kernel32Module } from '../../src/worker/api/kernel32.api';
import { ntdllModule } from '../../src/worker/api/ntdll.api';
import { Ntdll } from '../../src/worker/modules/ntdll';
import { dispatchCxxException } from '../../src/worker/core/seh-dispatch';
import { PF_HALT_TARGET } from '../../src/worker/core/bootloader';

const originalProcess = System.getInstance().process;
afterEach(() => { System.getInstance().process = originalProcess; });
function fixture() {
    const mem = new Uint8Array(0x60000), v = new DataView(mem.buffer);
    const esp = 0x30000, teb = 0x10000, ret = 0x18000;
    const d: any = new ThunkDispatcher({ add_listener() {} } as any, {} as any);
    const cpu: any = {
        reg32: Int32Array.from([1, 2, 3, 4, esp, 6, 7, 8]),
        instruction_pointer: new Int32Array([0x14000]), segment_offsets: [0, 0, 0, 0, teb],
        flags: new Int32Array([0x202]), flags_changed: new Int32Array([0]), get_eflags: () => 0x202,
    };
    Object.assign(d, { cachedMem8: mem, cachedDataView: v, memLength: mem.length,
        sehScratchAddr: 0x40000, sehDispatchStubAddress: 0x11000, cachedCpu: cpu });
    // Keep the production pin/unpin and nesting logic; only the scheduler is a fake.
    let pins = 0;
    d.ensureScheduler = () => ({ getCurrentThreadId: () => 1, registerTransientExecRange() {},
        unregisterTransientExecRange() {}, enterCriticalRuntime() {}, exitCriticalRuntime() {},
        pinCurrentThread() { pins++; }, unpinThread() { pins--; } });
    d.captureSehRuntimeDump = () => {};
    d._callbackManager = { captureState: () => ({ nextCallbackId: 1, nextFrameId: 1, stubs: [] }), restoreState() {}, reset() {} };
    v.setUint32(esp, ret, true); v.setUint32(teb, 0xffffffff, true);
    const r = d.vectoredExceptions;
    const raise = (code = 0xe0000001, flags = 0, at = esp) =>
        d.setupCxxExceptionX86Dispatch(cpu, mem, at, code, flags, 0, 0, 16);
    const context = () => d.sehDispatchStack.at(-1);
    const result = (value: number) => {
        const c = context();
        cpu.reg32[4] = v.getUint32(c.scratchAddr + L.SAFE_ESP, true);
        v.setUint32(c.scratchAddr + L.LAST_HANDLER_RESULT, value >>> 0, true);
        d._handleSehDispatchResult(cpu);
    };
    return { mem, v, esp, teb, ret, d, cpu, r, raise, context, result, pins: () => pins };
}

describe('process vectored exception handlers', () => {
    it('kernel32 and ntdll share removable opaque registrations and ABI descriptors', () => {
        const f = fixture(); System.getInstance().process = { dispatcher: f.d } as any;
        const nt = new Ntdll(); nt.initialize({} as any);
        const a = kernel.AddVectoredExceptionHandler!({} as any, f.mem, [0, 0x19000]);
        const b = nt.exports.RtlAddVectoredExceptionHandler!({}, f.mem, [1, 0x1a000]);
        expect(f.r.snapshot()).toEqual([b, a]);
        expect(nt.exports.RtlRemoveVectoredExceptionHandler!({}, f.mem, [a])).toBe(1);
        expect(kernel.RemoveVectoredExceptionHandler!({} as any, f.mem, [a as number])).toBe(0);
        expect(kernel.RemoveVectoredExceptionHandler!({} as any, f.mem, [b])).toBe(1);
        expect(f.r.size).toBe(0);
        for (const [module, prefix] of [[kernel32Module, ''], [ntdllModule, 'Rtl']] as const) {
            for (const [name, count] of [['AddVectoredExceptionHandler', 2], ['RemoveVectoredExceptionHandler', 1]] as const) {
                const descriptor = module.functions.find(fn => fn.name === prefix + name)!;
                expect(descriptor.params).toHaveLength(count); expect(descriptor.callingConvention).toBe('stdcall');
            }
        }
    });

    it('runs First/Last in order, then SEH, then UEF; zero means SEARCH for VEH', () => {
        const f = fixture();
        f.r.add(0, 0x19000); f.r.add(0, 0x1a000); f.r.add(1, 0x1b000); f.r.add(1, 0x1c000);
        f.d.unhandledExceptionFilterAddr = 0x1d000;
        expect(f.raise()).not.toBeNull(); const c = f.context(), s = c.scratchAddr;
        expect(f.v.getUint32(f.esp, true)).toBe(f.d.sehDispatchStubAddress + VEH_STUB_OFFSET);
        for (const fn of [0x1c000, 0x1b000, 0x19000, 0x1a000]) {
            expect(f.v.getUint32(s + L.LAST_HANDLER_ADDR, true)).toBe(fn);
            expect(c.awaitingUef).not.toBe(true); f.result(0);
        }
        expect(c.awaitingVeh).toBe(false); expect(c.veh).toBeUndefined();
        expect(f.v.getUint32(f.cpu.reg32[4], true)).toBe(f.d.sehDispatchStubAddress);
        f.result(1); expect(c.awaitingUef).toBe(true); f.result(0);
        expect(f.d.getSehDispatchDepth()).toBe(0); expect(f.pins()).toBe(0);
    });

    it('skips removal of self/next and does not call a removed handle reused for the same function', () => {
        const f = fixture(), a = f.r.add(0, 0x19000), b = f.r.add(0, 0x1a000);
        f.r.add(0, 0x1b000); f.raise();
        expect(f.r.remove(a)).toBe(1); expect(f.r.remove(b)).toBe(1);
        const newB = f.r.add(1, 0x1a000); expect(newB).not.toBe(b);
        f.result(0); expect(f.v.getUint32(f.context().scratchAddr + L.LAST_HANDLER_ADDR, true)).toBe(0x1b000);
        f.result(0); expect(f.context().awaitingVeh).toBe(false);
        expect(f.r.captureState().entries).toHaveLength(2);
    });

    it('empty hardware-chain fallback considers VEH without requiring a UEF', () => {
        const f = fixture(); f.r.add(0, 0x19000);
        expect(f.d._setupUnhandledExceptionFilterCall(f.cpu, 0, 0x14000, false, f.esp, 0, 3, f.v)).toBe(true);
        expect(f.context().awaitingVeh).toBe(true);
    });

    it('SEH search sees chain and CONTEXT changes made by a declining VEH', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.raise(); const s = f.context().scratchAddr;
        f.v.setUint32(f.teb, 0x2f000, true); f.v.setUint32(0x2f000, 0xffffffff, true);
        f.v.setUint32(0x2f004, 0x17000, true);
        f.v.setUint32(s + L.CONTEXT + 0xb0, 123, true);
        f.result(0);
        expect(f.v.getUint32(s + L.FRAME_LIST, true)).toBe(0x2f000);
        expect(f.v.getUint32(s + L.CONTEXT + 0xb0, true)).toBe(123);
    });

    it('CONTINUE_EXECUTION restores edited EIP, ESP, all integer registers and flags', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.raise(); const s = f.context().scratchAddr;
        const offsets = [0xb0, 0xac, 0xa8, 0xa4, 0xc4, 0xb4, 0xa0, 0x9c];
        offsets.forEach((offset, i) => f.v.setUint32(s + L.CONTEXT + offset, i === 4 ? 0x28000 : 90 + i, true));
        f.v.setUint32(s + L.CONTEXT + 0xb8, 0x1e000, true);
        f.v.setUint32(s + L.CONTEXT + 0xc0, 0x647, true); f.cpu.flags_changed[0] = -1;
        f.result(-1);
        expect(Array.from(f.cpu.reg32)).toEqual([90, 91, 92, 93, 0x27ffc, 95, 96, 97]);
        expect(f.v.getUint32(0x27ffc, true)).toBe(0x1e000);
        expect(f.cpu.flags[0]).toBe(0x647); expect(f.cpu.flags_changed[0]).toBe(0);
        expect(f.d.getSehDispatchDepth()).toBe(0); expect(f.pins()).toBe(0);
    });

    it('continuing an unedited software exception returns from RaiseException with cleanup', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.raise(); f.result(-1);
        expect(f.cpu.reg32[4]).toBe(f.esp + 16); expect(f.v.getUint32(f.esp + 16, true)).toBe(f.ret);
    });

    it('delivers hardware AV with empty SEH and no UEF before falling back', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.v.setUint32(f.esp + 20, 0x647, true);
        expect(f.d._tryDispatchAccessViolation(f.cpu, 0, 0x14000, false, f.esp, 0, 3, f.v)).toBe(true);
        const s = f.context().scratchAddr;
        expect(f.v.getUint32(s, true)).toBe(0xc0000005);
        expect(f.v.getUint32(s + 24, true)).toBe(0);
        expect(f.v.getUint32(f.esp + 12, true)).toBe(f.d.sehDispatchStubAddress + VEH_STUB_OFFSET);
        f.result(-1); expect(f.cpu.reg32[4]).toBe(f.esp + 20);
    });

    it('does not let a trivial EH3 fast filter precede VEH', () => {
        const f = fixture(); f.r.add(0, 0x19000);
        f.v.setUint32(f.teb, 0x2f000, true); f.v.setUint32(0x2f000, 0xffffffff, true);
        f.v.setUint32(0x2f004, 0x17000, true);
        f.d.thunkGenerator.getStubByAddress = () => ({ functionName: '_except_handler3' });
        f.v.setUint32(0x2f008, 0x21000, true); f.v.setInt32(0x2f00c, 0, true);
        f.v.setInt32(0x21000, -1, true); f.v.setUint32(0x21004, 0x22000, true);
        f.v.setUint32(0x21008, 0x23000, true);
        f.mem.set([0xb8, 1, 0, 0, 0, 0xc3], 0x22000); // trivial catch-all filter
        expect(f.d._tryDispatchAccessViolation(f.cpu, 0, 0x14000, false, f.esp, 0, 3, f.v)).toBe(true);
        expect(f.context().awaitingVeh).toBe(true);
        expect(f.v.getUint32(f.context().scratchAddr + L.FRAME_LIST, true)).toBe(0x2f000);
    });

    it('routes C++ fast search to VEH before searching or unwinding even an empty SEH chain', () => {
        const f = fixture(); f.r.add(0, 0x19000);
        System.getInstance().process = { dispatcher: f.d } as any;
        const before = f.mem.slice();
        expect(dispatchCxxException(f.mem, f.cpu, 0x18000, 0x19000, 8)).toEqual({
            deferToX86: true, pExceptionObject: 0x18000, pThrowInfo: 0x19000,
        });
        expect(f.mem).toEqual(before);
    });

    it('keeps nested contexts separate and resumes the outer handler without losing its cursor', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.r.add(0, 0x1a000); f.raise();
        const outer = f.context(), saved = f.mem.slice(outer.scratchAddr, outer.scratchAddr + 0x800);
        const nestedEsp = outer.startEsp - 0x100;
        f.v.setUint32(nestedEsp, 0x19200, true); f.cpu.reg32[4] = nestedEsp;
        expect(f.raise(0xe0000002, 0, nestedEsp)).not.toBeNull();
        expect(f.d.getSehDispatchDepth()).toBe(2); expect(f.pins()).toBe(1);
        const inner = f.context(); expect(inner.scratchAddr).toBeLessThan(outer.scratchAddr);
        f.result(-1); expect(f.context()).toBe(outer); expect(f.pins()).toBe(1);
        expect(f.mem.slice(outer.scratchAddr, outer.scratchAddr + 0x800)).toEqual(saved);
        f.result(0); expect(f.v.getUint32(outer.scratchAddr + L.LAST_HANDLER_ADDR, true)).toBe(0x1a000);
        f.result(-1); expect(f.pins()).toBe(0);
    });

    it('nested hardware handlers run below their live scratch, not through CONTEXT', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.raise(); const outer = f.context();
        const interruptEsp = outer.startEsp - 0x100;
        expect(f.d._setupSehDispatchStub(f.cpu, 0, 0x19030, false, interruptEsp, 0, 3, f.v, f.teb, 0xffffffff)).toBe(true);
        const inner = f.context();
        expect(inner.startEsp).toBeLessThan(inner.scratchAddr);
        expect(inner.scratchAddr + 0x800).toBeLessThanOrEqual(interruptEsp + 24);
        f.result(-1); expect(f.context()).toBe(outer); f.result(-1); expect(f.pins()).toBe(0);
    });

    it('longjmp and explicit unwind release pending cursors and the runtime pin', () => {
        for (const mode of ['jump', 'unwind', 'abort']) {
            const f = fixture(); f.r.add(0, 0x19000); f.raise();
            if (mode === 'jump') { f.cpu.reg32[4] = f.esp; f.d._checkSehNonLocalJump(1); }
            else if (mode === 'unwind') f.d.notifySehHandlerCaught(f.esp);
            else f.d.notifySehDispatchAborted('test');
            expect(f.d.getSehDispatchDepth()).toBe(0); expect(f.pins()).toBe(0);
        }
    });

    it('refuses active-dispatch save and round-trips registrations/identity counter when idle', () => {
        const f = fixture(); const a = f.r.add(0, 0x19000), b = f.r.add(1, 0x1a000);
        const state = structuredClone(f.d.captureState()); f.r.remove(a); f.r.remove(b);
        f.d.restoreState(state); expect(f.r.snapshot()).toEqual([b, a]);
        state.veh.entries.length = 0; expect(f.r.size).toBe(2);
        expect(f.r.add(0, 0x1b000)).toBeGreaterThan(b);
        f.raise(); expect(() => f.d.captureState()).toThrow('not at a safe point');
        f.result(-1); f.d.reset(); expect(f.r.size).toBe(0); expect(f.d.getSehDispatchDepth()).toBe(0);
    });

    it('process reset during pending VEH releases pin, cursor and registrations', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.raise(); expect(f.pins()).toBe(1);
        f.d.reset(); expect(f.pins()).toBe(0); expect(f.d.getSehDispatchDepth()).toBe(0);
        expect(f.r.captureState()).toEqual({ nextHandle: 1, entries: [] });
    });

    it('rejects null handlers and exhausted identities without reusing stale handles', () => {
        const f = fixture(); expect(f.r.add(0, 0)).toBe(0); expect(f.r.remove(0)).toBe(0);
        f.r.restoreState({ nextHandle: 0xffffffff, entries: [] });
        const last = f.r.add(0, 0x19000); expect(last).toBe(0xffffffff);
        f.r.remove(last); expect(f.r.add(0, 0x19000)).toBe(0); expect(f.r.size).toBe(0);
    });

    it('20,000 add/remove cycles retain no removed handler or cursor, including duplicate functions', () => {
        const f = fixture();
        for (let i = 0; i < 20000; i++) {
            const a = f.r.add(i & 1, 0x19000), b = f.r.add(0, 0x19000);
            expect(a).not.toBe(b); f.r.remove(a); f.r.remove(b);
        }
        expect(f.r.size).toBe(0); expect(f.r.snapshot()).toEqual([]);
        expect(f.r.captureState()).toEqual({ nextHandle: 40001, entries: [] });
    });

    it('raises NONCONTINUABLE_EXCEPTION instead of resuming a noncontinuable raise', () => {
        const f = fixture(); f.r.add(0, 0x19000); f.raise(0xe0000001, 1); const c = f.context();
        f.result(-1); expect(f.context()).toBe(c); expect(c.awaitingVeh).toBe(true);
        expect(f.v.getUint32(c.scratchAddr, true)).toBe(0xc0000025);
        const cause = f.v.getUint32(c.scratchAddr + 8, true);
        expect(f.v.getUint32(cause, true)).toBe(0xe0000001);
        f.result(-1); expect(f.d.getSehDispatchDepth()).toBe(0);
        expect(f.v.getUint32(f.cpu.reg32[4], true)).toBe(PF_HALT_TARGET);
    });

    it('preserves all 15 software exception parameters', () => {
        const f = fixture(); f.r.add(0, 0x19000);
        for (let i = 0; i < 15; i++) f.v.setUint32(0x20000 + i * 4, i + 100, true);
        f.d.setupCxxExceptionX86Dispatch(f.cpu, f.mem, f.esp, 0xe0000001, 0, 15, 0x20000, 16);
        const s = f.context().scratchAddr;
        for (let i = 0; i < 15; i++) expect(f.v.getUint32(s + 20 + i * 4, true)).toBe(i + 100);
    });

    it('static x86 stub uses one stdcall argument and a preserved scratch base', () => {
        const f = fixture(), at = 0x110fc;
        (ThunkMemoryManager.prototype as any).writeVectoredDispatchStub.call({}, f.mem, at);
        // Decode the ABI-bearing sequence independently: mov esp,[edi+safe]; push edi;
        // lea eax,[edi+EXCEPTION_POINTERS]; push eax; call [edi+handler]; pop edi.
        expect(Array.from(f.mem.slice(at, at + 2))).toEqual([0x8b, 0xa7]);
        expect(f.v.getUint32(at + 2, true)).toBe(L.SAFE_ESP);
        expect(Array.from(f.mem.slice(at + 6, at + 9))).toEqual([0x57, 0x8d, 0x87]);
        expect(f.v.getUint32(at + 9, true)).toBe(L.EXCEPTION_POINTERS);
        expect(Array.from(f.mem.slice(at + 13, at + 16))).toEqual([0x50, 0xff, 0x97]);
        expect(f.v.getUint32(at + 16, true)).toBe(L.LAST_HANDLER_ADDR);
        expect(f.mem[at + 20]).toBe(0x5f);
        expect(Array.from(f.mem.slice(at + 37, at + 39))).toEqual([0xef, 0xc3]);
    });
});
