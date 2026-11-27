import type { SyncAccessHandleLike } from "@bottleship/formats/zip";
import { sha256Hex } from "../savestate/chunk-store";
import { sha256HexSync } from "../savestate/sha256";
import { PE_PROFILE_MAX_ENTRIES } from "./pe-profile";
import type { PeAotCacheEntry } from "./pe-aot-cache";

const HASH = /^[a-f0-9]{64}$/;
const MAX_PACKAGE = 512 * 1024 * 1024;
const MAX_MODULE = 128 * 1024 * 1024;
const MAX_HEADER = 256 * 1024;
const MAX_MANIFEST = 4 * 1024 * 1024;
const MAX_RECORDS = 65536;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type DemandInput = {
    address: number;
    length: number;
    flags: number;
    opt: number;
    known: number[];
};

type DemandRecord = DemandInput & {
    kind: "demand";
    code: string;
    compilerMs: number;
    sha256?: string;
};

type PeRecord = { kind: "pe"; key: string; seeds: number[] };
type RecordHeader = DemandRecord | PeRecord;

interface WarmManifest {
    version: 1;
    compiler: string;
    pe: Record<string, { sha256: string; size: number; seeds: number[] }>;
    demand?: { sha256: string; size: number };
    profile?: Record<string, number[]>;
}

function uint32(n: unknown): n is number {
    return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
}

function seeds(value: unknown): value is number[] {
    return Array.isArray(value) && value.length <= PE_PROFILE_MAX_ENTRIES && value.every(uint32);
}

function hash(s: unknown): s is string {
    return typeof s === "string" && HASH.test(s);
}

function fileDescriptor(value: { sha256?: unknown; size?: unknown }, max: number): boolean {
    return !!value && hash(value.sha256) && uint32(value.size) && value.size > 0 && value.size <= max;
}

function validateManifest(value: WarmManifest, compilerHash: string): boolean {
    if (value?.version !== 1 || value.compiler !== compilerHash || !value.pe || typeof value.pe !== "object"
        || (value.demand !== undefined && !fileDescriptor(value.demand, MAX_PACKAGE))) return false;
    let bytes = value.demand?.size ?? 0;
    for (const [key, entry] of Object.entries(value.pe)) {
        if (!hash(key) || !fileDescriptor(entry, MAX_MODULE) || !seeds(entry.seeds)) return false;
        bytes += entry.size;
    }
    if (bytes > MAX_PACKAGE) return false;
    return value.profile === undefined || (!!value.profile && typeof value.profile === "object"
        && Object.entries(value.profile).every(([key, rvas]) => hash(key) && seeds(rvas)));
}

class PackageReader {
    private chunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    private at = 0;
    constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

    async exact(length: number): Promise<Uint8Array<ArrayBuffer>> {
        const bytes = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
            if (this.at === this.chunk.length) {
                const part = await this.reader.read();
                if (part.done) throw new Error("Truncated WWT package");
                this.chunk = part.value;
                this.at = 0;
            }
            const part = this.chunk.subarray(this.at, this.at + length - offset);
            bytes.set(part, offset);
            offset += part.length;
            this.at += part.length;
        }
        return bytes;
    }

    async end(): Promise<boolean> {
        if (this.at !== this.chunk.length) return false;
        return (await this.reader.read()).done === true;
    }

    async close(): Promise<void> {
        await this.reader.cancel().catch(() => {});
    }
}

async function openFile(url: URL, signal: AbortSignal, size?: number): Promise<PackageReader> {
    const response = await fetch(url, { signal, redirect: "error", mode: "same-origin" });
    if (!response.ok || !response.body) throw new Error(`WWT package HTTP ${response.status}`);
    const length = response.headers.get("content-length");
    if (size !== undefined && length !== null && !response.headers.has("content-encoding") && +length !== size) {
        await response.body.cancel();
        throw new Error("Unexpected WWT package size");
    }
    return new PackageReader(response.body.getReader());
}

type DemandEntries = Map<string, Map<string, WebAssembly.Module>>;

function demandContext(input: DemandInput): string {
    return `${input.length}/${input.flags}/${input.opt}/${input.known.join(",")}`;
}

export class WwtWarmPackage {
    private readonly controller = new AbortController();
    private readonly demand = new Map<number, DemandEntries>();
    private manifest?: WarmManifest;
    private root?: URL;
    readonly stats = { peHits: 0, demandHits: 0, demandPrepared: 0, demandBytes: 0, errors: 0 };
    readonly ready: Promise<void> = Promise.resolve();

    constructor(root: string | undefined, compilerHash: string) {
        if (!root) return;
        let base: URL;
        try { base = new URL(root, globalThis.location.href); } catch { return; }
        if (base.origin !== globalThis.location.origin || base.username || base.password || !HASH.test(compilerHash)) return;
        base.pathname = base.pathname.replace(/\/?$/, "/");
        this.root = new URL(compilerHash + "/", base);
        this.ready = this.loadManifest(this.root, compilerHash);
    }

    private async loadManifest(root: URL, compilerHash: string): Promise<void> {
        try {
            const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(2000)]);
            const response = await fetch(new URL("index.json", root), { signal, redirect: "error", mode: "same-origin", cache: "no-cache" });
            if (!response.ok || !response.body) return;
            const reader = response.body.getReader();
            try {
                let json = "", length = 0;
                const utf8 = new TextDecoder("utf-8", { fatal: true });
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    length += value.length;
                    if (length > MAX_MANIFEST) throw new Error("WWT warm manifest too large");
                    json += utf8.decode(value, { stream: true });
                }
                const manifest = JSON.parse(json + utf8.decode()) as WarmManifest;
                if (!validateManifest(manifest, compilerHash)) throw new Error("Invalid WWT warm manifest");
                if (this.controller.signal.aborted) return;
                this.manifest = manifest;
                if (manifest.demand) void this.loadDemand(root, manifest.demand);
            } finally {
                await reader.cancel().catch(() => {});
            }
        } catch {
            if (!this.controller.signal.aborted) this.stats.errors++;
        }
    }

    profile(digest: string): readonly number[] {
        return this.manifest?.profile?.[digest] ?? [];
    }

    async pe(key: string): Promise<PeAotCacheEntry | null> {
        const spec = this.manifest?.pe[key];
        if (!spec || !this.root) return null;
        try {
            const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]);
            const reader = await openFile(new URL(`${key}-${spec.sha256}.wasm`, this.root), signal, spec.size);
            try {
                const bytes = await reader.exact(spec.size);
                if (!(await reader.end()) || await sha256Hex(bytes) !== spec.sha256) {
                    throw new Error("Invalid WWT PE artifact");
                }
                return { bytes, seeds: spec.seeds };
            } finally {
                await reader.close();
            }
        } catch {
            if (!this.controller.signal.aborted) this.stats.errors++;
            return null;
        }
    }

    private async loadDemand(root: URL, spec: NonNullable<WarmManifest["demand"]>): Promise<void> {
        let reader: PackageReader | undefined;
        try {
            const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000)]);
            reader = await openFile(new URL(`demand-${spec.sha256}.bin`, root), signal, spec.size);
            let remaining = spec.size;
            let records = 0;
            while (remaining) {
                if (++records > MAX_RECORDS || remaining < 8) throw new Error("Invalid WWT demand pack");
                const sizes = new DataView((await reader.exact(8)).buffer);
                const headerSize = sizes.getUint32(0, true);
                const wasmSize = sizes.getUint32(4, true);
                remaining -= 8 + headerSize + wasmSize;
                if (!headerSize || headerSize > MAX_HEADER || !wasmSize || wasmSize > MAX_MODULE || remaining < 0) {
                    throw new Error("Invalid WWT demand record size");
                }
                const record = JSON.parse(decoder.decode(await reader.exact(headerSize))) as DemandRecord;
                const wasm = await reader.exact(wasmSize);
                if (record?.kind !== "demand" || !uint32(record.address) || !uint32(record.length)
                    || record.length === 0 || record.length > 0x40000 || !uint32(record.flags)
                    || (record.opt !== 0 && record.opt !== 1) || !seeds(record.known)
                    || !hash(record.code) || !hash(record.sha256)) throw new Error("Invalid WWT demand record");
                try {
                    if (await sha256Hex(wasm) !== record.sha256) throw new Error("Invalid WWT demand artifact");
                    const module = await WebAssembly.compile(wasm);
                    if (this.controller.signal.aborted) return;
                    let contexts = this.demand.get(record.address);
                    if (!contexts) this.demand.set(record.address, contexts = new Map());
                    const context = demandContext(record);
                    let codes = contexts.get(context);
                    if (!codes) contexts.set(context, codes = new Map());
                    codes.set(record.code, module);
                    this.stats.demandPrepared++;
                    this.stats.demandBytes += wasmSize;
                } catch {
                    this.stats.errors++;
                }
            }
            if (!(await reader.end())) throw new Error("Unexpected WWT demand pack trailer");
        } catch {
            if (!this.controller.signal.aborted) this.stats.errors++;
        } finally {
            await reader?.close();
        }
    }

    lookupDemand(address: number, code: Uint8Array, known: number[], flags: number, opt: number): WebAssembly.Module | undefined {
        const contexts = this.demand.get(address);
        const candidates = contexts?.get(demandContext({ address, length: code.length, known, flags, opt }));
        return candidates?.get(sha256HexSync(code));
    }

    close(): void {
        this.controller.abort();
        this.demand.clear();
    }
}

export class WwtWarmRecorder {
    private at: number;
    private readonly seen = new Set<string>();
    private closed = false;

    private constructor(private readonly file: SyncAccessHandleLike, compilerHash: string) {
        const header = encoder.encode(`WWTWARM1 ${compilerHash}\n`);
        this.at = file.write(header, { at: 0 });
        if (this.at !== header.length) throw new Error("Short WWT recording header");
    }

    static async open(id: unknown, compilerHash: string): Promise<WwtWarmRecorder | undefined> {
        if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return;
        try {
            const root = await navigator.storage.getDirectory();
            const file = await root.getFileHandle(`wwt-warm-${id}.bin`, { create: true });
            const access = file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandleLike> };
            const handle = await access.createSyncAccessHandle();
            try {
                handle.truncate(0);
                return new WwtWarmRecorder(handle, compilerHash);
            } catch {
                handle.close();
                return;
            }
        } catch {
            return;
        }
    }

    private append(key: string, header: RecordHeader, wasm: Uint8Array<ArrayBuffer>): void {
        if (this.closed || this.seen.has(key) || this.seen.size >= MAX_RECORDS || wasm.length > MAX_MODULE) return;
        const json = encoder.encode(JSON.stringify(header));
        const sizes = new DataView(new ArrayBuffer(8));
        sizes.setUint32(0, json.length, true);
        sizes.setUint32(4, wasm.length, true);
        if (json.length > MAX_HEADER || this.at + 8 + json.length + wasm.length > MAX_PACKAGE) return;
        const start = this.at;
        try {
            for (const part of [new Uint8Array(sizes.buffer), json, wasm]) {
                const written = this.file.write(part, { at: this.at });
                if (written !== part.byteLength) throw new Error("Short WWT recording write");
                this.at += written;
            }
            this.seen.add(key);
        } catch {
            try { this.file.truncate(start); this.at = start; } catch {}
            this.close();
        }
    }

    demand(address: number, code: Uint8Array, known: number[], flags: number, opt: number,
        compilerMs: number, wasm: Uint8Array<ArrayBuffer>): void {
        if (this.closed) return;
        const record: DemandRecord = { kind: "demand", address, length: code.length, known, flags, opt,
            code: sha256HexSync(code), compilerMs };
        this.append(`${address}/${demandContext(record)}/${record.code}`, record, wasm);
    }

    pe(key: string, seeds: number[], wasm: Uint8Array<ArrayBuffer>): void {
        this.append(`${key}/${seeds.join(",")}`, { kind: "pe", key, seeds }, wasm);
    }

    close(): number {
        if (!this.closed) {
            this.closed = true;
            try { this.file.flush(); } catch {}
            try { this.file.close(); } catch {}
        }
        return this.at;
    }
}
