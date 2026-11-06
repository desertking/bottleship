import { describe, expect, it } from "bun:test";
import { createStallWatch, DEFAULT_STALL_WATCH } from "../../src/app/stall-watch";

function harness() {
    const pings: number[] = [];
    const changes: boolean[] = [];
    const watch = createStallWatch((seq) => pings.push(seq), (v) => changes.push(v), DEFAULT_STALL_WATCH);
    let presents = 0;
    let busy = 0;
    const step = (t: number, opts: { answer?: boolean; frames?: number; busyPerStep?: number } = {}) => {
        watch.tick(t);
        presents += opts.frames ?? 0;
        busy += opts.busyPerStep ?? 0;
        if (opts.answer !== false) watch.pong(pings[pings.length - 1]!, presents, busy, t);
    };
    return { pings, changes, step };
}

describe("emulation stall hint", () => {
    it("stays off while the worker answers and the guest keeps presenting", () => {
        const { changes, step } = harness();
        for (let t = 0; t < 5000; t += 250) step(t, { frames: 15, busyPerStep: 200 });
        expect(changes).toEqual([]);
    });

    it("turns on when a ping goes unanswered past a second and off on the answer", () => {
        const { pings, changes, step } = harness();
        step(0, { answer: false });
        for (let t = 250; t <= 1000; t += 250) step(t, { answer: false });
        expect(changes).toEqual([]);
        step(1250, { answer: false });
        expect(changes).toEqual([true]);
        expect(pings).toEqual([1]);
        step(1500);
        expect(changes).toEqual([true, false]);
    });

    it("turns on when continuous presents stop while the guest stays busy", () => {
        const { changes, step } = harness();
        let t = 0;
        for (; t < 2000; t += 250) step(t, { frames: 15, busyPerStep: 200 });
        for (; t < 3500; t += 250) step(t, { busyPerStep: 240 });
        expect(changes).toEqual([true]);
        step(t, { frames: 1, busyPerStep: 240 });
        expect(changes).toEqual([true, false]);
    });

    it("stays off on a static screen whose guest is idle", () => {
        const { changes, step } = harness();
        let t = 0;
        for (; t < 2000; t += 250) step(t, { frames: 15, busyPerStep: 200 });
        for (; t < 6000; t += 250) step(t, { busyPerStep: 10 });
        expect(changes).toEqual([]);
    });

    it("stays off for a guest that never presented continuously", () => {
        const { changes, step } = harness();
        let t = 0;
        for (; t < 6000; t += 250) step(t, { frames: t % 2000 === 0 ? 1 : 0, busyPerStep: 250 });
        expect(changes).toEqual([]);
    });
});
