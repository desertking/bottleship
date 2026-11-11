import { describe, expect, test } from "bun:test";
import { POLL_SPIN_STREAK, PollKind, PollSpinDetector } from "../../src/worker/core/thunking/poll-spin-detector";
import { ThunkDispatcher } from "../../src/worker/core/thunking/thunk-dispatcher";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { registerFastPathSyncFunctions } from "../../src/worker/modules/kernel32/sync";
import { registerFastPathInputFunctions } from "../../src/worker/modules/user32/input";

function dispatcher() {
    const d = Object.create(ThunkDispatcher.prototype) as any;
    d.pollSpin = new PollSpinDetector();
    const calls: boolean[] = [];
    d.cachedScheduler = { yieldForPollSpin: (wall: boolean) => { calls.push(wall); return true; } };
    d.pollFastPathTable = new Uint8Array(16);
    d.trivialFastPathTable = new Uint8Array(16);
    d.recordShadowStackAtEntry = () => { /* stub */ };
    d.notifySchedulerBoundary = () => { /* stub */ };
    d.fastPathSinceLastBoundary = 0;
    return { d, calls };
}

describe("a sound loop that takes a lock around each cursor poll is still a spin", () => {
    test("Enter/LeaveCriticalSection and GetAsyncKeyState between GetCurrentPosition polls keep the streak", () => {
        const { d, calls } = dispatcher();
        d.pollFastPathTable[3] = PollKind.WallClock;
        d.pollFastPathTable[5] = PollKind.Neutral;
        const cpu = { instruction_counter: new Int32Array(1) };
        const original = preemptionManager.requestImmediateExit;
        preemptionManager.requestImmediateExit = () => { /* stub */ };
        try {
            for (let i = 0; i < POLL_SPIN_STREAK; i++) {
                cpu.instruction_counter[0] += 60;
                d.completeFastPathSync(5, 0x1000, 4, cpu);
                cpu.instruction_counter[0] += 60;
                d.completeFastPathSync(3, 0x1000, 8, cpu);
                cpu.instruction_counter[0] += 60;
                d.completeFastPathSync(5, 0x1000, 4, cpu);
            }
        } finally {
            preemptionManager.requestImmediateExit = original;
        }
        expect(calls).toEqual([true]);
    });

    test("the lock fast paths are neutral and GetAsyncKeyState is a wall-clock poll", () => {
        const kinds = new Map<string, number | undefined>();
        const registrar = {
            registerFastPath: (_dll: string, name: string, _fn: unknown, opts?: { poll?: number }) => { kinds.set(name, opts?.poll); },
        } as never;
        registerFastPathSyncFunctions(registrar);
        registerFastPathInputFunctions(registrar);
        expect([kinds.get("EnterCriticalSection"), kinds.get("LeaveCriticalSection"), kinds.get("GetAsyncKeyState")])
            .toEqual([3, 3, PollKind.WallClock]);
    });
});
