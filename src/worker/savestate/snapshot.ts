import { System } from '../core/system';
import { setAuthorityCpu } from '../modules/ddraw/surface-sync';
import { isRenderSurface } from '../modules/ddraw/com-objects';
import type { DirectDrawSurfaceState } from '../modules/ddraw/com-objects';
import { decodeGraph, encodeGraph, type EncodedGraph } from './graph';
import { MEM_THUNK_CODE_BASE, MEM_THUNK_CODE_SIZE } from '../core/cpu/emulator-config';

declare const __BUILD_SHA__: string;

export const SAVESTATE_FORMAT = 'BS-SAVE-1';

export interface SavestateMeta {
    format: string;
    engine: string;
    gameId: string;
    scope: 'cpu+ram';
    createdAt: number;
    rawBytes: number;
}

export interface SavestateHost {
    pause(): void;
    resume(): void;
    waitStopped(): Promise<void>;
    isPaused(): boolean;
}

const HALT_ATTEMPTS = 12;

/** v86 CPU.get_state slots that belong to the CPU and guest RAM; the rest are v86 devices. */
const CPU_SLOTS: number[] = [
    ...Array.from({ length: 45 }, (_, i) => i), 62, 64, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 77, 78, 86, 87, 88,
];
const DEVICE_SLOTS = [45, 47, 48, 49, 50, 52, 53, 54, 55, 56, 57, 58, 59, 61, 79, 80, 81, 82, 83, 84, 85];

interface V86Cpu { get_state(): unknown[]; set_state(state: unknown[]): void }

function v86Cpu(): V86Cpu | undefined {
    const v = System.getInstance().process?.v86 as { cpu?: V86Cpu; v86?: { cpu?: V86Cpu } } | undefined;
    return v?.cpu ?? v?.v86?.cpu;
}

/** Binary container: u32 JSON length, JSON tree, then per blob u32 length + bytes. */
function packGraph(graph: EncodedGraph): ArrayBuffer {
    const json = new TextEncoder().encode(JSON.stringify(graph.root));
    let size = 8 + json.byteLength;
    for (const b of graph.blobs) size += 4 + b.byteLength;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, json.byteLength, true);
    dv.setUint32(4, graph.blobs.length, true);
    out.set(json, 8);
    let off = 8 + json.byteLength;
    for (const b of graph.blobs) { dv.setUint32(off, b.byteLength, true); out.set(b, off + 4); off += 4 + b.byteLength; }
    return out.buffer;
}

function unpackGraph(buf: ArrayBuffer): EncodedGraph {
    const dv = new DataView(buf);
    const jsonLen = dv.getUint32(0, true), count = dv.getUint32(4, true);
    const root = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jsonLen)));
    const blobs: Uint8Array[] = [];
    let off = 8 + jsonLen;
    for (let i = 0; i < count; i++) { const len = dv.getUint32(off, true); blobs.push(new Uint8Array(buf, off + 4, len)); off += 4 + len; }
    return { root, blobs };
}

function captureCpuAndRam(): ArrayBuffer {
    const cpu = v86Cpu();
    if (!cpu) throw new Error('no-emulator');
    const full = cpu.get_state();
    const picked: Record<number, unknown> = {};
    for (const i of CPU_SLOTS) picked[i] = full[i];
    return packGraph(encodeGraph(picked));
}

/** Same bit layout as v86's Bitmap, which unpack_memory reads through get(). */
class V86Bitmap {
    private view: Uint8Array;
    constructor(buffer: ArrayBuffer) { this.view = new Uint8Array(buffer); }
    get(index: number): number { return (this.view[index >> 3]! >> (index & 7)) & 1; }
}

interface V86CpuFields {
    memory_size: Uint32Array; segment_is_null: Uint8Array; segment_access_bytes: Uint8Array;
    segment_offsets: Int32Array; segment_limits: Uint32Array; protected_mode: Int32Array;
    idtr_offset: Int32Array; idtr_size: Int32Array; gdtr_offset: Int32Array; gdtr_size: Int32Array;
    cr: Int32Array; cpl: Int32Array; is_32: Int32Array; stack_size_32: Int32Array; in_hlt: Int32Array;
    last_virt_eip: Int32Array; eip_phys: Int32Array; sysenter_cs: Int32Array; sysenter_eip: Int32Array;
    sysenter_esp: Int32Array; prefixes: Int32Array; flags: Int32Array; flags_changed: Int32Array;
    last_op1: Int32Array; last_op_size: Int32Array; instruction_pointer: Int32Array; previous_ip: Int32Array;
    reg32: Int32Array; sreg: Uint16Array; dreg: Int32Array; reg_pdpte: Int32Array; tss_size_32: Int32Array;
    reg_xmm32s: Int32Array; fpu_st: Int32Array; fpu_stack_empty: Int32Array; fpu_stack_ptr: Int32Array;
    fpu_control_word: Int32Array; fpu_ip: Int32Array; fpu_ip_selector: Int32Array; fpu_dp: Int32Array;
    fpu_dp_selector: Int32Array; fpu_opcode: Int32Array;
    last_result: Int32Array; fpu_status_word: Uint16Array; mxcsr: Int32Array; fw_value: unknown;
    set_tsc(lo: number, hi: number): void; unpack_memory(bitmap: unknown, packed: Uint8Array): void;
    update_state_flags(): void; full_clear_tlb(): void; jit_clear_cache(): void;
}

/**
 * The CPU half of v86 CPU.set_state, slot for slot, without its device half: BottleShip's
 * devices are not v86's emulated PC hardware and keep their live state.
 */
function restoreCpuAndRam(buf: ArrayBuffer): void {
    const cpu = v86Cpu() as unknown as V86CpuFields | undefined;
    if (!cpu) throw new Error('no-emulator');
    const st = decodeGraph(unpackGraph(buf)) as Record<number, any>;
    if (st[0] !== cpu.memory_size[0]) throw new Error('memory-size');
    const one = (field: { [k: number]: number }, v: number) => { field[0] = v; };
    if (st[1].length === 16) { cpu.segment_is_null.set(st[1].subarray(0, 8)); cpu.segment_access_bytes.set(st[1].subarray(8, 16)); }
    else cpu.segment_is_null.set(st[1]);
    cpu.segment_offsets.set(st[2]);
    cpu.segment_limits.set(st[3]);
    one(cpu.protected_mode, st[4]); one(cpu.idtr_offset, st[5]); one(cpu.idtr_size, st[6]);
    one(cpu.gdtr_offset, st[7]); one(cpu.gdtr_size, st[8]);
    cpu.cr.set(st[10]);
    one(cpu.cpl, st[11]); one(cpu.is_32, st[13]); one(cpu.stack_size_32, st[16]); one(cpu.in_hlt, st[17]);
    one(cpu.last_virt_eip, st[18]); one(cpu.eip_phys, st[19]);
    one(cpu.sysenter_cs, st[22]); one(cpu.sysenter_eip, st[23]); one(cpu.sysenter_esp, st[24]);
    one(cpu.prefixes, st[25]); one(cpu.flags, st[26]); one(cpu.flags_changed, st[27]); one(cpu.last_op1, st[28]);
    one(cpu.last_op_size, st[30]); one(cpu.instruction_pointer, st[37]); one(cpu.previous_ip, st[38]);
    cpu.reg32.set(st[39]); cpu.sreg.set(st[40]); cpu.dreg.set(st[41]);
    if (st[42]) cpu.reg_pdpte.set(st[42]);
    cpu.set_tsc(st[43][0], st[43][1]);
    cpu.fw_value = st[62];
    one(cpu.tss_size_32, st[64]);
    cpu.reg_xmm32s.set(st[66]); cpu.fpu_st.set(st[67]);
    one(cpu.fpu_stack_empty, st[68]); one(cpu.fpu_stack_ptr, st[69]); one(cpu.fpu_control_word, st[70]);
    one(cpu.fpu_ip, st[71]); one(cpu.fpu_ip_selector, st[72]); one(cpu.fpu_dp, st[73]);
    one(cpu.fpu_dp_selector, st[74]); one(cpu.fpu_opcode, st[75]);
    if (st[86] !== undefined) cpu.last_result.set(st[86]);
    if (st[87] !== undefined) cpu.fpu_status_word.set(st[87]);
    if (st[88] !== undefined) cpu.mxcsr.set(st[88]);
    // Thunk code is generated and patched by the host at run time (lazy entry points, fast
    // paths, write-buffer trampolines); its live bytes match the live dispatcher tables.
    const mem = (cpu as unknown as { mem8: Uint8Array }).mem8;
    const hostCode = mem.slice(MEM_THUNK_CODE_BASE, MEM_THUNK_CODE_BASE + MEM_THUNK_CODE_SIZE);
    cpu.unpack_memory(new V86Bitmap(st[78].buffer), st[77]);
    mem.set(hostCode, MEM_THUNK_CODE_BASE);
    cpu.update_state_flags();
    cpu.full_clear_tlb();
    cpu.jit_clear_cache();
}

export function savestateIdentity(): { gameId: string; engine: string } {
    return { gameId: currentGameId(), engine: engineBuild() };
}

function currentGameId(): string {
    try { return System.getInstance().registry.serialize().gameId ?? ''; } catch { return ''; }
}

function engineBuild(): string {
    return typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev';
}

function asyncWorkInFlight(): boolean {
    const d = System.getInstance().process?.dispatcher as unknown as
        { activeAsyncThunks?: Map<unknown, unknown>; pendingAsyncRestores?: unknown[] } | undefined;
    return (d?.activeAsyncThunks?.size ?? 0) > 0 || (d?.pendingAsyncRestores?.length ?? 0) > 0;
}

/**
 * Stop the guest at a point where no host-side work is suspended on its behalf: every
 * guest thread is then either the CPU's current context or parked at a scheduler boundary.
 * A thunk awaiting a Promise cannot be captured, so the guest runs on briefly and is
 * stopped again until nothing is in flight.
 */
async function haltAtSafePoint(host: SavestateHost): Promise<void> {
    for (let attempt = 0; attempt < HALT_ATTEMPTS; attempt++) {
        host.pause();
        await host.waitStopped();
        if (!asyncWorkInFlight()) return;
        host.resume();
        await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('busy');
}

export async function captureSavestate(host: SavestateHost): Promise<{ meta: SavestateMeta; state: ArrayBuffer }> {
    if (!v86Cpu()) throw new Error('no-emulator');
    const wasRunning = !host.isPaused();
    await haltAtSafePoint(host);
    try {
        const state = captureCpuAndRam();
        return {
            meta: { format: SAVESTATE_FORMAT, engine: engineBuild(), gameId: currentGameId(), scope: 'cpu+ram', createdAt: Date.now(), rawBytes: state.byteLength },
            state,
        };
    } finally {
        if (wasRunning) host.resume();
    }
}

/** GPU copies of guest-memory surfaces are stale after RAM is replaced: re-upload all. */
function invalidateSurfaceCopies(): void {
    const rp = System.getInstance().resourceProvider;
    for (const obj of rp.getAllComObjects()) {
        const s = (obj as { getState?: () => DirectDrawSurfaceState }).getState?.();
        if (s && isRenderSurface(s) && s.surfacePtr) setAuthorityCpu(s);
    }
}

export async function restoreSavestate(host: SavestateHost, meta: SavestateMeta, state: ArrayBuffer): Promise<void> {
    if (meta.format !== SAVESTATE_FORMAT) throw new Error('format');
    if (meta.engine !== engineBuild() || meta.gameId !== currentGameId()) throw new Error('mismatch');
    if (!v86Cpu()) throw new Error('no-emulator');
    const wasRunning = !host.isPaused();
    await haltAtSafePoint(host);
    try {
        restoreCpuAndRam(state);
        invalidateSurfaceCopies();
    } finally {
        if (wasRunning) host.resume();
    }
}

(globalThis as Record<string, unknown>).__bsSavestateDebug = {
    probe(): string {
        const cpu = v86Cpu();
        if (!cpu) return 'no cpu';
        const full = cpu.get_state();
        const out: string[] = [];
        for (const i of CPU_SLOTS) {
            const v = full[i] as { constructor?: { name?: string }; length?: number } | undefined;
            out.push(`${i}:${v === undefined ? 'undef' : (v?.constructor?.name ?? typeof v)}${v && typeof v === 'object' && 'length' in v ? '/' + v.length : ''}`);
        }
        return out.join(' ');
    },
    roundtrip(): string {
        try { restoreCpuAndRam(captureCpuAndRam()); return 'ok'; } catch (e) { return String((e as Error).stack ?? e); }
    },
};
