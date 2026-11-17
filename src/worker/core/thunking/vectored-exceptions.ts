/** Process-owned VEH registrations. No guest allocation or retained removed nodes. */
export class VectoredExceptions {
    private handlers = new Map<number, number>();
    private order: number[] = [];
    private nextHandle = 1;

    get size(): number { return this.handlers.size; }

    add(first: number, handler: number): number {
        // Opaque identities are never recycled within a process, including during dispatch.
        if (!(handler >>> 0) || this.nextHandle > 0xffffffff) return 0;
        const handle = this.nextHandle++;
        this.handlers.set(handle, handler >>> 0);
        if (first) this.order.unshift(handle); else this.order.push(handle);
        return handle;
    }

    remove(handle: number): number {
        handle >>>= 0;
        if (!this.handlers.delete(handle)) return 0;
        this.order.splice(this.order.indexOf(handle), 1);
        return 1;
    }

    get(handle: number): number { return this.handlers.get(handle) ?? 0; }
    // A dispatch retains only identities; removed handlers are skipped. Registrations
    // made by a callback become eligible on the next (including nested) exception.
    snapshot(): number[] { return this.order.slice(); }
    captureState(): { nextHandle: number; entries: number[][] } {
        return { nextHandle: this.nextHandle, entries: this.order.map(h => [h, this.handlers.get(h)!]) };
    }
    restoreState(state: ReturnType<VectoredExceptions['captureState']>): void {
        this.handlers = new Map(state.entries.map(([h, fn]) => [h!, fn!]));
        this.order = state.entries.map(([h]) => h!);
        this.nextHandle = state.nextHandle;
    }
    reset(): void { this.handlers.clear(); this.order.length = 0; this.nextHandle = 1; }
}
