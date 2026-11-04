import { describe, expect, test } from "bun:test";
import { smackw32Module } from "../../src/worker/api/smackw32.api";
import { APIRegistry } from "../../src/worker/core/api-registry";

describe("smackw32 ordinal imports", () => {
    test("resolve to the named implementation with the decorated stdcall arg count", () => {
        const registry = APIRegistry.getInstance();
        registry.registerModule(smackw32Module);
        const expected: Array<[number, string, number]> = [
            [2, "_SmackBufferOpen@24", 6],
            [14, "_SmackOpen@12", 3],
            [18, "_SmackClose@4", 1],
            [19, "_SmackDoFrame@4", 1],
            [21, "_SmackNextFrame@4", 1],
            [23, "_SmackToBuffer@28", 7],
            [28, "_SmackToBufferRect@8", 2],
            [32, "_SmackWait@4", 1],
            [33, "_SmackSoundUseMSS@4", 1],
        ];
        for (const [ordinal, name, argCount] of expected) {
            expect(registry.getFunctionNameByOrdinal("smackw32.dll", ordinal)).toBe(name);
            expect(registry.getArgCountByOrdinal("smackw32", ordinal)).toBe(argCount);
        }
    });

    test("ordinals are unique", () => {
        const ordinals = smackw32Module.functions.flatMap(f => f.ordinal === undefined ? [] : [f.ordinal]);
        expect(new Set(ordinals).size).toBe(ordinals.length);
    });
});
