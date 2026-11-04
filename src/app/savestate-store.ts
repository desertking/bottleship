export interface StoredMeta {
    format: string;
    engine: string;
    gameId: string;
    scope: string;
    createdAt: number;
    rawBytes: number;
    packedBytes: number;
    sha256: string;
    id: string;
}

interface StoredRecord { meta: StoredMeta; data: ArrayBuffer }

const DB_NAME = 'bs-saves-v1';
const STORE = 'games';
export const MAX_RAW = 900 * 1024 * 1024;
export const MAX_PACKED = 384 * 1024 * 1024;

export class SavestateError extends Error {
    constructor(readonly code: 'too-big' | 'packed-too-big' | 'quota' | 'checksum' | 'mismatch' | 'none' | 'file' | 'storage', message?: string) {
        super(message ?? code);
    }
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new SavestateError('storage', String(req.error)));
    });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await openDb();
    try {
        return await new Promise<T | undefined>((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            const req = run(t.objectStore(STORE));
            t.oncomplete = () => resolve(req ? req.result : undefined);
            t.onerror = () => reject(new SavestateError('storage', String(t.error)));
            t.onabort = () => reject(new SavestateError('storage', String(t.error)));
        });
    } finally {
        db.close();
    }
}

const key = (gameId: string, engine: string, slot: 'current' | 'previous') => `${gameId}:${engine}:${slot}`;

async function pipe(data: ArrayBuffer, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
    const out = new Response(stream.readable).arrayBuffer();
    const writer = stream.writable.getWriter();
    await writer.write(new Uint8Array(data));
    await writer.close();
    return out;
}

async function sha256(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function packSavestate(meta: Omit<StoredMeta, 'packedBytes' | 'sha256' | 'id'>, raw: ArrayBuffer): Promise<StoredRecord> {
    if (raw.byteLength > MAX_RAW) throw new SavestateError('too-big');
    const packed = await pipe(raw, new CompressionStream('gzip'));
    if (packed.byteLength > MAX_PACKED) throw new SavestateError('packed-too-big');
    return { meta: { ...meta, packedBytes: packed.byteLength, sha256: await sha256(packed), id: crypto.randomUUID() }, data: packed };
}

export async function storeSavestate(record: StoredRecord): Promise<void> {
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    if (estimate?.quota !== undefined && estimate.usage !== undefined
        && estimate.quota - estimate.usage < record.data.byteLength + (1 << 20)) {
        throw new SavestateError('quota');
    }
    const { gameId, engine } = record.meta;
    const current = await tx<StoredRecord>('readonly', s => s.get(key(gameId, engine, 'current')));
    await tx('readwrite', s => {
        if (current) s.put(current, key(gameId, engine, 'previous'));
        s.put(record, key(gameId, engine, 'current'));
    });
    await navigator.storage?.persist?.().catch(() => false);
}

export async function savedMeta(gameId: string, engine: string, slot: 'current' | 'previous' = 'current'): Promise<StoredMeta | null> {
    const rec = await tx<StoredRecord>('readonly', s => s.get(key(gameId, engine, slot))).catch(() => undefined);
    return rec?.meta ?? null;
}

export async function getRecord(gameId: string, engine: string, slot: 'current' | 'previous'): Promise<StoredRecord> {
    const rec = await tx<StoredRecord>('readonly', s => s.get(key(gameId, engine, slot)));
    if (!rec) throw new SavestateError('none');
    return rec;
}

export async function unpackSavestate(record: StoredRecord, gameId: string, engine: string): Promise<ArrayBuffer> {
    if (record.meta.gameId !== gameId || record.meta.engine !== engine) throw new SavestateError('mismatch');
    if (await sha256(record.data) !== record.meta.sha256) throw new SavestateError('checksum');
    const raw = await pipe(record.data, new DecompressionStream('gzip'));
    if (raw.byteLength !== record.meta.rawBytes) throw new SavestateError('checksum');
    return raw;
}

/** File: u32le header length, JSON meta, gzip payload. */
export function exportFile(record: StoredRecord): Blob {
    const header = new TextEncoder().encode(JSON.stringify(record.meta));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, header.byteLength, true);
    return new Blob([len, header, record.data], { type: 'application/octet-stream' });
}

export async function importFile(file: Blob): Promise<StoredRecord> {
    const buf = await file.arrayBuffer();
    if (buf.byteLength < 8) throw new SavestateError('file');
    const len = new DataView(buf).getUint32(0, true);
    if (len <= 0 || 4 + len > buf.byteLength) throw new SavestateError('file');
    let meta: StoredMeta;
    try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))); } catch { throw new SavestateError('file'); }
    const data = buf.slice(4 + len);
    if (data.byteLength !== meta.packedBytes || await sha256(data) !== meta.sha256) throw new SavestateError('checksum');
    return { meta, data };
}
