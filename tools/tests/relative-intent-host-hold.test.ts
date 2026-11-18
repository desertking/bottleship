/**
 * A host dialog holds the guest's relative-mouse claim.
 *
 * The guest's MessageBox is a page dialog answered with the real pointer. Under Pointer
 * Lock every click goes to the canvas, so a title that hides its pointer and then raises a
 * message box left the player with a dialog that could not be clicked. While a dialog is up
 * the store reads inactive (which releases the lock and stops re-acquiring it); the guest's
 * signals keep updating underneath and apply again when the dialog closes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { relativeIntent } from "../../src/input/relative-intent";

afterEach(() => { relativeIntent.setHostHold(false); relativeIntent.reset(); });

function listen(): { seen: boolean[]; stop: () => void } {
    const seen: boolean[] = [];
    return { seen, stop: relativeIntent.subscribe((active) => seen.push(active)) };
}

describe("relativeIntent host hold", () => {
    test("a hold turns an active claim off and the release turns it back on", () => {
        relativeIntent.set("cursorHidden", true);
        relativeIntent.set("captured", true);
        const l = listen();
        relativeIntent.setHostHold(true);
        expect(relativeIntent.get()).toBe(false);
        relativeIntent.setHostHold(false);
        expect(relativeIntent.get()).toBe(true);
        expect(l.seen).toEqual([false, true]);
        l.stop();
    });

    test("signals arriving during a hold wait for the release", () => {
        const l = listen();
        relativeIntent.setHostHold(true);
        relativeIntent.set("captured", true);
        relativeIntent.set("warping", true);
        expect(relativeIntent.get()).toBe(false);
        expect(relativeIntent.reasons()).toEqual(["captured", "warping"]);
        expect(l.seen).toEqual([]);
        relativeIntent.set("warping", false);
        relativeIntent.setHostHold(false);
        expect(relativeIntent.get()).toBe(true);
        expect(l.seen).toEqual([true]);
        l.stop();
    });

    test("a claim dropped during a hold stays dropped after it", () => {
        relativeIntent.set("clipped", true);
        relativeIntent.setHostHold(true);
        relativeIntent.set("clipped", false);
        const l = listen();
        relativeIntent.setHostHold(false);
        expect(relativeIntent.get()).toBe(false);
        expect(l.seen).toEqual([]);
        l.stop();
    });

    test("without a hold the store is what it was; repeated holds notify once", () => {
        const l = listen();
        relativeIntent.set("cursorHidden", true);
        relativeIntent.set("clipped", true);
        relativeIntent.set("cursorHidden", false);
        expect(relativeIntent.get()).toBe(true);
        relativeIntent.setHostHold(true);
        relativeIntent.setHostHold(true);
        relativeIntent.reset();
        expect(relativeIntent.get()).toBe(false);
        expect(l.seen).toEqual([true, false]);
        l.stop();
    });
});

describe("USER32 visibility is independent of relative input", () => {
    test("a hidden custom cursor alone never claims the host pointer, including after a dialog", () => {
        const l = listen();
        relativeIntent.set("cursorHidden", true);
        expect(relativeIntent.get()).toBe(false);
        expect(relativeIntent.reasons()).toEqual(["cursorHidden"]);
        relativeIntent.setHostHold(true);
        relativeIntent.setHostHold(false);
        expect(relativeIntent.get()).toBe(false);
        expect(l.seen).toEqual([]);
        l.stop();
    });

    test("each stronger claim survives visibility changes and releases even while hidden", () => {
        for (const signal of ["clipped", "captured", "warping"] as const) {
            relativeIntent.reset();
            const l = listen();
            relativeIntent.set("cursorHidden", true);
            relativeIntent.set(signal, true);
            expect(relativeIntent.get()).toBe(true);
            relativeIntent.set("cursorHidden", false);
            relativeIntent.set("cursorHidden", true);
            expect(l.seen).toEqual([true]);
            relativeIntent.set(signal, false);
            expect(relativeIntent.get()).toBe(false);
            expect(l.seen).toEqual([true, false]);
            l.stop();
        }
    });
});
