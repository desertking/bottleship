import { savestateParticipants } from './participant';
import { restoreRam, snapshotRam, storeRam, type RamCaptureStats } from './ram';
import type { ChunkStore } from './chunk-store';
import {
    decodeSavestate, encodeSavestate, incompatibilities, type CompatibilityKey, type Savestate,
} from './container';
import { encodeValue, type SaveValue } from './value-codec';
import { newObjectGraph, restoreObjectGraph } from './object-codecs';

const OBJECTS = '$objects';

export type RamFixup = (snap: ReturnType<typeof snapshotRam>) => void;
/** @transient(fixups queued by participants during one capture and consumed by it) */
export const ramFixups: RamFixup[] = [];

export function patchSnapshotWord(snap: ReturnType<typeof snapshotRam>, address: number, bytes: number[]): void {
    const chunkSize = 64 * 1024;
    for (let i = 0; i < bytes.length; i++) {
        const a = address + i;
        const chunk = snap.chunks.get(Math.floor(a / chunkSize));
        if (chunk) chunk[a % chunkSize] = bytes[i]!;
        else {
            const fresh = new Uint8Array(Math.min(chunkSize, snap.length - Math.floor(a / chunkSize) * chunkSize));
            fresh[a % chunkSize] = bytes[i]!;
            snap.chunks.set(Math.floor(a / chunkSize), fresh);
        }
    }
}

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
    const graph = newObjectGraph();
    for (const p of savestateParticipants.all()) {
        const value = p.capture(graph);
        sections.set(p.id, value);
        const enc = encodeValue(value);
        sizes[p.id] = enc.json.length + enc.blobs.reduce((n, b) => n + b.length, 0);
    }
    sections.set(OBJECTS, graph.objects as unknown as SaveValue);
    const snap = snapshotRam(target.guestMemory());
    for (const fix of ramFixups.splice(0)) fix(snap);
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
    const ctx = restoreObjectGraph((state.sections.get(OBJECTS) ?? []) as unknown as Array<[string, SaveValue]>);
    for (const p of savestateParticipants.all()) {
        const value = state.sections.get(p.id);
        if (value === undefined) throw new Error(`savestate: no section for participant ${p.id}`);
        await p.restore(value, ctx);
    }
}
