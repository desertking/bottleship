import { describe, expect, it } from 'bun:test';
import { deformViews, round24 } from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import {
    keyframeCounters, keyframeKernel, keyframePlan, keyframeResult, paramsFinite,
} from '../../src/worker/core/hle-lib/libs/dxa-keyframe/kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/dxa-keyframe/descriptor';

const f = Math.fround;
const r = round24;
const MESH = 0x100, ANIM = 0x200, FRAMES = 0x400, DATA = 0x1000, OUT = 0x8000, SIZE = 0x10000;
const C1 = f(1 / 255), C2 = f(2 / 255);

/** The guest function, one x87 instruction per operation, precision control single. */
function guest(mem: Uint8Array): void {
    const dv = new DataView(mem.buffer);
    const u = (a: number): number => dv.getUint32(a, true);
    const g = (a: number): number => dv.getFloat32(a, true);
    const anim = u(MESH + 0x38), time = u(MESH + 0x28);
    const count = u(anim + 8);
    let first = u(anim + 0x5c);
    const end = u(anim + 0x60);
    let a = anim, dataA = u(anim + 4), b = 0;
    if (end !== first) {
        let last = end - 56;
        let firstT = u(first), lastT = u(last);
        if (time <= firstT) { a = first; dataA = u(first + 0xc); }
        else if (time >= lastT) { a = last; dataA = u(last + 0xc); }
        else {
            let n = (last - first) / 56;
            while (n > 1) {
                let q = Number(BigInt.asUintN(32, BigInt(time - firstT) * BigInt(n)) / BigInt(lastT - firstT)) | 0;
                if (q <= 0) q = 1;
                else if (q >= n) q = n - 1;
                const cand = first + q * 56;
                if (u(cand) > time) { last = cand; lastT = u(cand); n = q; }
                else { first = cand; firstT = u(cand); n -= q; }
            }
            a = first; dataA = u(first + 0xc);
            if (mem[last + 4] !== 0 && ((lastT - u(last + 8)) >>> 0) < time && time < lastT) b = last;
            if (b !== 0) {
                const t = r((lastT - time) / u(last + 8));
                const w = f(r(1 - t));
                const dataB = u(b + 0xc);
                const pa = (k: number): number => g(a + 0x10 + 4 * k), pb = (k: number): number => g(b + 0x10 + 4 * k);
                for (let i = 0; i < count; i++) {
                    const s = dataA + 8 * i, e = dataB + 8 * i, o = OUT + 32 * i;
                    const pos = (lo: number, hi: number, k: number): number => r(
                        r(r(r(r(r(pb(hi) - pb(lo)) * mem[e + k]) * C1) + pb(lo)) * w)
                        + r(r(r(r(r(pa(hi) - pa(lo)) * mem[s + k]) * C1) + pa(lo)) * t));
                    for (let k = 0; k < 3; k++) dv.setFloat32(o + 4 * k, pos(k, k + 3, k), true);
                    for (let k = 3; k < 6; k++) {
                        dv.setFloat32(o + 4 * k,
                            r(r(r(r(mem[e + k] * C2) - 1) * w) + r(r(r(mem[s + k] * C2) - 1) * t)), true);
                    }
                    dv.setFloat32(o + 24, pos(6, 8, 6), true);
                    dv.setFloat32(o + 28, pos(7, 9, 7), true);
                }
                return;
            }
        }
    }
    const p = (k: number): number => g(a + 0x10 + 4 * k);
    for (let i = 0; i < count; i++) {
        const s = dataA + 8 * i, o = OUT + 32 * i;
        const pos = (lo: number, hi: number, k: number): number => r(r(r(r(p(hi) - p(lo)) * mem[s + k]) * C1) + p(lo));
        for (let k = 0; k < 3; k++) dv.setFloat32(o + 4 * k, pos(k, k + 3, k), true);
        for (let k = 3; k < 6; k++) dv.setFloat32(o + 4 * k, r(r(mem[s + k] * C2) - 1), true);
        dv.setFloat32(o + 24, pos(6, 8, 6), true);
        dv.setFloat32(o + 28, pos(7, 9, 7), true);
    }
}

type Shape = 'none' | 'before' | 'after' | 'between' | 'blend';

function build(seed: number, scale: number, shape: Shape): Uint8Array {
    const mem = new Uint8Array(SIZE);
    const dv = new DataView(mem.buffer);
    let s = seed >>> 0;
    const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
    for (let i = DATA; i < OUT; i++) mem[i] = (rnd() * 256) | 0;
    const params = (base: number): void => {
        for (let k = 0; k < 10; k++) dv.setFloat32(base + 0x10 + 4 * k, (rnd() - 0.5) * 100 * scale, true);
    };
    const frames = shape === 'none' ? 0 : 2 + ((rnd() * 9) | 0);
    dv.setUint32(MESH + 0x38, ANIM, true);
    dv.setUint32(ANIM + 4, DATA, true);
    dv.setUint32(ANIM + 8, 1 + ((rnd() * 40) | 0), true);
    dv.setUint32(ANIM + 0x5c, FRAMES, true);
    dv.setUint32(ANIM + 0x60, FRAMES + 56 * frames, true);
    params(ANIM);
    const times: number[] = [];
    let t = (rnd() * 1000) | 0;
    for (let i = 0; i < frames; i++) {
        const prev = t;
        t += 2 + ((rnd() * 5000) | 0);
        times.push(t);
        const fr = FRAMES + 56 * i;
        dv.setUint32(fr, t, true);
        mem[fr + 4] = shape === 'blend' ? 1 : 0;
        dv.setUint32(fr + 8, t - prev + 1, true);
        dv.setUint32(fr + 0xc, DATA + 0x200 * (i + 1), true);
        params(fr);
    }
    let time = 0;
    if (shape === 'before') time = times[0] - (seed & 1);
    else if (shape === 'after') time = times[frames - 1] + (seed & 1);
    else if (frames > 0) time = times[0] + 1 + ((rnd() * (times[frames - 1] - times[0] - 1)) | 0);
    dv.setUint32(MESH + 0x28, time, true);
    return mem;
}

function run(mem: Uint8Array): { blend: boolean } {
    const views = deformViews(mem)!;
    const p = keyframePlan(views, MESH, OUT)!;
    expect(p).not.toBeNull();
    expect(paramsFinite(views, p.a)).toBe(true);
    keyframeKernel(views, views, p);
    return { blend: p.b !== 0 };
}

describe('keyframe vertex decode kernel', () => {
    for (const scale of [1, 1e-2, 1e3, 1e-21, 1e-30, 1e20]) {
        for (const shape of ['none', 'before', 'after', 'between', 'blend'] as Shape[]) {
            it(`matches the instruction model, ${shape}, scale ${scale}`, () => {
                let blends = 0;
                for (let seed = 1; seed <= 120; seed++) {
                    const a = build(seed * 7919, scale, shape);
                    const b = new Uint8Array(a);
                    guest(a);
                    if (run(b).blend) blends++;
                    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
                }
                expect(blends > 0).toBe(shape === 'blend');
            });
        }
    }

    it('takes the plain path at ordinary magnitudes and the exact one outside', () => {
        const before = keyframeCounters.exactCalls;
        run(build(11, 1, 'blend'));
        expect(keyframeCounters.exactCalls).toBe(before);
        run(build(11, 1e-25, 'blend'));
        expect(keyframeCounters.exactCalls).toBe(before + 1);
    });

    it('leaves memory alone without an output view', () => {
        const a = build(5, 1, 'blend');
        const b = new Uint8Array(a);
        const before = new Uint8Array(b);
        guest(a);
        const views = deformViews(b)!;
        const p = keyframePlan(views, MESH, OUT)!;
        keyframeKernel(views, null, p);
        expect(Buffer.from(b).equals(Buffer.from(before))).toBe(true);
        expect(Buffer.from(keyframeResult.slice(0, p.count * 32)).equals(Buffer.from(a.slice(OUT, OUT + p.count * 32)))).toBe(true);
    });

    it('declines headers it cannot take', () => {
        const a = build(3, 1, 'between');
        const dv = new DataView(a.buffer);
        const views = deformViews(a)!;
        dv.setUint32(ANIM + 0x60, FRAMES + 57, true);
        expect(keyframePlan(views, MESH, OUT)).toBeNull();
        dv.setUint32(ANIM + 0x60, FRAMES - 56, true);
        expect(keyframePlan(views, MESH, OUT)).toBeNull();
        dv.setUint32(ANIM + 0x60, FRAMES + 112, true);
        dv.setUint32(ANIM + 8, 0x10001, true);
        expect(keyframePlan(views, MESH, OUT)).toBeNull();
        dv.setUint32(ANIM + 8, 4, true);
        expect(keyframePlan(views, MESH + 1, OUT)).toBeNull();
        expect(keyframePlan(views, SIZE - 0x10, OUT)).toBeNull();
        dv.setFloat32(ANIM + 0x10, NaN, true);
        expect(paramsFinite(views, ANIM)).toBe(false);
    });

    it('pins the detected body', () => {
        expect(__test.PREFIX.length).toBe(76);
        expect(__test.BODY_LEN).toBe(0x830);
        expect(__test.C1_OPERANDS.length + __test.C2_OPERANDS.length).toBe(18);
        expect(__test.PROLOGUE_LEN).toBe(6);
    });
});
