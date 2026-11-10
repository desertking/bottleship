/**
 * Keyframed vertex decompression (`calc_vertices`) of a mingw-built Direct3D 9 title:
 * one leaf function that expands a mesh's byte-quantised keyframe into 32-byte vertices,
 * optionally mixing two keyframes. See kernel.ts for the layout and the arithmetic.
 *
 * Detection: the function's first 76 bytes, then the SHA-256 of the whole body with the
 * eighteen absolute operands zeroed. Those operands must name two addresses holding the
 * f32 constants 1/255 and 2/255.
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
import { LiveShadowView } from '../../shadow-validator';
import { deformViews, type DeformViews } from '../granny-deform/kernel';
import {
    C1, C2, keyframeCounters, keyframeKernel, keyframePlan, keyframeResult, paramsFinite,
} from './kernel';

const FN = 'dxa_calc_vertices_normal_tex1';

function hexPattern(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

const PREFIX = hexPattern(
    '5589e557565381ec2c0100008b4d088b5d0c8b51388b7928899550ffffff8b726089d189bd64ffffff8b525c29d6'
    + 'c1fe0369c6b76ddbb685c0743089d78b41608b3739b564ffffff8d50c88b');
const BODY_LEN = 0x830;
const C1_OPERANDS = [0x102, 0x4e7, 0x517, 0x547, 0x567, 0x5af, 0x5e1, 0x721, 0x733, 0x780, 0x798];
const C2_OPERANDS = [0x10b, 0x61b, 0x637, 0x653, 0x66e, 0x690, 0x6c4];
const BODY_SHA256 = '1e5c00fee1cfe9ff08feb04fa5c3f584b990ec2e78940f2db412be061b9f7cca';
const PROLOGUE_LEN = 6;
const MAX_TIME = 1 << 24;

function resolveKernel(view: ResolverModuleView): HookedFunctionMatch[] {
    if ((globalThis as { __dxaKeyframeHook?: boolean }).__dxaKeyframeHook === false) return [];
    const hit = view.signatureHits.find(h => h.signatureId === FN);
    if (!hit) return [];
    const entry = hit.address;
    const body = Mem.readBytes(entry, BODY_LEN);
    if (!body || body.length !== BODY_LEN) return [];
    const masked = new Uint8Array(body);
    const c1 = Mem.readUint32(entry + C1_OPERANDS[0]);
    const c2 = Mem.readUint32(entry + C2_OPERANDS[0]);
    if (c1 === null || c2 === null) return [];
    for (const off of C1_OPERANDS) {
        if (Mem.readUint32(entry + off) !== c1) return [];
        masked.fill(0, off, off + 4);
    }
    for (const off of C2_OPERANDS) {
        if (Mem.readUint32(entry + off) !== c2) return [];
        masked.fill(0, off, off + 4);
    }
    if (sha256HexSync(masked) !== BODY_SHA256) {
        Logger.log(LogCategory.SYSTEM,
            `[dxa-keyframe] ${view.module.name}: calc_vertices prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    if (Mem.readFloat32(c1) !== C1 || Mem.readFloat32(c2) !== C2) {
        Logger.warn(LogCategory.SYSTEM,
            `[dxa-keyframe] ${view.module.name}: scale constants are not 1/255 and 2/255 — refusing to hook`);
        return [];
    }
    Logger.log(LogCategory.SYSTEM,
        `[dxa-keyframe] ${view.module.name}: keyframe vertex decode 0x${entry.toString(16)}`);
    return [{ name: FN, address: entry }];
}

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

const apart = (a: number, aLen: number, b: number, bLen: number): boolean => a + aLen <= b || b + bLen <= a;

const shadow: ShadowSpec = {
    validateInGame: true,
    guardDeclines: true,
    ignoreEax: true,
    n: 32,
    guard(args) {
        const live = liveViews();
        if (!live) return false;
        const size = live.u8.length;
        const p = keyframePlan(live, args[0] >>> 0, args[1] >>> 0);
        if (!p) return false;
        const outLen = p.count * 32, dataLen = p.count * 8;
        if (p.out === 0 || p.out + outLen > size) return false;
        if (p.dataA === 0 || p.dataA + dataLen > size || !apart(p.out, outLen, p.dataA, dataLen)) return false;
        if (!paramsFinite(live, p.a)) return false;
        if (p.b !== 0) {
            if (p.dataB === 0 || p.dataB + dataLen > size || !apart(p.out, outLen, p.dataB, dataLen)) return false;
            if (!paramsFinite(live, p.b)) return false;
            if (p.num === 0 || p.num >= p.den || p.den >= MAX_TIME) return false;
        }
        return callerRoundsToSingle();
    },
    ranges(args) {
        const live = liveViews();
        const p = live && keyframePlan(live, args[0] >>> 0, args[1] >>> 0);
        return p && p.count > 0 ? [{ addr: p.out, len: p.count * 32 }] : [];
    },
    kernel(view: ShadowView, args: number[]) {
        const live = liveViews();
        const p = live && keyframePlan(live, args[0] >>> 0, args[1] >>> 0);
        if (!live || !p) throw new Error('no keyframe plan');
        if (view instanceof LiveShadowView) {
            keyframeKernel(live, live, p);
            return 0;
        }
        keyframeKernel(live, null, p);
        if (p.count > 0) view.writeBytes(p.out, keyframeResult.slice(0, p.count * 32));
        return 0;
    },
};

export const dxaKeyframeDescriptor: LibDescriptor = {
    id: 'dxa-keyframe',
    displayName: 'Keyframed vertex decompression (inner-loop HLE)',
    minConfidence: 12,
    signatures: {
        [FN]: {
            kind: 'bytes',
            pattern: PREFIX,
            mask: 'x'.repeat(PREFIX.length),
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
            argCount: 2,
            required: false,
            prologueLen: PROLOGUE_LEN,
            shadow,
        },
    },
    handlers: {},
    resolveAdditionalFunctions: resolveKernel,
    onActivated() {
        (globalThis as Record<string, unknown>).__dxaKeyframeStats = () => ({ ...keyframeCounters });
    },
    onReset() {
        keyframeCounters.reset();
        liveMem = null;
        liveMemViews = null;
    },
};

export const __test = { PREFIX, BODY_LEN, C1_OPERANDS, C2_OPERANDS, BODY_SHA256, PROLOGUE_LEN };
