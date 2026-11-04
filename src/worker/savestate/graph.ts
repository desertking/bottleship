/**
 * Object-graph codec for savestate participants: plain data, Maps, Sets, typed arrays and
 * class instances (by constructor name, resolved again on restore in the same engine build),
 * with shared references and cycles preserved. Functions are not data: a participant must
 * drop or rebind them, and an unexpected one fails the capture rather than being lost.
 */

type Node =
    | { t: 'ref'; i: number }
    | { t: 'num'; v: number | string }
    | { t: 'big'; v: string }
    | { t: 'undef' }
    | { t: 'arr'; i: number; v: Node[] }
    | { t: 'map'; i: number; v: [Node, Node][] }
    | { t: 'set'; i: number; v: Node[] }
    | { t: 'typed'; i: number; k: string; b: number }
    | { t: 'obj'; i: number; c: string; v: Record<string, Node> }
    | { t: 'ext'; n: string }
    | null | boolean | string | number;

export interface EncodedGraph { root: Node; blobs: Uint8Array[] }

export class GraphFunctionError extends Error {
    constructor(readonly path: string) { super(`function at ${path}`); }
}

export interface EncodeOptions {
    /** Return true to drop a function-valued field instead of failing. */
    dropFunction?: (path: string, owner: object, key: string) => boolean;
    /** Return true to skip a field entirely (host handles, GPU objects, caches). */
    skipField?: (path: string, owner: object, key: string, value: unknown) => boolean;
    /** Objects that live outside the snapshot (engine singletons), encoded by name. */
    externals?: Map<object, string>;
}

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
    Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray,
    BigInt64Array: BigInt64Array as unknown as new (b: ArrayBuffer) => ArrayBufferView,
    BigUint64Array: BigUint64Array as unknown as new (b: ArrayBuffer) => ArrayBufferView,
};

function typedArrayName(v: object): string | null {
    for (const name of Object.keys(TYPED)) if (v instanceof TYPED[name]!) return name;
    return null;
}

export function encodeGraph(value: unknown, opts: EncodeOptions = {}): EncodedGraph {
    const ids = new Map<object, number>();
    const blobs: Uint8Array[] = [];
    let next = 0;
    const enc = (v: unknown, path: string): Node => {
        if (v === null || typeof v === 'boolean' || typeof v === 'string') return v as Node;
        if (v === undefined) return { t: 'undef' };
        if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : { t: 'num', v: Object.is(v, -0) ? '-0' : String(v) };
        if (typeof v === 'bigint') return { t: 'big', v: v.toString() };
        if (typeof v === 'function') throw new GraphFunctionError(path);
        if (typeof v !== 'object') throw new Error(`unsupported ${typeof v} at ${path}`);
        const seen = ids.get(v);
        if (seen !== undefined) return { t: 'ref', i: seen };
        const ext = opts.externals?.get(v);
        if (ext !== undefined) return { t: 'ext', n: ext };
        const i = next++;
        ids.set(v, i);
        const typedName = typedArrayName(v);
        if (typedName) {
            // Copy element-wise: engine views may be Proxies over WASM memory.
            const copy = new TYPED[typedName]!(v as unknown as ArrayBuffer) as unknown as ArrayBufferView;
            blobs.push(new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength).slice());
            return { t: 'typed', i, k: typedName, b: blobs.length - 1 };
        }
        if (Array.isArray(v)) return { t: 'arr', i, v: v.map((x, k) => enc(x, `${path}[${k}]`)) };
        if (v instanceof Map) return { t: 'map', i, v: [...v].map(([k, x], n) => [enc(k, `${path}<k${n}>`), enc(x, `${path}<${String(k)}>`)]) };
        if (v instanceof Set) return { t: 'set', i, v: [...v].map((x, n) => enc(x, `${path}{${n}}`)) };
        const out: Record<string, Node> = {};
        for (const key of Object.keys(v)) {
            const field = (v as Record<string, unknown>)[key];
            const fp = `${path}.${key}`;
            if (opts.skipField?.(fp, v, key, field)) continue;
            if (typeof field === 'function' && opts.dropFunction?.(fp, v, key)) continue;
            out[key] = enc(field, fp);
        }
        return { t: 'obj', i, c: v.constructor?.name ?? 'Object', v: out };
    };
    return { root: enc(value, '$'), blobs };
}

/** Resolve a constructor name to its prototype in this build; null = plain object. */
export type PrototypeLookup = (ctorName: string) => object | null | undefined;

export function decodeGraph(graph: EncodedGraph, lookup: PrototypeLookup = () => null, externals: Map<string, unknown> = new Map()): unknown {
    const made = new Map<number, unknown>();
    const dec = (n: Node): unknown => {
        if (n === null || typeof n !== 'object') return n;
        switch (n.t) {
            case 'ref': {
                if (!made.has(n.i)) throw new Error(`dangling ref ${n.i}`);
                return made.get(n.i);
            }
            case 'num': return Number(n.v);
            case 'big': return BigInt(n.v);
            case 'undef': return undefined;
            case 'ext': {
                if (!externals.has(n.n)) throw new Error(`unknown external ${n.n}`);
                return externals.get(n.n);
            }
            case 'typed': {
                const Ctor = TYPED[n.k];
                if (!Ctor) throw new Error(`typed array ${n.k}`);
                const view = new Ctor(graph.blobs[n.b]!.slice().buffer as ArrayBuffer);
                made.set(n.i, view);
                return view;
            }
            case 'arr': {
                const out: unknown[] = [];
                made.set(n.i, out);
                for (const x of n.v) out.push(dec(x));
                return out;
            }
            case 'map': {
                const out = new Map();
                made.set(n.i, out);
                for (const [k, x] of n.v) out.set(dec(k), dec(x));
                return out;
            }
            case 'set': {
                const out = new Set();
                made.set(n.i, out);
                for (const x of n.v) out.add(dec(x));
                return out;
            }
            case 'obj': {
                let proto: object | null = Object.prototype;
                if (n.c !== 'Object') {
                    const found = lookup(n.c);
                    if (found === undefined) throw new Error(`unknown class ${n.c}`);
                    proto = found ?? Object.prototype;
                }
                const out = Object.create(proto) as Record<string, unknown>;
                made.set(n.i, out);
                for (const [k, x] of Object.entries(n.v)) out[k] = dec(x);
                return out;
            }
        }
        throw new Error('bad node');
    };
    return dec(graph.root);
}

/** Collect constructor prototypes reachable from live roots, for PrototypeLookup. */
export function collectPrototypes(roots: unknown[], limit = 200000): Map<string, object> {
    const protos = new Map<string, object>();
    const seen = new WeakSet<object>();
    const stack: unknown[] = [...roots];
    let visited = 0;
    while (stack.length && visited++ < limit) {
        const v = stack.pop();
        if (!v || typeof v !== 'object' || seen.has(v) || ArrayBuffer.isView(v)) continue;
        seen.add(v);
        const proto = Object.getPrototypeOf(v);
        const name = proto?.constructor?.name;
        if (name && name !== 'Object' && !protos.has(name)) protos.set(name, proto);
        if (v instanceof Map) { for (const [k, x] of v) { stack.push(k, x); } continue; }
        if (v instanceof Set || Array.isArray(v)) { for (const x of v as Iterable<unknown>) stack.push(x); continue; }
        for (const key of Object.keys(v)) {
            try { stack.push((v as Record<string, unknown>)[key]); } catch { /* accessor */ }
        }
    }
    return protos;
}
