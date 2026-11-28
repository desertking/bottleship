import { expect, test } from "bun:test";
import { asBlobPart } from "../../src/dom-buffer";

test("Blob parts copy only the selected bytes of shared Wasm memory", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const bytes = new Uint8Array(memory.buffer, 6, 5);
    bytes.set([8, 137, 80, 78, 9]);
    const part = asBlobPart(bytes.subarray(1, 4));

    expect(ArrayBuffer.isView(part) && part.buffer instanceof ArrayBuffer).toBe(true);
    bytes.fill(0);
    expect(new Uint8Array(await new Blob([part]).arrayBuffer())).toEqual(Uint8Array.of(137, 80, 78));
});

test("Blob parts reuse views backed by ordinary ArrayBuffers", () => {
    const view = new DataView(new ArrayBuffer(16), 4, 3);
    expect(asBlobPart(view)).toBe(view);
});
