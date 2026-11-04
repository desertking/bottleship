import { System } from '../core/system';

/**
 * State census for savestates: which JS-side stores hold live state at this moment.
 * Guest RAM and CPU registers come with a v86 snapshot; everything listed here would need
 * its own serializer (or a reason why it can be rebuilt). Diagnostic only.
 */

interface StoreEntry { path: string; kind: string; size: number; closures: number }

const SKIP_CTORS = /^(GPU|WebGL|OffscreenCanvas|ImageBitmap|AudioContext|Worker|MessagePort|WebAssembly)/;

function ctorName(v: object): string {
    return (v as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
}

function walk(root: unknown, path: string, depth: number, seen: WeakSet<object>, out: StoreEntry[]): void {
    if (root === null || typeof root !== 'object' || seen.has(root as object)) return;
    seen.add(root as object);
    const name = ctorName(root as object);
    if (SKIP_CTORS.test(name) || ArrayBuffer.isView(root) || root instanceof ArrayBuffer) return;
    if (typeof SharedArrayBuffer !== 'undefined' && root instanceof SharedArrayBuffer) return;
    if (root instanceof Map || root instanceof Set) {
        let closures = 0;
        for (const v of root.values()) if (typeof v === 'function') closures++;
        if (root.size > 0) out.push({ path, kind: name, size: root.size, closures });
        if (depth > 0) {
            let i = 0;
            for (const v of root.values()) {
                if (i++ >= 4) break;
                walk(v, `${path}[*]`, depth - 1, seen, out);
            }
        }
        return;
    }
    if (Array.isArray(root)) {
        let closures = 0;
        for (const v of root) if (typeof v === 'function') closures++;
        if (root.length > 0) out.push({ path, kind: 'Array', size: root.length, closures });
        if (depth > 0) for (let i = 0; i < Math.min(root.length, 4); i++) walk(root[i], `${path}[*]`, depth - 1, seen, out);
        return;
    }
    if (depth < 0) return;
    for (const key of Object.keys(root as object)) {
        let v: unknown;
        try { v = (root as Record<string, unknown>)[key]; } catch { continue; }
        if (typeof v === 'function') { out.push({ path: `${path}.${key}`, kind: 'Function', size: 1, closures: 1 }); continue; }
        walk(v, `${path}.${key}`, depth - 1, seen, out);
    }
}

export function stateCensus(depth = 3): Record<string, unknown> {
    const system = System.getInstance() as unknown as Record<string, unknown> & {
        process?: { modules: Map<string, unknown>; dispatcher?: unknown; memory?: { getBucketStats?: () => unknown } };
    };
    const roots: Record<string, unknown> = {
        scheduler: system.scheduler,
        resourceProvider: system.resourceProvider,
        windowManager: system.windowManager,
        inputManager: system.inputManager,
        fileSystem: system.fileSystem,
        gdiContext: system.gdiContext,
        dispatcher: system.process?.dispatcher,
        memory: system.process?.memory,
    };
    for (const [name, mod] of system.process?.modules ?? []) roots[`module:${name}`] = mod;
    const seen = new WeakSet<object>();
    const perRoot: Record<string, { stores: number; entries: number; closures: number; top: StoreEntry[] }> = {};
    for (const [name, root] of Object.entries(roots)) {
        const out: StoreEntry[] = [];
        walk(root, name, depth, seen, out);
        const stores = out.filter(e => e.kind !== 'Function');
        perRoot[name] = {
            stores: stores.length,
            entries: stores.reduce((a, e) => a + e.size, 0),
            closures: out.reduce((a, e) => a + e.closures, 0),
            top: out.filter(e => e.kind !== 'Function' || name.startsWith('module:')).sort((a, b) => b.size - a.size).slice(0, 12),
        };
    }
    const sched = system.scheduler as unknown as {
        threads: Map<number, { state: number; waitInfo?: { onWake?: unknown } | null; apcQueue?: unknown[] }>;
        timerWheel: { entries: Map<number, { kind: number; intervalMs: number }> };
    };
    const threads = [...sched.threads.values()].map(t => ({ state: t.state, waiting: !!t.waitInfo, onWake: typeof t.waitInfo?.onWake === 'function', apcs: t.apcQueue?.length ?? 0 }));
    const timersByKind: Record<number, number> = {};
    for (const e of sched.timerWheel.entries.values()) timersByKind[e.kind] = (timersByKind[e.kind] ?? 0) + 1;
    const disp = system.process?.dispatcher as { activeAsyncThunks?: Map<unknown, unknown>; pendingAsyncRestores?: unknown[] } | undefined;
    const rp = system.resourceProvider as unknown as Record<string, { items?: unknown[] } | undefined>;
    const tables: Record<string, Record<string, number>> = {};
    for (const t of ['comObjects', 'gdiObjects', 'kernelObjects', 'userObjects', 'fileHandles']) {
        const hist: Record<string, number> = {};
        for (const o of rp[t]?.items ?? []) {
            if (!o || typeof o !== 'object') continue;
            const k = t === 'kernelObjects' ? String((o as { kind?: string }).kind ?? ctorName(o)) : ctorName(o);
            hist[k] = (hist[k] ?? 0) + 1;
        }
        tables[t] = hist;
    }
    return {
        threads,
        timersByKind,
        asyncThunksInFlight: disp?.activeAsyncThunks?.size ?? -1,
        pendingAsyncRestores: disp?.pendingAsyncRestores?.length ?? -1,
        tables,
        buckets: system.process?.memory?.getBucketStats?.() ?? null,
        perRoot,
    };
}

/** Guest RAM footprint: non-zero 4 KiB pages, and their gzip size when `compress` is set. */
export async function guestMemoryFootprint(compress = false): Promise<Record<string, number>> {
    const process = System.getInstance().process as unknown as { getCurrentMemory: () => Uint8Array } | undefined;
    const mem = process?.getCurrentMemory();
    if (!mem) return { error: 1 };
    const t0 = performance.now();
    const pages = mem.length >>> 12;
    const words = new Uint32Array(mem.buffer, mem.byteOffset, mem.length >>> 2);
    let nonZero = 0;
    const live: number[] = [];
    for (let p = 0; p < pages; p++) {
        const base = p << 10;
        for (let i = 0; i < 1024; i++) {
            if (words[base + i] !== 0) { nonZero++; live.push(p); break; }
        }
    }
    const scanMs = performance.now() - t0;
    const result: Record<string, number> = { memBytes: mem.length, nonZeroPages: nonZero, rawBytes: nonZero * 4096, scanMs: Math.round(scanMs) };
    if (compress) {
        const t1 = performance.now();
        const stream = new CompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const sized = new Response(stream.readable).arrayBuffer();
        for (const p of live) await writer.write(mem.slice(p << 12, (p + 1) << 12));
        await writer.close();
        result.gzipBytes = (await sized).byteLength;
        result.gzipMs = Math.round(performance.now() - t1);
    }
    return result;
}

(globalThis as Record<string, unknown>).__bsSavestate = { stateCensus, guestMemoryFootprint };
