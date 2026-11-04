import { isValidAddress } from '../../core/memory/address-guard';
import type { DirectDrawSurfaceState, RenderSurface } from './com-objects';
import { DDSCAPS_FLIP } from './constants';

/** CPU-mapped video memory remains visible to scanout between DirectDraw calls. */
export class PrimaryScanoutTracker {
    private surface: DirectDrawSurfaceState | null = null;
    private address = 0;
    private pixels: Uint8Array | null = null;

    private lockSurface: DirectDrawSurfaceState | null = null;
    private lockLease: number | undefined = undefined;

    reset(): void { this.surface = null; this.pixels = null; this.lockSurface = null; this.lockLease = undefined; }

    /**
     * True once the current Lock of `state` has stayed open across a whole frame tick.
     * Unlock of a primary presents by itself, so a Lock/write/Unlock inside one frame must
     * not be scanned out half-written; only a Lock held across frames needs the scanout.
     */
    lockHeldAcrossFrame(state: DirectDrawSurfaceState): boolean {
        const lease = state.activeLeaseId;
        if (lease === undefined) { this.lockSurface = null; this.lockLease = undefined; return false; }
        if (this.lockSurface === state && this.lockLease === lease) return true;
        this.lockSurface = state; this.lockLease = lease;
        return false;
    }

    changed(mem: Uint8Array, state: DirectDrawSurfaceState): boolean {
        const size = state.pitch * state.height, address = state.surfacePtr;
        if (size <= 0 || !address || !isValidAddress(mem, address, size, 'r') || address + size > mem.length) return false;
        const bytes = mem.subarray(address, address + size);
        if (this.surface !== state || this.address !== address || this.pixels?.length !== size) {
            this.surface = state; this.address = address; this.pixels = bytes.slice();
            return true;
        }
        const snapshot = this.pixels;
        const words = size >>> 2;
        let same = true;
        if (((mem.byteOffset + address) & 3) === 0) {
            const current = new Uint32Array(mem.buffer, mem.byteOffset + address, words);
            const previous = new Uint32Array(snapshot.buffer, snapshot.byteOffset, words);
            for (let i = 0; i < words; i++) if (current[i] !== previous[i]) { same = false; break; }
            if (same) for (let i = words * 4; i < size; i++) if (bytes[i] !== snapshot[i]) { same = false; break; }
        } else {
            for (let i = 0; i < size; i++) if (bytes[i] !== snapshot[i]) { same = false; break; }
        }
        if (same) return false;
        snapshot.set(bytes);
        return true;
    }
}

/**
 * Whether the frame-paced scanout should show a render primary's guest pixels now.
 * A primary at the head of a flip chain is shown by Flip alone: Flip rotates the chain's
 * storage and presents it, so a scanout between Flips could only show a buffer the app has
 * not flipped yet (or a stale CPU copy of one rotated in). Without a chain, the primary is
 * directly mapped video memory and stays visible while locked or CPU-written.
 */
export function primaryAutoPresentDue(state: RenderSurface): boolean {
    if ((state.caps & DDSCAPS_FLIP) !== 0) return false;
    if (state.activeLeaseId !== undefined) return true;
    return state.format.bpp === 8 && state.everLocked && state.mode === 'CPU'
        && state.gpuWrittenVersion !== state.version;
}
