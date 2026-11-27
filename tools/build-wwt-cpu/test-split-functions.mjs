import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [referencePath, prototypePath] = process.argv.slice(2);
const entry = 0x20000;
const guestLimit = 4 << 20;
const cpu = 0x1000;
const tick = 0x2000;
const source = 0x40000;
const target = 0x41000;
const stack = 0x42000;
const stop = 0xfffffff0;
const yieldAddress = 0xffffffe0;
const blocks = 800;
const loadsPerBlock = 8;
const repetitions = 6;
const bytes = [0x8b, 0x06, 0x83, 0xff, 0x03, 0x77, 0x07, 0xff, 0x24, 0xbd];
const tablePointer = bytes.length;
const appendWord = word => bytes.push(word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24);
appendWord(0);
const cases = [];
for (let n = 0; n < 5; n++) {
    cases.push(entry + bytes.length);
    bytes.push(0xba);
    appendWord(100 + n);
    bytes.push(0xeb, (4 - n) * 7);
}
const loop = bytes.length;
for (let n = 0; n < blocks; n++) {
    bytes.push(0xf6, 0xc1, 1, 0x74, 1, 0x40, 1, 0xc2);
    for (let load = 0; load < loadsPerBlock; load++) bytes.push(0x03, 0x16);
}
bytes.push(0x49, 0x0f, 0x85);
appendWord(loop - bytes.length - 4);
bytes.push(0x8b, 0xfd);
const faultPc = entry + bytes.length;
bytes.push(0x89, 0x17, 0xc3);
const tableAddress = entry + bytes.length;
for (const address of cases.slice(1)) appendWord(address);
const code = Buffer.from(bytes);
code.writeUInt32LE(tableAddress, tablePointer);

function load(path) {
    return new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)),
        { bottleship: { pe_progress() {} } }).exports;
}

function take(ex, ptr) {
    const length = new DataView(ex.memory.buffer).getUint32(ptr, true);
    const out = Buffer.from(new Uint8Array(ex.memory.buffer, ptr + 4, length));
    ex.wwt_free(ptr, length + 4);
    return out;
}

function translate(ex, flags) {
    const address = ex.wwt_alloc(code.length);
    const seed = ex.wwt_alloc(8);
    new Uint8Array(ex.memory.buffer, address, code.length).set(code);
    new DataView(ex.memory.buffer).setBigUint64(seed, BigInt(entry), true);
    const wasm = take(ex, ex.wwt_translate(address, code.length, BigInt(entry), seed, 1, 0, 0, 1, flags));
    ex.wwt_free(seed, 8);
    ex.wwt_free(address, code.length);
    return wasm;
}

function run(module, abi, index, badPointer, trap, preempt = false, splitTrap = false) {
    const memory = new WebAssembly.Memory({ initial: 144, maximum: 144, shared: true });
    const entries = section(module, "wwt.funcs").readUInt32LE(0);
    const table = new WebAssembly.Table({ initial: 1 + entries, element: "anyfunc" });
    const words = new Uint32Array(memory.buffer);
    const set = (offset, value) => { words[offset >>> 2] = value; };
    const get = offset => words[offset >>> 2];
    const events = [];
    const { GPR, PREEMPT_AT } = abi.cpu;
    const instance = new WebAssembly.Instance(module, { env: {
        memory, table, table_base: 1, lookup_l1: guestLimit + abi.native_layout.LOOKUP_L1,
        guest_limit: guestLimit, store_map: guestLimit + abi.native_layout.STORE_MAP,
        zero_l2: guestLimit + abi.native_layout.ZERO_L2, tick,
        math() { throw new Error("Unexpected math call"); },
        sin: Math.sin, cos: Math.cos,
        fault(_cpu, code, pc, info) { events.push([code >>> 0, pc >>> 0, info >>> 0]); return stop; },
        preempt(_cpu, pc) { events.push(["yield", pc >>> 0]); return 1; },
    } });
    set(cpu + GPR + 4, repetitions);
    set(cpu + GPR + 16, stack);
    set(cpu + GPR + 20, badPointer);
    set(cpu + GPR + 24, source);
    set(cpu + GPR + 28, index);
    set(cpu + PREEMPT_AT, 1);
    set(tick, Number(preempt));
    set(source, 17);
    set(stack, stop);
    const fn = table.get(1);
    let result;
    if (trap) {
        assert.throws(() => fn(cpu), error => {
            assert.ok(error instanceof WebAssembly.RuntimeError);
            const match = error.stack.match(/wasm-function\[\d+\]:(0x[0-9a-f]+)/);
            assert.ok(match);
            assert.equal(Number(match[1]), trapOffset(module));
            if (splitTrap) assert.match(error.stack, /x86_20000_part_[1-9]\d*/);
            return true;
        });
    } else {
        result = fn(cpu) >>> 0;
    }
    return { result, events, stored: get(target), flags: instance.exports.eflags(cpu),
        gpr: Array.from(words.subarray(cpu >>> 2, (cpu >>> 2) + 8)) };
}

const reference = load(referencePath);
const prototype = load(prototypePath);
const abi = JSON.parse(take(reference, reference.wwt_abi()).toString());
const flags = (guestLimit >>> 20) << 16;
const baseline = translate(reference, flags);
const disabled = translate(prototype, flags);
assert.deepEqual(disabled, baseline);
const enabled = translate(prototype, flags | 32);
const before = new WebAssembly.Module(baseline);
const after = new WebAssembly.Module(enabled);
const section = (module, name) => Buffer.from(WebAssembly.Module.customSections(module, name)[0]);
assert.deepEqual(section(after, "wwt.funcs"), section(before, "wwt.funcs"));
assert.deepEqual(section(after, "wwt.meta"), section(before, "wwt.meta"));

for (const index of [0, 1, 2, 3, 4, 0xffffffff]) {
    const expected = run(before, abi, index, target, false);
    let eax = 17;
    let edx = index <= 3 ? 101 + index : 100;
    for (let count = repetitions; count; count--) {
        for (let block = 0; block < blocks; block++) {
            eax += count & 1;
            edx = (edx + eax + loadsPerBlock * 17) >>> 0;
        }
    }
    assert.equal(expected.result, stop);
    assert.equal(expected.stored, edx);
    assert.deepEqual(expected.events, []);
    assert.deepEqual(run(after, abi, index, target, false), expected);
}

const expectedYield = run(before, abi, 1, target, false, true);
assert.equal(expectedYield.result, yieldAddress);
assert.equal(expectedYield.events.length, 1);
assert.equal(expectedYield.events[0][0], "yield");
assert.ok(expectedYield.events[0][1] >= entry + loop && expectedYield.events[0][1] < faultPc);
assert.deepEqual(run(after, abi, 1, target, false, true), expectedYield);

function trapOffset(module) {
    const sites = section(module, "wwt.traps");
    const matching = [];
    for (let i = 4; i < sites.length; i += 16) {
        if (sites.readUInt32LE(i + 4) === faultPc) matching.push(sites.readUInt32LE(i));
    }
    assert.equal(matching.length, 1);
    return matching[0];
}

const expectedFault = run(before, abi, 2, 0, false);
assert.deepEqual(expectedFault.events, [[abi.fault.ACCESS_VIOLATION_WRITE, faultPc, 0]]);
assert.deepEqual(run(after, abi, 2, 0, false), expectedFault);
const trapBeforeBytes = translate(reference, flags | 16);
const trapAfterBytes = translate(prototype, flags | 16 | 32);
const trapBefore = new WebAssembly.Module(trapBeforeBytes);
const trapAfter = new WebAssembly.Module(trapAfterBytes);
assert.deepEqual(run(trapAfter, abi, 2, 0x1000000, true, false, true), run(trapBefore, abi, 2, 0x1000000, true));
for (const [wasm, module] of [[trapBeforeBytes, trapBefore], [trapAfterBytes, trapAfter]]) {
    assert.equal(wasm[trapOffset(module)], 0x36);
}
assert.match(section(after, "name").toString(), /x86_20000_part_1/);
console.log("ABI11 split dispatch: byte-identical default, six switch/loop paths, loop preemption, explicit fault, mapped Wasm trap");
