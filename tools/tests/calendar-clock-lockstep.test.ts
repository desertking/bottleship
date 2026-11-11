/**
 * Calendar time and uptime are one clock.
 *
 * Windows serves GetSystemTime/GetLocalTime/GetSystemTimeAsFileTime and GetTickCount from
 * the same interrupt time, so over any interval their deltas agree to within a tick. The
 * guest clock here is instruction-paced and falls behind the host whenever emulation runs
 * slower than the original machine; a calendar read straight from the host then drifts
 * away from GetTickCount. Programs that cross-check the two as timer-tamper detection
 * (Super PI mod 1.5 compares both deltas every timing call and jumps to garbage beyond
 * 20 ms) die with an access violation right after GetLocalTime.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { TimeService } from "../../src/worker/runtime/time";
import { exports as time } from "../../src/worker/modules/kernel32/time/time";

const ST = 0x100;
const FT = 0x200;
const mem = new Uint8Array(0x1000);
const view = new DataView(mem.buffer);
const ctx = {} as never;

function busyWait(ms: number): void {
    const t = performance.now();
    while (performance.now() - t < ms) { /* spin */ }
}

function localTimeMs(): number {
    time["GetLocalTime"](ctx, mem, [ST]);
    const w = (o: number) => view.getUint16(ST + o, true);
    return Date.UTC(w(0), w(2) - 1, w(6), w(8), w(10), w(12), w(14));
}

function fileTimeMs(): number {
    time["GetSystemTimeAsFileTime"](ctx, mem, [FT]);
    return Number(view.getBigUint64(FT, true) / 10000n - 11644473600000n);
}

const tick = (): number => (time["GetTickCount"](ctx, mem, []) as number) >>> 0;

describe("calendar clock follows the guest clock", () => {
    const svc = TimeService.getInstance();
    beforeEach(() => {
        svc.resetForGameSwitch();
        svc.enableVirtualTime();
        svc.reanchorToWallClock();
    });

    test("host time passing while the guest clock stands still does not move the calendar", () => {
        const t0 = tick(), l0 = localTimeMs(), f0 = fileTimeMs();
        busyWait(60);
        expect(tick() - t0).toBe(0);
        expect(localTimeMs() - l0).toBe(0);
        expect(fileTimeMs() - f0).toBe(0);
    });

    test("guest time advancing moves calendar and uptime by the same amount", () => {
        const t0 = tick(), l0 = localTimeMs(), f0 = fileTimeMs();
        svc.advanceVirtualTime(4321);
        expect(tick() - t0).toBe(4321);
        expect(localTimeMs() - l0).toBe(4321);
        expect(fileTimeMs() - f0).toBe(4321);
    });

    test("the calendar starts at the host date", () => {
        expect(Math.abs(fileTimeMs() - Date.now())).toBeLessThan(1000);
    });
});
