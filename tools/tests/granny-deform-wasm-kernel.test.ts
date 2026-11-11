import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { LiveShadowView } from '../../src/worker/core/hle-lib/shadow-validator';
import {
    deformCounters, deformKernelDirect, deformViews, dstStride, srcStride,
} from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import { deformKernelSse } from '../../src/worker/core/hle-lib/libs/granny-deform/sse-kernel';
import {
    deformSseAccel, deformX87Accel, instantiateDeformAccel,
} from '../../src/worker/core/hle-lib/libs/granny-deform/wasm-kernel';

const GUEST_BASE = 0x20000;
const GUEST_LEN = 0x60000;
const SCALE = 0x100, IDX = 0x400, FRAME = 0x900, MATS = 0x1000, SRC = 0x4000, DST = 0x30000;
const BONES = 24;

const wasmBytes = readFileSync(new URL('../../public/granny-kernel.wasm', import.meta.url));
const memory = new WebAssembly.Memory({ initial: (GUEST_BASE + GUEST_LEN) / 65536 + 1 });
const accel = instantiateDeformAccel(wasmBytes, memory);
const guest = new Uint8Array(memory.buffer, GUEST_BASE, GUEST_LEN);

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const ODD = [0, -0, 1e-40, -3e-39, 2 ** -80, 2 ** 31, 1e30, 2 ** -72, 2 ** 30, Infinity, NaN];

function fill(seed: number, stride: number, count: number, opts: { odd: boolean; nan: boolean; zeroWeights: boolean }): Uint8Array {
    const mem = new Uint8Array(GUEST_LEN);
    const dv = new DataView(mem.buffer);
    const rnd = rng(seed);
    const pick = (span: number): number => {
        if (opts.odd && rnd() < 0.03) {
            const v = ODD[Math.floor(rnd() * (opts.nan ? ODD.length : ODD.length - 2))];
            return v;
        }
        return (rnd() - 0.5) * span;
    };
    dv.setFloat32(SCALE, Math.fround(1 / 255), true);
    dv.setUint32(FRAME + 0x20, MATS, true);
    dv.setUint32(FRAME + 0x24, IDX, true);
    for (let i = 0; i < 8; i++) dv.setFloat32(FRAME + 4 * i, rnd(), true);
    for (let i = 0; i < 256; i++) dv.setUint32(IDX + 4 * i, (i * 7) % BONES, true);
    for (let i = 0; i < BONES * 16; i++) dv.setFloat32(MATS + 4 * i, pick(4), true);
    for (let v = 0; v < count; v++) {
        const a = SRC + v * stride;
        for (let i = 0; i < 3; i++) dv.setFloat32(a + 4 * i, pick(200), true);
        for (let i = 0; i < 4; i++) mem[a + 0x0c + i] = opts.zeroWeights && rnd() < 0.4 ? 0 : Math.floor(rnd() * 256);
        for (let i = 0; i < 4; i++) mem[a + 0x10 + i] = Math.floor(rnd() * 256);
        for (let i = 0; i < 3; i++) dv.setFloat32(a + 0x14 + 4 * i, pick(2), true);
        for (let i = 0x20; i < stride; i++) mem[a + i] = Math.floor(rnd() * 256);
    }
    for (let i = DST - 64; i < DST + count * stride + 64; i++) mem[i] = 0xa5;
    return mem;
}

function sameBits(a: Uint8Array, b: Uint8Array, nanLoose: boolean): number {
    const x = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >>> 2);
    const y = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >>> 2);
    const isNan = (u: number): boolean => (u & 0x7f800000) === 0x7f800000 && (u & 0x007fffff) !== 0;
    for (let i = 0; i < x.length; i++) {
        if (x[i] !== y[i] && !(nanLoose && isNan(x[i]) && isNan(y[i]))) return i * 4;
    }
    return -1;
}

describe('granny wasm kernel', () => {
    it('imports the caller memory and owns nothing else', () => {
        const module = new WebAssembly.Module(wasmBytes);
        expect(WebAssembly.Module.imports(module)).toEqual([{ module: 'env', name: 'memory', kind: 'memory' }]);
        expect(WebAssembly.Module.exports(module).map((e) => e.name).sort()).toEqual(['deform_sse', 'deform_x87']);
    });

    it('x87 variant matches the JS kernel bit for bit', () => {
        let exact = 0, vertices = 0;
        for (let seed = 1; seed <= 400; seed++) {
            const tail = seed % 5;
            const count = 1 + (seed * 37) % 300;
            const init = fill(seed, srcStride(tail), count, { odd: seed % 3 === 0, nan: seed % 6 === 0, zeroWeights: seed % 4 === 0 });
            const dst = seed % 7 === 0 ? SRC + 8 * (seed % 5) : seed % 11 === 0 ? SRC - 0x18 : DST;
            const args = [count, SRC, dst, IDX, MATS, tail];
            const ref = init.slice();
            const rv = deformViews(ref)!;
            const refEax = deformKernelDirect(new LiveShadowView(ref), rv, rv, 0, args, SCALE);
            guest.set(init);
            const gv = deformViews(guest)!;
            deformCounters.reset();
            const eax = deformX87Accel(accel, new LiveShadowView(guest), gv, args, SCALE);
            exact += deformCounters.exactVertices;
            vertices += deformCounters.vertices;
            expect(eax).toBe(refEax);
            expect(sameBits(guest, ref, false)).toBe(-1);
            expect(dstStride(tail)).toBe(0x18 + 4 * tail);
        }
        expect(vertices).toBeGreaterThan(40000);
        expect(exact).toBeGreaterThan(100);
        expect(exact).toBeLessThan(vertices / 2);
    });

    it('SSE variant matches the JS kernel, scratch and EAX included', () => {
        for (let seed = 1; seed <= 400; seed++) {
            const count = 1 + (seed * 53) % 300;
            const init = fill(seed + 1000, 0x28, count, { odd: seed % 3 === 0, nan: seed % 6 === 0, zeroWeights: seed % 2 === 0 });
            const args = [count, SRC, DST, FRAME];
            const ref = init.slice();
            const rv = deformViews(ref)!;
            const refEax = deformKernelSse(rv, rv, 0, rv.f32.subarray(FRAME >>> 2, (FRAME >>> 2) + 8), args, SCALE);
            guest.set(init);
            const eax = deformSseAccel(accel, deformViews(guest)!, args, SCALE);
            expect(eax).toBe(refEax);
            expect(sameBits(guest, ref, true)).toBe(-1);
        }
    });

    it('hands a matrix outside memory back to the JS path', () => {
        const init = fill(7, 0x28, 8, { odd: false, nan: false, zeroWeights: false });
        const slot = init[SRC + 3 * 0x28 + 0x10];
        for (let v = 0; v < 3; v++) for (let k = 0; k < 4; k++) if (init[SRC + v * 0x28 + 0x10 + k] === slot) init[SRC + v * 0x28 + 0x10 + k] = slot ^ 1;
        new DataView(init.buffer).setUint32(IDX + 4 * slot, 0x00100000, true);
        guest.set(init);
        const gv = deformViews(guest)!;
        expect(accel.api.deform_sse(GUEST_BASE, GUEST_LEN, 8, SRC, DST, FRAME, Math.fround(1 / 255))).toBe(3);
        guest.set(init);
        expect(accel.api.deform_x87(GUEST_BASE, GUEST_LEN, 8, SRC, DST, IDX, MATS, 2, Math.fround(1 / 255))).toBe(3);
        expect(deformX87Accel(accel, new LiveShadowView(guest), gv, [8, SRC, DST, IDX + GUEST_LEN, MATS, 2], SCALE)).toBeNull();
    });
});
