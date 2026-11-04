import { describe, expect, test } from "bun:test";
import { GraphFunctionError, collectPrototypes, decodeGraph, encodeGraph } from "../../src/worker/savestate/graph";

class Surface { constructor(public ptr = 0, public pixels = new Uint8Array(4)) {} area() { return this.ptr; } }

describe("savestate object graph codec", () => {
    test("round-trips plain data, Maps, Sets, typed arrays, shared refs and cycles", () => {
        const shared = { n: 1 };
        const root: any = { a: [1, NaN, -0, Infinity, undefined, 2n], m: new Map<number, unknown>([[1, shared], [2, shared]]), s: new Set(['x']), t: new Int32Array([5, -6]) };
        root.self = root;
        const back: any = decodeGraph(encodeGraph(root));
        expect(back.a[0]).toBe(1);
        expect(Number.isNaN(back.a[1])).toBe(true);
        expect(Object.is(back.a[2], -0)).toBe(true);
        expect(back.a[3]).toBe(Infinity);
        expect(back.a[4]).toBeUndefined();
        expect(back.a[5]).toBe(2n);
        expect(back.m.get(1)).toBe(back.m.get(2));
        expect(back.s.has('x')).toBe(true);
        expect(Array.from(back.t)).toEqual([5, -6]);
        expect(back.t).toBeInstanceOf(Int32Array);
        expect(back.self).toBe(back);
    });

    test("class instances come back with their prototype from this build", () => {
        const live = { list: [new Surface(7)] };
        const protos = collectPrototypes([live]);
        const back: any = decodeGraph(encodeGraph({ s: new Surface(9) }), name => protos.get(name));
        expect(back.s).toBeInstanceOf(Surface);
        expect(back.s.area()).toBe(9);
    });

    test("an unexpected function fails the capture with its path; a declared one is dropped", () => {
        const obj = { timer: { kind: 5, callback: () => 1 } };
        expect(() => encodeGraph(obj)).toThrow(GraphFunctionError);
        try { encodeGraph(obj); } catch (e) { expect((e as GraphFunctionError).path).toBe('$.timer.callback'); }
        const g = encodeGraph(obj, { dropFunction: path => path.endsWith('.callback') });
        expect((decodeGraph(g) as any).timer).toEqual({ kind: 5 });
    });

    test("an unknown class is an error, not a silent plain object", () => {
        expect(() => decodeGraph(encodeGraph({ s: new Surface(1) }), () => undefined)).toThrow(/unknown class/);
    });
});
