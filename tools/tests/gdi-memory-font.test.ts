// Real production imports. Browser FontFace/Canvas are the only mocked APIs.
// Run from the repository after copying to tools/tests/gdi-memory-font.test.ts.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { GDIContext } from '../../src/worker/modules/gdi32/context';
import { createPaintingExports } from '../../src/worker/modules/gdi32/painting';
import { installedFontCoverage, registeredFontFamilies, resetFontResources } from '../../src/worker/modules/gdi32/font-resource';
import { parseSfntCoverage, writeGlyphSet, packGray8 } from '../../src/worker/modules/gdi32/sfnt-coverage.mjs';

const font = new Uint8Array(readFileSync(new URL('../../public/fonts/LiberationSans-Regular.ttf', import.meta.url)));
const coverage = parseSfntCoverage(font)!;
const system = System.getInstance();
const saved = { gdi: system.gdiContext, process: system.process, FontFace: globalThis.FontFace,
    self: globalThis.self, OffscreenCanvas: globalThis.OffscreenCanvas };
const api = createPaintingExports(); // Exercises actual registration, not registerFontExtraExports alone.
let memory: Uint8Array;
let gdi: GDIContext;
let finishLoad: (() => void) | undefined;
let rejectLoad = false;
let waitLoad: Promise<void> | undefined;
const faces = new Set<unknown>();
let uploaded: Uint8Array[];
let draws: Array<{ text: string; x: number; y: number; font: string; width: number; height: number }>;
let bounds: { actualBoundingBoxLeft: number; actualBoundingBoxRight: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number; width: number };
const view = () => new DataView(memory.buffer);
const call = (name: string, args: number[]) => api[name](null as never, memory, args);

beforeEach(() => {
    resetFontResources(); faces.clear(); uploaded = []; draws = [];
    rejectLoad = false; waitLoad = undefined; finishLoad = undefined;
    memory = new Uint8Array(font.length + 65536);
    Mem.bind(() => memory);
    gdi = new GDIContext(); system.gdiContext = gdi;
    system.process = { getCurrentMemory: () => memory } as never;
    gdi.objects.set(10, { type: 'FONT', handle: 10, faceName: 'Liberation Sans', data: '16px "Liberation Sans"', fontSize: 16 } as never);
    gdi.hdcStates.set(1, { hFont: 10, font: '16px "Liberation Sans"', fontSize: 16 } as never);
    globalThis.self = { fonts: { add: (f: unknown) => faces.add(f), delete: (f: unknown) => faces.delete(f) } } as never;
    globalThis.FontFace = class {
        constructor(_family: string, bytes: ArrayBuffer) { uploaded.push(new Uint8Array(bytes)); }
        async load() { if (waitLoad) await waitLoad; if (rejectLoad) throw Error('font rejected'); return this; }
    } as unknown as typeof FontFace;
    bounds = { actualBoundingBoxLeft: 1.25, actualBoundingBoxRight: 2.25,
        actualBoundingBoxAscent: 2.25, actualBoundingBoxDescent: 1.25, width: 4.5 };
    globalThis.OffscreenCanvas = class {
        constructor(public width: number, public height: number) {}
        getContext() {
            const canvas = this;
            return { font: '', textBaseline: '', textAlign: '', fillStyle: '',
                measureText: () => bounds,
                fillText(text: string, x: number, y: number) {
                    draws.push({ text, x, y, font: this.font, width: canvas.width, height: canvas.height });
                },
                getImageData: () => ({ data: Uint8ClampedArray.from(
                    { length: canvas.width * canvas.height * 4 }, (_, i) => i % 4 === 3 ? 255 : 0) }),
            };
        }
    } as unknown as typeof OffscreenCanvas;
});
afterEach(() => {
    resetFontResources();
    system.gdiContext = saved.gdi; system.process = saved.process;
    globalThis.FontFace = saved.FontFace; globalThis.self = saved.self; globalThis.OffscreenCanvas = saved.OffscreenCanvas;
    Mem.bind(() => saved.process?.getCurrentMemory() ?? new Uint8Array());
});
async function install() {
    memory.set(font, 8192);
    const handle = await call('AddFontMemResourceEx', [8192, font.length, 0, 64]);
    expect(typeof handle).toBe('number'); expect(handle).not.toBe(0);
    return handle as number;
}

test('painting export assembly registers all five font APIs', () => {
    for (const name of ['AddFontMemResourceEx', 'RemoveFontMemResourceEx', 'GetTextFaceW', 'GetFontUnicodeRanges', 'GetGlyphOutlineW'])
        expect(typeof api[name]).toBe('function');
});
test('memory font owns input and writes count through the fresh memory after await', async () => {
    memory.set(font, 8192);
    waitLoad = new Promise<void>(resolve => { finishLoad = resolve; });
    const pending = call('AddFontMemResourceEx', [8192, font.length, 0, 64]);
    expect(view().getUint32(64, true)).toBe(0); expect(faces.size).toBe(0);
    const old = memory; memory = old.slice(); old.fill(0);
    finishLoad!(); const handle = await pending;
    expect(handle).not.toBe(0); expect(view().getUint32(64, true)).toBe(1);
    expect(uploaded[0][1]).toBe(1); expect(faces.size).toBeGreaterThan(0);
    expect(registeredFontFamilies()).not.toContain('Liberation Sans');
    expect(call('RemoveFontMemResourceEx', [handle as number])).toBe(1);
    expect(call('RemoveFontMemResourceEx', [handle as number])).toBe(0); expect(faces.size).toBe(0);
});
test('load failure and container reset cannot publish a success handle', async () => {
    memory.set(font, 8192); rejectLoad = true;
    expect(await call('AddFontMemResourceEx', [8192, font.length, 0, 64])).toBe(0);
    rejectLoad = false; waitLoad = new Promise<void>(resolve => { finishLoad = resolve; });
    const pending = call('AddFontMemResourceEx', [8192, font.length, 0, 64]);
    resetFontResources(); finishLoad!();
    expect(await pending).toBe(0); expect(faces.size).toBe(0); expect(view().getUint32(64, true)).toBe(0);
});
test('GetTextFaceW includes NUL; truncated and zero-sized outputs follow the W contract', () => {
    expect(call('GetTextFaceW', [1, 0, 0])).toBe(16);
    expect(call('GetTextFaceW', [1, 32, 128])).toBe(16);
    expect(call('GetTextFaceW', [1, 1, 128])).toBe(1); expect(view().getUint16(128, true)).toBe(0);
    expect(call('GetTextFaceW', [1, 2, 128])).toBe(2); expect(view().getUint16(128, true)).toBe(76);
    expect(view().getUint16(130, true)).toBe(0);
    view().setUint16(128, 1234, true);
    expect(call('GetTextFaceW', [1, 0, 128])).toBe(0); expect(view().getUint16(128, true)).toBe(1234);
    expect(call('GetTextFaceW', [999, 32, 128])).toBe(0);
});
test('real selected font coverage drives GLYPHSET query/fill and bounded failure', async () => {
    await install(); expect(installedFontCoverage('Liberation Sans')?.total).toBe(coverage.total);
    const required = 16 + coverage.ranges.length * 4;
    expect(call('GetFontUnicodeRanges', [1, 0])).toBe(required);
    expect(call('GetFontUnicodeRanges', [1, 128])).toBe(required);
    expect(view().getUint32(136, true)).toBe(coverage.total);
    const small = new DataView(new ArrayBuffer(20));
    expect(writeGlyphSet(small, 4, coverage)).toBe(0); expect(small.getUint32(4)).toBe(0);
});
test('gray bitmap uses outward-rounded bounds, baseline origin and DWORD-aligned rows', async () => {
    await install(); [65536, 0, 0, 65536].forEach((n, i) => view().setInt32(512 + i * 4, n, true));
    // Bounds [-2,3] x [-2,3], bitmap 5x5, stride8; negative left bearing is retained.
    expect(call('GetGlyphOutlineW', [1, 65, 6, 600, 0, 0, 512])).toBe(40);
    expect([0, 4, 8, 12].map(i => view().getInt32(600 + i, true))).toEqual([5, 5, -2, 3]);
    expect(view().getInt16(616, true)).toBe(5);
    expect(call('GetGlyphOutlineW', [1, 65, 6, 600, 39, 700, 512])).toBe(0xffffffff);
    expect(call('GetGlyphOutlineW', [1, 65, 6, 600, 40, 700, 512])).toBe(40);
    expect(draws).toEqual([{ text: 'A', x: 2, y: 3, font: '16px "Liberation Sans"', width: 5, height: 5 }]);
    expect([...memory.slice(700, 708)]).toEqual([64, 64, 64, 64, 64, 0, 0, 0]);
    expect(call('GetGlyphOutlineW', [1, 65, 2, 600, 40, 700, 512])).toBe(0xffffffff);
    view().setInt32(512, 131072, true);
    expect(call('GetGlyphOutlineW', [1, 65, 6, 600, 40, 700, 512])).toBe(0xffffffff);
});
test('blank glyph retains advance and produces no bitmap; alpha is scaled to 0..64', async () => {
    await install(); bounds = { actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0,
        actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, width: 6 };
    [65536, 0, 0, 65536].forEach((n, i) => view().setInt32(512 + i * 4, n, true));
    expect(call('GetGlyphOutlineW', [1, 32, 6, 600, 40, 700, 512])).toBe(0);
    expect(view().getInt16(616, true)).toBe(6); expect(draws).toEqual([]);
    expect([...packGray8(Uint8Array.from([0,0,0,255, 0,0,0,128, 0,0,0,0]), 3, 1)]).toEqual([64,32,0,0]);
});
