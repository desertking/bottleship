import { decodeSavestate, type Savestate } from './container';
import { referencedChunks } from './ram';
import type { ChunkStore } from './chunk-store';

export interface Dir {
    list(): Promise<string[]>;
    read(name: string): Promise<Uint8Array | null>;
    write(name: string, bytes: Uint8Array): Promise<void>;
    remove(name: string): Promise<void>;
    dir(name: string, create: boolean): Promise<Dir | null>;
}

export class MemoryDir implements Dir {
    private readonly files = new Map<string, Uint8Array>();
    private readonly dirs = new Map<string, MemoryDir>();
    async list(): Promise<string[]> { return [...this.files.keys(), ...this.dirs.keys()]; }
    async read(name: string): Promise<Uint8Array | null> { return this.files.get(name)?.slice() ?? null; }
    async write(name: string, bytes: Uint8Array): Promise<void> { this.files.set(name, bytes.slice()); }
    async remove(name: string): Promise<void> { this.files.delete(name); this.dirs.delete(name); }
    async dir(name: string, create: boolean): Promise<Dir | null> {
        let d = this.dirs.get(name);
        if (!d && create) { d = new MemoryDir(); this.dirs.set(name, d); }
        return d ?? null;
    }
}

export class OpfsDir implements Dir {
    constructor(private readonly handle: FileSystemDirectoryHandle) {}

    static async root(name: string): Promise<OpfsDir> {
        const root = await navigator.storage.getDirectory();
        return new OpfsDir(await root.getDirectoryHandle(name, { create: true }));
    }

    async list(): Promise<string[]> {
        const out: string[] = [];
        for await (const name of (this.handle as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(name);
        return out;
    }

    async read(name: string): Promise<Uint8Array | null> {
        try { return new Uint8Array(await (await (await this.handle.getFileHandle(name)).getFile()).arrayBuffer()); } catch { return null; }
    }

    async write(name: string, bytes: Uint8Array): Promise<void> {
        const tmp = `${name}.tmp`;
        const w = await (await this.handle.getFileHandle(tmp, { create: true })).createWritable();
        await w.write(bytes as Uint8Array<ArrayBuffer>);
        await w.close();
        const fh = await this.handle.getFileHandle(tmp) as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
        if (fh.move) await fh.move(name);
        else {
            const w2 = await (await this.handle.getFileHandle(name, { create: true })).createWritable();
            await w2.write(bytes as Uint8Array<ArrayBuffer>);
            await w2.close();
            await this.handle.removeEntry(tmp);
        }
    }

    async remove(name: string): Promise<void> {
        await this.handle.removeEntry(name, { recursive: true }).catch(() => undefined);
    }

    async dir(name: string, create: boolean): Promise<Dir | null> {
        try { return new OpfsDir(await this.handle.getDirectoryHandle(name, { create })); } catch { return null; }
    }
}

export interface SlotInfo {
    slot: string;
    createdAt: number;
    bytes: number;
    chunkBytes: number;
    compatible: boolean;
    reasons: string[];
}

const STATE = '.bss';
const META = '.json';
const text = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

export class SlotStore {
    constructor(private readonly root: Dir, private readonly chunks: ChunkStore) {}

    async save(game: string, slot: string, bytes: Uint8Array, chunkBytes: number): Promise<SlotInfo> {
        const dir = (await this.root.dir(game, true))!;
        const createdAt = Date.now();
        await dir.write(slot + STATE, bytes);
        await dir.write(slot + META, text({ createdAt, bytes: bytes.length, chunkBytes }));
        await this.collectGarbage();
        return { slot, createdAt, bytes: bytes.length, chunkBytes, compatible: true, reasons: [] };
    }

    async read(game: string, slot: string): Promise<Uint8Array | null> {
        return (await (await this.root.dir(game, false))?.read(slot + STATE)) ?? null;
    }

    async list(game: string, check: (state: Savestate) => string[]): Promise<SlotInfo[]> {
        const dir = await this.root.dir(game, false);
        if (!dir) return [];
        const out: SlotInfo[] = [];
        for (const name of (await dir.list()).filter(n => n.endsWith(STATE)).sort()) {
            const slot = name.slice(0, -STATE.length);
            const meta = JSON.parse(new TextDecoder().decode((await dir.read(slot + META)) ?? text({}))) as Partial<SlotInfo>;
            let reasons: string[];
            try { reasons = check(decodeSavestate((await dir.read(name))!)); } catch (e) { reasons = [String((e as Error).message ?? e)]; }
            out.push({
                slot, createdAt: meta.createdAt ?? 0, bytes: meta.bytes ?? 0, chunkBytes: meta.chunkBytes ?? 0,
                compatible: reasons.length === 0, reasons,
            });
        }
        return out;
    }

    async remove(game: string, slot: string): Promise<number> {
        const dir = await this.root.dir(game, false);
        if (dir) { await dir.remove(slot + STATE); await dir.remove(slot + META); }
        return this.collectGarbage();
    }

    async collectGarbage(): Promise<number> {
        const manifests = [];
        for (const game of await this.root.list()) {
            const dir = await this.root.dir(game, false);
            if (!dir) continue;
            for (const name of (await dir.list()).filter(n => n.endsWith(STATE))) {
                const bytes = await dir.read(name);
                if (!bytes) continue;
                try { manifests.push(decodeSavestate(bytes).header.ram); } catch { return 0; }
            }
        }
        const keep = referencedChunks(manifests);
        let removed = 0;
        for (const hash of await this.chunks.list()) {
            if (!keep.has(hash)) { await this.chunks.delete(hash); removed++; }
        }
        return removed;
    }
}
