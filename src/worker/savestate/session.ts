import { savestateParticipants } from './participant';
import { restoreRam, snapshotRam, storeRam, type RamCaptureStats } from './ram';
import type { ChunkStore } from './chunk-store';
import {
    decodeSavestate, encodeSavestate, incompatibilities, type CompatibilityKey, type Savestate,
} from './container';
import { encodeValue, type SaveValue } from './value-codec';

export interface SavestateTarget {
    guestMemory(): Uint8Array;
    compatibilityKey(): CompatibilityKey;
    overlayState(): string;
    gameId(): string;
}

export interface CaptureResult { bytes: Uint8Array; ram: RamCaptureStats; sections: Record<string, number> }

export async function captureSession(target: SavestateTarget, store: ChunkStore): Promise<CaptureResult> {
    const sections = new Map<string, SaveValue>();
    const sizes: Record<string, number> = {};
    for (const p of savestateParticipants.all()) {
        const value = p.capture();
        sections.set(p.id, value);
        const enc = encodeValue(value);
        sizes[p.id] = enc.json.length + enc.blobs.reduce((n, b) => n + b.length, 0);
    }
    const snap = snapshotRam(target.guestMemory());
    const { manifest, stats } = await storeRam(snap, store);
    const state: Savestate = {
        header: {
            key: target.compatibilityKey(), overlay: target.overlayState(),
            createdAt: Date.now(), gameId: target.gameId(), ram: manifest,
        },
        sections,
    };
    const bytes = encodeSavestate(state);
    return { bytes, ram: stats, sections: sizes };
}

export interface LoadCheck { ok: boolean; reasons: string[]; overlayChanged: boolean; state: Savestate }

export function checkSavestate(target: SavestateTarget, bytes: Uint8Array): LoadCheck {
    const state = decodeSavestate(bytes);
    const reasons = incompatibilities(state.header.key, target.compatibilityKey());
    if (state.header.gameId !== target.gameId()) reasons.unshift(`snapshot is for ${state.header.gameId}`);
    return { ok: reasons.length === 0, reasons, overlayChanged: state.header.overlay !== target.overlayState(), state };
}

export async function restoreSession(target: SavestateTarget, state: Savestate, store: ChunkStore): Promise<void> {
    await restoreRam(target.guestMemory(), state.header.ram, store);
    for (const p of savestateParticipants.all()) {
        const value = state.sections.get(p.id);
        if (value === undefined) throw new Error(`savestate: no section for participant ${p.id}`);
        p.restore(value);
    }
}
