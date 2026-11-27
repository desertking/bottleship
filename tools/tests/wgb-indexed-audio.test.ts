import { expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import { buildRomIndex, WgbLoader } from "../../src/worker/runtime/filesystem/wgb-loader";

const fixture = new Uint8Array(await Bun.file(new URL("./fixtures/indexed-audio.wgb", import.meta.url)).arrayBuffer());

test("mounts indexed Vorbis audio and reads WAV headers and samples across chunks", async () => {
    const { archive, entrypointBytes } = await WgbLoader.fromBuffer(fixture);
    const index = buildRomIndex(archive, "rom");
    new VirtualFileSystem().mountRom(archive, "rom", index);
    expect(new TextDecoder().decode(entrypointBytes)).toBe("MZfixture");
    const entry = index.get("voice.wav")!;
    expect(entry.compression).toBe(22337);

    const header = archive.readEntryRangeSync(entry, 0, 44)!;
    expect(new TextDecoder().decode(header.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(header.buffer, header.byteOffset).getUint32(40, true)).toBe(30002);

    const offset = 44 + 2048 * 2 - 7;
    const [wav, crossing] = await Promise.all([archive.readEntry(entry), archive.readEntryRange(entry, offset, 53)]);
    expect(wav.length).toBe(30082);
    expect(new Bun.CryptoHasher("sha256").update(wav).digest("hex"))
        .toBe("19da2a588b6630c94d0f525c2a51de982d648edd3fd8158d788154d8d006af2c");
    expect(crossing).toEqual(wav.slice(offset, offset + 53));
    expect(archive.readEntryRangeSync(entry, offset, 53)).toEqual(crossing);
});

test("rejects an archive whose required audio index fails its CRC", async () => {
    const { archive } = await WgbLoader.fromBuffer(fixture);
    const index = archive.getEntry("wgb-audio.idx")!;
    const broken = fixture.slice();
    const view = new DataView(broken.buffer);
    const local = index.localHeaderOffset;
    const offset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    broken[offset + 16] ^= 1;
    await expect(WgbLoader.fromBuffer(broken)).rejects.toThrow(/audio-index.*CRC mismatch/);
});
