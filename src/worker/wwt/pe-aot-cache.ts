import { sha256Hex } from "../savestate/chunk-store";

const HEADER_BYTES = 32;
const DISK_BUDGET = 1024 * 1024 * 1024;
const stats = { hits: 0, misses: 0, writes: 0, writeErrors: 0, bytesRead: 0, bytesWritten: 0 };
type Directory = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

export function peAotCacheStats() { return { ...stats }; }

async function cacheDirectory(): Promise<Directory | null> {
    if (!globalThis.navigator?.storage?.getDirectory) return null;
    try {
        const root = await navigator.storage.getDirectory();
        const app = await root.getDirectoryHandle("bottleship", { create: true });
        return await app.getDirectoryHandle("wwt-pe-aot-v1", { create: true }) as Directory;
    } catch {
        return null;
    }
}

async function readEntry(dir: Directory, key: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    try {
        const file = await (await dir.getFileHandle(key)).getFile();
        if (file.size <= HEADER_BYTES || file.size > DISK_BUDGET) return;
        const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
        const payload = new Uint8Array(await file.slice(HEADER_BYTES).arrayBuffer());
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
        if (header.every((b, i) => b === hash[i])) return payload;
    } catch { /* Missing or unreadable cache entries are rebuilt from the PE. */ }
}

async function makeRoom(dir: Directory, except: string, required: number): Promise<void> {
    const files = [];
    let total = required;
    for await (const [, handle] of dir.entries()) {
        if (handle.kind !== "file" || !/^[0-9a-f]{64}\.wasm$/.test(handle.name) || handle.name === except) continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        total += file.size;
        files.push({name: file.name, size: file.size, date: file.lastModified});
    }
    if (total <= DISK_BUDGET) return;
    files.sort((a,b) => a.date - b.date);
    for (const file of files) {
        if (total <= DISK_BUDGET) break;
        await dir.removeEntry(file.name);
        await dir.removeEntry(file.name + ".seeds").catch(() => {});
        total -= file.size;
    }
}

export interface PeAotCacheEntry {
    bytes: Uint8Array<ArrayBuffer>;
    seeds: number[];
}

export async function peAotKey(image: Uint8Array<ArrayBuffer>, modeKey: string): Promise<string> {
    const digest = await sha256Hex(image);
    return await sha256Hex(new TextEncoder().encode(modeKey + "/" + digest));
}

async function readSeeds(dir: Directory, key: string): Promise<number[]> {
    try {
        const file = await (await dir.getFileHandle(key + ".seeds")).getFile();
        if (file.size % 4) return [];
        return Array.from(new Uint32Array(await file.slice(0, file.size).arrayBuffer()));
    } catch {
        return [];
    }
}

async function writeFile(dir: Directory, name: string, parts: BufferSource[]): Promise<void> {
    const handle = await dir.getFileHandle(name, {create: true});
    const writer = await handle.createWritable();
    try {
        for (const part of parts) await writer.write(part);
        await writer.close();
    } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
    }
}

export async function readPeAot(image: Uint8Array<ArrayBuffer>, modeKey: string, key?: string): Promise<PeAotCacheEntry | null> {
    const dir = await cacheDirectory();
    if (!dir) return null;
    const name = (key ?? await peAotKey(image, modeKey)) + ".wasm";
    const cached = await readEntry(dir, name);
    if (!cached) return null;
    return { bytes: cached, seeds: await readSeeds(dir, name) };
}

export function notePeAotLookup(hit: Uint8Array<ArrayBuffer> | null): void {
    if (!hit) { stats.misses++; return; }
    stats.hits++;
    stats.bytesRead += hit.byteLength;
}

export type PeAotPlan = "use" | "use-and-refresh" | "rebuild";

export function planPeAot(cachedSeeds: readonly number[] | null, profile: readonly number[], refreshInBackground: boolean): PeAotPlan {
    if (!cachedSeeds) return "rebuild";
    const known = new Set(cachedSeeds);
    if (profile.every(address => known.has(address))) return "use";
    return refreshInBackground ? "use-and-refresh" : "rebuild";
}

export async function writePeAot(image: Uint8Array<ArrayBuffer>, modeKey: string,
    bytes: Uint8Array<ArrayBuffer>, seeds: readonly number[] = []): Promise<void> {
    const dir = await cacheDirectory();
    if (!dir || !bytes.length || bytes.length + HEADER_BYTES > DISK_BUDGET) return;
    try {
        const key = (await peAotKey(image, modeKey)) + ".wasm";
        await makeRoom(dir, key, bytes.length + HEADER_BYTES);
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        await writeFile(dir, key, [hash, bytes]);
        await writeFile(dir, key + ".seeds", [new Uint8Array(Uint32Array.from(seeds).buffer)]);
        stats.writes++;
        stats.bytesWritten += bytes.byteLength;
    } catch { stats.writeErrors++; }
}

export async function getOrBuild(
    image: Uint8Array<ArrayBuffer>, modeKey: string,
    build: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer>> {
    const cached = await readPeAot(image, modeKey);
    notePeAotLookup(cached?.bytes ?? null);
    if (cached) return cached.bytes;
    const bytes = await build();
    await writePeAot(image, modeKey, bytes);
    return bytes;
}
