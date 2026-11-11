import { afterEach, beforeEach, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { windows, finalizeWindowDestroy, type WindowInfo } from "../../src/worker/modules/user32/shared-state";
import { GDIContext } from "../../src/worker/modules/gdi32/context";
import { createWindowExports } from "../../src/worker/modules/user32/window";
import { createWglExports } from "../../src/worker/modules/opengl32/wgl";

const HWND = 0x7a004;

function mkWin(): WindowInfo {
    return { handle: HWND, title: "Tf", style: 0, x: 0, y: 0, width: 640, height: 480, children: [], visible: true, wndProc: 0 };
}

let saved: { gdiContext: unknown; ddrawContext: unknown };
let seeds: string[];
let gdi: GDIContext;

beforeEach(() => {
    const system = System.getInstance() as any;
    saved = { gdiContext: system.gdiContext, ddrawContext: system.ddrawContext };
    seeds = [];
    const owner = new Map<number, number>();
    let next = 0x20000;
    system.ddrawContext = null;
    gdi = new GDIContext();
    Object.assign(gdi, {
        createSizedMemoryDC: () => ++next,
        createDC: () => ++next,
        setDCWindow: (hdc: number, hwnd: number) => { owner.set(hdc, hwnd); },
        getDCWindow: (hdc: number) => owner.get(hdc) ?? 0,
        attachWindowBlit: () => {},
        getDC: () => undefined,
        dropWindowClientBacking: () => {},
        seedMemoryDCFromClientBacking: () => { seeds.push("backing"); return false; },
        seedMemoryDCFromOverlay: () => { seeds.push("overlay"); },
    });
    system.gdiContext = gdi;
    windows.set(HWND, mkWin());
});

afterEach(() => {
    const system = System.getInstance() as any;
    system.gdiContext = saved.gdiContext;
    system.ddrawContext = saved.ddrawContext;
    windows.delete(HWND);
    delete (globalThis as { __noGlPaintSeedSkip?: boolean }).__noGlPaintSeedSkip;
});

function harness() {
    const mem = new Uint8Array(0x1000);
    const user = createWindowExports();
    const wgl = createWglExports({ process: { getCurrentMemory: () => mem, dispatcher: null }, stringCache: new Map() } as any);
    const call = (api: Record<string, any>, name: string, ...args: number[]) => api[name]!({ esp: 0 } as any, mem, args) as number;
    return {
        getDC: () => call(user, "GetDC", HWND),
        create: (hdc: number) => call(wgl, "wglCreateContext", hdc),
        makeCurrent: (hdc: number, hglrc: number) => call(wgl, "wglMakeCurrent", hdc, hglrc),
        remove: (hglrc: number) => call(wgl, "wglDeleteContext", hglrc),
    };
}

test("a window DC is seeded until a GL context is made current on it, and again after the context is deleted", () => {
    const h = harness();
    const glDC = h.getDC();
    expect(seeds).toEqual(["backing", "overlay"]);
    const hglrc = h.create(glDC);
    expect(h.makeCurrent(glDC, hglrc)).toBe(1);
    expect(gdi.skipsPaintSeed(HWND)).toBe(true);

    seeds = [];
    h.getDC();
    expect(seeds).toEqual([]);

    h.remove(hglrc);
    expect(gdi.skipsPaintSeed(HWND)).toBe(false);
    h.getDC();
    expect(seeds).toEqual(["backing", "overlay"]);
});

test("the kill switch restores seeding of a GL window's paint DC", () => {
    const h = harness();
    const glDC = h.getDC();
    h.makeCurrent(glDC, h.create(glDC));
    (globalThis as { __noGlPaintSeedSkip?: boolean }).__noGlPaintSeedSkip = true;
    seeds = [];
    h.getDC();
    expect(seeds).toEqual(["backing", "overlay"]);
    expect(gdi.skipsPaintSeed(HWND)).toBe(false);
});

test("a context made current on a DC with no window marks nothing", () => {
    const h = harness();
    expect(h.makeCurrent(0x5555, h.create(0x5555))).toBe(1);
    expect(gdi.skipsPaintSeed(HWND)).toBe(false);
    seeds = [];
    h.getDC();
    expect(seeds).toEqual(["backing", "overlay"]);
});

test("a destroyed GL window's handle, reused by a plain window, is seeded again", () => {
    const h = harness();
    const glDC = h.getDC();
    h.makeCurrent(glDC, h.create(glDC));
    expect(gdi.skipsPaintSeed(HWND)).toBe(true);
    finalizeWindowDestroy(HWND);
    windows.set(HWND, mkWin());
    seeds = [];
    h.getDC();
    expect(seeds).toEqual(["backing", "overlay"]);
});

test("a GDI reset forgets every GL-owned window", () => {
    const h = harness();
    const glDC = h.getDC();
    h.makeCurrent(glDC, h.create(glDC));
    gdi.reset();
    expect(gdi.skipsPaintSeed(HWND)).toBe(false);
});
