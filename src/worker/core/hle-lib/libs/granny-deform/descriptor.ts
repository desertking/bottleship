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
import { LiveShadowView } from '../../shadow-validator';

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
const SSE_BODY_SHA256 = '21af306b8af3a6211edaa5daa7d8cb5c80eea6ac72942f800ef99112ad691b00';
const WEIGHT_SCALE = Math.fround(1 / 255);

interface KernelShape {
    name: string;
    label: string;
    bodyLen: number;
    scaleOperands: number[];
    sha256: string;
}

const SHAPES: KernelShape[] = [
    { name: FN, label: 'x87', bodyLen: BODY_LEN, scaleOperands: SCALE_OPERANDS, sha256: BODY_SHA256 },
    { name: FN_SSE, label: 'SSE', bodyLen: SSE_BODY_LEN, scaleOperands: SSE_SCALE_OPERANDS, sha256: SSE_BODY_SHA256 },
];

function resolveShape(view: ResolverModuleView, shape: KernelShape): HookedFunctionMatch[] {
    const hit = view.signatureHits.find(h => h.signatureId === shape.name);
    if (!hit) return [];
    const entry = hit.address;
    const body = Mem.readBytes(entry, shape.bodyLen);
    if (!body || body.length !== shape.bodyLen) return [];
    const masked = new Uint8Array(body);
    const scale = Mem.readUint32(entry + shape.scaleOperands[0]);
    if (scale === null) return [];
    for (const off of shape.scaleOperands) {
        if (Mem.readUint32(entry + off) !== scale) {
            Logger.warn(LogCategory.SYSTEM,
                `[granny-deform] ${view.module.name}: weight-scale operands at 0x${entry.toString(16)} disagree — refusing to hook`);
            return [];
        }
        masked.fill(0, off, off + 4);
    }
    if (sha256HexSync(masked) !== shape.sha256) {
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
        `[granny-deform] ${view.module.name}: 4-bone PWN343 ${shape.label} kernel 0x${entry.toString(16)}, weight scale 0x${scale.toString(16)}`);
    return [{ name: shape.name, address: entry }];
}

function resolveKernel(view: ResolverModuleView): HookedFunctionMatch[] {
    return SHAPES.flatMap(shape => resolveShape(view, shape));
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
        if (!callerRoundsToSingle()) return deformKernel(view, args, scale, false);
        const live = liveViews();
        if (!live) return deformKernel(view, args, scale, true);
        if (view instanceof LiveShadowView) return deformKernelDirect(view, live, live, 0, args, scale);
        const a = decodeArgs(args);
        const srcLen = a.count * srcStride(a.tail);
        const dstLen = a.count * dstStride(a.tail);
        if (a.count <= 0 || (a.dst & 3) !== 0 || (a.src < a.dst + dstLen && a.dst < a.src + srcLen)) {
            return deformKernel(view, args, scale, true);
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
        if (view instanceof LiveShadowView) {
            return deformKernelSse(live, live, 0, live.f32.subarray(a.frame >>> 2, (a.frame >>> 2) + 8), args, scale);
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
            mask: 'x'.repeat(SSE_PREFIX.length),
            section: '.text',
            weight: 12,
        },
    },
    functions: {
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
        (globalThis as Record<string, unknown>).__grannyDeformStats = () => ({ ...deformCounters });
    },
    onReset() {
        clearWeightScales();
        deformCounters.reset();
        liveMem = null;
        liveMemViews = null;
    },
};

export const __test = {
    PREFIX, BODY_LEN, SCALE_OPERANDS, BODY_SHA256, PROLOGUE_LEN,
    SSE_PREFIX, SSE_BODY_LEN, SSE_SCALE_OPERANDS, SSE_BODY_SHA256,
};
