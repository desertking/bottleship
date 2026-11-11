import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mdctBackward, mdctShape } from '../../src/worker/core/hle-lib/libs/vorbis-mdct/kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/vorbis-mdct/descriptor';

const cases = readFileSync(join(import.meta.dir, 'fixtures', 'vorbis-mdct-cases.bin'));

interface Case { n: number; cw: number; alias: boolean; mem: Uint8Array; init: number; inp: number; out: number; expected: Uint8Array }

function load(): Case[] {
    const list: Case[] = [];
    const dv = new DataView(cases.buffer, cases.byteOffset, cases.byteLength);
    let p = 0;
    while (p < cases.length) {
        const n = dv.getUint32(p, true), cw = dv.getUint32(p + 4, true), alias = dv.getUint32(p + 8, true) === 1;
        p += 16;
        const mem = new Uint8Array(0x10000);
        const m = new DataView(mem.buffer);
        const init = 0x1000, trig = 0x2000, bitrev = trig + 5 * n, inp = 0x6000, out = alias ? inp : 0x9000;
        mem.set(cases.subarray(p, p + 0x14), init); p += 0x14;
        m.setUint32(init + 8, trig, true);
        m.setUint32(init + 0xc, bitrev, true);
        mem.set(cases.subarray(p, p + 5 * n), trig); p += 5 * n;
        mem.set(cases.subarray(p, p + n), bitrev); p += n;
        mem.set(cases.subarray(p, p + 4 * n), inp); p += 4 * n;
        mem.set(cases.subarray(p, p + 4 * n), out); p += 4 * n;
        const expected = cases.subarray(p, p + 4 * n); p += 4 * n;
        list.push({ n, cw, alias, mem, init, inp, out, expected });
    }
    return list;
}

describe('vorbis-mdct', () => {
    test('matches the guest function bit for bit under both precision controls, in place and not', () => {
        const list = load();
        expect(list.length).toBe(12);
        expect(list.filter(c => c.alias).length).toBe(6);
        for (const c of list) {
            const before = c.mem.slice();
            expect(mdctShape(c.mem, c.init, c.inp, c.out)).toBe(c.n);
            const got = mdctBackward(c.mem, c.init, c.inp, c.out, c.n, (c.cw & 0x300) === 0);
            expect(Buffer.from(got).equals(Buffer.from(c.expected))).toBe(true);
            expect(Buffer.from(c.mem).equals(Buffer.from(before))).toBe(true);
        }
    });

    test('turns down what the translation does not cover', () => {
        const c = load()[0]!;
        const m = new DataView(c.mem.buffer);
        expect(mdctShape(c.mem, c.init + 1, c.inp, c.out)).toBe(0);
        expect(mdctShape(c.mem, c.init, c.inp, c.inp + 8)).toBe(0);
        expect(mdctShape(c.mem, c.init, 0, c.out)).toBe(0);
        m.setInt32(c.init + 4, 5, true);
        expect(mdctShape(c.mem, c.init, c.inp, c.out)).toBe(0);
        m.setInt32(c.init + 4, 6, true);
        m.setInt32(c.init, 96, true);
        expect(mdctShape(c.mem, c.init, c.inp, c.out)).toBe(0);
        m.setInt32(c.init, 64, true);
        m.setUint32(c.init + 8, 0xfff0, true);
        expect(mdctShape(c.mem, c.init, c.inp, c.out)).toBe(0);
    });

    test('recognises the build by content at any address', () => {
        const body = new Uint8Array(__test.BODY_LEN);
        body.set(__test.PREFIX, 0);
        const dv = new DataView(body.buffer);
        for (const [off] of __test.CONSTANT_OPERANDS) dv.setUint32(off, 0x12345678, true);
        expect(__test.bodyMatches(body, () => 0)).toBe(false);
        expect(__test.PREFIX.length).toBe(64);
        expect(__test.CONSTANT_OPERANDS.length).toBe(24);
    });
});
