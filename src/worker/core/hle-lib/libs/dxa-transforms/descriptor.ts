/**
 * Effect-manager world-transform save / restore / multiply of a mingw-built Direct3D 9
 * title: three small functions that are nothing but device calls, issued several hundred
 * times a frame. Served whole, each costs one trap instead of three to eight. See
 * kernel.ts for what each one does.
 *
 * Detection: each function's first bytes, then the SHA-256 of its whole body with the
 * absolute operands zeroed. All three must name the same device-pointer and renderer
 * globals.
 */

import { Logger, LogCategory } from '../../../logger';
import { Mem } from '../../../memory/mem-accessor';
import { isValidAddress } from '../../../memory/address-guard';
import { sha256HexSync } from '../../../../savestate/sha256';
import { getFpuControlWord } from '../../../fpu-helper';
import { System } from '../../../system';
import { devices } from '../../../../modules/d3d9/shared-state';
import type {
    HookedFunction,
    HookedFunctionMatch,
    LibDescriptor,
    ResolverModuleView,
    ShadowSpec,
    ShadowView,
} from '../../types';
import { LiveShadowView } from '../../shadow-validator';
import {
    BANK_FLOATS, BANK_REGISTERS, SHADER_MODE_ABOVE, STORE_FFP_LEN, STORE_SHADER_LEN, WORLD,
    multiplyBank, plainBank, plainFloats, sameBank, transformCounters,
} from './kernel';

const STORE = 'dxa_store_transforms';
const RESTORE = 'dxa_restore_transforms';
const MULTIPLY = 'dxa_multiply_transforms';

function hexPattern(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

interface Shape {
    prefix: Uint8Array;
    mask: string;
    bodyLen: number;
    device: number[];
    renderer: number[];
    other: number[];
    sha: string;
}

const SMALL_MASK = 'x'.repeat(14) + '????' + 'x'.repeat(22);

const SHAPES: Record<string, Shape> = {
    [STORE]: {
        prefix: hexPattern('55b90001000089e5565383ec10a1e0e2df008b750c8b1089742408894c2404890424ff92b4000000'),
        mask: SMALL_MASK,
        bodyLen: 0x100,
        device: [0xe, 0x67, 0xc3],
        renderer: [0x33, 0x49],
        other: [0xb0],
        sha: '6aeed376aae10862bd939422fbb42dedcde5fe331a425e30ce6fb49436a17fed',
    },
    [RESTORE]: {
        prefix: hexPattern('55b90001000089e5565383ec10a1e0e2df008b750c8b1089742408894c2404890424ff92b0000000'),
        mask: SMALL_MASK,
        bodyLen: 0x100,
        device: [0xe, 0x67, 0xc3],
        renderer: [0x33, 0x49],
        other: [0xb0],
        sha: 'edeccd2753c0efb82e2093a92010f55426dda3eee10a569f90fa05a858820d9e',
    },
    [MULTIPLY]: {
        prefix: hexPattern('55b90001000089e557565381ecbc020000a1e0e2df008b5d0c8b10895c2408894c2404890424ff92b8000000'),
        mask: 'x'.repeat(18) + '????' + 'x'.repeat(22),
        bodyLen: 0x2d70,
        device: [0x12, 0x2981, 0x29d4, 0x2a04, 0x2a31, 0x2a61, 0x2a91, 0x2ac1, 0x2af1, 0x2b82, 0x2bb5, 0x2be8,
            0x2c21, 0x2c54, 0x2c97],
        renderer: [0x37, 0x64d, 0x667, 0xd17, 0xd31, 0x1409, 0x1423, 0x1b1d, 0x1b37, 0x2297, 0x22b1, 0x292b,
            0x2941, 0x295b],
        other: [0x29c0],
        sha: '0534194446d167ffecf1fec457a4c1f9455a76372aa5dfa3a0f0c1168c0856e5',
    },
};
const PROLOGUE_LEN = 6;
const RENDERER_CAPS = 0x1c;
const CAPS_MODE = 0xc8;

let deviceAddr = 0;
let rendererAddr = 0;

function resolveOne(view: ResolverModuleView, name: string): { entry: number; device: number; renderer: number } | null {
    const hit = view.signatureHits.find(h => h.signatureId === name);
    if (!hit) return null;
    const shape = SHAPES[name]!;
    const entry = hit.address;
    const body = Mem.readBytes(entry, shape.bodyLen);
    if (!body || body.length !== shape.bodyLen) return null;
    const masked = new Uint8Array(body);
    const device = Mem.readUint32(entry + shape.device[0]!);
    const renderer = Mem.readUint32(entry + shape.renderer[0]!);
    if (device === null || renderer === null) return null;
    for (const off of shape.device) {
        if (Mem.readUint32(entry + off) !== device) return null;
        masked.fill(0, off, off + 4);
    }
    for (const off of shape.renderer) {
        if (Mem.readUint32(entry + off) !== renderer) return null;
        masked.fill(0, off, off + 4);
    }
    for (const off of shape.other) masked.fill(0, off, off + 4);
    if (sha256HexSync(masked) !== shape.sha) {
        Logger.log(LogCategory.SYSTEM,
            `[dxa-transforms] ${view.module.name}: ${name} prefix at 0x${entry.toString(16)} but a different body — not hooked`);
        return null;
    }
    return { entry, device, renderer };
}

function resolveKernel(view: ResolverModuleView): HookedFunctionMatch[] {
    if ((globalThis as { __dxaTransformsHook?: boolean }).__dxaTransformsHook === false) return [];
    const found = [STORE, RESTORE, MULTIPLY].map(name => ({ name, hit: resolveOne(view, name) }));
    const first = found[0]!.hit;
    if (!first || found.some(f => !f.hit || f.hit.device !== first.device || f.hit.renderer !== first.renderer)) return [];
    deviceAddr = first.device;
    rendererAddr = first.renderer;
    Logger.log(LogCategory.SYSTEM,
        `[dxa-transforms] ${view.module.name}: store/restore/multiply at `
        + found.map(f => `0x${f.hit!.entry.toString(16)}`).join(', '));
    return found.map(f => ({ name: f.name, address: f.hit!.entry }));
}

type Device = NonNullable<ReturnType<typeof devices.lookup>>;

interface Call {
    device: Device;
    shader: boolean;
    mem: Uint8Array;
}

const call: Call = { device: null as unknown as Device, shader: false, mem: new Uint8Array(0) };

let pendingDevice: Device | null = null;
const pendingBank = new Float32Array(BANK_FLOATS);

function settlePending(): void {
    const device = pendingDevice;
    if (!device) return;
    pendingDevice = null;
    if (sameBank(device.getVertexShaderConstants(0, BANK_REGISTERS), pendingBank)) transformCounters.checkOk++;
    else transformCounters.checkDiff++;
}

/** The device and mode the guest function would see, or null when it must run itself. */
function resolveCall(view: ShadowView): Call | null {
    settlePending();
    const mem = Mem.getView();
    if (!mem || deviceAddr === 0 || deviceAddr + 4 > mem.length || rendererAddr + 4 > mem.length) return null;
    const device = devices.lookup(view.readU32(deviceAddr));
    if (!device || device.getSoftwareVertexProcessing()) return null;
    const mode = view.readU32(rendererAddr) + RENDERER_CAPS + CAPS_MODE;
    if (mode + 4 > mem.length) return null;
    call.device = device;
    call.shader = view.readU32(mode) > SHADER_MODE_ABOVE;
    call.mem = mem;
    return call;
}

const inRange = (mem: Uint8Array, ptr: number, len: number): boolean => ptr !== 0 && ptr <= mem.length - len;

/** The calling thread's x87 precision-control field is 00 (single, as Direct3D leaves it). */
function callerRoundsToSingle(): boolean {
    const cw = getFpuControlWord((System.getInstance() as { process?: { v86?: unknown } }).process?.v86);
    return cw !== null && (cw & 0x300) === 0;
}

const storeBytes = new Uint8Array(STORE_SHADER_LEN);
const storeView = new DataView(storeBytes.buffer);
const matrix = new Float32Array(16);
const product = new Float32Array(BANK_FLOATS);

function readMatrix(view: ShadowView, ptr: number, out: Float32Array): Float32Array {
    for (let i = 0; i < 16; i++) out[i] = view.readF32(ptr + i * 4);
    return out;
}

const common = { validateInGame: true, guardDeclines: true, allowGuestImports: true, n: 16 } as const;

const storeShadow: ShadowSpec = {
    ...common,
    guard(args, view) {
        const c = resolveCall(view);
        if (!c) return false;
        const len = c.shader ? STORE_SHADER_LEN : STORE_FFP_LEN;
        const buf = args[1]! >>> 0;
        return inRange(c.mem, buf, len) && isValidAddress(c.mem, buf, len, 'rw');
    },
    ranges(args, view) {
        const c = resolveCall(view);
        return c ? [{ addr: args[1]! >>> 0, len: c.shader ? STORE_SHADER_LEN : STORE_FFP_LEN }] : [];
    },
    kernel(view, args) {
        const c = resolveCall(view);
        if (!c) throw new Error('no device');
        const world = c.device.getTransform(WORLD);
        if (!world || world.length < 16) throw new Error('no world matrix');
        for (let i = 0; i < 16; i++) storeView.setFloat32(i * 4, world[i]!, true);
        let len = STORE_FFP_LEN;
        if (c.shader) {
            if (!c.device.copyHardwareVertexShaderConstantsToGuest(0, 4, 0x40, storeView)
                || !c.device.copyHardwareVertexShaderConstantsToGuest(8, 21, 0x80, storeView)) {
                throw new Error('constant bank unreadable');
            }
            len = STORE_SHADER_LEN;
        }
        view.writeBytes(args[1]! >>> 0, storeBytes.subarray(0, len));
        transformCounters.store++;
        return 0;
    },
};

const restoreShadow: ShadowSpec = {
    ...common,
    guard(args, view) {
        const c = resolveCall(view);
        if (!c) return false;
        const buf = args[1]! >>> 0;
        if (!inRange(c.mem, buf, c.shader ? STORE_SHADER_LEN : STORE_FFP_LEN)) return false;
        for (let i = 0; i < 16; i++) if (!Number.isFinite(view.readF32(buf + i * 4))) return false;
        return true;
    },
    ranges: () => [],
    kernel(view, args) {
        if (!(view instanceof LiveShadowView)) return 0;
        const c = resolveCall(view);
        if (!c) throw new Error('no device');
        const buf = args[1]! >>> 0;
        if (c.device.setTransform(WORLD, readMatrix(view, buf, new Float32Array(16))) !== 0) throw new Error('SetTransform failed');
        if (c.shader) {
            c.device.setVertexShaderConstantF(0, buf + 0x40, 4, c.mem);
            c.device.setVertexShaderConstantF(8, buf + 0x80, 21, c.mem);
        }
        transformCounters.restore++;
        return 0;
    },
};

const multiplyShadow: ShadowSpec = {
    ...common,
    guard(args, view) {
        const c = resolveCall(view);
        if (!c) return false;
        const m = args[1]! >>> 0;
        if (!inRange(c.mem, m, 64)) return false;
        if (!plainFloats(readMatrix(view, m, matrix), 0, 16)) { transformCounters.declinedValues++; return false; }
        if (!c.shader) return true;
        if (!callerRoundsToSingle()) return false;
        if (!plainBank(c.device.getVertexShaderConstants(0, BANK_REGISTERS))) { transformCounters.declinedValues++; return false; }
        return true;
    },
    ranges: () => [],
    kernel(view, args) {
        const c = resolveCall(view);
        if (!c) throw new Error('no device');
        const m = readMatrix(view, args[1]! >>> 0, matrix);
        if (!(view instanceof LiveShadowView)) {
            if (c.shader) {
                multiplyBank(c.device.getVertexShaderConstants(0, BANK_REGISTERS), m, pendingBank);
                pendingDevice = c.device;
            }
            return 0;
        }
        if (c.device.multiplyTransform(WORLD, m) !== 0) throw new Error('MultiplyTransform failed');
        transformCounters.multiply++;
        if (!c.shader) return 0;
        multiplyBank(c.device.getVertexShaderConstants(0, BANK_REGISTERS), m, product);
        c.device.setVertexShaderConstantFFromArray(0, product.subarray(0, 16), null as unknown as Uint8Array);
        c.device.setVertexShaderConstantFFromArray(8, product.subarray(32, BANK_FLOATS), null as unknown as Uint8Array);
        transformCounters.multiplyShader++;
        return 0;
    },
};

function hooked(name: string, argCount: number, shadow: ShadowSpec): HookedFunction {
    return {
        name,
        entryProbe: { kind: 'prologue', pattern: new Uint8Array(0), mask: '' },
        externallyResolved: true,
        callingConvention: 'cdecl',
        argCount,
        required: false,
        prologueLen: PROLOGUE_LEN,
        shadow,
    };
}

function signature(name: string): LibDescriptor['signatures'][string] {
    return { kind: 'bytes', pattern: SHAPES[name]!.prefix, mask: SHAPES[name]!.mask, section: '.text', weight: 4 };
}

export const dxaTransformsDescriptor: LibDescriptor = {
    id: 'dxa-transforms',
    displayName: 'Effect-manager world transforms (whole-function HLE)',
    minConfidence: 12,
    signatures: {
        [STORE]: signature(STORE),
        [RESTORE]: signature(RESTORE),
        [MULTIPLY]: signature(MULTIPLY),
    },
    functions: {
        [STORE]: hooked(STORE, 3, storeShadow),
        [RESTORE]: hooked(RESTORE, 3, restoreShadow),
        [MULTIPLY]: hooked(MULTIPLY, 2, multiplyShadow),
    },
    handlers: {},
    resolveAdditionalFunctions: resolveKernel,
    onActivated() {
        (globalThis as Record<string, unknown>).__dxaTransformsStats = () => ({ ...transformCounters });
    },
    onReset() {
        transformCounters.reset();
        pendingDevice = null;
        deviceAddr = 0;
        rendererAddr = 0;
    },
};

export const __test = { SHAPES, PROLOGUE_LEN };
