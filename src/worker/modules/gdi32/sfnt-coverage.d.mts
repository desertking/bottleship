export interface SfntCoverage {
    glyphs: Uint16Array;
    ranges: number[][];
    total: number;
    codePages: number | null;
}
export function parseSfntCoverage(data: Uint8Array): SfntCoverage | null;
export function writeGlyphSet(view: DataView, pointer: number, coverage: SfntCoverage): number;
export function packGray8(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array;
