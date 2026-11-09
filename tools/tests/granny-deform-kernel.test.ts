import { describe, expect, it } from 'bun:test';
import { LiveShadowView } from '../../src/worker/core/hle-lib/shadow-validator';
import {
    deformCounters, deformKernel, deformKernelDirect, deformViews, dstStride, round24, ShiftedWriteView, srcStride,
} from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/granny-deform/descriptor';

const f = Math.fround;
const C = f(1 / 255);
const SCALE = 0x100;
const IDX = 0x200;
const MATS = 0x400;
const SRC = 0x2000;
const DST = 0x6000;

function setup() {
    const mem = new Uint8Array(0x10000);
    const dv = new DataView(mem.buffer);
    dv.setFloat32(SCALE, C, true);
    return { mem, dv, view: new LiveShadowView(mem) };
}

function writeMatrix(dv: DataView, slot: number, m: number[]) {
    for (let i = 0; i < 16; i++) dv.setFloat32(MATS + slot * 64 + i * 4, m[i], true);
}

function writeVertex(dv: DataView, addr: number, p: number[], w: number[], idx: number[], n: number[], tail: number[]) {
    p.forEach((v, i) => dv.setFloat32(addr + i * 4, v, true));
    w.forEach((v, i) => dv.setUint8(addr + 0x0c + i, v));
    idx.forEach((v, i) => dv.setUint8(addr + 0x10 + i, v));
    n.forEach((v, i) => dv.setFloat32(addr + 0x14 + i * 4, v, true));
    tail.forEach((v, i) => dv.setUint32(addr + 0x20 + i * 4, v, true));
}

/** Row-vector transform the kernel transcribes: P' = P * M (rows 0..2) + row 3. */
function reference(p: number[], n: number[], w: number[], mats: number[][]) {
    let P = [0, 0, 0], N = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
        const m = mats[k];
        const wk = k === 3 ? f(w[k] * C) : w[k] * C;
        const [x, y, z] = p, [nx, ny, nz] = n;
        const t = [
            ((x * m[0] + z * m[8]) + y * m[4] + m[12]) * wk,
            ((z * m[9] + y * m[5]) + x * m[1] + m[13]) * wk,
            ((x * m[2] + z * m[10]) + y * m[6] + m[14]) * wk,
        ];
        const u = [
            ((nx * m[0] + nz * m[8]) + ny * m[4]) * wk,
            ((nz * m[9] + ny * m[5]) + nx * m[1]) * wk,
            ((nx * m[2] + nz * m[10]) + ny * m[6]) * wk,
        ];
        P = P.map((v, i) => f(k === 0 ? t[i] : t[i] + v));
        N = N.map((v, i) => f(k === 0 ? u[i] : u[i] + v));
    }
    return { P, N };
}

const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('granny-deform kernel', () => {
    it('a single full-weight identity bone reproduces the input scaled by 255*f32(1/255)', () => {
        const { mem, dv, view } = setup();
        writeMatrix(dv, 0, ident);
        dv.setUint32(IDX, 0, true);
        writeVertex(dv, SRC, [1.5, -2, 3.25], [255, 0, 0, 0], [0, 0, 0, 0], [0, 1, 0], [0x11111111, 0x22222222]);
        const eax = deformKernel(view, [1, SRC, DST, IDX, MATS, 2], SCALE, false);
        expect(eax).toBe(DST + dstStride(2));
        const s = 255 * C;
        expect(dv.getFloat32(DST, true)).toBe(f(1.5 * s));
        expect(dv.getFloat32(DST + 4, true)).toBe(f(-2 * s));
        expect(dv.getFloat32(DST + 8, true)).toBe(f(3.25 * s));
        expect(dv.getFloat32(DST + 0x10, true)).toBe(f(s));
        expect(dv.getUint32(DST + 0x18, true)).toBe(0x11111111);
        expect(dv.getUint32(DST + 0x1c, true)).toBe(0x22222222);
        void mem;
    });

    it('goes through matrixIndices, uses row 3 as translation, and blends four bones with f32 accumulation', () => {
        const { dv, view } = setup();
        const mats = [
            [0.9, 0.1, -0.2, 0, 0.05, 1.1, 0.3, 0, 0.2, -0.4, 0.95, 0, 10, -3, 7, 1],
            [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0.5, 0.25, -0.125, 1],
            [0.3, 0.7, 0.1, 0, -0.6, 0.2, 0.9, 0, 0.4, 0.5, -0.3, 0, -1, 2, -3, 1],
            [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1e-3, 1e3, 0.333, 1],
        ].map(m => m.map(f));
        mats.forEach((m, i) => writeMatrix(dv, 7 - i, m));
        for (let i = 0; i < 4; i++) dv.setUint32(IDX + 4 * (2 * i + 1), 7 - i, true);
        const p = [f(0.123), f(-4.56), f(7.89)], n = [f(0.267), f(0.534), f(0.801)];
        const w = [100, 77, 50, 28];
        writeVertex(dv, SRC, p, w, [1, 3, 5, 7], n, []);
        writeVertex(dv, SRC + srcStride(0), p.map(v => f(-v)), [255, 0, 0, 0], [3, 3, 3, 3], n, []);
        deformKernel(view, [2, SRC, DST, IDX, MATS, 0], SCALE, false);
        const r = reference(p, n, w, mats);
        for (let i = 0; i < 3; i++) {
            expect(dv.getFloat32(DST + 4 * i, true)).toBe(r.P[i]);
            expect(dv.getFloat32(DST + 0x0c + 4 * i, true)).toBe(r.N[i]);
        }
        const r2 = reference(p.map(v => f(-v)), n, [255, 0, 0, 0], [mats[1], mats[1], mats[1], mats[1]]);
        for (let i = 0; i < 3; i++) expect(dv.getFloat32(DST + 0x18 + 4 * i, true)).toBe(r2.P[i]);
    });

    it('rounds the fourth weight to f32 but not the first three', () => {
        const { dv, view } = setup();
        writeMatrix(dv, 0, ident);
        dv.setUint32(IDX, 0, true);
        const x = f(1234.5678);
        writeVertex(dv, SRC, [x, 0, 0], [0, 0, 0, 3], [0, 0, 0, 0], [0, 0, 0], []);
        deformKernel(view, [1, SRC, DST, IDX, MATS, 0], SCALE, false);
        expect(dv.getFloat32(DST, true)).toBe(f(x * f(3 * C)));
        writeVertex(dv, SRC, [x, 0, 0], [3, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0], []);
        deformKernel(view, [1, SRC, DST, IDX, MATS, 0], SCALE, false);
        expect(dv.getFloat32(DST, true)).toBe(f(x * (3 * C)));
    });

    it('a zero count writes nothing and returns dst', () => {
        const { dv, view } = setup();
        dv.setUint32(DST, 0xCAFEBABE, true);
        expect(deformKernel(view, [0, SRC, DST, IDX, MATS, 2], SCALE)).toBe(DST);
        expect(dv.getUint32(DST, true)).toBe(0xCAFEBABE);
    });
});

describe('granny-deform detection constants', () => {
    it('the prefix ends exactly at the first relocated operand', () => {
        expect(__test.PREFIX.length).toBe(__test.SCALE_OPERANDS[0]);
        expect(__test.PREFIX[__test.PREFIX.length - 2]).toBe(0xd8);
        expect(__test.PREFIX[__test.PREFIX.length - 1]).toBe(0x0d);
    });
    it('the operands sit inside the body and the prologue ends on an instruction boundary', () => {
        for (const off of __test.SCALE_OPERANDS) expect(off + 4).toBeLessThanOrEqual(__test.BODY_LEN);
        expect(Array.from(__test.PREFIX.subarray(0, __test.PROLOGUE_LEN))).toEqual([0x51, 0x8b, 0x4c, 0x24, 0x08]);
    });
});

describe('granny-deform precision control', () => {
    it('round24 matches f32 rounding in the normal range and keeps the exponent outside it', () => {
        expect(round24(1 / 3)).toBe(Math.fround(1 / 3));
        expect(round24(-123.456789)).toBe(Math.fround(-123.456789));
        expect(round24(0)).toBe(0);
        expect(Object.is(round24(-0), -0)).toBe(true);
        const big = 2 ** 200 * (1 + 2 ** -30);
        expect(round24(big)).toBe(2 ** 200);
        const tiny = 2 ** -140 * (1 + 2 ** -24 + 2 ** -40);
        expect(round24(tiny)).toBe(2 ** -140 * (1 + 2 ** -23));
    });

    it('single precision rounds every product and sum', () => {
        const { dv, view } = setup();
        writeMatrix(dv, 0, [0.1, 0.2, 0.3, 0, 0.4, 0.5, 0.6, 0, 0.7, 0.8, 0.9, 0, 1.1, 1.2, 1.3, 1].map(f));
        dv.setUint32(IDX, 0, true);
        const p = [f(1.7), f(-2.3), f(0.37)];
        writeVertex(dv, SRC, p, [200, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0], []);
        deformKernel(view, [1, SRC, DST, IDX, MATS, 0], SCALE, true);
        const m = Array.from({ length: 16 }, (_, i) => dv.getFloat32(MATS + 4 * i, true));
        const w = f(200 * C);
        const [x, y, z] = p;
        const px = f(f(f(f(f(x * m[0]) + f(z * m[8])) + f(y * m[4])) + m[12]) * w);
        expect(dv.getFloat32(DST, true)).toBe(px);
    });
});

describe('granny-deform direct kernel', () => {
    function fill(expLo: number, expHi: number, seed0: number) {
        const { mem, dv } = setup();
        let seed = seed0;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
        const value = () => {
            const t = rnd();
            if (t < 0.08) return t < 0.04 ? 0 : -0;
            return (rnd() < 0.5 ? -1 : 1) * (1 + rnd()) * 2 ** Math.floor(expLo + rnd() * (expHi - expLo));
        };
        const count = 96, tail = 2;
        for (let i = 0; i < 32; i++) dv.setUint32(IDX + 4 * i, (i * 7) % 24, true);
        for (let i = 0; i < 24 * 16; i++) dv.setFloat32(MATS + 4 * i, value(), true);
        for (let v = 0; v < count; v++) {
            writeVertex(dv, SRC + v * srcStride(tail), [value(), value(), value()],
                [0, 1, 2, 3].map(() => (rnd() < 0.3 ? 0 : (rnd() * 256) | 0)),
                [0, 1, 2, 3].map(() => (rnd() * 32) | 0),
                [value(), value(), value()], [(rnd() * 2 ** 32) >>> 0, v]);
        }
        return { mem, args: [count, SRC, DST, IDX, MATS, tail], len: count * dstStride(tail) };
    }

    for (const [name, lo, hi, allPlain] of [
        ['ordinary magnitudes', -6, 8, true],
        ['the full plain windows', -32, 30, false],
        ['magnitudes far outside the windows', -149, 127, false],
    ] as const) {
        it(`is byte-identical to the exact kernel over ${name}`, () => {
            for (let seed = 1; seed <= 12; seed++) {
                const a = fill(lo, hi, seed), b = fill(lo, hi, seed), c = fill(lo, hi, seed);
                const eax = deformKernel(new LiveShadowView(a.mem), a.args, SCALE, true);
                deformCounters.reset();
                const views = deformViews(b.mem)!;
                expect(deformKernelDirect(new LiveShadowView(b.mem), views, views, 0, b.args, SCALE)).toBe(eax);
                expect(Buffer.compare(a.mem, b.mem)).toBe(0);
                if (allPlain) expect(deformCounters.exactVertices).toBe(0);
                const bytes = new Uint8Array(c.len);
                const shifted = new ShiftedWriteView(new LiveShadowView(c.mem), bytes, -DST);
                expect(deformKernelDirect(shifted, deformViews(c.mem)!, deformViews(bytes)!, -DST, c.args, SCALE)).toBe(eax);
                expect(Buffer.compare(bytes, a.mem.subarray(DST, DST + c.len))).toBe(0);
                expect(c.mem.subarray(DST, DST + c.len).every(v => v === 0)).toBe(true);
            }
        });
    }
});
