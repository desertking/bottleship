import { describe, expect, test } from "bun:test";
import { SavestateError, exportFile, importFile, packSavestate, unpackSavestate } from "../../src/app/savestate-store";

const META = { format: 'BS-SAVE-1', engine: 'abc1234', gameId: 'app:test', scope: 'cpu+ram', createdAt: 1, rawBytes: 0 };

describe("savestate file format", () => {
    test("pack → export → import → unpack round-trips the raw state", async () => {
        const raw = new Uint8Array(200000).map((_, i) => (i * 13) & 0xff).buffer;
        const record = await packSavestate({ ...META, rawBytes: raw.byteLength }, raw);
        expect(record.meta.packedBytes).toBeLessThan(raw.byteLength);
        const imported = await importFile(exportFile(record));
        expect(imported.meta.sha256).toBe(record.meta.sha256);
        const back = await unpackSavestate(imported, 'app:test', 'abc1234');
        expect(new Uint8Array(back)).toEqual(new Uint8Array(raw));
    });

    test("a different game or engine build is refused", async () => {
        const raw = new Uint8Array(1000).buffer;
        const record = await packSavestate({ ...META, rawBytes: raw.byteLength }, raw);
        await expect(unpackSavestate(record, 'app:other', 'abc1234')).rejects.toBeInstanceOf(SavestateError);
        await expect(unpackSavestate(record, 'app:test', 'fff0000')).rejects.toMatchObject({ code: 'mismatch' });
    });

    test("a corrupted payload fails the checksum", async () => {
        const raw = new Uint8Array(1000).fill(7).buffer;
        const record = await packSavestate({ ...META, rawBytes: raw.byteLength }, raw);
        const blob = exportFile(record);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        bytes[bytes.length - 5] ^= 0xff;
        await expect(importFile(new Blob([bytes]))).rejects.toMatchObject({ code: 'checksum' });
    });
});
