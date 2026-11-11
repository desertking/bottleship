import { expect, test } from "bun:test";
import { layoutText, placeText, cssFontFor, lineHeightFor, type FontDesc } from "../../src/worker/modules/d3dx9/font";

const DT_CENTER = 0x1, DT_RIGHT = 0x2, DT_VCENTER = 0x4, DT_WORDBREAK = 0x10, DT_SINGLELINE = 0x20;
const fixed = { measure: (t: string) => t.length * 10 };
const desc = (height: number): FontDesc => ({ height, width: 0, weight: 700, mipLevels: 1, italic: true, charSet: 0, outputPrecision: 0, quality: 0, pitchAndFamily: 0, faceName: "Arial" });

test("line breaks split lines and word break wraps to the rect width", () => {
    expect(layoutText("ab\ncd", 0, 0, 12, fixed).lines).toEqual(["ab", "cd"]);
    const wrapped = layoutText("one two three", DT_WORDBREAK, 75, 12, fixed);
    expect(wrapped.lines).toEqual(["one two", "three"]);
    expect([wrapped.width, wrapped.height]).toEqual([70, 24]);
    expect(layoutText("a\nb", DT_SINGLELINE, 0, 12, fixed).lines).toEqual(["a b"]);
});

test("alignment places the block inside the rect as DrawText does", () => {
    const layout = layoutText("abcd", DT_SINGLELINE, 0, 10, fixed);
    const rect = { left: 0, top: 0, right: 100, bottom: 50 };
    expect(placeText(layout, rect, DT_SINGLELINE)).toEqual({ x: 0, y: 0 });
    expect(placeText(layout, rect, DT_SINGLELINE | DT_CENTER | DT_VCENTER)).toEqual({ x: 30, y: 20 });
    expect(placeText(layout, rect, DT_SINGLELINE | DT_RIGHT)).toEqual({ x: 60, y: 0 });
});

test("a negative height is the character height, a positive one the cell height", () => {
    expect(cssFontFor(desc(-20))).toBe('italic 700 20px "Arial", Arial, sans-serif');
    expect(cssFontFor(desc(20))).toBe('italic 700 16px "Arial", Arial, sans-serif');
    expect(lineHeightFor(desc(20))).toBe(20);
    expect(lineHeightFor(desc(-20))).toBe(24);
});
