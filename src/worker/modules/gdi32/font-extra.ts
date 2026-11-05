import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { addMemoryFontResource, removeMemoryFontResource, installedFontCoverage } from './font-resource';
import { packGray8, writeGlyphSet } from './sfnt-coverage.mjs';

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

    exports['GetGlyphOutlineW'] = (_ctx, mem, args) => {
        const [hdc, ch, format, gm, size, out, mat] = args.map(n => n >>> 0);
        const fail = 0xffffffff;
        // Observed generic route: Unicode character, identity MAT2, metrics or gray8.
        // Native curves, glyph-index input and transformed outlines are not fabricated.
        if ((format !== 0 && format !== 6) || ch > 65535 || !gm || gm + 20 > mem.length || !mat || mat + 16 > mem.length) return fail;
        const v = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if ([0x10000, 0, 0, 0x10000].some((value, i) => v.getInt32(mat + i * 4, true) !== value)) return fail;
        const gdi = System.getInstance().gdiContext, state = gdi.hdcStates.get(hdc);
        if (!state || !installedFontCoverage(gdi.getSelectedFontFace(hdc))?.glyphs[ch]) return fail;
        try {
            const canvas = new OffscreenCanvas(1, 1);
            const c = canvas.getContext('2d', { willReadFrequently: true });
            if (!c) return fail;
            c.font = state.font; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
            const text = String.fromCharCode(ch), m = c.measureText(text);
            const left = Math.floor(-m.actualBoundingBoxLeft), top = Math.ceil(m.actualBoundingBoxAscent);
            const right = Math.ceil(m.actualBoundingBoxRight), bottom = Math.floor(-m.actualBoundingBoxDescent);
            const width = Math.max(0, right - left), height = Math.max(0, top - bottom), advance = Math.round(m.width);
            if (![left, top, width, height, advance].every(Number.isFinite) || width > 4096 || height > 4096 || advance < -32768 || advance > 32767) return fail;
            const required = ((width + 3) & ~3) * height;
            if (format === 6 && size && out && (size < required || out + required > mem.length)) return fail;
            v.setUint32(gm, width, true); v.setUint32(gm + 4, height, true);
            v.setInt32(gm + 8, left, true); v.setInt32(gm + 12, top, true);
            v.setInt16(gm + 16, advance, true); v.setInt16(gm + 18, 0, true);
            if (format === 0) return 0;
            if (!size || !out || !required) return required;
            canvas.width = width; canvas.height = height;
            c.font = state.font; c.textBaseline = 'alphabetic'; c.textAlign = 'left'; c.fillStyle = '#fff';
            c.fillText(text, -left, top);
            const bitmap = packGray8(c.getImageData(0, 0, width, height).data, width, height);
            mem.set(bitmap, out);
            return required;
        } catch { return fail; }
    };
}
