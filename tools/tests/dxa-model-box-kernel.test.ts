import { describe, expect, test } from 'bun:test';
import { deformViews } from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import { aabbKernel, aabbResult } from '../../src/worker/core/hle-lib/libs/granny-deform/aabb-kernel';
import * as K from '../../src/worker/core/hle-lib/libs/dxa-model-box/kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/dxa-model-box/descriptor';

const BASE = 0x10000;
const SIZE = 0x8000;

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

interface Built { mem: Uint8Array; model: number; bindings: { matrix: number; bone: number }[] }

function build(seed: number, shape: number[][]): Built {
    const r = rng(seed);
    const mem = new Uint8Array(BASE + SIZE);
    const dv = new DataView(mem.buffer);
    let top = BASE + 0x200;
    const alloc = (n: number): number => { const a = top; top = (top + n + 3) & ~3; return a; };
    const model = BASE + 0x100;
    const parts = alloc(Math.max(shape.length, 1) * K.PART_SIZE);
    dv.setUint32(model + K.MODEL_PARTS, shape.length, true);
    dv.setUint32(model + K.MODEL_PART_ARRAY, parts, true);
    const bindings: Built['bindings'] = [];
    shape.forEach((meshes, p) => {
        const part = parts + p * K.PART_SIZE;
        const bones = 6;
        const pose = alloc(8);
        const matrices = alloc(bones * 64);
        for (let i = 0; i < bones * 16; i++) dv.setFloat32(matrices + i * 4, (r() - 0.5) * 20, true);
        dv.setUint32(pose + K.POSE_COUNT, bones, true);
        dv.setUint32(pose + K.POSE_MATRICES, matrices, true);
        dv.setUint32(part + K.PART_WORLD_POSE, pose, true);
        const entries = alloc(Math.max(meshes.length, 1) * K.ENTRY_SIZE);
        dv.setUint32(part + K.PART_MESHES, meshes.length, true);
        dv.setUint32(part + K.PART_MESH_ARRAY, entries, true);
        meshes.forEach((count, m) => {
            const entry = entries + m * K.ENTRY_SIZE;
            const mesh = alloc(0x24);
            const boneArray = alloc(Math.max(count, 1) * K.BONE_SIZE);
            const binding = alloc(0x18);
            const indices = alloc(Math.max(count, 1) * 4);
            dv.setUint32(mesh + K.MESH_BONES, count, true);
            dv.setUint32(mesh + K.MESH_BONE_ARRAY, boneArray, true);
            dv.setUint32(entry + K.ENTRY_MESH, mesh, true);
            dv.setUint32(entry + K.ENTRY_BINDING, binding, true);
            dv.setUint32(binding + K.BINDING_INDICES, indices, true);
            for (let b = 0; b < count; b++) {
                const index = Math.floor(r() * bones);
                dv.setUint32(indices + b * 4, index, true);
                const bone = boneArray + b * K.BONE_SIZE;
                for (let k = 0; k < 3; k++) {
                    const lo = (r() - 0.5) * 10;
                    dv.setFloat32(bone + K.BONE_MIN + k * 4, lo, true);
                    dv.setFloat32(bone + K.BONE_MAX + k * 4, lo + r() * 5, true);
                }
                bindings.push({ matrix: matrices + index * 64, bone });
            }
        });
    });
    return { mem, model, bindings };
}

function reference(built: Built): Float32Array | null {
    let out: Float32Array | null = null;
    const one = new Float32Array(aabbResult.buffer, aabbResult.byteOffset, 6);
    for (const { matrix, bone } of built.bindings) {
        const stage = new Uint8Array(72);
        stage.set(built.mem.subarray(matrix + 48, matrix + 60), 0);
        stage.set(built.mem.subarray(matrix, matrix + 12), 12);
        stage.set(built.mem.subarray(matrix + 16, matrix + 28), 24);
        stage.set(built.mem.subarray(matrix + 32, matrix + 44), 36);
        stage.set(built.mem.subarray(bone + K.BONE_MIN, bone + K.BONE_MIN + 24), 48);
        aabbKernel(deformViews(stage)!, null, [0, 12, 48, 60]);
        if (!out) { out = new Float32Array(one); continue; }
        for (let k = 0; k < 3; k++) {
            if (!(one[k]! >= out[k]!)) out[k] = one[k]!;
            if (one[k + 3]! > out[k + 3]!) out[k + 3] = one[k + 3]!;
        }
    }
    return out;
}

describe('dxa model bounding box', () => {
    test('union over every binding of every mesh of every part', () => {
        for (let seed = 1; seed <= 200; seed++) {
            const r = rng(seed * 7919);
            const shape = Array.from({ length: 1 + Math.floor(r() * 3) },
                () => Array.from({ length: Math.floor(r() * 4) }, () => Math.floor(r() * 6)));
            const built = build(seed, shape);
            const want = reference(built);
            const count = K.modelBox(deformViews(built.mem)!, built.model);
            expect(count).toBe(built.bindings.length);
            if (want) expect([...new Float32Array(K.modelBoxResult.slice().buffer)]).toEqual([...want]);
        }
    });

    test('a model without bindings folds nothing', () => {
        expect(K.modelBox(deformViews(build(1, []).mem)!, BASE + 0x100)).toBe(0);
        expect(K.modelBox(deformViews(build(1, [[0, 0], []]).mem)!, BASE + 0x100)).toBe(0);
    });

    test('declines what the guest has to handle itself', () => {
        const index = build(3, [[2]]);
        const dv = new DataView(index.mem.buffer);
        const pose = dv.getUint32(dv.getUint32(index.model + K.MODEL_PART_ARRAY, true) + K.PART_WORLD_POSE, true);
        dv.setUint32(pose + K.POSE_COUNT, 0, true);
        expect(K.modelBox(deformViews(index.mem)!, index.model)).toBe(-1);

        const nan = build(4, [[1]]);
        new DataView(nan.mem.buffer).setFloat32(nan.bindings[0]!.matrix + 48, NaN, true);
        expect(K.modelBox(deformViews(nan.mem)!, nan.model)).toBe(-1);

        const odd = build(5, [[1]]);
        new DataView(odd.mem.buffer).setUint32(odd.model + K.MODEL_PART_ARRAY, BASE + SIZE - 4, true);
        expect(K.modelBox(deformViews(odd.mem)!, odd.model)).toBe(-1);
        expect(K.modelBox(deformViews(odd.mem)!, odd.model + 1)).toBe(-1);
    });

    test('entry filter runs the pose update in the guest and keeps it out of the validated original', () => {
        const mem = new Uint8Array(0x4000);
        const dv = new DataView(mem.buffer);
        const target = 0x1000, stub = 0x2000, trampoline = 0x2800, update = 0x1800;
        mem.set(__test.PREFIX, target);
        dv.setInt32(target + __test.POSE_CALL + 1, update - (target + __test.POSE_CALL + 5), true);
        const at = __test.buildFilter({
            mem, targetAddress: target, stubAddress: stub, trampolineAddress: trampoline,
            allocCode: () => 0x3000,
        } as never)!;
        expect(at).toBe(0x3000);
        const hex = (from: number, to: number): string =>
            [...mem.subarray(from, to)].map(x => x.toString(16).padStart(2, '0')).join('');
        expect(hex(at, at + 2)).toBe('803d');
        expect(dv.getUint32(at + 2, true)).toBe(at + 108);
        expect(at + 13 + dv.getInt32(at + 9, true)).toBe(at + 71);
        expect(hex(at + 13, at + 23)).toBe('8b442408508b44240850');
        expect(at + 28 + dv.getInt32(at + 24, true)).toBe(update);
        expect(hex(at + 28, at + 33)).toBe('83c40885c0');
        expect(at + 39 + dv.getInt32(at + 35, true)).toBe(at + 71);
        expect(hex(at + 39, at + 55)).toBe('8b44240c508b44240c508b44240c50e8');
        expect(at + 59 + dv.getInt32(at + 55, true)).toBe(stub);
        expect(hex(at + 59, at + 66)).toBe('83c40c85c00f85');
        expect(at + 70 + dv.getInt32(at + 66, true)).toBe(at + 82);
        expect(mem[at + 70]).toBe(0xc3);
        expect(hex(at + 71, at + 78)).toBe('5589e5575653e9');
        expect(at + 82 + dv.getInt32(at + 78, true)).toBe(target + 6);
        expect(hex(at + 82, at + 104)).toBe('5589e557565381ec9c000000c64593018b7d1031c0e9');
        expect(at + 108 + dv.getInt32(at + 104, true)).toBe(target + 0x25);
        expect(mem[at + 108]).toBe(1);
        expect(mem[trampoline]).toBe(0xe9);
        expect(trampoline + 5 + dv.getInt32(trampoline + 1, true)).toBe(at + 82);
    });
});
