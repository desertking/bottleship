/**
 * ID3DXFont — D3DXCreateFont and friends.
 *
 * Text is rasterized on the host (white glyphs, alpha coverage) into a managed A8R8G8B8
 * texture per distinct string, and drawn through the game's own device as a
 * pre-transformed, diffuse-modulated quad. The device state the quad needs is saved and
 * restored with a state block, the way ID3DXSprite does it, so the caller's pipeline is
 * left as it was.
 */

import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { type GuestRoutine, runGuestRoutine } from '../../core/thunking/guest-routine';
import { createVTablesFromDescriptor, VTableInfo } from '../../api/adapters/module-adapter';
import { InterfaceDescriptor, IUnknown, ModuleDescriptor, ParameterDescriptor } from '../../api/types';
import { IDirect3DDevice9 } from '../../api/d3d9.api';
import { addComRef, createComObject, forgetComObject, registerComFinalizer, releaseComRef } from '../d3d9/shared-state';
import { createGuestTexture } from '../d3d9/resource-registry';
import { uploadRgbaToTexture } from '../d3d9/d3dx-bridge';
import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { normalizeGuid, readGuidFromMem } from '../../core/com/typelib/typelib-types';

const S_OK = 0;
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const D3DERR_INVALIDCALL = 0x8876086c;
const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';

const D3DFMT_A8R8G8B8 = 21;
const D3DPOOL_MANAGED = 1;

const DT_CENTER = 0x1;
const DT_RIGHT = 0x2;
const DT_VCENTER = 0x4;
const DT_BOTTOM = 0x8;
const DT_WORDBREAK = 0x10;
const DT_SINGLELINE = 0x20;
const DT_EXPANDTABS = 0x40;
const DT_NOCLIP = 0x100;
const DT_CALCRECT = 0x400;

const FONT_CACHE_LIMIT = 256;
const D3DSBT_ALL = 1;
const FVF_XYZRHW_DIFFUSE_TEX1 = 0x144;
const VERTEX_STRIDE = 28;

const ptr = (name: string): ParameterDescriptor => ({ name, type: 'ptr', direction: 'in' });
const u32 = (name: string): ParameterDescriptor => ({ name, type: 'u32', direction: 'in' });
const method = (name: string, params: ParameterDescriptor[]) => ({
    name, params: [ptr('this'), ...params], returnType: 'u32' as const, callingConvention: 'stdcall' as const,
});

export const ID3DXFont: InterfaceDescriptor = {
    name: 'ID3DXFont',
    inherits: 'IUnknown',
    iid: 'D79DBB70-5F21-4D36-BBC2-FF525C213CDC',
    methods: [
        ...IUnknown.methods,
        method('GetDevice', [ptr('ppDevice')]),
        method('GetDescA', [ptr('pDesc')]),
        method('GetDescW', [ptr('pDesc')]),
        method('GetTextMetricsA', [ptr('pTextMetrics')]),
        method('GetTextMetricsW', [ptr('pTextMetrics')]),
        method('GetDC', []),
        method('GetGlyphData', [u32('Glyph'), ptr('ppTexture'), ptr('pBlackBox'), ptr('pCellInc')]),
        method('PreloadCharacters', [u32('First'), u32('Last')]),
        method('PreloadGlyphs', [u32('First'), u32('Last')]),
        method('PreloadTextA', [ptr('pString'), u32('Count')]),
        method('PreloadTextW', [ptr('pString'), u32('Count')]),
        method('DrawTextA', [ptr('pSprite'), ptr('pString'), u32('Count'), ptr('pRect'), u32('Format'), u32('Color')]),
        method('DrawTextW', [ptr('pSprite'), ptr('pString'), u32('Count'), ptr('pRect'), u32('Format'), u32('Color')]),
        method('OnLostDevice', []),
        method('OnResetDevice', []),
    ],
};

const fontModuleDescriptor: ModuleDescriptor = { name: 'd3dx9', functions: [], interfaces: [ID3DXFont] };

export interface FontDesc {
    height: number;
    width: number;
    weight: number;
    mipLevels: number;
    italic: boolean;
    charSet: number;
    outputPrecision: number;
    quality: number;
    pitchAndFamily: number;
    faceName: string;
}

interface CachedText { texture: number; width: number; height: number }

interface FontState {
    device: number;
    desc: FontDesc;
    cache: Map<string, CachedText>;
}

export interface TextLayout {
    lines: string[];
    lineHeight: number;
    width: number;
    height: number;
}

export interface TextMeasurer {
    measure(text: string): number;
}

// @transient(ID3DXFont objects belong to a D3D9 device, which no savestate participant captures; resetD3DXFonts clears them with the process)
const fonts = new Map<number, FontState>();
// @transient(the vtable is rebuilt on first use after resetD3DXFonts)
let fontVtable: VTableInfo | null = null;

const deviceSlot = (name: string): number => IDirect3DDevice9.methods.findIndex((m) => m.name === name);

function vtableSlot(obj: number, slot: number): number {
    const vtbl = Mem.readUint32(obj) ?? 0;
    return vtbl ? (Mem.readUint32(vtbl + slot * 4) ?? 0) : 0;
}

/** CSS font shorthand for a D3DXFONT_DESC: a negative height is the character height, a
 *  positive one the cell height, which GDI maps to about 1.25 times the em size. */
export function cssFontFor(desc: FontDesc): string {
    const px = desc.height < 0 ? -desc.height : Math.max(1, Math.round((desc.height || 16) * 0.8));
    const weight = Math.min(900, Math.max(100, Math.round((desc.weight || 400) / 100) * 100));
    const face = desc.faceName ? `"${desc.faceName.replace(/"/g, '')}", ` : '';
    return `${desc.italic ? 'italic ' : ''}${weight} ${px}px ${face}Arial, sans-serif`;
}

export function lineHeightFor(desc: FontDesc): number {
    return desc.height < 0 ? Math.ceil(-desc.height * 1.2) : Math.max(1, desc.height || 16);
}

/** Lines DrawText would put out for `text` in a rect `maxWidth` wide. */
export function layoutText(text: string, format: number, maxWidth: number, lineHeight: number, measurer: TextMeasurer): TextLayout {
    let source = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (format & DT_EXPANDTABS) source = source.replace(/\t/g, '        ');
    const paragraphs = format & DT_SINGLELINE ? [source.replace(/\n/g, ' ')] : source.split('\n');
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
        if (!(format & DT_WORDBREAK) || format & DT_SINGLELINE || maxWidth <= 0) {
            lines.push(paragraph);
            continue;
        }
        let current = '';
        for (const word of paragraph.split(/(\s+)/)) {
            const candidate = current + word;
            if (current && measurer.measure(candidate.trimEnd()) > maxWidth && word.trim()) {
                lines.push(current.trimEnd());
                current = word.trimStart();
            } else {
                current = candidate;
            }
        }
        lines.push(current.trimEnd());
    }
    const width = Math.ceil(Math.max(0, ...lines.map((l) => measurer.measure(l))));
    return { lines, lineHeight, width, height: lines.length * lineHeight };
}

/** Top-left of a layout inside `rect`, as DrawText aligns it. */
export function placeText(layout: TextLayout, rect: { left: number; top: number; right: number; bottom: number }, format: number): { x: number; y: number } {
    let x = rect.left;
    let y = rect.top;
    if (format & DT_CENTER) x = Math.round(rect.left + (rect.right - rect.left - layout.width) / 2);
    else if (format & DT_RIGHT) x = rect.right - layout.width;
    if (format & DT_SINGLELINE) {
        if (format & DT_VCENTER) y = Math.round(rect.top + (rect.bottom - rect.top - layout.height) / 2);
        else if (format & DT_BOTTOM) y = rect.bottom - layout.height;
    }
    return { x, y };
}

function canvasFor(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
    if (typeof OffscreenCanvas === 'undefined') return null;
    return new OffscreenCanvas(Math.max(1, width), Math.max(1, height)).getContext('2d', { willReadFrequently: true });
}

function measurerFor(desc: FontDesc): TextMeasurer {
    const ctx = canvasFor(1, 1);
    if (ctx) ctx.font = cssFontFor(desc);
    const em = desc.height < 0 ? -desc.height : (desc.height || 16) * 0.8;
    return { measure: (text) => (ctx ? ctx.measureText(text).width : text.length * em * 0.55) };
}

function rasterize(desc: FontDesc, layout: TextLayout, format: number): Uint8Array | null {
    const ctx = canvasFor(layout.width, layout.height);
    if (!ctx || layout.width <= 0 || layout.height <= 0) return null;
    ctx.font = cssFontFor(desc);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    const measurer = { measure: (t: string) => ctx.measureText(t).width };
    layout.lines.forEach((line, i) => {
        const w = measurer.measure(line);
        const x = format & DT_CENTER ? (layout.width - w) / 2 : format & DT_RIGHT ? layout.width - w : 0;
        ctx.fillText(line, x, i * layout.lineHeight + Math.max(0, (layout.lineHeight - (desc.height < 0 ? -desc.height : desc.height * 0.8)) / 2));
    });
    const pixels = ctx.getImageData(0, 0, layout.width, layout.height).data;
    const rgba = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
        rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = pixels[i + 3]!;
    }
    return rgba;
}

function ensureVtable(process: Process): number {
    if (!fontVtable) fontVtable = createVTablesFromDescriptor(process, fontModuleDescriptor)['ID3DXFont'] ?? null;
    return fontVtable?.address ?? 0;
}

export function createD3DXFont(process: Process, device: number, desc: FontDesc): number {
    const vtable = ensureVtable(process);
    if (!vtable) return 0;
    const self = createComObject(vtable);
    fonts.set(self, { device, desc, cache: new Map() });
    addComRef(device);
    registerComFinalizer(self, () => {
        const state = fonts.get(self);
        fonts.delete(self);
        if (!state) return;
        for (const entry of state.cache.values()) releaseComRef(entry.texture);
        releaseComRef(state.device);
    });
    return self;
}

function readDesc(pDesc: number, wide: boolean): FontDesc | null {
    if (!pDesc) return null;
    const r = (o: number) => Mem.readUint32(pDesc + o) ?? 0;
    const b = (o: number) => Mem.readUint8(pDesc + o) ?? 0;
    const mem = Mem.getView();
    if (!mem) return null;
    return {
        height: r(0) | 0, width: r(4), weight: r(8), mipLevels: r(12), italic: r(16) !== 0,
        charSet: b(20), outputPrecision: b(21), quality: b(22), pitchAndFamily: b(23),
        faceName: wide ? Marshaler.readWideString(mem, pDesc + 24).slice(0, 32) : Marshaler.readString(mem, pDesc + 24).slice(0, 32),
    };
}

function writeDesc(pDesc: number, desc: FontDesc, wide: boolean): boolean {
    if (!pDesc) return false;
    const ok = [Mem.writeUint32(pDesc, desc.height >>> 0), Mem.writeUint32(pDesc + 4, desc.width), Mem.writeUint32(pDesc + 8, desc.weight),
        Mem.writeUint32(pDesc + 12, desc.mipLevels), Mem.writeUint32(pDesc + 16, desc.italic ? 1 : 0),
        Mem.writeUint8(pDesc + 20, desc.charSet), Mem.writeUint8(pDesc + 21, desc.outputPrecision),
        Mem.writeUint8(pDesc + 22, desc.quality), Mem.writeUint8(pDesc + 23, desc.pitchAndFamily)].every(Boolean);
    const name = desc.faceName.slice(0, 31);
    const bytes = new Uint8Array(wide ? 64 : 32);
    for (let i = 0; i < name.length; i++) {
        if (wide) { bytes[i * 2] = name.charCodeAt(i) & 0xff; bytes[i * 2 + 1] = name.charCodeAt(i) >> 8; } else bytes[i] = name.charCodeAt(i) & 0xff;
    }
    return ok && Mem.writeBytes(pDesc + 24, bytes) === bytes.length;
}

function writeTextMetrics(p: number, desc: FontDesc, wide: boolean): boolean {
    if (!p) return false;
    const em = desc.height < 0 ? -desc.height : Math.round((desc.height || 16) * 0.8);
    const height = lineHeightFor(desc);
    const ascent = Math.round(height * 0.8);
    const longs = [height, ascent, height - ascent, height - em, 0, Math.round(em * 0.5), em, desc.weight || 400, 0, 96, 96];
    const size = wide ? 60 : 56;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    longs.forEach((v, i) => view.setInt32(i * 4, v, true));
    let o = 44;
    const ch = (c: number) => { if (wide) { view.setUint16(o, c, true); o += 2; } else { bytes[o++] = c; } };
    ch(0x20); ch(0xff); ch(0x3f); ch(0x20);
    bytes[o++] = desc.italic ? 1 : 0; o += 2;
    bytes[o++] = desc.pitchAndFamily; bytes[o] = desc.charSet;
    return Mem.writeBytes(p, bytes) === size;
}

export function createFontExports(process: Process): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const create = (device: number, desc: FontDesc | null, ppFont: number): number => {
        if (ppFont) Mem.writeUint32(ppFont, 0);
        if (!device || !desc || !ppFont) return D3DERR_INVALIDCALL;
        const font = createD3DXFont(process, device, desc);
        if (!font) return D3DERR_INVALIDCALL;
        Mem.writeUint32(ppFont, font);
        return S_OK;
    };
    const createFont = (wide: boolean): ThunkImplementation => (_ctx, mem, args) => {
        const a = args.map((x) => x >>> 0);
        const faceName = a[10] ? (wide ? Marshaler.readWideString(mem, a[10]!) : Marshaler.readString(mem, a[10]!)) : '';
        return create(a[0]!, {
            height: a[1]! | 0, width: a[2]!, weight: a[3]!, mipLevels: a[4]!, italic: a[5] !== 0, charSet: a[6]! & 0xff,
            outputPrecision: a[7]! & 0xff, quality: a[8]! & 0xff, pitchAndFamily: a[9]! & 0xff, faceName: faceName.slice(0, 32),
        }, a[11]!);
    };
    exports['D3DXCreateFontA'] = createFont(false);
    exports['D3DXCreateFontW'] = createFont(true);
    exports['D3DXCreateFontIndirectA'] = (_ctx, _mem, args) => create(args[0]! >>> 0, readDesc(args[1]! >>> 0, false), args[2]! >>> 0);
    exports['D3DXCreateFontIndirectW'] = (_ctx, _mem, args) => create(args[0]! >>> 0, readDesc(args[1]! >>> 0, true), args[2]! >>> 0);

    exports['ID3DXFont_QueryInterface'] = (_ctx, mem, args) => {
        const self = args[0]! >>> 0;
        const ppv = args[2]! >>> 0;
        if (!ppv) return E_POINTER;
        Mem.writeUint32(ppv, 0);
        if (!fonts.has(self)) return E_NOINTERFACE;
        const iid = args[1] ? normalizeGuid(readGuidFromMem(mem, args[1]! >>> 0)) : null;
        if (iid !== normalizeGuid(ID3DXFont.iid!) && iid !== IID_IUNKNOWN) return E_NOINTERFACE;
        Mem.writeUint32(ppv, self);
        addComRef(self);
        return S_OK;
    };
    exports['ID3DXFont_AddRef'] = (_ctx, _mem, args) => addComRef(args[0]! >>> 0) ?? 1;
    exports['ID3DXFont_Release'] = (_ctx, _mem, args) => releaseComRef(args[0]! >>> 0) ?? 0;
    exports['ID3DXFont_GetDevice'] = (_ctx, _mem, args) => {
        const state = fonts.get(args[0]! >>> 0);
        const pp = args[1]! >>> 0;
        if (!state || !pp) return D3DERR_INVALIDCALL;
        Mem.writeUint32(pp, state.device);
        addComRef(state.device);
        return S_OK;
    };
    exports['ID3DXFont_GetDescA'] = (_ctx, _mem, args) => {
        const state = fonts.get(args[0]! >>> 0);
        return state && writeDesc(args[1]! >>> 0, state.desc, false) ? S_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXFont_GetDescW'] = (_ctx, _mem, args) => {
        const state = fonts.get(args[0]! >>> 0);
        return state && writeDesc(args[1]! >>> 0, state.desc, true) ? S_OK : D3DERR_INVALIDCALL;
    };
    exports['ID3DXFont_GetTextMetricsA'] = (_ctx, _mem, args) => {
        const state = fonts.get(args[0]! >>> 0);
        return state && writeTextMetrics(args[1]! >>> 0, state.desc, false) ? 1 : 0;
    };
    exports['ID3DXFont_GetTextMetricsW'] = (_ctx, _mem, args) => {
        const state = fonts.get(args[0]! >>> 0);
        return state && writeTextMetrics(args[1]! >>> 0, state.desc, true) ? 1 : 0;
    };
    exports['ID3DXFont_GetDC'] = () => 0;
    exports['ID3DXFont_GetGlyphData'] = () => D3DERR_INVALIDCALL;
    for (const name of ['PreloadCharacters', 'PreloadGlyphs', 'PreloadTextA', 'PreloadTextW']) {
        exports[`ID3DXFont_${name}`] = (_ctx, _mem, args) => (fonts.has(args[0]! >>> 0) ? S_OK : D3DERR_INVALIDCALL);
    }
    exports['ID3DXFont_OnLostDevice'] = () => S_OK;
    exports['ID3DXFont_OnResetDevice'] = () => S_OK;

    const drawText = (wide: boolean): ThunkImplementation => (ctx, mem, args) => {
        const [self, , pString, countArg, pRect, format, color] = args.map((x) => x >>> 0);
        const state = fonts.get(self!);
        if (!state || !pString) return 0;
        const count = countArg! | 0;
        let text = wide ? Marshaler.readWideString(mem, pString!) : Marshaler.readString(mem, pString!);
        if (count >= 0) text = text.slice(0, count);
        const rect = pRect
            ? { left: Mem.readInt32(pRect) ?? 0, top: Mem.readInt32(pRect + 4) ?? 0, right: Mem.readInt32(pRect + 8) ?? 0, bottom: Mem.readInt32(pRect + 12) ?? 0 }
            : { left: 0, top: 0, right: 0, bottom: 0 };
        const layout = layoutText(text, format!, rect.right - rect.left, lineHeightFor(state.desc), measurerFor(state.desc));
        if (format! & DT_CALCRECT) {
            if (pRect) {
                Mem.writeUint32(pRect + 8, (rect.left + layout.width) >>> 0);
                Mem.writeUint32(pRect + 12, (rect.top + layout.height) >>> 0);
            }
            return layout.height;
        }
        if (!text || layout.width <= 0) return layout.height;

        const key = `${format! & (DT_CENTER | DT_RIGHT | DT_WORDBREAK | DT_SINGLELINE | DT_EXPANDTABS)}|${layout.width}|${text}`;
        let entry = state.cache.get(key);
        if (!entry) {
            const rgba = rasterize(state.desc, layout, format!);
            if (!rgba) return layout.height;
            const out = process.memory.alloc(4, 'HEAP', 'rw') >>> 0;
            if (!out) return layout.height;
            const hr = createGuestTexture(state.device, layout.width, layout.height, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, out);
            const texture = Mem.readUint32(out) ?? 0;
            process.memory.free(out);
            if (hr !== S_OK || !texture || !uploadRgbaToTexture(texture, layout.width, layout.height, rgba)) {
                if (texture) releaseComRef(texture);
                return layout.height;
            }
            entry = { texture, width: layout.width, height: layout.height };
            if (state.cache.size >= FONT_CACHE_LIMIT) {
                const [oldKey, old] = state.cache.entries().next().value as [string, CachedText];
                state.cache.delete(oldKey);
                releaseComRef(old.texture);
            }
            state.cache.set(key, entry);
        } else {
            state.cache.delete(key);
            state.cache.set(key, entry);
        }

        const at = placeText(layout, rect, format!);
        const clip = !(format! & DT_NOCLIP) && pRect;
        const x0 = clip ? Math.max(at.x, rect.left) : at.x;
        const y0 = clip ? Math.max(at.y, rect.top) : at.y;
        const x1 = clip ? Math.min(at.x + entry.width, rect.right) : at.x + entry.width;
        const y1 = clip ? Math.min(at.y + entry.height, rect.bottom) : at.y + entry.height;
        if (x1 <= x0 || y1 <= y0) return layout.height;
        const u0 = (x0 - at.x) / entry.width, u1 = (x1 - at.x) / entry.width;
        const v0 = (y0 - at.y) / entry.height, v1 = (y1 - at.y) / entry.height;

        const scratch = process.memory.alloc(VERTEX_STRIDE * 4 + 8, 'HEAP', 'rw') >>> 0;
        if (!scratch) return layout.height;
        const view = new DataView(new ArrayBuffer(VERTEX_STRIDE * 4));
        const corners: Array<[number, number, number, number]> = [[x0, y0, u0, v0], [x1, y0, u1, v0], [x0, y1, u0, v1], [x1, y1, u1, v1]];
        corners.forEach(([x, y, u, v], i) => {
            const o = i * VERTEX_STRIDE;
            view.setFloat32(o, x - 0.5, true); view.setFloat32(o + 4, y - 0.5, true);
            view.setFloat32(o + 8, 0, true); view.setFloat32(o + 12, 1, true);
            view.setUint32(o + 16, color!, true);
            view.setFloat32(o + 20, u, true); view.setFloat32(o + 24, v, true);
        });
        Mem.writeBytes(scratch, new Uint8Array(view.buffer));
        const blockOut = scratch + VERTEX_STRIDE * 4;
        Mem.writeUint32(blockOut, 0);
        const device = state.device;
        const texture = entry.texture;
        const height = layout.height;
        const call = (name: string, rest: number[]) => ({ fn: vtableSlot(device, deviceSlot(name)), args: [device, ...rest], tag: `IDirect3DDevice9::${name}` });

        return runGuestRoutine(ctx, mem, (function* (): GuestRoutine {
            let block = 0;
            try {
                yield call('CreateStateBlock', [D3DSBT_ALL, blockOut]);
                block = Mem.readUint32(blockOut) ?? 0;
                yield call('SetVertexShader', [0]);
                yield call('SetPixelShader', [0]);
                yield call('SetFVF', [FVF_XYZRHW_DIFFUSE_TEX1]);
                yield call('SetTexture', [0, texture]);
                yield call('SetTexture', [1, 0]);
                for (const [rs, value] of [[7, 0], [14, 0], [15, 0], [22, 1], [27, 1], [19, 5], [20, 6], [28, 0], [52, 0], [137, 0], [168, 0xf], [171, 1], [194, 0], [206, 0]]) {
                    yield call('SetRenderState', [rs!, value!]);
                }
                for (const [tss, value] of [[1, 4], [2, 2], [3, 0], [4, 4], [5, 2], [6, 0], [11, 0], [24, 0]]) {
                    yield call('SetTextureStageState', [0, tss!, value!]);
                }
                yield call('SetTextureStageState', [1, 1, 1]);
                yield call('SetTextureStageState', [1, 4, 1]);
                for (const [ss, value] of [[1, 3], [2, 3], [5, 1], [6, 1], [7, 0]]) {
                    yield call('SetSamplerState', [0, ss!, value!]);
                }
                yield call('DrawPrimitiveUP', [5, 2, scratch, VERTEX_STRIDE]);
                return height;
            } finally {
                if (block) {
                    yield { fn: vtableSlot(block, 5), args: [block], tag: 'IDirect3DStateBlock9::Apply' };
                    yield { fn: vtableSlot(block, 2), args: [block], tag: 'IDirect3DStateBlock9::Release' };
                }
                process.memory.free(scratch);
            }
        })(), 28, 'ID3DXFont::DrawText');
    };
    exports['ID3DXFont_DrawTextA'] = drawText(false);
    exports['ID3DXFont_DrawTextW'] = drawText(true);

    return exports;
}

export function resetD3DXFonts(): void {
    for (const self of fonts.keys()) forgetComObject(self);
    fonts.clear();
    fontVtable = null;
}
