/**
 * Granny 2 software skinning (granny2.dll, RAD Game Tools) — Guarded Inner-Loop HLE
 * descriptor. GrannyDeformVertices dispatches through the mesh deformer to one of a
 * family of format-specialised leaf kernels; the four-bone position+normal kernel is
 * the hot one in a title that skins its characters on the CPU, at ~330 x87 instructions
 * per vertex.
 *
 * It qualifies under §3.8: a pure-compute leaf (no calls, no state beyond its arguments,
 * reads the vertex/matrix arrays, writes the destination array).
 *
 * THE FUNCTION (cdecl, six arguments, `ret`):
 *   +00 51           push ecx
 *   +01 8b4c2408     mov  ecx,[esp+8]          ; count
 *   +05 8b442410     mov  eax,[esp+0x10]       ; dst  (EAX stays the dst cursor)
 *   +09 33d2 3bca    xor edx,edx / cmp ecx,edx
 *   +0d 56 8b742410  push esi / mov esi,[esp+0x10]  ; src
 *   +12 0f84 ...     je   epilogue
 *       ...          ebp = matrixIndices, edi = matrices, [esp+0x2c] = tail dword count
 * The per-vertex body and its operand order are transcribed in kernel.ts.
 *
 * DETECTION is the function's own first 0x72 bytes (up to the first relocated operand),
 * then the WHOLE body is confirmed by digest with its four relocated `fmul dword [C]`
 * operands zeroed — a sibling kernel with the same prologue but another layout cannot
 * pass. The four operands must name one address holding f32(1/255). Nothing keys on a
 * module name, an image base or a title.
 */

import { Logger, LogCategory } from '../../../logger';
import { Mem } from '../../../memory/mem-accessor';
import { sha256HexSync } from '../../../../savestate/sha256';
import { getFpuControlWord } from '../../../fpu-helper';
import { System } from '../../../system';
import type {
    HookedFunctionMatch,
    LibDescriptor,
    ResolverModuleView,
    ShadowSpec,
    ShadowView,
} from '../../types';
import {
    clearWeightScales,
    decodeArgs,
    deformCounters,
    deformKernel,
    deformKernelDirect,
    deformViews,
    type DeformViews,
    dstStride,
    getWeightScale,
    MAX_TAIL_DWORDS,
    MAX_VERTICES,
    setWeightScale,
    ShiftedWriteView,
    srcStride,
} from './kernel';
import {
    decodeSseArgs,
    deformKernelSse,
    SSE_DST_STRIDE,
    SSE_FRAME_INDICES,
    SSE_FRAME_MATRICES,
    SSE_SCRATCH_LEN,
    SSE_SRC_STRIDE,
} from './sse-kernel';
import { aabbInputsFinite, aabbKernel, aabbResult, decodeAabbArgs, setAabbVariant } from './aabb-kernel';
import {
    decodeWorldPoseArgs,
    worldPoseComposite,
    worldPoseKernel,
    worldPosePlan,
    type WorldPosePlan,
    worldPoseWorld,
} from './worldpose-kernel';
import { LiveShadowView } from '../../shadow-validator';
import {
    deformAccelFor, deformAccelState, deformSseAccel, deformX87Accel, loadDeformAccel, resetDeformAccel,
} from './wasm-kernel';

const FN = 'granny_deform_pwn343_pn33';
const FN_SSE = 'granny_deform_pwn343_pn33_sse';

function hexPattern(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

const PREFIX = hexPattern(
    '518b4c24088b44241033d23bca568b7424100f84d203000053558b6c2420578b7c2428894c24'
    + '10895008895004891089500c895014895010d9068b4e14d94604894c241cd946088b4e18894c'
    + '24188b4e1c894c242033c98a4e108b4c8d00c1e10603cf33db8a5e0c895c2428db442428d80d');
const BODY_LEN = 0x3ed;
const SCALE_OPERANDS = [0x72, 0x13d, 0x219, 0x2f5];
const BODY_SHA256 = 'de0c210bbee42ab970fc88f0c7724164b379d8db1b1cc46a63ebc716bc80b109';
const PROLOGUE_LEN = 5;
const SSE_PREFIX = hexPattern(
    '558bec5657535156578b750c8b5d14908d7e140f126e208b432433c98a4e108b0c88c1e10603'
    + '4b2033d28a56118b1490c1e20603532033c08a460cf30f2af0f30f5935');
const SSE_BODY_LEN = 0x286;
const SSE_SCALE_OPERANDS = [0x43, 0x56, 0x15d, 0x170];
const SSE_CORE_AT = 0x10;
const SSE_CORE_END = 0x27e;
const SSE_CORE_SHA256 = '855ab07b711a4a6a3fd4077d88872385742a2bcbc49d67100205dae0066ca87e';
const SSE_MASK = 'xxx' + '?'.repeat(SSE_CORE_AT - 3) + 'x'.repeat(SSE_PREFIX.length - SSE_CORE_AT);
const SSE_ARG_LOADS = hexPattern('8b750c8b5d14');
const WEIGHT_SCALE = Math.fround(1 / 255);
const FN_AABB = 'granny_aabb_transform';
const AABB_PREFIX = hexPattern(
    '83ec28a100000000d9050000000053d9e055d954242c8b6c2440d95424288bd0d95c2424568b7424388bc8'
    + '8954241c8b54243c5789442428894c2424c7442410');
const AABB_MASK = 'xxxx????xx????' + 'x'.repeat(AABB_PREFIX.length - 14);
const AABB_BODY_LEN = 0x191;
const AABB_LIMIT_OPERANDS = [0x4, 0xa];
const AABB_BODY_SHA256 = 'd3d7d15730fa2980a3923a209dbc9c1f92154b593cde445f2abce59bbc7ad68f';
const AABB_PROLOGUE_LEN = 8;
const FN_AABB_B = 'granny_aabb_transform_b';
const AABB_B_PREFIX = hexPattern(
    '83ec28d905000000008b4c2430538b5c243c558b6c243c568b74243857c7442428ffff7f7fc7442424ffff7f7f'
    + 'c7442420ffff7f7fc7442430ffff7fffc74424');
const AABB_B_MASK = 'xxxxx????' + 'x'.repeat(AABB_B_PREFIX.length - 9);
const AABB_B_BODY_LEN = 0x1e2;
const AABB_B_LIMIT_OPERAND = 5;
const AABB_B_BODY_SHA256 = '557e8579fba3539f531b34f90b176c36c8f9ff64cb62c02e231c7bb85836c5f1';
const AABB_B_PROLOGUE_LEN = 9;
let aabbEntry = 0;

/** Entry of the verified bounding-box transform, or 0 while none has been identified. */
export function grannyBoxTransformEntry(): number {
    return aabbEntry;
}
const FLT_MAX = Math.fround(3.4028234663852886e38);

const FN_WORLDPOSE = 'granny_build_world_pose';
const WORLDPOSE_PREFIX = hexPattern(
    '8a0d5863051083ec585355b00184c85657751c8ad90ad868dc5e0310881d58630510e8f9bbffff83c404a354630510'
    + '8b2d0c440310a154630510896c2418a30c4403100f31894424');
const WORLDPOSE_MASKED = [0x2, 0x18, 0x1e, 0x23, 0x2b, 0x31, 0x36, 0x3f];
const WORLDPOSE_MASK = (() => {
    const m = new Array<string>(WORLDPOSE_PREFIX.length).fill('x');
    for (const off of WORLDPOSE_MASKED) m.fill('?', off, off + 4);
    return m.join('');
})();
const WORLDPOSE_FLAG_OPERANDS = [0x2, 0x1e];
const WORLDPOSE_SLOT_OPERANDS = [0x2b, 0x36];
const WORLDPOSE_ONE_OPERANDS = [0x58, 0x83, 0xb7];
const WORLDPOSE_QUAT_PART = 6;
interface WorldPosePart {
    via: [number, number] | null;
    rel: number;
    len: number;
    relocs: number[];
    calls: [number, number][];
}
const WORLDPOSE_PARTS: WorldPosePart[] = [
    {
        via: null, rel: 0, len: 0x292,
        relocs: [0x2, 0x18, 0x1e, 0x2b, 0x31, 0x36, 0x3f, 0x1f0, 0x1f5, 0x225, 0x22a, 0x245, 0x276],
        calls: [
            [0x23, -1], [0x66, 1], [0x88, 2], [0xae, 3], [0xe5, 4], [0xfe, 5], [0x111, 8], [0x11d, 5], [0x12b, 8],
            [0x17e, 4], [0x189, 5], [0x1a1, 8], [0x1a9, 8], [0x1fe, -1], [0x217, 1], [0x233, -1],
        ],
    },
    { via: [0, 0x66], rel: -0x218e0, len: 7, relocs: [], calls: [] },
    { via: [0, 0x88], rel: -0xb4e0, len: 8, relocs: [], calls: [] },
    { via: [0, 0xae], rel: -0x23b30, len: 8, relocs: [], calls: [] },
    { via: [0, 0xe5], rel: -0xe450, len: 0x1e, relocs: [], calls: [] },
    { via: [0, 0xfe], rel: -0x243b0, len: 0xaa, relocs: [], calls: [[0x13, 6], [0x2f, 7]] },
    { via: [5, 0x13], rel: -0xd2e0, len: 0xc4, relocs: WORLDPOSE_ONE_OPERANDS, calls: [] },
    { via: [5, 0x2f], rel: -0xd830, len: 0xe7, relocs: [], calls: [] },
    { via: [0, 0x111], rel: -0xd650, len: 0x14c, relocs: [], calls: [] },
];
const WORLDPOSE_SHA256 = 'fafc517f1a4423b55d207cb96ee6a975c59d6c36edb1090deddb81366fd46376';
const WORLDPOSE_PROLOGUE_LEN = 6;

interface WorldPoseSite { flag: number; slot: number }
const worldPoseSites = new Map<number, WorldPoseSite>();

const generic = (): boolean => (globalThis as { __grannyGeneric?: boolean }).__grannyGeneric !== false;

interface TextSection { base: number; bytes: Uint8Array }

function textOf(view: ResolverModuleView): TextSection | null {
    const section = view.getSection('.text');
    if (!section) return null;
    const base = view.module.baseAddress + section.virtualAddress;
    const bytes = Mem.readBytes(base, section.virtualSize);
    return bytes ? { base, bytes } : null;
}

function scanAll(bytes: Uint8Array, pattern: Uint8Array, mask: string, limit = 2): number[] {
    const hits: number[] = [];
    const plen = pattern.length;
    const first = pattern[0];
    const end = bytes.length - plen;
    for (let i = 0; i <= end; i++) {
        if (bytes[i] !== first) continue;
        let j = 1;
        for (; j < plen; j++) if (mask.charCodeAt(j) === 0x78 && bytes[i + j] !== pattern[j]) break;
        if (j === plen) {
            hits.push(i);
            if (hits.length >= limit) break;
        }
    }
    return hits;
}

function only(view: ResolverModuleView, text: TextSection, what: string, pattern: Uint8Array, mask: string): number {
    const hits = scanAll(text.bytes, pattern, mask);
    if (hits.length > 1) {
        Logger.warn(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: ${what} pattern matches more than once — refusing to hook`);
    }
    return hits.length === 1 ? text.base + hits[0] : -1;
}

function inText(text: TextSection, addr: number, len: number): boolean {
    return addr >= text.base && addr + len <= text.base + text.bytes.length;
}

function sliceText(text: TextSection, addr: number, len: number): Uint8Array | null {
    return inText(text, addr, len) ? text.bytes.slice(addr - text.base, addr - text.base + len) : null;
}

function resolveX87(view: ResolverModuleView, text: TextSection): HookedFunctionMatch[] {
    const entry = only(view, text, 'x87 kernel', PREFIX, 'x'.repeat(PREFIX.length));
    if (entry < 0) return [];
    const masked = sliceText(text, entry, BODY_LEN);
    if (!masked) return [];
    const scale = Mem.readUint32(entry + SCALE_OPERANDS[0]);
    if (scale === null) return [];
    for (const off of SCALE_OPERANDS) {
        if (Mem.readUint32(entry + off) !== scale) {
            Logger.warn(LogCategory.SYSTEM,
                `[granny-deform] ${view.module.name}: weight-scale operands at 0x${entry.toString(16)} disagree — refusing to hook`);
            return [];
        }
        masked.fill(0, off, off + 4);
    }
    if (sha256HexSync(masked) !== BODY_SHA256) {
        Logger.log(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    if (Mem.readFloat32(scale) !== WEIGHT_SCALE) {
        Logger.warn(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: weight scale at 0x${scale.toString(16)} is not 1/255 — refusing to hook`);
        return [];
    }
    setWeightScale(entry, scale);
    Logger.log(LogCategory.SYSTEM,
        `[granny-deform] ${view.module.name}: 4-bone PWN343 x87 kernel 0x${entry.toString(16)}, weight scale 0x${scale.toString(16)}`);
    return [{ name: FN, address: entry }];
}

function sseFrameLength(head: Uint8Array, tail: Uint8Array): number {
    if (head.length < SSE_CORE_AT || head[0] !== 0x55 || head[1] !== 0x8b || head[2] !== 0xec) return 0;
    let i = 3;
    const pushes: number[] = [];
    while (i < SSE_CORE_AT && head[i] >= 0x50 && head[i] <= 0x57 && head[i] !== 0x54 && head[i] !== 0x55) pushes.push(head[i++]);
    if (pushes.length < 2 || i + SSE_ARG_LOADS.length > SSE_CORE_AT) return 0;
    for (let k = 0; k < SSE_ARG_LOADS.length; k++) if (head[i++] !== SSE_ARG_LOADS[k]) return 0;
    for (; i < SSE_CORE_AT; i++) if (head[i] !== 0x90) return 0;
    const n = pushes.length;
    if (tail.length < n + 2) return 0;
    for (let k = 0; k < n; k++) if (tail[k] !== pushes[n - 1 - k] + 8) return 0;
    if (tail[n] !== 0x5d || tail[n + 1] !== 0xc3) return 0;
    return SSE_CORE_END + n + 2;
}

function resolveSse(view: ResolverModuleView, text: TextSection): HookedFunctionMatch[] {
    const entry = only(view, text, 'SSE kernel', SSE_PREFIX, SSE_MASK);
    if (entry < 0) return [];
    const body = sliceText(text, entry, SSE_CORE_END + 16);
    if (!body) return [];
    const length = sseFrameLength(body.subarray(0, SSE_CORE_AT), body.subarray(SSE_CORE_END));
    const reference = body.subarray(0, SSE_CORE_AT).every((b, i) => b === SSE_PREFIX[i]);
    if (length === 0 || (!generic() && !reference)) {
        Logger.log(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: SSE kernel core at 0x${entry.toString(16)} in an unknown frame — not hooked`);
        return [];
    }
    const core = body.slice(SSE_CORE_AT, SSE_CORE_END);
    const scale = Mem.readUint32(entry + SSE_SCALE_OPERANDS[0]);
    if (scale === null) return [];
    for (const off of SSE_SCALE_OPERANDS) {
        if (Mem.readUint32(entry + off) !== scale) {
            Logger.warn(LogCategory.SYSTEM,
                `[granny-deform] ${view.module.name}: weight-scale operands at 0x${entry.toString(16)} disagree — refusing to hook`);
            return [];
        }
        core.fill(0, off - SSE_CORE_AT, off - SSE_CORE_AT + 4);
    }
    if (sha256HexSync(core) !== SSE_CORE_SHA256) {
        Logger.log(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    if (Mem.readFloat32(scale) !== WEIGHT_SCALE) {
        Logger.warn(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: weight scale at 0x${scale.toString(16)} is not 1/255 — refusing to hook`);
        return [];
    }
    setWeightScale(entry, scale);
    Logger.log(LogCategory.SYSTEM,
        `[granny-deform] ${view.module.name}: 4-bone PWN343 SSE kernel 0x${entry.toString(16)} (${length} bytes${reference ? '' : ', frame variant'}), weight scale 0x${scale.toString(16)}`);
    return [{ name: FN_SSE, address: entry }];
}

function resolveAabbA(view: ResolverModuleView, text: TextSection): HookedFunctionMatch[] {
    const entry = only(view, text, 'box-transform', AABB_PREFIX, AABB_MASK);
    if (entry < 0) return [];
    const masked = sliceText(text, entry, AABB_BODY_LEN);
    if (!masked) return [];
    const limit = Mem.readUint32(entry + AABB_LIMIT_OPERANDS[0]);
    if (limit === null || Mem.readUint32(entry + AABB_LIMIT_OPERANDS[1]) !== limit) return [];
    for (const off of AABB_LIMIT_OPERANDS) masked.fill(0, off, off + 4);
    if (sha256HexSync(masked) !== AABB_BODY_SHA256) {
        Logger.log(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: box-transform prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    if (Mem.readFloat32(limit) !== FLT_MAX) {
        Logger.warn(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: box limit at 0x${limit.toString(16)} is not FLT_MAX — refusing to hook`);
        return [];
    }
    Logger.log(LogCategory.SYSTEM,
        `[granny-deform] ${view.module.name}: bounding-box transform 0x${entry.toString(16)}`);
    aabbEntry = entry;
    setAabbVariant(0);
    return [{ name: FN_AABB, address: entry }];
}

function resolveAabbB(view: ResolverModuleView, text: TextSection): HookedFunctionMatch[] {
    const entry = only(view, text, 'box-transform (2.7)', AABB_B_PREFIX, AABB_B_MASK);
    if (entry < 0) return [];
    const masked = sliceText(text, entry, AABB_B_BODY_LEN);
    if (!masked) return [];
    const limit = Mem.readUint32(entry + AABB_B_LIMIT_OPERAND);
    if (limit === null) return [];
    masked.fill(0, AABB_B_LIMIT_OPERAND, AABB_B_LIMIT_OPERAND + 4);
    if (sha256HexSync(masked) !== AABB_B_BODY_SHA256) {
        Logger.log(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: box-transform (2.7) prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    if (Mem.readFloat32(limit) !== -FLT_MAX) {
        Logger.warn(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: box limit at 0x${limit.toString(16)} is not -FLT_MAX — refusing to hook`);
        return [];
    }
    Logger.log(LogCategory.SYSTEM,
        `[granny-deform] ${view.module.name}: bounding-box transform (2.7 operand order) 0x${entry.toString(16)}`);
    aabbEntry = entry;
    setAabbVariant(1);
    return [{ name: FN_AABB_B, address: entry }];
}

function resolveAabb(view: ResolverModuleView, text: TextSection): HookedFunctionMatch[] {
    const a = resolveAabbA(view, text);
    return a.length > 0 || !generic() ? a : resolveAabbB(view, text);
}

function resolveWorldPose(view: ResolverModuleView, text: TextSection): HookedFunctionMatch[] {
    const entry = only(view, text, 'world-pose', WORLDPOSE_PREFIX, WORLDPOSE_MASK);
    if (entry < 0) return [];
    const at: number[] = [entry];
    for (let k = 1; k < WORLDPOSE_PARTS.length; k++) {
        const [from, off] = WORLDPOSE_PARTS[k].via!;
        const site = at[from] + off;
        const rel = Mem.readInt32(site);
        if (rel === null || Mem.readUint8(site - 1) !== 0xe8) return [];
        at.push((site + 4 + rel) >>> 0);
    }
    let total = 0;
    for (const part of WORLDPOSE_PARTS) total += part.len;
    const family = new Uint8Array(total);
    let fill = 0;
    let placed = true;
    for (let k = 0; k < WORLDPOSE_PARTS.length; k++) {
        const part = WORLDPOSE_PARTS[k];
        const bytes = sliceText(text, at[k], part.len);
        if (!bytes) return [];
        family.set(bytes, fill);
        for (const off of part.relocs) family.fill(0, fill + off, fill + off + 4);
        for (const [off, to] of part.calls) {
            if (bytes[off - 1] !== 0xe8) placed = false;
            const rel = bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
            const target = (at[k] + off + 4 + rel) >>> 0;
            if (to >= 0 ? target !== at[to] : !inText(text, target, 1)) placed = false;
            family.fill(0, fill + off, fill + off + 4);
        }
        if (!generic() && at[k] - entry !== part.rel) placed = false;
        fill += part.len;
    }
    if (!placed || sha256HexSync(family) !== WORLDPOSE_SHA256) {
        Logger.log(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: world-pose prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    const quat = at[WORLDPOSE_QUAT_PART];
    const flag = Mem.readUint32(entry + WORLDPOSE_FLAG_OPERANDS[0]);
    const slot = Mem.readUint32(entry + WORLDPOSE_SLOT_OPERANDS[0]);
    const one = Mem.readUint32(quat + WORLDPOSE_ONE_OPERANDS[0]);
    if (flag === null || slot === null || one === null || (slot & 3) !== 0
        || Mem.readUint32(entry + WORLDPOSE_FLAG_OPERANDS[1]) !== flag
        || Mem.readUint32(entry + WORLDPOSE_SLOT_OPERANDS[1]) !== slot
        || WORLDPOSE_ONE_OPERANDS.some(off => Mem.readUint32(quat + off) !== one)
        || Mem.readFloat32(one) !== 1) {
        Logger.warn(LogCategory.SYSTEM,
            `[granny-deform] ${view.module.name}: world-pose operands at 0x${entry.toString(16)} disagree — refusing to hook`);
        return [];
    }
    worldPoseSites.set(entry, { flag, slot });
    Logger.log(LogCategory.SYSTEM,
        `[granny-deform] ${view.module.name}: world-pose build 0x${entry.toString(16)}`);
    return [{ name: FN_WORLDPOSE, address: entry }];
}

function resolveKernel(view: ResolverModuleView): HookedFunctionMatch[] {
    const text = textOf(view);
    if (!text) return [];
    const deform = [...resolveX87(view, text), ...resolveSse(view, text)];
    if ((globalThis as { __grannyPoseHooks?: boolean }).__grannyPoseHooks === false) return deform;
    return [...deform, ...resolveAabb(view, text), ...resolveWorldPose(view, text)];
}

const memLength = (): number => Mem.getView()?.length ?? 0;

let liveMem: Uint8Array | null = null;
let liveMemViews: DeformViews | null = null;

function liveViews(): DeformViews | null {
    const mem = Mem.getView();
    if (!mem) return null;
    if (!liveMem || liveMem.buffer !== mem.buffer || liveMem.byteOffset !== mem.byteOffset
        || liveMem.byteLength !== mem.byteLength) {
        liveMem = mem;
        liveMemViews = deformViews(mem);
    }
    return liveMemViews;
}

/** The calling thread's x87 precision-control field is 00 (single, as Direct3D leaves it). */
function callerRoundsToSingle(): boolean {
    const cw = getFpuControlWord((System.getInstance() as { process?: { v86?: unknown } }).process?.v86);
    return cw !== null && (cw & 0x300) === 0;
}

function inBounds(addr: number, len: number): boolean {
    return addr > 0 && len >= 0 && addr + len <= memLength();
}

const shadow: ShadowSpec = {
    validateInGame: true,
    n: 32,
    guard(args) {
        const a = decodeArgs(args);
        if (a.count < 0 || a.count > MAX_VERTICES || a.tail < 0 || a.tail > MAX_TAIL_DWORDS) return false;
        if (a.count === 0) return true;
        return inBounds(a.src, a.count * srcStride(a.tail))
            && inBounds(a.dst, a.count * dstStride(a.tail))
            && inBounds(a.matrixIndices, 4)
            && inBounds(a.matrices, 64);
    },
    ranges(args) {
        const a = decodeArgs(args);
        if (a.count <= 0) return [];
        return [{ addr: a.dst, len: a.count * dstStride(a.tail) }];
    },
    kernel(view: ShadowView, args: number[], site) {
        const scale = getWeightScale(site.targetAddress);
        if (scale === undefined) throw new Error(`no weight scale for 0x${site.targetAddress.toString(16)}`);
        const seen = decodeArgs(args);
        if ((seen.dst & 15) !== 0) deformCounters.x87DstUnaligned++;
        if ((seen.matrices & 15) !== 0) deformCounters.x87MatricesUnaligned++;
        if (!callerRoundsToSingle()) return deformKernel(view, args, scale, false);
        const live = liveViews();
        if (!live) return deformKernel(view, args, scale, true);
        const accel = deformAccelFor(live.u8);
        if (view instanceof LiveShadowView) {
            const eax = accel ? deformX87Accel(accel, view, live, args, scale) : null;
            return eax !== null ? eax : deformKernelDirect(view, live, live, 0, args, scale);
        }
        const a = decodeArgs(args);
        const srcLen = a.count * srcStride(a.tail);
        const dstLen = a.count * dstStride(a.tail);
        if (a.count <= 0 || (a.dst & 3) !== 0 || (a.src < a.dst + dstLen && a.dst < a.src + srcLen)) {
            return deformKernel(view, args, scale, true);
        }
        if (accel) {
            const saved = live.u8.slice(a.dst, a.dst + dstLen);
            const eax = deformX87Accel(accel, new LiveShadowView(live.u8), live, args, scale);
            if (eax !== null) {
                const result = live.u8.slice(a.dst, a.dst + dstLen);
                live.u8.set(saved, a.dst);
                view.writeBytes(a.dst, result);
                return eax;
            }
        }
        const bytes = new Uint8Array(dstLen);
        const out = deformViews(bytes);
        if (!out) return deformKernel(view, args, scale, true);
        const eax = deformKernelDirect(new ShiftedWriteView(view, bytes, -a.dst), live, out, -a.dst, args, scale);
        view.writeBytes(a.dst, bytes);
        return eax;
    },
};

const sseShadow: ShadowSpec = {
    validateInGame: true,
    guardDeclines: true,
    n: 32,
    guard(args, view) {
        const a = decodeSseArgs(args);
        if (a.count <= 0 || a.count > MAX_VERTICES) return false;
        if ((a.src & 3) !== 0 || (a.dst & 15) !== 0 || (a.frame & 15) !== 0) return false;
        const srcLen = a.count * SSE_SRC_STRIDE;
        const dstLen = a.count * SSE_DST_STRIDE;
        if (!inBounds(a.src, srcLen) || !inBounds(a.dst, dstLen) || !inBounds(a.frame, SSE_FRAME_INDICES + 4)) return false;
        if (a.src < a.dst + dstLen && a.dst < a.src + srcLen) return false;
        if (a.frame < a.dst + dstLen && a.dst < a.frame + SSE_SCRATCH_LEN) return false;
        if (a.frame < a.src + srcLen && a.src < a.frame + SSE_SCRATCH_LEN) return false;
        const matrices = view.readU32(a.frame + SSE_FRAME_MATRICES);
        const indices = view.readU32(a.frame + SSE_FRAME_INDICES);
        return (matrices & 15) === 0 && (indices & 3) === 0 && inBounds(matrices, 64) && inBounds(indices, 4)
            && liveViews() !== null;
    },
    ranges(args) {
        const a = decodeSseArgs(args);
        if (a.count <= 0) return [];
        return [{ addr: a.dst, len: a.count * SSE_DST_STRIDE }, { addr: a.frame, len: SSE_SCRATCH_LEN }];
    },
    kernel(view: ShadowView, args: number[], site) {
        const scale = getWeightScale(site.targetAddress);
        const live = liveViews();
        if (scale === undefined || !live) throw new Error(`no weight scale or dword view for 0x${site.targetAddress.toString(16)}`);
        const a = decodeSseArgs(args);
        const accel = deformAccelFor(live.u8);
        if (view instanceof LiveShadowView) {
            const eax = accel ? deformSseAccel(accel, live, args, scale) : null;
            return eax !== null ? eax
                : deformKernelSse(live, live, 0, live.f32.subarray(a.frame >>> 2, (a.frame >>> 2) + 8), args, scale);
        }
        if (accel) {
            const dstLen = a.count * SSE_DST_STRIDE;
            const savedDst = live.u8.slice(a.dst, a.dst + dstLen);
            const savedFrame = live.u8.slice(a.frame, a.frame + SSE_SCRATCH_LEN);
            const eax = deformSseAccel(accel, live, args, scale);
            if (eax !== null) {
                const result = live.u8.slice(a.dst, a.dst + dstLen);
                const frame = live.u8.slice(a.frame, a.frame + SSE_SCRATCH_LEN);
                live.u8.set(savedDst, a.dst);
                live.u8.set(savedFrame, a.frame);
                view.writeBytes(a.dst, result);
                view.writeBytes(a.frame, frame);
                return eax;
            }
        }
        const bytes = new Uint8Array(a.count * SSE_DST_STRIDE);
        const out = deformViews(bytes);
        const scratch = new Float32Array(8);
        if (!out) throw new Error('no dword view of the scratch destination');
        const eax = deformKernelSse(live, out, -a.dst, scratch, args, scale);
        view.writeBytes(a.dst, bytes);
        view.writeBytes(a.frame, new Uint8Array(scratch.buffer));
        return eax;
    },
};

const aabbShadow: ShadowSpec = {
    validateInGame: true,
    guardDeclines: true,
    n: 32,
    guard(args) {
        const a = decodeAabbArgs(args);
        if (((a.t | a.m | a.min | a.max) & 3) !== 0) return false;
        if (!inBounds(a.t, 12) || !inBounds(a.m, 36) || !inBounds(a.min, 12) || !inBounds(a.max, 12)) return false;
        if (a.min < a.max + 12 && a.max < a.min + 12) return false;
        const live = liveViews();
        return live !== null && callerRoundsToSingle() && aabbInputsFinite(live, a);
    },
    ranges(args) {
        const a = decodeAabbArgs(args);
        return [{ addr: a.min, len: 12 }, { addr: a.max, len: 12 }];
    },
    kernel(view: ShadowView, args: number[]) {
        const live = liveViews();
        if (!live) throw new Error('no dword view of guest memory');
        if (view instanceof LiveShadowView) return aabbKernel(live, live, args);
        const a = decodeAabbArgs(args);
        const eax = aabbKernel(live, null, args);
        view.writeBytes(a.min, aabbResult.slice(0, 12));
        view.writeBytes(a.max, aabbResult.slice(12, 24));
        return eax;
    },
};

/** The profiling node a site's calls are counted on, or 0 while the guest has not created it. */
function worldPoseNode(live: DeformViews, site: WorldPoseSite): number {
    if (!inBounds(site.flag, 1) || !inBounds(site.slot, 4) || (live.u8[site.flag] & 1) === 0) return 0;
    const node = live.u32[site.slot >>> 2];
    return (node & 3) === 0 && inBounds(node, 8) ? node : 0;
}

let worldPosePending: WorldPosePlan | null = null;

const worldPoseShadow: ShadowSpec = {
    validateInGame: true,
    guardDeclines: true,
    ignoreEax: true,
    n: 32,
    guard(args) {
        const live = liveViews();
        worldPosePending = null;
        if (!live || !callerRoundsToSingle()) return false;
        for (const site of worldPoseSites.values()) if (worldPoseNode(live, site) === 0) return false;
        worldPosePending = worldPosePlan(live, decodeWorldPoseArgs(args));
        return worldPosePending !== null;
    },
    ranges(args) {
        const live = liveViews();
        const plan = live && (worldPosePending ?? worldPosePlan(live, decodeWorldPoseArgs(args)));
        if (!plan) return [];
        return [{ addr: plan.world, len: plan.count << 6 }, { addr: plan.composite, len: plan.count << 6 }];
    },
    kernel(view: ShadowView, args: number[], site) {
        const live = liveViews();
        const plan = live && (worldPosePending ?? worldPosePlan(live, decodeWorldPoseArgs(args)));
        worldPosePending = null;
        if (!live || !plan) throw new Error('world-pose call past its guard');
        if (view instanceof LiveShadowView) {
            worldPoseKernel(live, live, plan);
            const at = worldPoseSites.get(site.targetAddress);
            const node = at ? worldPoseNode(live, at) : 0;
            if (node !== 0) live.u32[(node >>> 2) + 1]++;
            return 0;
        }
        worldPoseKernel(live, null, plan);
        view.writeBytes(plan.world, worldPoseWorld.slice(0, plan.count << 6));
        view.writeBytes(plan.composite, worldPoseComposite.slice(0, plan.count << 6));
        return 0;
    },
};

export const grannyDeformDescriptor: LibDescriptor = {
    id: 'granny-deform',
    displayName: 'Granny 2 four-bone position+normal skinning kernel (inner-loop HLE)',
    minConfidence: 12,
    signatures: {
        [FN]: {
            kind: 'bytes',
            pattern: PREFIX,
            mask: 'x'.repeat(PREFIX.length),
            section: '.text',
            weight: 12,
        },
        [FN_SSE]: {
            kind: 'bytes',
            pattern: SSE_PREFIX,
            mask: SSE_MASK,
            section: '.text',
            weight: 12,
        },
        [FN_AABB]: {
            kind: 'bytes',
            pattern: AABB_PREFIX,
            mask: AABB_MASK,
            section: '.text',
            weight: 12,
        },
        [FN_WORLDPOSE]: {
            kind: 'bytes',
            pattern: WORLDPOSE_PREFIX,
            mask: WORLDPOSE_MASK,
            section: '.text',
            weight: 12,
        },
    },
    functions: {
        [FN_WORLDPOSE]: {
            name: FN_WORLDPOSE,
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 6,
            required: false,
            prologueLen: WORLDPOSE_PROLOGUE_LEN,
            shadow: worldPoseShadow,
        },
        [FN_AABB]: {
            name: FN_AABB,
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 4,
            required: false,
            prologueLen: AABB_PROLOGUE_LEN,
            shadow: aabbShadow,
        },
        [FN_AABB_B]: {
            name: FN_AABB_B,
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 4,
            required: false,
            prologueLen: AABB_B_PROLOGUE_LEN,
            shadow: aabbShadow,
        },
        [FN]: {
            name: FN,
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 6,
            required: false,
            prologueLen: PROLOGUE_LEN,
            shadow,
        },
        [FN_SSE]: {
            name: FN_SSE,
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 4,
            required: false,
            prologueLen: PROLOGUE_LEN,
            shadow: sseShadow,
        },
    },
    handlers: {},
    resolveAdditionalFunctions: resolveKernel,
    onActivated() {
        (globalThis as Record<string, unknown>).__grannyDeformStats = () => ({ ...deformCounters, wasm: deformAccelState() });
        if ((globalThis as { __grannyWasmKernel?: boolean }).__grannyWasmKernel !== false) {
            const v86 = (System.getInstance() as { process?: { v86?: { cpu?: unknown; v86?: { cpu?: unknown } } } }).process?.v86;
            const cpu = (v86?.cpu ?? v86?.v86?.cpu) as { wasm_memory?: WebAssembly.Memory } | undefined;
            loadDeformAccel(cpu?.wasm_memory);
        }
    },
    onReset() {
        clearWeightScales();
        worldPoseSites.clear();
        worldPosePending = null;
        deformCounters.reset();
        resetDeformAccel();
        aabbEntry = 0;
        setAabbVariant(0);
        liveMem = null;
        liveMemViews = null;
    },
};

export const __test = {
    PREFIX, BODY_LEN, SCALE_OPERANDS, BODY_SHA256, PROLOGUE_LEN,
    SSE_PREFIX, SSE_MASK, SSE_BODY_LEN, SSE_SCALE_OPERANDS, SSE_CORE_AT, SSE_CORE_END, SSE_CORE_SHA256, sseFrameLength,
    AABB_PREFIX, AABB_MASK, AABB_BODY_LEN, AABB_LIMIT_OPERANDS, AABB_BODY_SHA256,
    AABB_B_PREFIX, AABB_B_MASK, AABB_B_BODY_LEN, AABB_B_BODY_SHA256, AABB_B_PROLOGUE_LEN,
    WORLDPOSE_PREFIX, WORLDPOSE_MASK, WORLDPOSE_PARTS, WORLDPOSE_SHA256, WORLDPOSE_PROLOGUE_LEN,
    scanAll,
};
