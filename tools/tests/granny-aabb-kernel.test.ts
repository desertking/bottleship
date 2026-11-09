import { describe, expect, it } from 'bun:test';
import { deformViews, round24 } from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import { aabbInputsPlain, aabbKernel, aabbResult, decodeAabbArgs } from '../../src/worker/core/hle-lib/libs/granny-deform/aabb-kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/granny-deform/descriptor';

const f = Math.fround;
const r = round24;
const T = 0x100, M = 0x140, MIN = 0x200, MAX = 0x240;
const FLT_MAX = f(3.4028234663852886e38);

/** The guest function, one x87 instruction per operation, precision control single. */
function guest(mem: Uint8Array): number {
    const dv = new DataView(mem.buffer);
    const g = (a: number): number => dv.getFloat32(a, true);
    const lo = [FLT_MAX, FLT_MAX, FLT_MAX];
    const hi = [-FLT_MAX, -FLT_MAX, -FLT_MAX];
    for (let k = 0; k < 2; k++) {
        for (let b = 0; b < 2; b++) {
            for (let d = 0; d < 2; d++) {
                let s14 = d === 0 ? g(MIN) : g(MAX);
                let s18 = b === 0 ? g(MIN + 4) : g(MAX + 4);
                const z = k === 0 ? g(MIN + 8) : g(MAX + 8);
                const x = s14, y = s18;
                let st = r(z * g(M + 8));
                st = r(st + r(s18 * g(M + 4)));
                st = r(st + r(s14 * g(M)));
                s14 = f(st);
                st = r(x * g(M + 0xc));
                st = r(st + r(z * g(M + 0x14)));
                st = r(st + r(s18 * g(M + 0x10)));
                s18 = f(st);
                st = r(r(x * g(M + 0x18)) + r(y * g(M + 0x1c)));
                st = r(st + r(z * g(M + 0x20)));
                s14 = f(r(s14 + g(T)));
                s18 = f(r(s18 + g(T + 4)));
                const s1c = f(r(st + g(T + 8)));
                const v = [s14, s18, s1c];
                for (let c = 0; c < 3; c++) {
                    lo[c] = lo[c] < v[c] ? lo[c] : v[c];
                    hi[c] = hi[c] > v[c] ? hi[c] : v[c];
                }
            }
        }
    }
    for (let c = 0; c < 3; c++) dv.setFloat32(MIN + 4 * c, lo[c], true);
    for (let c = 0; c < 3; c++) dv.setFloat32(MAX + 4 * c, hi[c], true);
    return dv.getUint32(MAX, true);
}

function build(seed: number, scale: number): Uint8Array {
    const mem = new Uint8Array(0x400);
    const dv = new DataView(mem.buffer);
    let s = seed >>> 0;
    const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 - 0.5; };
    for (let i = 0; i < 3; i++) dv.setFloat32(T + 4 * i, rnd() * scale * 100, true);
    for (let i = 0; i < 9; i++) dv.setFloat32(M + 4 * i, rnd() * 2 * scale, true);
    for (let i = 0; i < 3; i++) {
        const a = rnd() * 50 * scale, b = rnd() * 50 * scale;
        dv.setFloat32(MIN + 4 * i, Math.min(a, b), true);
        dv.setFloat32(MAX + 4 * i, Math.max(a, b), true);
    }
    return mem;
}

const ARGS = [T, M, MIN, MAX];

describe('granny bounding-box transform kernel', () => {
    for (const scale of [1, 1e-3, 1e6, 1e-21, 1e-30]) {
        it(`matches the instruction model at scale ${scale}`, () => {
            for (let seed = 1; seed <= 400; seed++) {
                const a = build(seed * 7919, scale);
                const b = new Uint8Array(a);
                const want = guest(a);
                const views = deformViews(b)!;
                expect(aabbInputsPlain(views, decodeAabbArgs(ARGS))).toBe(true);
                const got = aabbKernel(views, views, ARGS);
                expect(got >>> 0).toBe(want >>> 0);
                expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
            }
        });
    }

    it('keeps signed zeros and leaves memory alone without an output view', () => {
        const a = build(5, 1);
        new DataView(a.buffer).setFloat32(T, -0, true);
        for (let i = 0; i < 9; i++) new DataView(a.buffer).setFloat32(M + 4 * i, i % 2 ? -0 : 0, true);
        const b = new Uint8Array(a);
        const before = new Uint8Array(b);
        const want = guest(a);
        const views = deformViews(b)!;
        const got = aabbKernel(views, null, ARGS);
        expect(Buffer.from(b).equals(Buffer.from(before))).toBe(true);
        expect(got >>> 0).toBe(want >>> 0);
        expect(Buffer.from(aabbResult.slice(0, 12)).equals(Buffer.from(a.slice(MIN, MIN + 12)))).toBe(true);
        expect(Buffer.from(aabbResult.slice(12, 24)).equals(Buffer.from(a.slice(MAX, MAX + 12)))).toBe(true);
    });

    it('rejects inputs that could leave the plain range', () => {
        for (const bad of [NaN, Infinity, -Infinity, 1e19, -1e19]) {
            const a = build(9, 1);
            new DataView(a.buffer).setFloat32(M + 16, bad, true);
            expect(aabbInputsPlain(deformViews(a)!, decodeAabbArgs(ARGS))).toBe(false);
        }
    });

    it('pins the detected body', () => {
        expect(__test.AABB_PREFIX.length).toBe(__test.AABB_MASK.length);
        expect(__test.AABB_BODY_LEN).toBe(0x191);
        expect(__test.AABB_LIMIT_OPERANDS).toEqual([0x4, 0xa]);
    });
});
