/**
 * GetDC on a DirectDraw surface: only the primary is the screen. An offscreen plain
 * surface in video memory owns its own pixels — Tiberian Sun draws its dialog captions
 * into one with TextOut and blits it afterwards — so its DC must write the surface, not
 * the screen overlay, or the blit carries uninitialised memory and the text lands on the
 * screen at the surface's origin.
 */

import { describe, expect, test } from "bun:test";
import { usesScreenOverlayDC } from "../../src/worker/modules/ddraw/surface";

const DDSCAPS_BACKBUFFER = 0x00000004;
const DDSCAPS_OFFSCREENPLAIN = 0x00000040;
const DDSCAPS_PRIMARYSURFACE = 0x00000200;
const DDSCAPS_SYSTEMMEMORY = 0x00000800;
const DDSCAPS_TEXTURE = 0x00001000;
const DDSCAPS_VIDEOMEMORY = 0x00004000;

describe("usesScreenOverlayDC", () => {
    test("the primary draws to the screen", () => {
        expect(usesScreenOverlayDC(DDSCAPS_PRIMARYSURFACE | DDSCAPS_VIDEOMEMORY)).toBe(true);
    });
    test("an offscreen plain surface in video memory keeps its own pixels", () => {
        expect(usesScreenOverlayDC(DDSCAPS_OFFSCREENPLAIN | DDSCAPS_VIDEOMEMORY)).toBe(false);
    });
    test("an offscreen surface without memory-placement caps keeps its own pixels", () => {
        expect(usesScreenOverlayDC(DDSCAPS_OFFSCREENPLAIN)).toBe(false);
    });
    test("back buffers, system-memory surfaces and textures keep their own pixels", () => {
        expect(usesScreenOverlayDC(DDSCAPS_BACKBUFFER)).toBe(false);
        expect(usesScreenOverlayDC(DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN)).toBe(false);
        expect(usesScreenOverlayDC(DDSCAPS_TEXTURE)).toBe(false);
    });
});
