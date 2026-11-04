import { System } from '../core/system';
import { setAuthorityCpu } from '../modules/ddraw/surface-sync';
import { isRenderSurface } from '../modules/ddraw/com-objects';
import type { DirectDrawSurfaceState } from '../modules/ddraw/com-objects';

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
    const v86 = System.getInstance().process?.v86 as { save_state?: () => Promise<ArrayBuffer> } | undefined;
    if (!v86?.save_state) throw new Error('no-emulator');
    const wasRunning = !host.isPaused();
    await haltAtSafePoint(host);
    try {
        const state = await v86.save_state();
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
    const v86 = System.getInstance().process?.v86 as { restore_state?: (s: ArrayBuffer) => Promise<void> } | undefined;
    if (!v86?.restore_state) throw new Error('no-emulator');
    const wasRunning = !host.isPaused();
    await haltAtSafePoint(host);
    try {
        await v86.restore_state(state);
        invalidateSurfaceCopies();
    } finally {
        if (wasRunning) host.resume();
    }
}
