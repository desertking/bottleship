/**
 * A single-buffered exclusive-fullscreen primary and GDI share one piece of display
 * memory: whatever is written last is what the display shows. Our GDI output lives on a
 * separate overlay plane, so a guest write to the primary has to take that plane's pixels
 * away under the written rect, or window chrome the game already painted over (Tiberian
 * Sun draws its own dialogs into the primary and never lets the controls paint) stays on
 * top of the frame as a grey Win32 dialog.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { noteGuestPrimaryWrite, primaryWriteCoversGdi } from "../../src/worker/modules/ddraw/gdi-visibility";
import type { DDrawContext } from "../../src/worker/modules/ddraw/context";

const DDSCL_FULLSCREEN = 0x00000001;
const DDSCL_EXCLUSIVE = 0x00000010;
const DDSCL_NORMAL = 0x00000008;
const DDSCAPS_PRIMARYSURFACE = 0x00000200;
const DDSCAPS_OFFSCREENPLAIN = 0x00000040;

const base = { isPrimary: true, exclusiveFullscreen: true, gdiSurfaceVisible: true, clipped: false };

describe("primaryWriteCoversGdi", () => {
    test("an unclipped write to the displayed exclusive primary covers GDI output", () => {
        expect(primaryWriteCoversGdi(base)).toBe(true);
    });
    test("an offscreen surface is not the display", () => {
        expect(primaryWriteCoversGdi({ ...base, isPrimary: false })).toBe(false);
    });
    test("a windowed primary is clipped to its window, never over others", () => {
        expect(primaryWriteCoversGdi({ ...base, exclusiveFullscreen: false })).toBe(false);
    });
    test("while a flip chain is on screen GDI output is not visible anyway", () => {
        expect(primaryWriteCoversGdi({ ...base, gdiSurfaceVisible: false })).toBe(false);
    });
    test("a Blt through a clipper leaves the windows above it alone", () => {
        expect(primaryWriteCoversGdi({ ...base, clipped: true })).toBe(false);
    });
});

describe("noteGuestPrimaryWrite", () => {
    function run(flags: number, caps: number, gdiSurfaceVisible: boolean, clipped = false) {
        const calls: unknown[][] = [];
        const fake = { gdiContext: { clearOverlayRect: (...a: unknown[]) => calls.push(a) } };
        const spy = spyOn(System, "getInstance").mockReturnValue(fake as never);
        try {
            const ctx = { cooperative: { hwnd: 1, flags }, gdiSurfaceVisible } as unknown as DDrawContext;
            noteGuestPrimaryWrite(ctx, caps, { left: 10, top: 20, right: 110, bottom: 70 }, clipped);
        } finally {
            spy.mockRestore();
        }
        return calls;
    }

    test("clears exactly the written rect, without asking windows to repaint", () => {
        const calls = run(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN, DDSCAPS_PRIMARYSURFACE, true);
        expect(calls).toEqual([[10, 20, 100, 50, { skipRepair: true }]]);
    });
    test("leaves the overlay alone for an offscreen surface", () => {
        expect(run(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN, DDSCAPS_OFFSCREENPLAIN, true)).toEqual([]);
    });
    test("leaves the overlay alone in windowed mode", () => {
        expect(run(DDSCL_NORMAL, DDSCAPS_PRIMARYSURFACE, true)).toEqual([]);
    });
    test("leaves the overlay alone while the flip chain owns the screen", () => {
        expect(run(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN, DDSCAPS_PRIMARYSURFACE, false)).toEqual([]);
    });
    test("leaves the overlay alone for a clipped blit", () => {
        expect(run(DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN, DDSCAPS_PRIMARYSURFACE, true, true)).toEqual([]);
    });
});
