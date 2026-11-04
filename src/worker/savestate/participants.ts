import { System } from '../core/system';
import { collectPrototypes, decodeGraph, encodeGraph, GraphFunctionError, HOST_VIEW, type EncodedGraph } from './graph';

/**
 * JS-side state that a savestate carries next to guest RAM and CPU. Each participant names
 * a live engine object whose own data fields are captured and, on load, written back onto
 * the same live object. Engine singletons are referenced by name, host objects (GPU, canvas,
 * workers, audio) are left out and rebuilt by their owners, and functions keep their live
 * binding.
 */

const HOST_CTOR = /^(GPU|OffscreenCanvas|ImageBitmap|AudioContext|AudioWorklet|Worker|MessagePort|WebAssembly|SharedArrayBuffer|WebSocket|FileSystem|Promise|WeakMap|WeakSet|WeakRef)/;

interface Participant { name: string; get(): object | undefined; skip?: (key: string) => boolean }

function engineExternals(): Map<object, string> {
    const sys = System.getInstance() as unknown as Record<string, unknown> & { process?: Record<string, unknown> & { modules: Map<string, object> } };
    const ext = new Map<object, string>();
    const add = (o: unknown, n: string) => { if (o && typeof o === 'object' && !ext.has(o)) ext.set(o, n); };
    add(sys, 'system');
    for (const k of Object.keys(sys)) add(sys[k], `system.${k}`);
    if (sys.process) {
        for (const k of Object.keys(sys.process)) add(sys.process[k], `process.${k}`);
        for (const [n, m] of sys.process.modules) add(m, `module.${n}`);
    }
    return ext;
}

export function participants(): Participant[] {
    const sys = System.getInstance() as unknown as Record<string, any>;
    return [
        { name: 'memory', get: () => sys.process?.memory },
        { name: 'addressSpace', get: () => sys.process?.addressSpace },
        { name: 'resources', get: () => sys.resourceProvider },
    ];
}

const hostField = (_p: string, _o: object, _k: string, v: unknown) =>
    !!v && typeof v === 'object' && HOST_CTOR.test((v as { constructor?: { name?: string } }).constructor?.name ?? '');

export interface ParticipantProbe { name: string; ok: boolean; bytes?: number; droppedFunctions?: number; error?: string; samplePaths?: string[] }

export function probeParticipants(): ParticipantProbe[] {
    const out: ParticipantProbe[] = [];
    for (const p of participants()) {
        const root = p.get();
        if (!root) { out.push({ name: p.name, ok: false, error: 'missing' }); continue; }
        const externals = engineExternals();
        externals.delete(root);
        const dropped: string[] = [];
        try {
            const g = encodeGraph(root, {
                externals,
                skipField: hostField,
                dropFunction: (path) => { dropped.push(path); return true; },
            });
            const bytes = JSON.stringify(g.root).length + g.blobs.reduce((a, b) => a + b.byteLength, 0);
            out.push({ name: p.name, ok: true, bytes, droppedFunctions: dropped.length, samplePaths: dropped.slice(0, 12) });
        } catch (e) {
            out.push({ name: p.name, ok: false, error: e instanceof GraphFunctionError ? `function ${e.path}` : String((e as Error).message ?? e) });
        }
    }
    return out;
}

export function captureParticipants(): Record<string, EncodedGraph> {
    const graphs: Record<string, EncodedGraph> = {};
    for (const p of participants()) {
        const root = p.get();
        if (!root) throw new Error(`participant ${p.name} missing`);
        const externals = engineExternals();
        externals.delete(root);
        graphs[p.name] = encodeGraph(root, { externals, skipField: hostField, dropFunction: () => true });
    }
    return graphs;
}

export function restoreParticipants(graphs: Record<string, EncodedGraph>): void {
    const roots = participants().map(p => p.get()).filter(Boolean) as object[];
    const protos = collectPrototypes([System.getInstance(), ...roots]);
    for (const p of participants()) {
        const graph = graphs[p.name];
        const live = p.get() as Record<string, unknown> | undefined;
        if (!graph || !live) throw new Error(`participant ${p.name} missing`);
        const extByName = new Map<string, unknown>();
        for (const [o, n] of engineExternals()) extByName.set(n, o);
        const decoded = decodeGraph(graph, name => protos.get(name), extByName) as Record<string, unknown>;
        mergeInto(live, decoded, new WeakSet());
    }
}

const isPlainMergeable = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set) && !ArrayBuffer.isView(v);

/**
 * Write decoded data onto the live object graph: where both sides hold an instance of the
 * same class (or a same-length array), the live instance is kept and updated in place, so
 * its functions (dropped at capture) and identity survive; anything else is replaced.
 */
function mergeInto(live: Record<string, unknown>, decoded: Record<string, unknown>, seen: WeakSet<object>): void {
    if (seen.has(live)) return;
    seen.add(live);
    for (const key of Object.keys(decoded)) {
        const lv = live[key], dv = decoded[key];
        if (typeof lv === 'function' || dv === HOST_VIEW) continue;
        if (Array.isArray(lv) && Array.isArray(dv)) {
            for (let i = 0; i < dv.length; i++) {
                const a = lv[i], b = dv[i];
                if (b === HOST_VIEW) continue;
                if (isPlainMergeable(a) && isPlainMergeable(b) && Object.getPrototypeOf(a) === Object.getPrototypeOf(b)) mergeInto(a, b, seen);
                else lv[i] = b;
            }
            lv.length = dv.length;
            continue;
        }
        if (isPlainMergeable(lv) && isPlainMergeable(dv) && Object.getPrototypeOf(lv) === Object.getPrototypeOf(dv)) {
            mergeInto(lv, dv, seen);
            continue;
        }
        live[key] = dv;
    }
}
