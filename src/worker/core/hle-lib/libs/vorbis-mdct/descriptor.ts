/**
 * Inverse MDCT of a statically linked libvorbis (mdct.c, mingw gcc 3 build): the
 * transform of every decoded block, some 25 000 x87 instructions for a 2048 block,
 * served as one call. See kernel.ts.
 *
 * Detection carries no address: the first 64 bytes of mdct_backward anywhere in .text,
 * then the SHA-256 of mdct_backward and of the five butterfly and bit reverse helpers
 * behind it, with the operands that address the three rotation constants zeroed, and
 * the constants themselves compared by value. A libvorbis built by another compiler
 * does not match and keeps running its own code.
 */

import { Logger, LogCategory } from '../../../logger';
import { Mem } from '../../../memory/mem-accessor';
import { sha256HexSync } from '../../../../savestate/sha256';
import { getFpuControlWord } from '../../../fpu-helper';
import { System } from '../../../system';
import type { EntryFilterInfo, HookedFunctionMatch, LibDescriptor, ResolverModuleView, ShadowSpec } from '../../types';
import { mdctBackward, mdctCounters, mdctShape } from './kernel';

const FN = 'vorbis_mdct_backward';

function hexPattern(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

const PREFIX = hexPattern(
    '5589e557565383ec2c8b4d088b5d0c8b75108b0189c7c1f802d1ff8945ec897df08d54bbe401c7897de8'
    + '8d0cbe8b7d088b77088975e48d04868db42600000000');
const BODY_LEN = 0x1080;
const HASHED = [[0, 0x350], [0x660, 0x1080]] as const;
const PI3_8 = 0x3ec3ef15, PI2_8 = 0x3f3504f3, PI1_8 = 0x3f6c835e, HALF = 0x3f000000;
const CONSTANT_OPERANDS: ReadonlyArray<readonly [number, number]> = [
    [0x671, PI3_8], [0x6b8, PI1_8], [0x6e0, PI1_8], [0x71c, PI2_8], [0x722, PI2_8], [0x76f, PI1_8],
    [0x782, PI1_8], [0x7ca, PI2_8], [0x7e5, PI1_8], [0x803, PI1_8], [0x887, PI1_8], [0x89f, PI2_8],
    [0x8ce, PI2_8], [0x8dd, PI2_8], [0x963, PI2_8], [0x980, PI2_8], [0xa4c, PI2_8], [0xa64, PI2_8],
    [0xaec, PI2_8], [0xb16, PI2_8], [0xf1d, HALF], [0xf2b, HALF], [0xfa3, HALF], [0xfab, HALF],
];
const BODY_SHA256 = 'ed0622a559ff29465e81ddc4fed6b926ec228721bed1677a1c4b8a6394273693';
const PROLOGUE_LEN = 6;

/** Whether `body`, the BODY_LEN bytes at a prefix hit, is the translated build. */
function bodyMatches(body: Uint8Array, readU32: (addr: number) => number | undefined): boolean {
    if (body.length !== BODY_LEN) return false;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const masked = new Uint8Array(body);
    for (const [off, value] of CONSTANT_OPERANDS) {
        if (readU32(dv.getUint32(off, true)) !== value) return false;
        masked.fill(0, off, off + 4);
    }
    const hashed = new Uint8Array(HASHED.reduce((sum, [lo, hi]) => sum + hi - lo, 0));
    let at = 0;
    for (const [lo, hi] of HASHED) { hashed.set(masked.subarray(lo, hi), at); at += hi - lo; }
    return sha256HexSync(hashed) === BODY_SHA256;
}

function resolveKernel(view: ResolverModuleView): HookedFunctionMatch[] {
    if ((globalThis as { __vorbisMdctHook?: boolean }).__vorbisMdctHook === false) return [];
    const hits = view.signatureHits.filter(h => h.signatureId === FN);
    if (hits.length !== 1) return [];
    const entry = hits[0]!.address;
    const body = Mem.readBytes(entry, BODY_LEN);
    if (!body || !bodyMatches(body, addr => Mem.readUint32(addr) ?? undefined)) {
        Logger.log(LogCategory.SYSTEM,
            `[vorbis-mdct] ${view.module.name}: prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    Logger.log(LogCategory.SYSTEM, `[vorbis-mdct] ${view.module.name}: mdct_backward 0x${entry.toString(16)}`);
    return [{ name: FN, address: entry }];
}

let enableFlag = 0;
let pendingN = 0;
let pendingSingle = false;

/** 0 single, 1 double precision control, -1 when the rounding mode is not to nearest. */
function precision(): number {
    const cw = getFpuControlWord((System.getInstance() as { process?: { v86?: unknown } }).process?.v86);
    if (cw === null || (cw & 0xc00) !== 0) return -1;
    return (cw & 0x300) === 0 ? 0 : 1;
}

/**
 * Emits
 *
 *   cmp byte [flag], 0 ; je original
 *   sub esp, 4 ; fnstcw [esp] ; pop eax
 *   test ah, 0x0c ; jnz original
 *   jmp stub
 *
 * EAX is dead at a cdecl entry. Switched off, or with a rounding mode other than to
 * nearest, the call runs the guest function through the relocated prologue. The hook
 * takes no in-game validation: that runs the original synchronously on the decoder
 * thread while other threads sit in a wait, and the translation is compared against
 * the original offline instead.
 */
function buildFilter(info: EntryFilterInfo): number | null {
    const { mem, stubAddress, trampolineAddress } = info;
    const size = 36;
    const at = info.allocCode(size);
    if (at <= 0 || at + size > mem.length) return null;
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    enableFlag = at + 34;
    let p = at;
    const b = (...bytes: number[]): void => { for (const x of bytes) mem[p++] = x; };
    const rel = (target: number): void => { dv.setInt32(p, (target - (p + 4)) | 0, true); p += 4; };
    b(0x80, 0x3d); dv.setUint32(p, enableFlag, true); p += 4; b(0x00);
    b(0x0f, 0x84); rel(trampolineAddress);
    b(0x83, 0xec, 0x04, 0xd9, 0x3c, 0x24, 0x58);
    b(0xf6, 0xc4, 0x0c);
    b(0x0f, 0x85); rel(trampolineAddress);
    b(0xe9); rel(stubAddress);
    b(0x01, 0xcc);
    return at;
}

const shadow: ShadowSpec = {
    guard(args) {
        pendingN = 0;
        const mem = Mem.getView();
        const mode = precision();
        if (!mem || mode < 0) { mdctCounters.declined++; return false; }
        const n = mdctShape(mem, args[0]! >>> 0, args[1]! >>> 0, args[2]! >>> 0);
        if (n === 0) { mdctCounters.declined++; return false; }
        pendingN = n;
        pendingSingle = mode === 0;
        return true;
    },
    ranges(args) {
        return [{ addr: args[2]! >>> 0, len: 4 * pendingN }];
    },
    kernel(view, args) {
        const mem = Mem.getView();
        if (!mem || pendingN === 0) throw new Error('call outside the served shape');
        const out = args[2]! >>> 0;
        view.writeBytes(out, mdctBackward(mem, args[0]! >>> 0, args[1]! >>> 0, out, pendingN, pendingSingle));
        return 0;
    },
};

export const vorbisMdctDescriptor: LibDescriptor = {
    id: 'vorbis-mdct',
    displayName: 'libvorbis inverse MDCT (whole-function HLE)',
    minConfidence: 4,
    signatures: {
        [FN]: { kind: 'bytes', pattern: PREFIX, mask: 'x'.repeat(PREFIX.length), section: '.text', weight: 4 },
    },
    functions: {
        [FN]: {
            name: FN,
            entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
            externallyResolved: true,
            callingConvention: 'cdecl',
            argCount: 3,
            required: false,
            prologueLen: PROLOGUE_LEN,
            shadow,
            entryFilter: buildFilter,
        },
    },
    handlers: {},
    resolveAdditionalFunctions: resolveKernel,
    onActivated() {
        const g = globalThis as Record<string, unknown>;
        g.__vorbisMdctStats = () => ({ ...mdctCounters, enabled: enableFlag !== 0 && Mem.getView()?.[enableFlag] === 1 });
        g.__vorbisMdctEnable = (on: boolean) => {
            const mem = Mem.getView();
            if (!mem || enableFlag === 0) return false;
            mem[enableFlag] = on ? 1 : 0;
            return true;
        };
    },
    onReset() {
        mdctCounters.reset();
        enableFlag = 0;
        pendingN = 0;
    },
};

export const __test = { PREFIX, BODY_LEN, BODY_SHA256, CONSTANT_OPERANDS, bodyMatches };
