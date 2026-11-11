import { describe, expect, test } from "bun:test";

describe("LeaveCriticalSection stays on the fast path once a lock event exists", () => {
    const CS = 0x100, EVENT = 0x4d2, THREAD = 7;

    async function leaveFastPath(waiters: boolean) {
        const { System } = await import("../../src/worker/core/system");
        const system = System.getInstance() as any;
        if (!system.scheduler) system.scheduler = {};
        const sched = system.scheduler;
        const saved = {
            getCurrentThreadId: sched.getCurrentThreadId,
            hasWaitersForHandle: sched.hasWaitersForHandle,
            clearCriticalSectionOwner: sched.clearCriticalSectionOwner,
            resourceProvider: system.resourceProvider,
        };
        sched.getCurrentThreadId = () => THREAD;
        sched.hasWaitersForHandle = (h: number) => waiters && h === EVENT;
        sched.clearCriticalSectionOwner = () => true;
        system.resourceProvider = { ...(saved.resourceProvider ?? {}), isValidHandle: (h: number) => h === EVENT };
        try {
            const { registerFastPathSyncFunctions } = await import(`../../src/worker/modules/kernel32/sync.ts?fresh=${waiters ? 1 : 0}`);
            let leave: ((esp: number, v: DataView, m8: Uint8Array, m32: Uint32Array) => number | null | undefined) | undefined;
            registerFastPathSyncFunctions({
                registerFastPath: (_dll: string, name: string, fn: never) => { if (name === "LeaveCriticalSection") leave = fn; },
            } as never);
            const mem = new Uint8Array(0x400);
            const m32 = new Uint32Array(mem.buffer);
            const view = new DataView(mem.buffer);
            view.setUint32(0x10 + 4, CS, true);
            m32[(CS >> 2) + 1] = 0;
            m32[(CS >> 2) + 2] = 1;
            m32[(CS >> 2) + 3] = THREAD;
            m32[(CS >> 2) + 4] = EVENT;
            const result = leave!(0x10, view, mem, m32);
            return { result, lockCount: m32[(CS >> 2) + 1], owner: m32[(CS >> 2) + 3] };
        } finally {
            sched.getCurrentThreadId = saved.getCurrentThreadId;
            sched.hasWaitersForHandle = saved.hasWaitersForHandle;
            sched.clearCriticalSectionOwner = saved.clearCriticalSectionOwner;
            system.resourceProvider = saved.resourceProvider;
        }
    }

    test("no thread waits: the section is released without a thunk", async () => {
        const r = await leaveFastPath(false);
        expect(r.result).toBe(0);
        expect(r.lockCount).toBe(0xffffffff);
        expect(r.owner).toBe(0);
    });

    test("a thread waits: the slow path hands the section over", async () => {
        const r = await leaveFastPath(true);
        expect(r.result).toBeNull();
        expect(r.owner).toBe(THREAD);
    });
});
