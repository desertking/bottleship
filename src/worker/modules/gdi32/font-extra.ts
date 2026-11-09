import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { addMemoryFontResource, removeMemoryFontResource, installedFontCoverage } from './font-resource';
import { packGray8, writeGlyphSet } from './sfnt-coverage.mjs';
import { decodeAnsiString, EmulatorConfig } from '../../core/emulator-config-manager';
import { dcFontScale } from './painting-dc-state';

export function registerFontExtraExports(exports: Record<string, ThunkImplementation>): void {
    exports['AddFontMemResourceEx'] = (_ctx, mem, args): number | Promise<number> => {
        const [data, size, reserved, count] = args.map(n => n >>> 0);
        if (!data || !size || reserved || !count || data + size > mem.length || count + 4 > mem.length) return 0;
        if (!Mem.writeUint32(count, 0)) return 0;
        const process = System.getInstance().process;
        // Own the image synchronously. No guest view crosses the await/FontFace.load.
        const owned = new Uint8Array(size);
        owned.set(mem.subarray(data, data + size));
        return addMemoryFontResource(owned).then<number>((handle): number => {
            if (System.getInstance().process !== process) return 0;
            if (!handle) return 0;
            if (!Mem.writeUint32(count, 1)) { removeMemoryFontResource(handle); return 0; }
            return handle;
        });
    };
    exports['RemoveFontMemResourceEx'] = (_ctx, _mem, args) => removeMemoryFontResource(args[0]) ? 1 : 0;

    exports['GetTextFaceW'] = (_ctx, mem, args) => {
        const [hdc, rawCount, out] = args, count = rawCount | 0;
        const gdi = System.getInstance().gdiContext;
        if (!gdi.hdcStates.has(hdc)) return 0;
        const name = gdi.getSelectedFontFace(hdc);
        if (!out) return name.length + 1;
        if (count <= 0 || out + count * 2 > mem.length) return 0;
        const n = Math.min(count - 1, name.length), v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < n; i++) v.setUint16(out + i * 2, name.charCodeAt(i), true);
        v.setUint16(out + n * 2, 0, true);
        return n + 1; // GetTextFaceW includes the terminating NUL, unlike GetTextFaceA.
    };

    exports['GetFontUnicodeRanges'] = (_ctx, mem, args) => {
        const gdi = System.getInstance().gdiContext;
        if (!gdi.hdcStates.has(args[0])) return 0;
        const coverage = installedFontCoverage(gdi.getSelectedFontFace(args[0]));
        if (!coverage) return 0;
        return writeGlyphSet(new DataView(mem.buffer, mem.byteOffset, mem.byteLength), args[1] >>> 0, coverage);
    };

    const ansiChar = (code: number): number =>
        decodeAnsiString(new Uint8Array([code & 0xff]), 0, 1, EmulatorConfig.getInstance().ansiCodePage).charCodeAt(0) || (code & 0xff);

    // GetCharacterPlacementA hands out glyph "indices" that are the characters' UTF-16 code
    // units; GetGlyphOutline with GGO_GLYPH_INDEX reads them back the same way.
    const glyphOutline = (mem: Uint8Array, hdc: number, ch: number, format: number, gm: number, size: number, out: number, mat: number): number => {
        const fail = 0xffffffff;
        const kind = format & ~0x80;
        // Unicode character or our glyph index, identity MAT2: metrics, 1-bit or gray2/4/8.
        // Native curves and transformed outlines are not fabricated.
        if (![0, 1, 4, 5, 6].includes(kind) || ch > 65535 || !gm || gm + 20 > mem.length || !mat || mat + 16 > mem.length) return fail;
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if ([0x10000, 0, 0, 0x10000].some((value, i) => v.getInt32(mat + i * 4, true) !== value)) return fail;
        const gdi = System.getInstance().gdiContext, state = gdi.hdcStates.get(hdc);
        if (!state) return fail;
        const coverage = installedFontCoverage(gdi.getSelectedFontFace(hdc));
        if (coverage && !coverage.glyphs[ch]) return fail;
        try {
            const canvas = new OffscreenCanvas(1, 1);
            const c = canvas.getContext('2d', { willReadFrequently: true });
            if (!c) return fail;
            // GLYPHMETRICS and bitmaps are in device units: a font created in logical units under
            // MM_ANISOTROPIC/ISOTROPIC is realized at its height times the viewport/window ratio.
            const scale = dcFontScale(hdc);
            const font = scale === 1 ? state.font : state.font.replace(/(\d+(?:\.\d+)?)px/, (_m, px) => `${Math.max(1, Math.round(Number(px) * scale))}px`);
            c.font = font; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
            const text = String.fromCharCode(ch), m = c.measureText(text);
            const left = Math.floor(-m.actualBoundingBoxLeft), top = Math.ceil(m.actualBoundingBoxAscent);
            const right = Math.ceil(m.actualBoundingBoxRight), bottom = Math.floor(-m.actualBoundingBoxDescent);
            const width = Math.max(0, right - left), height = Math.max(0, top - bottom), advance = Math.round(m.width);
            if (![left, top, width, height, advance].every(Number.isFinite) || width > 4096 || height > 4096 || advance < -32768 || advance > 32767) return fail;
            const stride = kind === 1 ? ((width + 31) >>> 5) * 4 : (width + 3) & ~3;
            const required = stride * height;
            if (kind !== 0 && size && out && (size < required || out + required > mem.length)) return fail;
            v.setUint32(gm, width, true); v.setUint32(gm + 4, height, true);
            v.setInt32(gm + 8, left, true); v.setInt32(gm + 12, top, true);
            v.setInt16(gm + 16, advance, true); v.setInt16(gm + 18, 0, true);
            if (kind === 0) return 0;
            if (!size || !out || !required) return required;
            canvas.width = width; canvas.height = height;
            c.font = font; c.textBaseline = 'alphabetic'; c.textAlign = 'left'; c.fillStyle = '#fff';
            c.fillText(text, -left, top);
            const gray = packGray8(c.getImageData(0, 0, width, height).data, width, height);
            const levels = kind === 4 ? 4 : kind === 5 ? 16 : 64;
            const bitmap = new Uint8Array(required);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                const g = gray[y * ((width + 3) & ~3) + x];
                if (kind === 1) { if (g >= 32) bitmap[y * stride + (x >>> 3)] |= 0x80 >>> (x & 7); }
                else bitmap[y * stride + x] = Math.round(g * levels / 64);
            }
            mem.set(bitmap, out);
            return required;
        } catch { return fail; }
    };

    exports['GetGlyphOutlineW'] = (_ctx, mem, args) => {
        const [hdc, ch, format, gm, size, out, mat] = args.map(n => n >>> 0);
        if (format & 0x80) return 0xffffffff;
        return glyphOutline(mem, hdc, ch, format, gm, size, out, mat);
    };

    exports['GetGlyphOutlineA'] = (_ctx, mem, args) => {
        const [hdc, ch, format, gm, size, out, mat] = args.map(n => n >>> 0);
        return glyphOutline(mem, hdc, (format & 0x80) ? ch : ansiChar(ch), format, gm, size, out, mat);
    };

    // GCP_RESULTSA: lStructSize, lpOutString, lpOrder, lpDx, lpCaretPos, lpClass, lpGlyphs, nGlyphs, nMaxFit.
    // Left-to-right, no ligatures or reordering: one glyph per character, glyph = UTF-16 unit.
    exports['GetCharacterPlacementA'] = (_ctx, mem, args) => {
        const [hdc, str, count, , results] = args.map(n => n >>> 0);
        const gdi = System.getInstance().gdiContext, state = gdi.hdcStates.get(hdc);
        if (!state || (count && (!str || str + count > mem.length))) return 0;
        const bytes = mem.slice(str, str + count);
        const text = decodeAnsiString(bytes, 0, count, EmulatorConfig.getInstance().ansiCodePage);
        const c = new OffscreenCanvas(1, 1).getContext('2d');
        if (!c) return 0;
        c.font = state.font;
        const widths: number[] = [];
        let prev = 0;
        for (let i = 1; i <= text.length; i++) { const w = Math.round(c.measureText(text.slice(0, i)).width); widths.push(w - prev); prev = w; }
        const m = c.measureText('Hg');
        const height = Math.ceil((m.fontBoundingBoxAscent ?? 12) + (m.fontBoundingBoxDescent ?? 4));
        if (results && results + 36 <= mem.length) {
            const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const n = Math.min(text.length, v.getUint32(results + 28, true) || text.length);
            const outStr = v.getUint32(results + 4, true), order = v.getUint32(results + 8, true), dx = v.getUint32(results + 12, true);
            const caret = v.getUint32(results + 16, true), cls = v.getUint32(results + 20, true), glyphs = v.getUint32(results + 24, true);
            let x = 0;
            for (let i = 0; i < n; i++) {
                if (outStr) Mem.writeUint8(outStr + i, bytes[i]);
                if (order) Mem.writeUint32(order + i * 4, i);
                if (dx) Mem.writeUint32(dx + i * 4, widths[i] | 0);
                if (caret) Mem.writeUint32(caret + i * 4, x);
                if (cls) Mem.writeUint8(cls + i, 0);
                if (glyphs) Mem.writeUint16(glyphs + i * 2, text.charCodeAt(i));
                x += widths[i];
            }
            v.setUint32(results + 28, n, true);
            v.setUint32(results + 32, n, true);
        }
        return ((Math.min(height, 0xffff) << 16) | (Math.min(prev, 0xffff) & 0xffff)) >>> 0;
    };
}
