/**
 * Model bounding box of a mingw-built Direct3D 9 title that culls its Granny models on
 * the CPU: one call per visible model, each of which calls three Granny exports once per
 * bone binding. Served whole, a model costs one trap instead of one per binding. See
 * kernel.ts for the arithmetic.
 *
 * Detection: the function's first bytes, then the SHA-256 of its whole body with the
 * absolute operands zeroed. The three Granny exports it calls are taken from its own
 * import slots and checked by shape before the first call is served: the two accessors
 * byte for byte, the box transform against the one granny-deform has verified.
 *
 * The pose update the function starts with stays guest code: the entry filter calls it
 * and hands over only when it reports success.
 */

import { Logger, LogCategory } from '../../../logger';
import { Mem } from '../../../memory/mem-accessor';
import { sha256HexSync } from '../../../../savestate/sha256';
import { getFpuControlWord } from '../../../fpu-helper';
import { System } from '../../../system';
import type {
    EntryFilterInfo,
    HookedFunctionMatch,
    LibDescriptor,
    ResolverModuleView,
    ShadowSpec,
} from '../../types';
import type { DeformViews } from '../granny-deform/kernel';
import { deformViews } from '../granny-deform/kernel';
import { grannyBoxTransformEntry } from '../granny-deform/descriptor';
import { BOX_LEN, modelBox, modelBoxCounters, modelBoxResult } from './kernel';

const FN = 'dxa_model_bounding_box';

function hexPattern(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

const PREFIX = hexPattern(
    '5589e557565381ec9c0000008b550cc64593018b45088b7d1089542404890424e8');
const BODY_LEN = 0x299;
const POSE_CALL = 0x20;
const IMPORT_INDICES = 0xc6;
const IMPORT_POSE = 0xe5;
const IMPORT_BOX = 0x15b;
const ABSOLUTE_OPERANDS = [IMPORT_INDICES, IMPORT_POSE, IMPORT_BOX, 0x27b];
const BODY_SHA256 = '801c528516c395f8f9f342f8577d41c805685b7e3db2c5e680bc6d5fd67368bc';
const PROLOGUE_LEN = 6;

const INDICES_EXPORT = { bytes: hexPattern('8b44240450e80000000083c404c20400'), call: 5 };
const INDICES_BODY = hexPattern('8b4424048b4014c3');
const POSE_EXPORT = { bytes: hexPattern('8b4424088b4c24045051e80000000083c408c20800'), call: 10 };
const POSE_BODY = hexPattern('8b5424048b4c2408568b3233c03bce5e7d0a8b4204c1e10603c88bc1c3');
const BOX_EXPORT = { bytes: hexPattern('8b4424108b4c240c8b542408508b442408515250e80000000083c410c21000'), call: 20 };

let importSlots: number[] = [];
let grannyChecked = false;
let grannyOk = false;
let enableFlag = 0;
let pendingModel = 0;
let pendingCount = -1;
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

function callerRoundsToSingle(): boolean {
    const cw = getFpuControlWord((System.getInstance() as { process?: { v86?: unknown } }).process?.v86);
    return cw !== null && (cw & 0x300) === 0;
}

/** Target of the call inside an export wrapper of the given shape, or 0. */
function wrapperTarget(entry: number, shape: { bytes: Uint8Array; call: number }): number {
    const got = Mem.readBytes(entry, shape.bytes.length);
    if (!got || got.length !== shape.bytes.length) return 0;
    for (let i = 0; i < got.length; i++) {
        if (i > shape.call && i <= shape.call + 4) continue;
        if (got[i] !== shape.bytes[i]) return 0;
    }
    const rel = Mem.readUint32(entry + shape.call + 1);
    return rel === null ? 0 : (entry + shape.call + 5 + rel) >>> 0;
}

function bodyIs(entry: number, bytes: Uint8Array): boolean {
    if (entry === 0) return false;
    const got = Mem.readBytes(entry, bytes.length);
    return !!got && got.length === bytes.length && got.every((b, i) => b === bytes[i]);
}

function grannyMatches(): boolean {
    if (grannyChecked) return grannyOk;
    if (importSlots.length !== 3) return false;
    const exports = importSlots.map(slot => Mem.readUint32(slot) ?? 0);
    if (exports.some(e => e === 0)) return false;
    grannyChecked = true;
    const box = grannyBoxTransformEntry();
    grannyOk = bodyIs(wrapperTarget(exports[0]!, INDICES_EXPORT), INDICES_BODY)
        && bodyIs(wrapperTarget(exports[1]!, POSE_EXPORT), POSE_BODY)
        && box !== 0 && wrapperTarget(exports[2]!, BOX_EXPORT) === box;
    Logger.log(LogCategory.SYSTEM,
        `[dxa-model-box] Granny exports at ${exports.map(e => '0x' + e.toString(16)).join(', ')} `
        + (grannyOk ? 'match' : 'have a different shape — every call runs the guest function'));
    return grannyOk;
}

function resolveKernel(view: ResolverModuleView): HookedFunctionMatch[] {
    if ((globalThis as { __dxaModelBoxHook?: boolean }).__dxaModelBoxHook === false) return [];
    const hit = view.signatureHits.find(h => h.signatureId === FN);
    if (!hit) return [];
    const entry = hit.address;
    const body = Mem.readBytes(entry, BODY_LEN);
    if (!body || body.length !== BODY_LEN) return [];
    const masked = new Uint8Array(body);
    for (const off of ABSOLUTE_OPERANDS) masked.fill(0, off, off + 4);
    if (sha256HexSync(masked) !== BODY_SHA256) {
        Logger.log(LogCategory.SYSTEM,
            `[dxa-model-box] ${view.module.name}: prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return [];
    }
    const slots = [IMPORT_INDICES, IMPORT_POSE, IMPORT_BOX].map(off => Mem.readUint32(entry + off) ?? 0);
    if (slots.some(s => s === 0)) return [];
    importSlots = slots;
    grannyChecked = false;
    grannyOk = false;
    Logger.log(LogCategory.SYSTEM, `[dxa-model-box] ${view.module.name}: model bounding box 0x${entry.toString(16)}`);
    return [{ name: FN, address: entry }];
}

/**
 * Emits
 *
 *   cmp byte [flag], 0 ; je original
 *   push [esp+8] ; push [esp+8] ; call pose update ; add esp, 8
 *   test eax, eax ; jnz original
 *   jmp stub
 *
 * EAX is dead at a cdecl entry; the two pushes are balanced before either exit.
 */
function buildFilter(info: EntryFilterInfo): number | null {
    const { mem, targetAddress, stubAddress, trampolineAddress } = info;
    if (mem[targetAddress + POSE_CALL] !== 0xe8) return null;
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const update = (targetAddress + POSE_CALL + 5 + dv.getInt32(targetAddress + POSE_CALL + 1, true)) >>> 0;
    const size = 48;
    const at = info.allocCode(size);
    if (at <= 0 || at + size > mem.length) return null;
    enableFlag = at + 44;
    let p = at;
    const b = (...bytes: number[]): void => { for (const x of bytes) mem[p++] = x; };
    const d = (value: number): void => { dv.setUint32(p, value >>> 0, true); p += 4; };
    const rel = (target: number): void => { dv.setInt32(p, (target - (p + 4)) | 0, true); p += 4; };
    b(0x80, 0x3d); d(enableFlag); b(0x00);
    b(0x0f, 0x84); rel(trampolineAddress);
    b(0x8b, 0x44, 0x24, 0x08, 0x50);
    b(0x8b, 0x44, 0x24, 0x08, 0x50);
    b(0xe8); rel(update);
    b(0x83, 0xc4, 0x08);
    b(0x85, 0xc0);
    b(0x0f, 0x85); rel(trampolineAddress);
    b(0xe9); rel(stubAddress);
    while (p < at + size) mem[p++] = 0xcc;
    mem[enableFlag] = 1;
    return at;
}

const shadow: ShadowSpec = {
    validateInGame: true,
    guardDeclines: true,
    allowGuestImports: true,
    n: 32,
    guard(args) {
        pendingCount = -1;
        const box = args[2]! >>> 0;
        const live = liveViews();
        if (!live || box === 0 || box + BOX_LEN > live.u8.length) return false;
        if (!grannyMatches() || !callerRoundsToSingle()) { modelBoxCounters.declined++; return false; }
        const model = args[1]! >>> 0;
        const count = modelBox(live, model);
        if (count < 0) { modelBoxCounters.declined++; return false; }
        pendingModel = model;
        pendingCount = count;
        return true;
    },
    ranges(args) {
        return [{ addr: args[2]! >>> 0, len: BOX_LEN }];
    },
    kernel(view, args) {
        const model = args[1]! >>> 0;
        let count = pendingCount;
        if (count < 0 || pendingModel !== model) {
            const live = liveViews();
            if (!live) throw new Error('no dword view of guest memory');
            count = modelBox(live, model);
            if (count < 0) throw new Error('model outside the served shape');
        }
        pendingCount = -1;
        if (count > 0) view.writeBytes(args[2]! >>> 0, modelBoxResult);
        modelBoxCounters.calls++;
        modelBoxCounters.bindings += count;
        return 0;
    },
};

export const dxaModelBoxDescriptor: LibDescriptor = {
    id: 'dxa-model-box',
    displayName: 'Granny model bounding box (whole-function HLE)',
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
        g.__dxaModelBoxStats = () => ({ ...modelBoxCounters, granny: grannyChecked ? grannyOk : null });
        g.__dxaModelBoxEnable = (on: boolean) => {
            const mem = Mem.getView();
            if (!mem || enableFlag === 0) return false;
            mem[enableFlag] = on ? 1 : 0;
            return true;
        };
    },
    onReset() {
        modelBoxCounters.reset();
        importSlots = [];
        grannyChecked = false;
        grannyOk = false;
        enableFlag = 0;
        pendingCount = -1;
        liveMem = null;
        liveMemViews = null;
    },
};

export const __test = {
    PREFIX, BODY_LEN, ABSOLUTE_OPERANDS, BODY_SHA256, PROLOGUE_LEN, POSE_CALL,
    INDICES_EXPORT, INDICES_BODY, POSE_EXPORT, POSE_BODY, BOX_EXPORT, buildFilter,
};
