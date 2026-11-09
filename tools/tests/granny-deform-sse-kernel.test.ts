import { describe, expect, it } from 'bun:test';
import { deformCounters, deformViews } from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import { deformKernelSse } from '../../src/worker/core/hle-lib/libs/granny-deform/sse-kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/granny-deform/descriptor';

const f = Math.fround;
const SCALE = 0x100;
const IDX = 0x200;
const FRAME = 0x300;
const MATS = 0x400;
const SRC = 0x2000;
const DST = 0x6000;

type Lanes = Float32Array;
const lanes = (a = 0, b = 0, c = 0, d = 0): Lanes => Float32Array.of(a, b, c, d);
const splat = (v: number): Lanes => lanes(v, v, v, v);
const mulps = (a: Lanes, b: Lanes): Lanes => a.map((v, i) => v * b[i]);
const addps = (a: Lanes, b: Lanes): Lanes => a.map((v, i) => v + b[i]);
const shufps = (a: Lanes, b: Lanes, imm: number): Lanes =>
    lanes(a[imm & 3], a[(imm >> 2) & 3], b[(imm >> 4) & 3], b[(imm >> 6) & 3]);

/** The guest loop, one instruction per line, over packed f32 lanes. */
function guest(mem: Uint8Array, count: number): number {
    const dv = new DataView(mem.buffer);
    const row = (m: number, r: number): Lanes => new Float32Array(mem.buffer.slice(m + 16 * r, m + 16 * r + 16));
    let esi = SRC, dst = DST, eax = 0;
    const c = dv.getFloat32(SCALE, true);
    const pair = (ib: number, wb: number): [Lanes, Lanes] => {
        const idx = dv.getUint32(FRAME + 0x24, true);
        const base = dv.getUint32(FRAME + 0x20, true);
        const edi = esi + 0x14;
        const ecx = base + (dv.getUint32(idx + 4 * mem[esi + ib], true) << 6);
        const edx = base + (dv.getUint32(idx + 4 * mem[esi + ib + 1], true) << 6);
        eax = mem[esi + wb];
        const xmm6 = splat(f(f(eax) * c));
        eax = mem[esi + wb + 1];
        const xmm7 = splat(f(f(eax) * c));
        const xform = (m: number): [Lanes, Lanes] => {
            let p = row(m, 3);
            p = addps(p, mulps(splat(dv.getFloat32(esi, true)), row(m, 0)));
            p = addps(p, mulps(splat(dv.getFloat32(esi + 4, true)), row(m, 1)));
            p = addps(p, mulps(splat(dv.getFloat32(esi + 8, true)), row(m, 2)));
            let n = mulps(splat(dv.getFloat32(edi, true)), row(m, 0));
            n = addps(n, mulps(splat(dv.getFloat32(edi + 4, true)), row(m, 1)));
            n = addps(n, mulps(splat(dv.getFloat32(edi + 8, true)), row(m, 2)));
            return [p, n];
        };
        let [xmm0, xmm1] = xform(ecx);
        xmm0 = mulps(xmm0, xmm6);
        xmm1 = mulps(xmm1, xmm6);
        let [xmm2, xmm3] = xform(edx);
        xmm2 = mulps(xmm2, xmm7);
        xmm0 = addps(xmm0, xmm2);
        xmm3 = mulps(xmm3, xmm7);
        xmm1 = addps(xmm1, xmm3);
        return [xmm0, xmm1];
    };
    do {
        const xmm5 = new Uint8Array(mem.buffer.slice(esi + 0x20, esi + 0x28));
        let [xmm0, xmm1] = pair(0x10, 0x0c);
        mem.set(new Uint8Array(xmm0.buffer), FRAME);
        mem.set(new Uint8Array(xmm1.buffer), FRAME + 0x10);
        [xmm0, xmm1] = pair(0x12, 0x0e);
        xmm0 = addps(xmm0, new Float32Array(mem.buffer.slice(FRAME, FRAME + 16)));
        xmm1 = addps(xmm1, new Float32Array(mem.buffer.slice(FRAME + 0x10, FRAME + 0x20)));
        xmm0 = shufps(xmm0, xmm0, 0x24);
        xmm0[0] = xmm1[0];
        xmm0 = shufps(xmm0, xmm0, 0x27);
        xmm1 = shufps(xmm1, xmm1, 0x09);
        mem.set(new Uint8Array(xmm0.buffer), dst);
        mem.set(new Uint8Array(xmm1.buffer).subarray(0, 8), dst + 0x10);
        mem.set(xmm5, dst + 0x18);
        dst += 0x20;
        esi += 0x28;
    } while (--count !== 0);
    return eax;
}

function build(count: number, seed: number, wild: boolean): Uint8Array {
    const mem = new Uint8Array(0x10000);
    const dv = new DataView(mem.buffer);
    let state = seed >>> 0;
    const rnd = (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const value = (): number => {
        if (!wild) return (rnd() - 0.5) * 200;
        const pick = rnd();
        if (pick < 0.1) return 0;
        if (pick < 0.2) return (rnd() - 0.5) * 1e-40;
        if (pick < 0.3) return (rnd() - 0.5) * 1e30;
        if (pick < 0.35) return -0;
        return (rnd() - 0.5) * 2 ** Math.floor(rnd() * 80 - 40);
    };
    dv.setFloat32(SCALE, f(1 / 255), true);
    dv.setUint32(FRAME + 0x20, MATS, true);
    dv.setUint32(FRAME + 0x24, IDX, true);
    for (let i = 0; i < 16; i++) dv.setUint32(IDX + 4 * i, (i * 7 + 3) % 24, true);
    for (let i = 0; i < 24 * 16; i++) dv.setFloat32(MATS + 4 * i, value(), true);
    for (let v = 0; v < count; v++) {
        const s = SRC + v * 0x28;
        for (let i = 0; i < 3; i++) dv.setFloat32(s + 4 * i, value(), true);
        for (let i = 0; i < 4; i++) mem[s + 0x0c + i] = Math.floor(rnd() * 256);
        for (let i = 0; i < 4; i++) mem[s + 0x10 + i] = Math.floor(rnd() * 16);
        for (let i = 0; i < 3; i++) dv.setFloat32(s + 0x14 + 4 * i, value(), true);
        dv.setUint32(s + 0x20, 0x7fc12345 ^ v, true);
        dv.setUint32(s + 0x24, 0xffa00001 + v, true);
    }
    return mem;
}

/** A generated NaN's sign is the host's choice; fold both default NaNs onto one. */
function foldNaN(mem: Uint8Array): Uint8Array {
    const words = new Uint32Array(mem.buffer.slice(mem.byteOffset, mem.byteOffset + mem.byteLength));
    for (let i = 0; i < words.length; i++) if (words[i] === 0xffc00000) words[i] = 0x7fc00000;
    return new Uint8Array(words.buffer);
}

describe('granny-deform SSE kernel', () => {
    for (const [name, count, wild] of [['ordinary data', 300, false], ['extreme data', 300, true], ['one vertex', 1, false]] as const) {
        it(`is byte-identical to the instruction-level model over ${name}`, () => {
            const expected = build(count, 0x1234 + count, wild);
            const actual = expected.slice();
            const eax = guest(expected, count);
            const views = deformViews(actual)!;
            deformCounters.reset();
            const got = deformKernelSse(views, views, 0, views.f32.subarray(FRAME >>> 2, (FRAME >>> 2) + 8), [count, SRC, DST, FRAME], SCALE);
            expect(got).toBe(eax);
            expect(Buffer.from(foldNaN(actual)).equals(Buffer.from(foldNaN(expected)))).toBe(true);
            expect(deformCounters.sseCalls).toBe(1);
            expect(deformCounters.vertices).toBe(count);
        });
    }

    it('writes a shifted destination and a detached scratch for validation runs', () => {
        const expected = build(40, 99, false);
        const live = expected.slice();
        guest(expected, 40);
        const bytes = new Uint8Array(40 * 0x20);
        const scratch = new Float32Array(8);
        const before = live.slice();
        deformKernelSse(deformViews(live)!, deformViews(bytes)!, -DST, scratch, [40, SRC, DST, FRAME], SCALE);
        expect(Buffer.from(live).equals(Buffer.from(before))).toBe(true);
        expect(Buffer.from(bytes).equals(Buffer.from(expected.subarray(DST, DST + 40 * 0x20)))).toBe(true);
        expect(Buffer.from(scratch.buffer).equals(Buffer.from(expected.subarray(FRAME, FRAME + 0x20)))).toBe(true);
    });
});

describe('granny-deform SSE detection constants', () => {
    it('the prefix ends at the first relocated operand and the prologue on an instruction boundary', () => {
        expect(__test.SSE_PREFIX.length).toBe(__test.SSE_SCALE_OPERANDS[0]);
        for (const off of __test.SSE_SCALE_OPERANDS) expect(off + 4).toBeLessThanOrEqual(__test.SSE_BODY_LEN);
        expect(Array.from(__test.SSE_PREFIX.subarray(0, __test.PROLOGUE_LEN))).toEqual([0x55, 0x8b, 0xec, 0x56, 0x57]);
    });
});
