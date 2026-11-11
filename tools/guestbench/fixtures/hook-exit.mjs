/**
 * hook_exit — what one HLE hook crossing costs next to the guest code it replaces.
 *
 * An HLE hook swaps a function body for `mov eax,id; mov edx,port; out dx,eax; ret`, and the
 * port write leaves the compiled module for a JS handler. Whether that is a win depends on
 * the crossing being cheaper than the body it replaces, which a game profile cannot show:
 * the handler timer starts after the exit and stops before the re-entry.
 *
 *   --mode 0   the call lands on a plain leaf of `--work` register instructions
 *   --mode 1   the call lands on the OUT stub; the JS handler only writes EAX
 *   --mode 2   as 1, and the handler also reads `--work` dwords of guest memory
 *
 * `ms/iteration(mode 1) - ms/iteration(mode 0, work 0)` is the crossing itself.
 */

import { mem, reg, EAX, ECX, EDX, EBX } from "../lib/asm.mjs";

const HOOK_PORT = 0xB077;
const HOOK_ID = 0x1234;

export default {
    name: "hook_exit",
    describe: "one call per iteration into a leaf (mode 0) or an OUT-to-JS stub (mode 1/2)",
    defaults: { mode: 0, work: 0 },

    setup(a, ctx) {
        a.movImm(EBX, 0);
        a.movImm(ECX, ctx.ARENA);
    },

    body(a) {
        a.callRel("callee");
        a.alu("add", EBX, reg(EAX));
        a.imulImm(EBX, reg(EBX), 0x01000193);
    },

    tail(a, ctx) {
        a.label("callee");
        if (ctx.params.mode === 0) {
            a.movImm(EAX, HOOK_ID);
            for (let i = 0; i < ctx.params.work; i++) a.aluImm("add", reg(EAX), 0x01010101);
            a.ret();
            return;
        }
        a.movImm(EAX, HOOK_ID);
        a.movImm(EDX, HOOK_PORT);
        a.db(0xef);
        a.ret();
    },

    attach(cpu, ctx) {
        if (ctx.params.mode === 0) return;
        const reg32 = cpu.reg32;
        const work = ctx.params.work | 0;
        const mode = ctx.params.mode;
        cpu.io.register_write(HOOK_PORT, cpu, undefined, undefined, (value) => {
            let acc = value;
            if (mode === 2) {
                const m32 = new Int32Array(cpu.mem8.buffer, ctx.ARENA, work);
                for (let i = 0; i < work; i++) acc = (acc + m32[i]) | 0;
            }
            reg32[0] = acc;
        });
    },

    finish(a, ctx) { a.movTo(ctx.checksum, EBX); },
    perIteration() { return { memoryOps: 2 }; },
};
