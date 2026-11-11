import { describe, expect, it } from 'bun:test';
import { deformCounters, deformViews, round24 } from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import {
    BONE_STRIDE,
    decodeWorldPoseArgs,
    LOCAL_STRIDE,
    worldPoseComposite,
    worldPoseKernel,
    worldPosePlan,
    worldPoseWorld,
} from '../../src/worker/core/hle-lib/libs/granny-deform/worldpose-kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/granny-deform/descriptor';
import { validatePrologueBytes } from '../../src/worker/core/hle-lib/lib-patcher';

const f = Math.fround;
const r = round24;
const SKEL = 0x100, LP = 0x120, WP = 0x140, OFF = 0x180, BONES = 0x400;
const NAN_BITS = 0xffc00000;

/** The guest's four leaf routines and its two loops, one x87 instruction per operation. */
function guest(mem: Uint8Array, first: number, count: number, offset: number): void {
    const dv = new DataView(mem.buffer);
    const g = (a: number): number => dv.getFloat32(a, true);
    const u = (a: number): number => dv.getUint32(a, true);
    const put = (a: number, v: number): void => {
        if (v !== v) dv.setUint32(a, NAN_BITS, true); else dv.setFloat32(a, v, true);
    };
    const rot = (q: number): number[] => {
        const x = g(q), y = g(q + 4), z = g(q + 8), w = g(q + 12);
        const xx = r(x * x), yy = r(y * y), zz = r(z * z), xy = r(y * x), wz = r(z * w);
        const xz = f(r(z * x)), yz = f(r(z * y)), wx = f(r(w * x)), wy = f(r(y * w));
        const dbl = (v: number): number => r(v + v);
        return [
            r(1 - dbl(r(zz + yy))), dbl(r(xy - wz)), dbl(r(wy + xz)),
            dbl(r(wz + xy)), r(1 - dbl(r(zz + xx))), dbl(r(yz - wx)),
            dbl(r(xz - wy)), dbl(r(wx + yz)), r(1 - dbl(r(yy + xx))),
        ].map(f);
    };
    const mul3 = (A: number[], B: number[]): number[] => [
        r(r(r(A[0] * B[0]) + r(A[2] * B[6])) + r(A[1] * B[3])),
        r(r(r(A[1] * B[4]) + r(B[1] * A[0])) + r(A[2] * B[7])),
        r(r(r(A[2] * B[8]) + r(A[1] * B[5])) + r(B[2] * A[0])),
        r(r(r(A[5] * B[6]) + r(A[4] * B[3])) + r(A[3] * B[0])),
        r(r(r(A[4] * B[4]) + r(A[5] * B[7])) + r(A[3] * B[1])),
        r(r(r(A[5] * B[8]) + r(A[3] * B[2])) + r(A[4] * B[5])),
        r(r(r(B[6] * A[8]) + r(A[7] * B[3])) + r(B[0] * A[6])),
        r(r(r(A[7] * B[4]) + r(B[7] * A[8])) + r(B[1] * A[6])),
        r(r(r(B[8] * A[8]) + r(B[2] * A[6])) + r(A[7] * B[5])),
    ].map(f);
    const mul4 = (A: number[], B: number[]): number[] => [
        r(r(r(A[0] * B[0]) + r(A[2] * B[8])) + r(A[1] * B[4])),
        r(r(r(A[1] * B[5]) + r(B[1] * A[0])) + r(A[2] * B[9])),
        r(r(r(A[2] * B[10]) + r(A[1] * B[6])) + r(B[2] * A[0])),
        0,
        r(r(r(A[6] * B[8]) + r(A[5] * B[4])) + r(A[4] * B[0])),
        r(r(r(A[5] * B[5]) + r(A[6] * B[9])) + r(A[4] * B[1])),
        r(r(r(A[6] * B[10]) + r(A[4] * B[2])) + r(A[5] * B[6])),
        0,
        r(r(r(B[8] * A[10]) + r(A[9] * B[4])) + r(B[0] * A[8])),
        r(r(r(A[9] * B[5]) + r(B[9] * A[10])) + r(B[1] * A[8])),
        r(r(r(B[10] * A[10]) + r(B[2] * A[8])) + r(A[9] * B[6])),
        0,
        r(r(r(r(A[14] * B[8]) + r(A[12] * B[0])) + r(B[4] * A[13])) + B[12]),
        r(r(r(r(A[14] * B[9]) + r(A[12] * B[1])) + r(A[13] * B[5])) + B[13]),
        r(r(r(r(B[6] * A[13]) + r(B[10] * A[14])) + r(B[2] * A[12])) + B[14]),
        1,
    ].map(f);
    const load = (a: number, n: number): number[] => Array.from({ length: n }, (_, k) => g(a + 4 * k));
    const store = (a: number, m: number[]): void => m.forEach((v, k) => put(a + 4 * k, v));
    const bones = u(SKEL + 8), locals = u(LP + 4), world = u(WP + 4), composite = u(WP + 8);
    let parented = false;
    for (let i = first; i < first + count; i++) {
        const bone = bones + i * BONE_STRIDE;
        const t = locals + i * LOCAL_STRIDE + 8;
        let m = rot(t + 0x10);
        if (u(t) & 4) m = mul3(m, load(t + 0x20, 9));
        const T = [m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, g(t + 4), g(t + 8), g(t + 12), 1];
        const parent = dv.getInt32(bone + 4, true);
        if (parent !== -1) parented = true;
        let w = T;
        if (parented) w = mul4(T, load(world + parent * 64, 16));
        else if (offset) w = mul4(T, load(offset, 16));
        store(world + i * 64, w);
        store(composite + i * 64, mul4(load(bone + 0x4c, 16), load(world + i * 64, 16)));
    }
}

interface Case { mem: Uint8Array; args: number[]; world: number; composite: number; total: number }

function build(seed: number, scale: number, opts: { first?: number; offset?: boolean; roots?: number } = {}): Case {
    let s = seed >>> 0;
    const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 - 0.5; };
    const total = 4 + ((seed >>> 3) % 40);
    const first = Math.min(opts.first ?? 0, total - 1);
    const roots = Math.max(opts.roots ?? 1, first === 0 ? 1 : 0);
    const locals = BONES + total * BONE_STRIDE + 0x40;
    const world = locals + total * LOCAL_STRIDE + 0x40;
    const composite = world + total * 64 + 0x40;
    const mem = new Uint8Array(composite + total * 64 + 0x100);
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < mem.length; i += 4) dv.setFloat32(i, rnd() * 3, true);
    dv.setUint32(SKEL + 8, BONES, true);
    dv.setUint32(LP, total, true); dv.setUint32(LP + 4, locals, true);
    dv.setUint32(WP, total, true); dv.setUint32(WP + 4, world, true); dv.setUint32(WP + 8, composite, true);
    for (let i = 0; i < total; i++) {
        const bone = BONES + i * BONE_STRIDE;
        dv.setInt32(bone + 4, i < roots ? -1 : Math.max(0, i - 1 - (Math.abs(rnd() * 8) | 0)), true);
        for (let k = 0; k < 16; k++) dv.setFloat32(bone + 0x4c + 4 * k, rnd() * 4 * scale, true);
        const t = locals + i * LOCAL_STRIDE + 8;
        dv.setUint32(t, (Math.abs(rnd() * 16) | 0), true);
        for (let k = 0; k < 3; k++) dv.setFloat32(t + 4 + 4 * k, rnd() * 50 * scale, true);
        for (let k = 0; k < 4; k++) dv.setFloat32(t + 0x10 + 4 * k, rnd() * 2 * scale, true);
        for (let k = 0; k < 9; k++) dv.setFloat32(t + 0x20 + 4 * k, rnd() * 3 * scale, true);
    }
    for (let k = 0; k < 16; k++) dv.setFloat32(OFF + 4 * k, rnd() * 5 * scale, true);
    return { mem, args: [SKEL, first, total - first, LP, opts.offset ? OFF : 0, WP], world, composite, total };
}

function check(c: Case): void {
    const want = new Uint8Array(c.mem);
    guest(want, c.args[1], c.args[2], c.args[4]);
    const views = deformViews(c.mem)!;
    const plan = worldPosePlan(views, decodeWorldPoseArgs(c.args));
    expect(plan).not.toBeNull();
    worldPoseKernel(views, views, plan!);
    expect(Buffer.from(c.mem).equals(Buffer.from(want))).toBe(true);
}

describe('granny world-pose kernel', () => {
    for (const scale of [1, 1e-3, 1e5, 1e-12, 1e-22, 1e18]) {
        it(`matches the instruction model at scale ${scale}`, () => {
            for (let seed = 1; seed <= 120; seed++) {
                check(build(seed * 7919, scale, { offset: seed % 2 === 0, roots: 1 + (seed % 5 === 0 ? 2 : 0) }));
            }
        });
    }

    it('reads parents below the range from the world array', () => {
        for (let seed = 1; seed <= 60; seed++) check(build(seed * 104729, 1, { first: 1 + (seed % 9), offset: seed % 3 === 0 }));
    });

    it('handles a range of roots only', () => {
        for (let seed = 1; seed <= 20; seed++) check(build(seed * 31, 1, { roots: 99, offset: seed % 2 === 0 }));
    });

    it('leaves memory alone without an output view and keeps the result', () => {
        const c = build(77, 1, { offset: true });
        const want = new Uint8Array(c.mem);
        guest(want, c.args[1], c.args[2], c.args[4]);
        const before = new Uint8Array(c.mem);
        const views = deformViews(c.mem)!;
        worldPoseKernel(views, null, worldPosePlan(views, decodeWorldPoseArgs(c.args))!);
        expect(Buffer.from(c.mem).equals(Buffer.from(before))).toBe(true);
        const len = c.total * 64;
        expect(Buffer.from(worldPoseWorld.slice(0, len)).equals(Buffer.from(want.slice(c.world, c.world + len)))).toBe(true);
        expect(Buffer.from(worldPoseComposite.slice(0, len)).equals(Buffer.from(want.slice(c.composite, c.composite + len)))).toBe(true);
    });

    it('rejects calls the guest would not run as two plain loops', () => {
        const plan = (c: Case): unknown => worldPosePlan(deformViews(c.mem)!, decodeWorldPoseArgs(c.args));
        const dvOf = (c: Case): DataView => new DataView(c.mem.buffer);
        let c = build(5, 1);
        c.args[2] = c.total + 1;
        expect(plan(c)).toBeNull();
        c = build(5, 1);
        c.args[2] = 0;
        expect(plan(c)).toBeNull();
        c = build(5, 1);
        c.args[1] = -1;
        expect(plan(c)).toBeNull();
        c = build(5, 1);
        dvOf(c).setInt32(BONES + 3 * BONE_STRIDE + 4, -1, true);
        expect(plan(c)).toBeNull();
        c = build(5, 1);
        dvOf(c).setInt32(BONES + 3 * BONE_STRIDE + 4, 3, true);
        expect(plan(c)).toBeNull();
        c = build(5, 1);
        dvOf(c).setUint32(WP + 8, dvOf(c).getUint32(WP + 4, true) + 32, true);
        expect(plan(c)).toBeNull();
        c = build(5, 1);
        dvOf(c).setUint32(WP + 4, dvOf(c).getUint32(WP + 4, true) + 2, true);
        expect(plan(c)).toBeNull();
        for (const bad of [NaN, Infinity, -Infinity]) {
            c = build(5, 1);
            dvOf(c).setFloat32(BONES + 2 * BONE_STRIDE + 0x4c + 20, bad, true);
            expect(plan(c)).toBeNull();
            c = build(5, 1, { offset: true });
            dvOf(c).setFloat32(OFF + 8, bad, true);
            expect(plan(c)).toBeNull();
        }
    });

    it('pins the detected family and a patchable prologue', () => {
        expect(__test.WORLDPOSE_PREFIX.length).toBe(__test.WORLDPOSE_MASK.length);
        expect(__test.WORLDPOSE_PARTS.reduce((n, p) => n + p.len, 0)).toBe(0x292 + 7 + 8 + 8 + 0x1e + 0xaa + 0xc4 + 0xe7 + 0x14c);
        expect(validatePrologueBytes(__test.WORLDPOSE_PREFIX.slice(0, __test.WORLDPOSE_PROLOGUE_LEN))).toBeNull();
        expect(validatePrologueBytes(__test.WORLDPOSE_PREFIX.slice(0, 5))).not.toBeNull();
    });

    it('takes the plain pass only while no product can leave the normal f32 range', () => {
        const plainRuns = (scale: number): number => {
            const before = deformCounters.worldPosePlain;
            check(build(4242, scale, { offset: true }));
            return deformCounters.worldPosePlain - before;
        };
        expect(plainRuns(1)).toBe(1);
        expect(plainRuns(1e-3)).toBe(1);
        expect(plainRuns(1e-22)).toBe(0);
        expect(plainRuns(1e18)).toBe(0);
    });

    it('redoes only the bones whose products leave the normal f32 range', () => {
        const redone = (patch: (c: Case) => void): number => {
            const c = build(977, 1, { offset: true });
            patch(c);
            const before = deformCounters.worldPoseExactBones;
            check(c);
            return deformCounters.worldPoseExactBones - before;
        };
        expect(redone(() => undefined)).toBe(0);
        expect(redone((c) => {
            const t = BONES + c.total * BONE_STRIDE + 0x40 + (c.total - 1) * LOCAL_STRIDE + 8;
            for (let k = 0; k < 4; k++) new DataView(c.mem.buffer).setFloat32(t + 0x10 + 4 * k, 2 ** -70 * (k + 1), true);
        })).toBe(1);
        expect(redone((c) => {
            const t = BONES + c.total * BONE_STRIDE + 0x40 + 8;
            for (let k = 0; k < 3; k++) new DataView(c.mem.buffer).setFloat32(t + 4 + 4 * k, 2 ** -30 * (k + 1), true);
        })).toBe(0);
    });

    it('rounds a value just below the smallest normal f32 like the x87 does', () => {
        expect(round24(2 ** -126)).toBe(2 ** -126);
        expect(round24(2 ** -126 * (1 - 2 ** -24 - 2 ** -30))).toBe(2 ** -126 * (1 - 2 ** -24));
        expect(round24(2 ** -126 * (1 - 2 ** -26))).toBe(2 ** -126);
        expect(round24(2 ** -1040 * (1 + 2 ** -24 + 2 ** -30))).toBe(2 ** -1040 * (1 + 2 ** -23));
    });
});
