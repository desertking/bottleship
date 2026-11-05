import { System } from '../core/system';
import { Logger, LogCategory } from '../core/logger';
import { MemoryChunkStore, OpfsChunkStore, sha256Hex, type ChunkStore } from './chunk-store';
import { captureSession, checkSavestate, restoreSession, type SavestateTarget } from './session';
import { savestateParticipants } from './participant';
import type { CompatibilityKey } from './container';

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

async function slotDir(create: boolean): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('savestates', { create });
}

async function writeSlot(name: string, bytes: Uint8Array): Promise<void> {
    const dir = await slotDir(true);
    const handle = await dir.getFileHandle(`${name}.bss`, { create: true });
    const w = await handle.createWritable();
    await w.write(bytes as Uint8Array<ArrayBuffer>);
    await w.close();
}

async function readSlot(name: string): Promise<Uint8Array> {
    const dir = await slotDir(false);
    const file = await (await dir.getFileHandle(`${name}.bss`)).getFile();
    return new Uint8Array(await file.arrayBuffer());
}

const PENDING = 'pending-load.json';

export async function requestLoadOnNextBoot(name: string): Promise<void> {
    await readSlot(name);
    const dir = await slotDir(true);
    const w = await (await dir.getFileHandle(PENDING, { create: true })).createWritable();
    await w.write(JSON.stringify({ name, at: Date.now() }));
    await w.close();
}

async function takePendingLoad(): Promise<string | null> {
    try {
        const dir = await slotDir(false);
        const file = await (await dir.getFileHandle(PENDING)).getFile();
        const { name } = JSON.parse(await file.text()) as { name: string };
        await dir.removeEntry(PENDING);
        return name;
    } catch { return null; }
}

export interface SaveReport { name: string; bytes: number; chunkWrites: number; ms: { capture: number; store: number }; sections: Record<string, number>; ram: unknown }

export async function saveToSlot(name: string, halt: () => Promise<() => void>): Promise<SaveReport> {
    const t0 = performance.now();
    const release = await halt();
    let result;
    try {
        result = await captureSession(target(), await chunkStore());
    } finally {
        release();
    }
    const t1 = performance.now();
    await writeSlot(name, result.bytes);
    const t2 = performance.now();
    return {
        name, bytes: result.bytes.length, chunkWrites: result.ram.written,
        ms: { capture: Math.round(t1 - t0), store: Math.round(t2 - t1) }, sections: result.sections, ram: result.ram,
    };
}

export async function restorePendingAtEntry(): Promise<{ name: string; ms: number } | null> {
    const name = await takePendingLoad();
    if (!name) return null;
    const t0 = performance.now();
    const check = checkSavestate(target(), await readSlot(name));
    if (!check.ok) throw new Error(`savestate ${name} does not fit this boot: ${check.reasons.join('; ')}`);
    if (check.overlayChanged) Logger.warn(LogCategory.SYSTEM, `[SAVESTATE] ${name}: the game's files changed since it was taken`);
    await restoreSession(target(), check.state, await chunkStore());
    const ms = Math.round(performance.now() - t0);
    Logger.log(LogCategory.SYSTEM, `[SAVESTATE] restored ${name} in ${ms} ms`);
    return { name, ms };
}
