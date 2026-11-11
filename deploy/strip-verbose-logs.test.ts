import { describe, expect, test } from "bun:test";
import { stripVerboseLogs } from "./strip-verbose-logs";

describe("stripVerboseLogs", () => {
    test("drops a verbose call together with its argument construction", () => {
        const src = "function f(x){ Logger.verbose(LogCategory.DDRAW, `Blt ${x.toString(16)} ${hex(x)}`); return x; }";
        const r = stripVerboseLogs(src, "a.ts")!;
        expect(r.removed).toBe(1);
        expect(r.code).toBe("function f(x){ void 0; return x; }");
    });

    test("drops verboseLazy and calls inside expressions", () => {
        const src = "a && Logger.verboseLazy(c, () => s(a)); const y = (Logger.verbose(c, 'x'), 3);";
        const r = stripVerboseLogs(src, "a.ts")!;
        expect(r.removed).toBe(2);
        expect(r.code).toBe("a && void 0; const y = (void 0, 3);");
    });

    test("keeps calls whose arguments change state", () => {
        const src = "Logger.verbose(c, `n=${n++}`); Logger.verbose(c, `${(k = 2)}`);";
        const r = stripVerboseLogs(src, "a.ts");
        expect(r).toBeNull();
    });

    test("leaves every other logger call alone", () => {
        const src = "Logger.log(c, m); Logger.warn(c, m); other.verbose(c, m); Logger.isEnabled(c, l);";
        expect(stripVerboseLogs(src, "a.ts")).toBeNull();
    });

    test("the stripped module still parses and runs", () => {
        const src = "let calls = 0; const Logger = { verbose() { calls++; } }; for (let i = 0; i < 3; i++) Logger.verbose(0, `${i}`); calls;";
        const r = stripVerboseLogs(src, "a.ts")!;
        expect(r.removed).toBe(1);
        expect(eval(r.code)).toBe(0);
        expect(eval(src)).toBe(3);
    });
});
