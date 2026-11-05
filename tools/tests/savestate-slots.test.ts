import { describe, expect, test } from "bun:test";
import { MemoryChunkStore } from "../../src/worker/savestate/chunk-store";
import { captureRam, RAM_CHUNK_SIZE } from "../../src/worker/savestate/ram";
import { encodeSavestate, incompatibilities, type CompatibilityKey } from "../../src/worker/savestate/container";
import { MemoryDir, SlotStore } from "../../src/worker/savestate/slots";

const key = (buildSha = "a"): CompatibilityKey => ({ buildSha, bundleHash: "b", configHash: "c", bootLayout: "d", participants: { cpu: 1 } });

async function state(store: MemoryChunkStore, fill: number[], buildSha = "a"): Promise<Uint8Array> {
    const mem = new Uint8Array(4 * RAM_CHUNK_SIZE);
    fill.forEach((v, i) => { mem[i * RAM_CHUNK_SIZE] = v; });
    const { manifest } = await captureRam(mem, store);
    return encodeSavestate({
        header: { key: key(buildSha), overlay: "", createdAt: 1, gameId: "g", ram: manifest },
        sections: new Map([["cpu", { v: 1 }]]),
    });
}

describe("savestate slots", () => {
    test("slots share chunks; deleting one keeps the chunks the other still needs", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        await slots.save("game", "slot1", await state(chunks, [1, 2, 3]), 0);
        await slots.save("game", "slot2", await state(chunks, [1, 2, 4]), 0);
        expect(chunks.chunks.size).toBe(4);
        expect(await slots.remove("game", "slot1")).toBe(1);
        expect(chunks.chunks.size).toBe(3);
        expect(await slots.remove("game", "slot2")).toBe(3);
        expect(chunks.chunks.size).toBe(0);
    });

    test("an overwritten slot releases the chunks only it used", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        await slots.save("game", "slot1", await state(chunks, [5, 6]), 0);
        await slots.save("game", "slot1", await state(chunks, [5, 7]), 0);
        expect(chunks.chunks.size).toBe(2);
    });

    test("chunks of other games stay alive", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        await slots.save("a", "slot1", await state(chunks, [8]), 0);
        await slots.save("b", "slot1", await state(chunks, [9]), 0);
        await slots.remove("a", "slot1");
        expect(chunks.chunks.size).toBe(1);
    });

    test("a slot from another build is listed as incompatible, not as an error", async () => {
        const chunks = new MemoryChunkStore();
        const slots = new SlotStore(new MemoryDir(), chunks);
        await slots.save("game", "slot1", await state(chunks, [1]), 123);
        await slots.save("game", "slot2", await state(chunks, [1], "old"), 0);
        const list = await slots.list("game", (s) => incompatibilities(s.header.key, key()));
        expect(list.map(s => [s.slot, s.compatible])).toEqual([["slot1", true], ["slot2", false]]);
        expect(list[0]!.chunkBytes).toBe(123);
        expect(list[1]!.reasons).toEqual(["buildSha differs"]);
        expect(await slots.read("game", "slot3")).toBeNull();
    });
});
