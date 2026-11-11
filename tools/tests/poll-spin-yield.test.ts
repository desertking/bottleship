import { afterEach, describe, expect, test } from "bun:test";
import { POLL_SPIN_MAX_GAP_INSNS, POLL_SPIN_STREAK, PollKind, PollSpinDetector } from "../../src/worker/core/thunking/poll-spin-detector";
import { ThunkDispatcher } from "../../src/worker/core/thunking/thunk-dispatcher";
import { Scheduler } from "../../src/worker/core/scheduler/scheduler";
import { ThreadState, type Thread, type V86Cpu } from "../../src/worker/core/scheduler/types";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";

function mkThread(id: number, state: ThreadState): Thread {
    return {
        id, handle: 0x1000 + id, state, context: null, stackBase: 0x00200000, stackSize: 0x00100000,
        stackTop: 0x00300000, startAddress: 0x00401000, parameter: 0, waitInfo: null, exitCode: null,
        tlsValues: new Map(), lastError: 0, suspendCount: 0, priority: 0, lastSwitchTime: 0, lastSwitchInsn: 0,
        tebAddress: 0, kernelPinCount: 0, apcQueue: [], quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    };
}

function scheduler(opts: { others?: boolean; state?: ThreadState } = {}): Scheduler {
    const s = new Scheduler();
    const any = s as any;
    const t = mkThread(1, opts.state ?? ThreadState.RUNNING);
    any.threads.set(1, t);
    any.currentThreadId = 1;
    if (opts.others) {
        any.threads.set(2, mkThread(2, ThreadState.READY));
        any.runQueue.push(2);
    }
    return s;
}

function fakeCpu(): V86Cpu & { instruction_counter: Int32Array } {
    return { instruction_counter: new Int32Array(1) } as unknown as V86Cpu & { instruction_counter: Int32Array };
}

afterEach(() => {
    delete (globalThis as Record<string, unknown>).__noPollSpinYield;
});

describe("poll spin detector", () => {
    test("a tight run of polls is a spin", () => {
        const d = new PollSpinDetector();
        let insn = 5_000_000;
        let fired = -1;
        for (let i = 0; i < POLL_SPIN_STREAK * 2 && fired < 0; i++) {
            insn += 150;
            if (d.poll(insn)) fired = i;
        }
        expect(fired).toBe(POLL_SPIN_STREAK - 1);
    });

    test("negative: any other call between the polls is not a spin", () => {
        const d = new PollSpinDetector();
        let insn = 5_000_000;
        for (let i = 0; i < POLL_SPIN_STREAK * 20; i++) {
            insn += 150;
            expect(d.poll(insn)).toBe(false);
            if (i % 100 === 99) d.other();
        }
    });

    test("negative: a frame loop that polls once per stretch of work is not a spin", () => {
        const d = new PollSpinDetector();
        let insn = 5_000_000;
        for (let i = 0; i < POLL_SPIN_STREAK * 20; i++) {
            insn += POLL_SPIN_MAX_GAP_INSNS + 1;
            expect(d.poll(insn)).toBe(false);
        }
    });

    test("the instruction counter wrapping does not break a streak", () => {
        const d = new PollSpinDetector();
        let insn = 0xffffffff - 150 * 100;
        let fired = false;
        for (let i = 0; i < POLL_SPIN_STREAK; i++) {
            insn = (insn + 150) >>> 0;
            fired = d.poll(insn) || fired;
        }
        expect(fired).toBe(true);
    });
});

describe("scheduler yield for a poll spin", () => {
    test("a sole thread spinning on a wall-clock poll gives the host a short yield", () => {
        const s = scheduler();
        expect(s.yieldForPollSpin(true)).toBe(true);
        expect((s as any).yieldToHostMs).toBeGreaterThan(0);
        expect((s as any).yieldToHostMs).toBeLessThanOrEqual(2);
        expect((s as any).pendingYieldSource).toBe("pollSpin");
        expect((s as any).switchRequested).toBe(false);
    });

    test("with another thread ready the spinner switches instead of idling the host", () => {
        const s = scheduler({ others: true });
        expect(s.yieldForPollSpin(true)).toBe(false);
        expect((s as any).switchRequested).toBe(true);
        expect((s as any).yieldToHostMs).toBe(0);
    });

    test("negative: a virtual-clock poller never idles the host (its clock only runs while it runs)", () => {
        const s = scheduler();
        expect(s.yieldForPollSpin(false)).toBe(false);
        expect((s as any).yieldToHostMs).toBe(0);
        expect((s as any).switchRequested).toBe(false);
    });

    test("negative: a thread that is not running is left alone", () => {
        const s = scheduler({ state: ThreadState.WAITING });
        expect(s.yieldForPollSpin(true)).toBe(false);
        expect((s as any).yieldToHostMs).toBe(0);
    });
});

describe("dispatcher poll fast paths", () => {
    function dispatcher(yieldResult: boolean) {
        const d = Object.create(ThunkDispatcher.prototype) as any;
        d.pollSpin = new PollSpinDetector();
        const calls: boolean[] = [];
        d.cachedScheduler = { yieldForPollSpin: (wall: boolean) => { calls.push(wall); return yieldResult; } };
        return { d, calls };
    }

    function spin(d: any, cpu: { instruction_counter: Int32Array }, kind: number, n: number): void {
        for (let i = 0; i < n; i++) {
            cpu.instruction_counter[0] += 120;
            d.notePollFastPath(kind, cpu);
        }
    }

    test("a GetCurrentPosition spin asks for a wall-clock yield and ends the slice", () => {
        const { d, calls } = dispatcher(true);
        const cpu = fakeCpu();
        const exits: number[] = [];
        const original = preemptionManager.requestImmediateExit;
        preemptionManager.requestImmediateExit = () => { exits.push(1); };
        try {
            spin(d, cpu, PollKind.WallClock, POLL_SPIN_STREAK);
        } finally {
            preemptionManager.requestImmediateExit = original;
        }
        expect(calls).toEqual([true]);
        expect(exits.length).toBe(1);
    });

    test("a time-poll spin asks without the wall-clock flag", () => {
        const { d, calls } = dispatcher(false);
        spin(d, fakeCpu(), PollKind.VirtualClock, POLL_SPIN_STREAK);
        expect(calls).toEqual([false]);
    });

    test("negative: the kill switch leaves the spin alone", () => {
        (globalThis as Record<string, unknown>).__noPollSpinYield = true;
        const { d, calls } = dispatcher(true);
        spin(d, fakeCpu(), PollKind.WallClock, POLL_SPIN_STREAK * 4);
        expect(calls).toEqual([]);
    });

    test("negative: any other fast path between the polls breaks the streak", () => {
        const { d, calls } = dispatcher(true);
        d.pollFastPathTable = new Uint8Array(16);
        d.trivialFastPathTable = new Uint8Array(16);
        d.pollFastPathTable[3] = PollKind.WallClock;
        d.recordShadowStackAtEntry = () => {};
        d.notifySchedulerBoundary = () => {};
        d.fastPathSinceLastBoundary = 0;
        const cpu = fakeCpu();
        const original = preemptionManager.requestImmediateExit;
        preemptionManager.requestImmediateExit = () => {};
        try {
            for (let i = 0; i < POLL_SPIN_STREAK * 8; i++) {
                cpu.instruction_counter[0] += 120;
                d.completeFastPathSync(i % 64 === 63 ? 4 : 3, 0x1000, 8, cpu);
            }
            expect(calls).toEqual([]);
            for (let i = 0; i < POLL_SPIN_STREAK; i++) {
                cpu.instruction_counter[0] += 120;
                d.completeFastPathSync(3, 0x1000, 8, cpu);
            }
            expect(calls).toEqual([true]);
        } finally {
            preemptionManager.requestImmediateExit = original;
        }
    });
});
