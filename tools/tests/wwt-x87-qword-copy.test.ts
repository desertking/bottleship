import { expect, test } from "bun:test";
import { BottleShipMachine } from "../../src/worker/wwt/machine";
import { WwtCompiler } from "../../src/worker/wwt/translator";

const pc = 0x20000;
const stack = 0x54000;
const src = 0x30000;
const dst = 0x31000;

const delphiMove = [
    0x39, 0xd0, 0x74, 0x31, 0x83, 0xf9, 0x20, 0x77, 0x7c, 0x83, 0xe9, 0x08, 0x7f, 0x07, 0xcc, 0xcc,
    0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xdf, 0x2c, 0x01, 0xdf, 0x28, 0x83, 0xf9, 0x08, 0x7e, 0x11, 0xdf,
    0x68, 0x08, 0x83, 0xf9, 0x10, 0x7e, 0x06, 0xdf, 0x68, 0x10, 0xdf, 0x7a, 0x10, 0xdf, 0x7a, 0x08,
    0xdf, 0x3a, 0xdf, 0x3c, 0x11, 0xc3,
];

const cases: Array<[string, number[]]> = [
    ["fild; fistp", [0xdf, 0x28, 0xdf, 0x3a, 0xc3]],
    ["fild; cmp; fistp", [0xdf, 0x28, 0x83, 0xf9, 0x08, 0xdf, 0x3a, 0xc3]],
    ["fild; jmp; fistp", [0xdf, 0x28, 0xeb, 0x00, 0xdf, 0x3a, 0xc3]],
    ["Delphi 7 FastCode Move, 11 bytes", delphiMove],
];

for (const [compilerFile, flat] of [["wwt_abi11.wasm", true], ["wwt_wasm.wasm", false]] as const) {
    for (const [name, code] of cases) {
        test(`${compilerFile}: ${name} copies a qword exactly`, async () => {
            const dir = process.env.WWT_PROVIDER_DIR;
            const bytes = await Bun.file(dir ? `${dir}/${compilerFile}` : new URL(`../../public/wwt-provider/${compilerFile}`, import.meta.url)).arrayBuffer();
            const machine = new BottleShipMachine(await WwtCompiler.fromBytes(bytes, flat), 4 << 20);
            await machine.init();
            const cpu = machine.newCpu();
            const memory = new Uint8Array(machine.memory.buffer);
            const words = new Uint32Array(machine.memory.buffer);
            const A = machine.abi.cpu;
            const text = new TextEncoder().encode("TRUNNERFORM");
            memory.fill(0, src, src + 32);
            memory.fill(0xee, dst, dst + 32);
            memory.set(text, src);
            memory.set(code, pc);
            words[(cpu + A.PREEMPT_AT) >>> 2] = 0x70000000;
            words[(cpu + A.GPR) >>> 2] = src;
            words[(cpu + A.GPR + 4) >>> 2] = 11;
            words[(cpu + A.GPR + 8) >>> 2] = dst;
            words[(cpu + A.GPR + 16) >>> 2] = stack;
            words[stack >>> 2] = machine.stopAddress;
            expect(machine.run(cpu, pc)).toBe(machine.stopAddress);
            const n = code === delphiMove ? 11 : 8;
            expect(new TextDecoder().decode(memory.subarray(dst, dst + n))).toBe("TRUNNERFORM".slice(0, n));
        });
    }
}
