import { encodeValue, type SaveValue } from './value-codec';

import type { RestoreContext } from './participant';

export interface ObjectCodec<T = unknown> {
    readonly tag: string;
    matches(obj: unknown): obj is T;
    capture(obj: T): SaveValue;
    restore(data: SaveValue, ctx: RestoreContext): T;
}

export class ObjectCodecRegistry {
    private readonly codecs: ObjectCodec[] = [];

    add<T>(codec: ObjectCodec<T>): void {
        const at = this.codecs.findIndex(c => c.tag === codec.tag);
        if (at >= 0) this.codecs[at] = codec as ObjectCodec;
        else this.codecs.push(codec as ObjectCodec);
    }

    codecFor(obj: unknown): ObjectCodec | null {
        return this.codecs.find(c => c.matches(obj)) ?? null;
    }

    byTag(tag: string): ObjectCodec | null {
        return this.codecs.find(c => c.tag === tag) ?? null;
    }
}

/** @transient(behaviour, not data: owners add their codecs when they are created) */
export const objectCodecs = new ObjectCodecRegistry();

/** @transient(constant: kernel object kinds that are plain records) */
export const PLAIN_KERNEL_KINDS: ReadonlySet<string> = new Set(['event', 'mutex', 'semaphore', 'thread']);

export function isPlainRecord(obj: unknown): obj is Record<string, SaveValue> {
    if (obj === null || typeof obj !== 'object' || Object.getPrototypeOf(obj) !== Object.prototype) return false;
    try { encodeValue(obj as SaveValue); return true; } catch { return false; }
}

export class CaptureRefusal extends Error {}

export interface ObjectGraph {
    objects: Array<[string, SaveValue]>;
    ref(obj: unknown, where: string): number;
}

export function newObjectGraph(): ObjectGraph {
    const ids = new Map<unknown, number>();
    const objects: Array<[string, SaveValue]> = [];
    return {
        objects,
        ref(obj: unknown, where: string): number {
            const known = ids.get(obj);
            if (known !== undefined) return known;
            const codec = objectCodecs.codecFor(obj);
            if (!codec) {
                const name = (obj as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof obj;
                const kind = (obj as { kind?: unknown } | null)?.kind;
                throw new CaptureRefusal(`${where}: no savestate codec for ${name}${kind ? ` (${String(kind)})` : ''}`);
            }
            const id = objects.length;
            ids.set(obj, id);
            objects.push([codec.tag, null]);
            objects[id] = [codec.tag, codec.capture(obj)];
            return id;
        },
    };
}

export function restoreObjectGraph(objects: Array<[string, SaveValue]>): RestoreContext {
    const live = new Map<number, unknown>();
    const ctx: RestoreContext = {
        object(ref: number): unknown {
            if (live.has(ref)) return live.get(ref);
            const entry = objects[ref];
            if (!entry) throw new Error(`savestate: object ${ref} is missing`);
            const codec = objectCodecs.byTag(entry[0]);
            if (!codec) throw new Error(`savestate: no codec ${entry[0]} in this build`);
            const obj = codec.restore(entry[1], ctx);
            live.set(ref, obj);
            return obj;
        },
    };
    return ctx;
}
