/**
 * Bounding box of a posed Granny model, as a mingw-built title computes it once per
 * visible model per frame:
 *
 *   for each part of the model (0x6c bytes each, count at model+4, array at model+8)
 *     for each mesh of the part (0x20 bytes each, count at part+0x4c, array at part+0x50)
 *       for each bone binding b of the mesh (0x24 bytes each, count at mesh+0x1c, array at mesh+0x20)
 *         W   = world pose matrix of bone  indices[b]      (4x4, 64 bytes)
 *         box = transform(W row 3, upper 3x3 of W, binding min, binding max)
 *         out = first ? box : union(out, box)
 *
 * The union keeps the old minimum unless the new one compares below it or unordered, and
 * the old maximum unless the new one compares above it. Nothing is written for a model
 * without bindings.
 */

import type { DeformViews } from '../granny-deform/kernel';
import { deformViews } from '../granny-deform/kernel';
import { aabbInputsFinite, aabbKernel, aabbResult, decodeAabbArgs } from '../granny-deform/aabb-kernel';

export const MODEL_PARTS = 0x4;
export const MODEL_PART_ARRAY = 0x8;
export const PART_SIZE = 0x6c;
export const PART_WORLD_POSE = 0x48;
export const PART_MESHES = 0x4c;
export const PART_MESH_ARRAY = 0x50;
export const ENTRY_SIZE = 0x20;
export const ENTRY_MESH = 0x4;
export const ENTRY_BINDING = 0x8;
export const MESH_BONES = 0x1c;
export const MESH_BONE_ARRAY = 0x20;
export const BONE_SIZE = 0x24;
export const BONE_MIN = 0x4;
export const BONE_MAX = 0x10;
export const BINDING_INDICES = 0x14;
export const POSE_COUNT = 0x0;
export const POSE_MATRICES = 0x4;
export const BOX_LEN = 24;
const MAX_BINDINGS = 1 << 16;

const T = 0, M = 12, LO = 48, HI = 60;
const stage = deformViews(new Uint8Array(72))!;
const stageArgs = [T, M, LO, HI];
const stageDecoded = decodeAabbArgs(stageArgs);
const part = new Float32Array(aabbResult.buffer, aabbResult.byteOffset, 6);
const partBits = new Uint32Array(aabbResult.buffer, aabbResult.byteOffset, 6);
const union = new Float32Array(6);
const unionBits = new Uint32Array(union.buffer);

/** The box of the last modelBox call that returned a positive count. */
export const modelBoxResult = new Uint8Array(union.buffer);

export const modelBoxCounters = {
    calls: 0,
    bindings: 0,
    declined: 0,
    declinedRounding: 0,
    reset(): void { this.calls = 0; this.bindings = 0; this.declined = 0; this.declinedRounding = 0; },
};

/**
 * Number of bindings folded into modelBoxResult, 0 for a model without any, or -1 when
 * the guest function has to run itself (a pointer outside memory or unaligned, a bone
 * index past the pose, a value that is not finite).
 */
export function modelBox(v: DeformViews, model: number): number {
    const U = v.u32;
    const limit = v.u8.length;
    if ((model & 3) !== 0 || model === 0 || model + 12 > limit) return -1;
    const parts = U[(model + MODEL_PARTS) >>> 2] | 0;
    if (parts <= 0) return 0;
    const partArray = U[(model + MODEL_PART_ARRAY) >>> 2];
    if ((partArray & 3) !== 0 || partArray === 0 || partArray + parts * PART_SIZE > limit) return -1;
    let folded = 0;
    for (let p = 0; p < parts; p++) {
        const pa = partArray + p * PART_SIZE;
        const meshes = U[(pa + PART_MESHES) >>> 2] | 0;
        if (meshes <= 0) continue;
        const entries = U[(pa + PART_MESH_ARRAY) >>> 2];
        const pose = U[(pa + PART_WORLD_POSE) >>> 2];
        if ((entries & 3) !== 0 || entries === 0 || entries + meshes * ENTRY_SIZE > limit) return -1;
        if ((pose & 3) !== 0 || pose === 0 || pose + 8 > limit) return -1;
        const poseCount = U[(pose + POSE_COUNT) >>> 2] | 0;
        const matrices = U[(pose + POSE_MATRICES) >>> 2];
        if ((matrices & 3) !== 0 || matrices === 0 || poseCount < 0 || matrices + poseCount * 64 > limit) return -1;
        for (let m = 0; m < meshes; m++) {
            const entry = entries + m * ENTRY_SIZE;
            const mesh = U[(entry + ENTRY_MESH) >>> 2];
            if ((mesh & 3) !== 0 || mesh === 0 || mesh + MESH_BONE_ARRAY + 4 > limit) return -1;
            const bones = U[(mesh + MESH_BONES) >>> 2] | 0;
            if (bones <= 0) continue;
            if (bones > MAX_BINDINGS) return -1;
            const boneArray = U[(mesh + MESH_BONE_ARRAY) >>> 2];
            const binding = U[(entry + ENTRY_BINDING) >>> 2];
            if ((boneArray & 3) !== 0 || boneArray === 0 || boneArray + bones * BONE_SIZE > limit) return -1;
            if ((binding & 3) !== 0 || binding === 0 || binding + BINDING_INDICES + 4 > limit) return -1;
            const indices = U[(binding + BINDING_INDICES) >>> 2];
            if ((indices & 3) !== 0 || indices === 0 || indices + bones * 4 > limit) return -1;
            for (let b = 0; b < bones; b++) {
                const index = U[(indices >>> 2) + b] | 0;
                if (index < 0 || index >= poseCount) return -1;
                const w = (matrices >>> 2) + index * 16;
                const bone = (boneArray + b * BONE_SIZE) >>> 2;
                const S = stage.u32;
                S[0] = U[w + 12]; S[1] = U[w + 13]; S[2] = U[w + 14];
                S[3] = U[w]; S[4] = U[w + 1]; S[5] = U[w + 2];
                S[6] = U[w + 4]; S[7] = U[w + 5]; S[8] = U[w + 6];
                S[9] = U[w + 8]; S[10] = U[w + 9]; S[11] = U[w + 10];
                S[12] = U[bone + 1]; S[13] = U[bone + 2]; S[14] = U[bone + 3];
                S[15] = U[bone + 4]; S[16] = U[bone + 5]; S[17] = U[bone + 6];
                if (!aabbInputsFinite(stage, stageDecoded)) return -1;
                aabbKernel(stage, null, stageArgs);
                if (folded === 0) {
                    unionBits[0] = partBits[0]; unionBits[1] = partBits[1]; unionBits[2] = partBits[2];
                    unionBits[3] = partBits[3]; unionBits[4] = partBits[4]; unionBits[5] = partBits[5];
                } else {
                    if (!(part[0] >= union[0])) unionBits[0] = partBits[0];
                    if (!(part[1] >= union[1])) unionBits[1] = partBits[1];
                    if (!(part[2] >= union[2])) unionBits[2] = partBits[2];
                    if (part[3] > union[3]) unionBits[3] = partBits[3];
                    if (part[4] > union[4]) unionBits[4] = partBits[4];
                    if (part[5] > union[5]) unionBits[5] = partBits[5];
                }
                folded++;
            }
        }
    }
    return folded;
}

