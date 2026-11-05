import { System } from '../core/system';
import { Logger, LogCategory } from '../core/logger';
import { MemoryChunkStore, OpfsChunkStore, sha256Hex, type ChunkStore } from './chunk-store';
import { captureSession, checkSavestate, restoreSession, type SavestateTarget } from './session';
import { savestateParticipants } from './participant';
import { decodeSavestate, incompatibilities, type CompatibilityKey } from './container';
import { OpfsDir, SlotStore, type SlotInfo } from './slots';
import { gameIdToContainerDir } from '@bottleship/formats/wgb/container-id';

declare const __BUILD_SHA__: string;

export interface BootIdentity {
    gameId: string;
    bundleHash: string;
    configHash: string;
    bootLayout: string;
}

/** @transient(identity of the current boot, recomputed at every entry point) */
let boot: BootIdentity | null = null;

const text = (s: string) => new TextEncoder().encode(s);

export async function noteBootIdentity(input: {
    gameId: string; manifest: unknown; bundleSize: number; config: unknown; layout: unknown;
}): Promise<BootIdentity> {
    boot = {
        gameId: input.gameId,
        bundleHash: await sha256Hex(text(JSON.stringify([input.manifest, input.bundleSize]))),
        configHash: await sha256Hex(text(JSON.stringify(input.config))),
        bootLayout: await sha256Hex(text(JSON.stringify(input.layout))),
    };
    return boot;
}

function target(): SavestateTarget {
    if (!boot) throw new Error('savestate: no boot identity (the game has not reached its entry point)');
    const identity = boot;
    return {
        guestMemory: () => {
            const process = System.getInstance().process;
            if (!process) throw new Error('savestate: no process');
            return process.getCurrentMemory();
        },
        compatibilityKey: (): CompatibilityKey => ({
            buildSha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev',
            bundleHash: identity.bundleHash,
            configHash: identity.configHash,
            bootLayout: identity.bootLayout,
            participants: savestateParticipants.versions(),
        }),
        overlayState: () => '',
        gameId: () => identity.gameId,
    };
}

async function chunkStore(): Promise<ChunkStore> {
    try { return await OpfsChunkStore.open(); } catch { return new MemoryChunkStore(); }
}

const SLOT_NAME = /^[a-z0-9_-]{1,32}$/i;

function checkSlotName(slot: string): string {
    if (!SLOT_NAME.test(slot)) throw new Error(`savestate: bad slot name ${slot}`);
    return slot;
}

function gameDir(): string {
    if (!boot) throw new Error('savestate: no boot identity (the game has not reached its entry point)');
    return gameIdToContainerDir(boot.gameId);
}

async function slots(): Promise<SlotStore> {
    return new SlotStore(await OpfsDir.root('savestates'), await chunkStore());
}

const PENDING = 'pending-load.json';

export async function requestLoadOnNextBoot(slot: string): Promise<void> {
    const game = gameDir();
    if (!(await (await slots()).read(game, checkSlotName(slot)))) throw new Error(`savestate: slot ${slot} is empty`);
    await (await OpfsDir.root('savestates')).write(PENDING, new TextEncoder().encode(JSON.stringify({ game, slot, at: Date.now() })));
}

async function takePendingLoad(): Promise<{ game: string; slot: string } | null> {
    const root = await OpfsDir.root('savestates');
    const bytes = await root.read(PENDING);
    if (!bytes) return null;
    await root.remove(PENDING);
    try { return JSON.parse(new TextDecoder().decode(bytes)) as { game: string; slot: string }; } catch { return null; }
}

export async function listSlots(): Promise<{ gameId: string; game: string; slots: SlotInfo[] }> {
    const game = gameDir();
    const t = target();
    const list = await (await slots()).list(game, (state) => {
        const reasons = incompatibilities(state.header.key, t.compatibilityKey());
        if (state.header.gameId !== t.gameId()) reasons.unshift('other game');
        return reasons;
    });
    return { gameId: boot!.gameId, game, slots: list };
}

export async function deleteSlot(slot: string): Promise<{ removedChunks: number }> {
    return { removedChunks: await (await slots()).remove(gameDir(), checkSlotName(slot)) };
}

export interface SaveReport { name: string; bytes: number; chunkBytes: number; chunkWrites: number; ms: { capture: number; store: number }; sections: Record<string, number>; ram: unknown }

export async function saveToSlot(name: string, halt: () => Promise<() => void>): Promise<SaveReport> {
    checkSlotName(name);
    const t0 = performance.now();
    const store = await chunkStore();
    const release = await halt();
    let result;
    try {
        result = await captureSession(target(), store);
    } finally {
        release();
    }
    const t1 = performance.now();
    const manifest = decodeSavestate(result.bytes).header.ram;
    let chunkBytes = 0;
    for (const [, hash] of manifest.chunks) chunkBytes += await store.size(hash);
    await (await slots()).save(gameDir(), name, result.bytes, chunkBytes);
    const t2 = performance.now();
    return {
        name, bytes: result.bytes.length, chunkBytes, chunkWrites: result.ram.written,
        ms: { capture: Math.round(t1 - t0), store: Math.round(t2 - t1) }, sections: result.sections, ram: result.ram,
    };
}

export async function restorePendingAtEntry(): Promise<{ name: string; ms: number } | null> {
    const pending = await takePendingLoad();
    if (!pending) return null;
    if (pending.game !== gameDir()) return null;
    const name = pending.slot;
    const bytes = await (await slots()).read(pending.game, checkSlotName(name));
    if (!bytes) throw new Error(`savestate: slot ${name} is empty`);
    const t0 = performance.now();
    const check = checkSavestate(target(), bytes);
    if (!check.ok) throw new Error(`savestate ${name} does not fit this boot: ${check.reasons.join('; ')}`);
    if (check.overlayChanged) Logger.warn(LogCategory.SYSTEM, `[SAVESTATE] ${name}: the game's files changed since it was taken`);
    await restoreSession(target(), check.state, await chunkStore());
    const ms = Math.round(performance.now() - t0);
    Logger.log(LogCategory.SYSTEM, `[SAVESTATE] restored ${name} in ${ms} ms`);
    return { name, ms };
}
