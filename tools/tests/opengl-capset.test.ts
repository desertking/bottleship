import { expect, test } from "bun:test";
import { GLCapSet } from "../../src/worker/modules/opengl32/context";

test("GLCapSet answers like a Set for every operation, small and large capabilities", () => {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const caps = [0x0B44, 0x0B71, 0x0BE2, 0x0DE1, 0x0C11, 0xFFFF, 0x10000, 0x8D20, 0x80000000, 0];
    const a = new GLCapSet();
    const b = new Set<number>();
    for (let n = 0; n < 50000; n++) {
        const cap = caps[next() % caps.length]!;
        const op = next() % 7;
        if (op < 3) expect(a.add(cap)).toBe(a), b.add(cap);
        else if (op < 6) expect(a.delete(cap)).toBe(b.delete(cap));
        else if (next() % 50 === 0) { a.clear(); b.clear(); }
        expect(a.has(cap)).toBe(b.has(cap));
        if (n % 97 === 0) {
            expect(a.size).toBe(b.size);
            const sorted = (xs: Iterable<number>) => [...xs].sort((x, y) => x - y);
            expect(sorted(a)).toEqual(sorted(b));
            expect(sorted(a.keys())).toEqual(sorted(b));
            expect([...a.entries()].every(([k, v]) => k === v && b.has(k))).toBe(true);
            const seen: number[] = [];
            a.forEach(v => seen.push(v));
            expect(sorted(seen)).toEqual(sorted(b));
        }
    }
});
