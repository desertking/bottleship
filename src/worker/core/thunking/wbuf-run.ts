import type { WriteBufHandler } from "./thunk-dispatcher";

export interface WriteBufRunTables {
    readonly owners: ReadonlyArray<WriteBufRunConsumer | null>;
    readonly ops: Uint8Array;
    readonly argCounts: Uint8Array;
}

export interface WriteBufRunConsumer {
    run(mem8: Uint8Array, mem32: Uint32Array, base: number, offset: number, head: number, tables: WriteBufRunTables): number;
}

interface WriteBufRunBinding { consumer: WriteBufRunConsumer; op: number; }

const bindings = new WeakMap<WriteBufHandler, WriteBufRunBinding>();

export function bindWriteBufRun(handler: WriteBufHandler, consumer: WriteBufRunConsumer, op: number): WriteBufHandler {
    if (op < 1 || op > 255) throw new RangeError(`WBUF run opcode ${op} out of range`);
    bindings.set(handler, { consumer, op });
    return handler;
}

export function writeBufRunOf(handler: WriteBufHandler | null): WriteBufRunBinding | undefined {
    return handler ? bindings.get(handler) : undefined;
}
