import { System } from '../core/system';
import { setAuthorityCpu } from '../modules/ddraw/surface-sync';
import { isRenderSurface } from '../modules/ddraw/com-objects';
import type { DirectDrawSurfaceState } from '../modules/ddraw/com-objects';
import { decodeGraph, encodeGraph, type EncodedGraph } from './graph';

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

/** Apply saved CPU and RAM slots over the live device state, which stays as it is. */
function restoreCpuAndRam(buf: ArrayBuffer): void {
    const cpu = v86Cpu();
    if (!cpu) throw new Error('no-emulator');
    const saved = decodeGraph(unpackGraph(buf)) as Record<number, unknown>;
    const live = cpu.get_state();
    for (const i of DEVICE_SLOTS) {
        const dev = live[i] as { get_state?: () => unknown } | undefined;
        live[i] = dev && typeof dev.get_state === 'function' ? dev.get_state() : dev;
    }
    for (const i of CPU_SLOTS) live[i] = saved[i];
    cpu.set_state(live);
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
