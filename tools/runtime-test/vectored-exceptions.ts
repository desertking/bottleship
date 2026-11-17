/** Execute the production VEH/SEH stubs and real stdcall/cdecl handlers on b44 v86. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMachine, LEAF, DONE, STACK } from './bulk-machine.mjs';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';
import { ThunkMemoryManager } from '../../src/worker/core/thunking/thunk-memory-manager';
import { SEH_SCRATCH_LAYOUT as L, VEH_STUB_OFFSET } from '../../src/worker/core/thunking/seh-layout';

const binary = readFileSync(new URL('../../public/v86.wasm', import.meta.url));
for (const jit of [false, true]) for (const viaSeh of [false, true]) {
    const m = await createMachine(binary, { jit });
    try {
        const mem = m.guest(), v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength), cpu = m.cpu;
        const d: any = new ThunkDispatcher({ add_listener() {} } as any, {} as any);
        Object.assign(d, { cachedMem8: mem, cachedDataView: v, memLength: mem.length,
            sehScratchAddr: 0x500000, sehDispatchStubAddress: LEAF, cachedCpu: cpu });
        d._enterSehCriticalRuntime = d._leaveSehCriticalRuntime = d.captureSehRuntimeDump = () => {};
        (ThunkMemoryManager.prototype as any).writeSehDispatchStub.call({}, mem, LEAF);
        (ThunkMemoryManager.prototype as any).writeVectoredDispatchStub.call({}, mem, LEAF + VEH_STUB_OFFSET);
        const first = LEAF + 0x400, second = LEAF + 0x500, seh = LEAF + 0x600, count = 0x510000;
        // First VEH: increment counter, return CONTINUE_SEARCH using stdcall RET 4.
        mem.set([0xff, 0x05, ...u32(count), 0x31, 0xc0, 0xc2, 4, 0], first);
        // Second VEH: load CONTEXT through its one EXCEPTION_POINTERS argument.
        const loadContext = [0x8b, 0x44, 0x24, 4, 0x8b, 0x40, 4];
        const changeContext = [
            0xc7, 0x80, ...u32(0xb0), ...u32(0x12345678), // ctx.Eax
            0xc7, 0x80, ...u32(0xb8), ...u32(DONE),       // ctx.Eip
            0xc7, 0x80, ...u32(0xc4), ...u32(STACK),      // ctx.Esp
        ];
        mem.set(viaSeh ? [0x31, 0xc0, 0xc2, 4, 0]
            : [...loadContext, ...changeContext, 0xb8, ...u32(0xffffffff), 0xc2, 4, 0], second);
        // SEH: third of four cdecl arguments is CONTEXT; return ContinueExecution (0).
        mem.set([0x8b, 0x44, 0x24, 12, ...changeContext, 0x31, 0xc0, 0xc3], seh);
        const teb = 0x520000, frame = STACK + 0x100;
        cpu.segment_offsets[4] = teb;
        v.setUint32(teb, viaSeh ? frame : 0xffffffff, true);
        v.setUint32(frame, 0xffffffff, true); v.setUint32(frame + 4, seh, true);
        v.setUint32(STACK, DONE, true); m.reg()[4] = STACK;
        d.vectoredExceptions.add(0, first); d.vectoredExceptions.add(0, second);
        assert.ok(d.setupCxxExceptionX86Dispatch(cpu, mem, STACK, 0xe0000001, 0, 0, 0, 16));
        m.state().setUint32(556, v.getUint32(STACK, true), true);
        let crossings = 0;
        m.setFallback((id: number) => {
            assert.equal(id >>> 0, 0x7fff0002); crossings++;
            d._handleSehDispatchResult(cpu);
        });
        m.execute(100000);
        assert.equal(crossings, viaSeh ? 3 : 2);
        assert.equal(v.getUint32(count, true), 1);
        assert.equal(m.reg()[0] >>> 0, 0x12345678);
        assert.equal(m.reg()[4] >>> 0, STACK);
        assert.equal(d.getSehDispatchDepth(), 0);
        console.log(JSON.stringify({ jit, viaSeh, crossings, eax: m.reg()[0] >>> 0, esp: m.reg()[4] >>> 0, ok: true }));
    } finally { m.close(); }
}
function u32(n: number): number[] { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]; }
