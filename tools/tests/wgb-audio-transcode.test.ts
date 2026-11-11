import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
    audioChunkRange, BufferSource, decodeAudioIndex, encodeAudioIndex, WGB_AUDIO_INDEX_ENTRY, WGB_AUDIO_METHOD, ZipArchive,
    type ReadHint, type ZipEntry, type ZipSource,
} from "@bottleship/formats/zip";
import { ZipStoreWriter } from "../internal/zip-store-writer";
import { buildAudioMember, parsePcmWav, snrDb, type PcmWavLayout } from "../internal/wgb-audio";
import { compressWgb } from "../wgb-compress";
import { buildRomIndex, checkAudioIndex } from "../../src/worker/runtime/filesystem/wgb-loader";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import { installFakeOpfs } from "./fixtures/fake-opfs";
import { MUSIC, synthWav, VOICE } from "./fixtures/wgb-audio/synth";

const CHUNK = 2048;
const FIX = resolve(import.meta.dir, "fixtures/wgb-audio");
const logs = resolve("logs");
mkdirSync(logs, { recursive: true });
const root = mkdtempSync(join(logs, "wgb-audio-transcode-"));
afterAll(() => {
    if (!resolve(root).startsWith(logs + sep)) throw new Error("fixture outside logs");
    rmSync(root, { recursive: true, force: true });
});

const music = MUSIC();
const voice = VOICE();
const eightBit = (() => {
    const w = synthWav(1, 8000, 9000, null, 3).bytes.slice();
    const v = new DataView(w.buffer);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    v.setUint32(28, 8000, true);
    return w;
})();
const OGG = new Map<string, Uint8Array>([
    [music.bytes.length + ":2", new Uint8Array(readFileSync(join(FIX, "music.q5.ogg")))],
    [voice.bytes.length + ":1", new Uint8Array(readFileSync(join(FIX, "voice.q5.ogg")))],
]);
const inverted = (() => {
    const w = music.bytes.slice();
    const pcm = new Int16Array(w.buffer, music.pcmStart, (music.pcmEnd - music.pcmStart) / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32767, -pcm[i]);
    return w;
})();
const broken = synthWav(2, 22050, 5000, null, 4).bytes;
function fixtureEncoder(data: Uint8Array, layout: PcmWavLayout): Uint8Array {
    if (data.length === broken.length) return new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
    const ogg = OGG.get(data.length + ":" + layout.channels);
    if (!ogg) throw new Error("no fixture encode for this member");
    return ogg;
}

const FILES: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(JSON.stringify({ formatVersion: 2, name: "fixture", entrypoint: "rom/game.exe", rom: "rom" })),
    "rom/game.exe": new TextEncoder().encode("MZ".padEnd(9000, "x")),
    "rom/Music/Track1.wav": music.bytes,
    "rom/Voice/hello.wav": voice.bytes,
    "rom/Voice/eight.wav": eightBit,
    "rom/Sfx/click.wav": music.bytes.slice(0, 8000),
    "rom/Music/Inverted.wav": inverted,
    "rom/Music/Broken.wav": broken,
};

const storedPath = join(root, "stored.wgb");
const packedPath = join(root, "packed.wgb");
{
    const w = new ZipStoreWriter(storedPath);
    for (const [name, data] of Object.entries(FILES)) w.addStored(name, data);
    w.finish();
}
const report = await compressWgb(storedPath, packedPath, {
    blockKiB: 16, audio: ["rom/Music/*.wav", "rom/Voice/*.wav"], audioEncoder: fixtureEncoder, audioChunkFrames: CHUNK,
});
const packed = new Uint8Array(readFileSync(packedPath));
const refMusic = buildAudioMember(music.bytes, parsePcmWav(music.bytes)!, OGG.get(music.bytes.length + ":2")!, CHUNK).pcm;
const refVoice = buildAudioMember(voice.bytes, parsePcmWav(voice.bytes)!, OGG.get(voice.bytes.length + ":1")!, CHUNK).pcm;

class CountingSource implements ZipSource {
    readonly size: number;
    syncAnswers = true;
    readonly spans: Array<[number, number]> = [];
    constructor(private readonly data: Uint8Array) { this.size = data.byteLength; }
    async readRange(start: number, end: number, _hint?: ReadHint): Promise<Uint8Array> {
        await Promise.resolve();
        this.spans.push([start, end]);
        return this.data.slice(start, end);
    }
    readRangeSync(start: number, end: number): Uint8Array | null {
        if (!this.syncAnswers) return null;
        this.spans.push([start, end]);
        return this.data.slice(start, end);
    }
}

async function open(bytes: Uint8Array, blockCacheBytes?: number, source?: ZipSource): Promise<ZipArchive> {
    const a = new ZipArchive(source ?? new BufferSource(bytes), blockCacheBytes === undefined ? {} : { blockCacheBytes });
    await a.init();
    return a;
}

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function rewrite(bytes: Uint8Array, at: number, patch: (b: Uint8Array) => void): Uint8Array {
    const copy = bytes.slice();
    patch(copy.subarray(at));
    return copy;
}

async function dataStart(a: ZipArchive, e: ZipEntry): Promise<number> {
    const whole = await a.readEntry(a.getEntry("manifest.json")!);
    expect(whole.length).toBeGreaterThan(0);
    const lfh = e.localHeaderOffset;
    const v = new DataView(packed.buffer, packed.byteOffset + lfh, 30);
    return lfh + 30 + v.getUint16(26, true) + v.getUint16(28, true);
}

describe("packing", () => {
    test("matching PCM WAV members become audio members, everything else keeps its old form", async () => {
        const a = await open(packed);
        expect(a.audioIndexState).toBe("loaded");
        expect(report.audio).toBe(2);
        for (const [n, src] of [["rom/Music/Track1.wav", music.bytes], ["rom/Voice/hello.wav", voice.bytes]] as const) {
            const e = a.getEntry(n)!;
            expect(e.compression).toBe(WGB_AUDIO_METHOD);
            expect(e.uncompressedSize).toBe(src.length);
            expect(e.compressedSize).toBeLessThan(src.length / 3);
            expect(e.audio).toBeDefined();
            expect(a.isRangeReadable(e)).toBe(true);
        }
        expect(a.getEntry("rom/Voice/eight.wav")!.audio).toBeUndefined();
        expect(a.getEntry("rom/Sfx/click.wav")!.audio).toBeUndefined();
        for (const n of ["rom/Music/Inverted.wav", "rom/Music/Broken.wav"]) {
            const e = a.getEntry(n)!;
            expect(e.audio).toBeUndefined();
            expect(e.compression === 0 || e.compression === 8).toBe(true);
            expect(await a.readEntry(e)).toEqual(FILES[n]);
        }
        expect(await a.readEntry(a.getEntry("rom/Voice/eight.wav")!)).toEqual(eightBit);
        expect(await a.readEntry(a.getEntry("rom/Sfx/click.wav")!)).toEqual(FILES["rom/Sfx/click.wav"]);
        const manifest = JSON.parse(new TextDecoder().decode(await a.readEntry(a.getEntry("manifest.json")!)));
        expect(manifest.audioIndex).toEqual({ member: WGB_AUDIO_INDEX_ENTRY, version: 1 });
        expect(() => checkAudioIndex(manifest, a)).not.toThrow();
        expect(report.audioOutputBytes).toBeLessThan(report.audioInputBytes / 4);
    });

    test("the served file keeps the header and trailer byte for byte and the length exactly", async () => {
        const a = await open(packed);
        const m = await a.readEntry(a.getEntry("rom/Music/Track1.wav")!);
        expect(m.length).toBe(music.bytes.length);
        expect(m.subarray(0, music.pcmStart)).toEqual(music.bytes.subarray(0, music.pcmStart));
        const v = await a.readEntry(a.getEntry("rom/Voice/hello.wav")!);
        expect(v.length).toBe(voice.bytes.length);
        expect(v.subarray(0, voice.pcmStart)).toEqual(voice.bytes.subarray(0, voice.pcmStart));
        expect(v.subarray(voice.pcmEnd)).toEqual(voice.bytes.subarray(voice.pcmEnd));
        expect(parsePcmWav(m)).toEqual(parsePcmWav(music.bytes));
        expect(parsePcmWav(v)).toEqual(parsePcmWav(voice.bytes));
    });

    test("the PCM is the decoded Vorbis stream, aligned to the source", async () => {
        const a = await open(packed);
        const m = await a.readEntry(a.getEntry("rom/Music/Track1.wav")!);
        expect(m).toEqual(refMusic);
        expect(snrDb(music.bytes.subarray(music.pcmStart, music.pcmEnd), m.subarray(music.pcmStart, music.pcmEnd))).toBeGreaterThan(12);
        const shifted = m.subarray(music.pcmStart + 4 * 64, music.pcmEnd);
        expect(snrDb(music.bytes.subarray(music.pcmStart, music.pcmEnd - 4 * 64), shifted)).toBeLessThan(3);
        const v = await a.readEntry(a.getEntry("rom/Voice/hello.wav")!);
        expect(v).toEqual(refVoice);
        expect(snrDb(voice.bytes.subarray(voice.pcmStart, voice.pcmEnd), v.subarray(voice.pcmStart, voice.pcmEnd))).toBeGreaterThan(12);
    });
});

describe("range reads", () => {
    test("random sync and async ranges across chunk boundaries equal the whole decode, cold and warm", async () => {
        for (const cache of [0, undefined]) {
            for (const [name, ref] of [["rom/Music/Track1.wav", refMusic], ["rom/Voice/hello.wav", refVoice]] as const) {
                const a = await open(packed, cache);
                const e = a.getEntry(name)!;
                const r = rng(name.length + (cache ?? 7));
                for (let i = 0; i < 150; i++) {
                    const off = Math.floor(r() * (ref.length + 100)) - 50;
                    const len = 1 + Math.floor(r() * (i % 3 === 0 ? 40_000 : 3_000));
                    const from = Math.max(0, off);
                    const want = ref.subarray(from, Math.min(ref.length, from + len));
                    const got = i % 2 ? await a.readEntryRange(e, off, len) : a.readEntryRangeSync(e, off, len)!;
                    expect(got).toEqual(want);
                }
            }
        }
    });

    test("every chunk boundary, read on its own and backwards, gives the same bytes", async () => {
        const a = await open(packed, 0);
        const e = a.getEntry("rom/Music/Track1.wav")!;
        const map = e.audio!;
        expect(map.chunkStart.length).toBeGreaterThan(10);
        for (let c = map.chunkStart.length - 1; c >= 0; c--) {
            const at = map.prefixLen + audioChunkRange(map, c).first * 4;
            for (const [o, l] of [[at - 3, 6], [at, 1], [at - 1, 1], [at + 1, 4097]]) {
                if (o < 0 || o >= refMusic.length) continue;
                expect(a.readEntryRangeSync(e, o, l)!).toEqual(refMusic.subarray(o, Math.min(refMusic.length, o + l)));
            }
        }
        expect(await a.readEntryRange(e, refMusic.length - 1, 10)).toEqual(refMusic.subarray(refMusic.length - 1));
        expect(await a.readEntryRange(e, refMusic.length, 10)).toEqual(new Uint8Array());
    });

    test("a cold read fetches only the chunks it overlaps", async () => {
        const src = new CountingSource(packed);
        const a = await open(packed, 0, src);
        const e = a.getEntry("rom/Music/Track1.wav")!;
        const map = e.audio!;
        a.readEntryRangeSync(e, 0, 64);
        src.spans.length = 0;
        const mid = map.prefixLen + audioChunkRange(map, 7).first * 4 + 8;
        expect(a.readEntryRangeSync(e, mid, 16)).toEqual(refMusic.subarray(mid, mid + 16));
        const fetched = src.spans.reduce((n, [s, t]) => n + t - s, 0);
        expect(fetched).toBeLessThanOrEqual(map.chunkEnd[7] - map.chunkStart[7]);
    });

    test("through the VFS: size, seek, sync and async reads, sync reads widen only to the chunk end", async () => {
        installFakeOpfs();
        const a = await open(packed);
        const vfs = new VirtualFileSystem();
        vfs.mountRom(a, "rom", buildRomIndex(a, "rom"));
        await vfs.initOverlay("test:wgb-audio-transcode");
        expect(vfs.getFileSize("C:\\Music\\Track1.wav")).toBe(music.bytes.length);
        expect(vfs.getFileSize("C:\\Voice\\hello.wav")).toBe(voice.bytes.length);
        const h = vfs.openSync("C:\\Music\\Track1.wav", 0x80000000, 3)!;
        expect(vfs.readSync(h, 44)).toEqual(music.bytes.subarray(0, 44));
        const map = a.getEntry("rom/Music/Track1.wav")!.audio!;
        const at = map.prefixLen + audioChunkRange(map, 3).first * 4 + 100;
        vfs.setPosition(h, at, 0);
        expect(vfs.readSync(h, 10)).toEqual(refMusic.subarray(at, at + 10));
        expect(h.buffer?.byteLength ?? 0).toBeLessThanOrEqual(CHUNK * 4 * 2);
        const r = rng(5);
        for (let i = 0; i < 60; i++) {
            const off = Math.floor(r() * refMusic.length);
            const len = 1 + Math.floor(r() * 20_000);
            vfs.setPosition(h, off, 0);
            const got = i % 2 ? await vfs.read(h, len) : vfs.readSync(h, len)!;
            expect(got).toEqual(refMusic.subarray(off, Math.min(refMusic.length, off + len)));
        }
        vfs.setPosition(h, -8, 2);
        expect(vfs.readSync(h, 100)).toEqual(refMusic.subarray(refMusic.length - 8));
        const hv = vfs.openSync("C:\\Voice\\hello.wav", 0x80000000, 3)!;
        vfs.setPosition(hv, voice.pcmEnd - 2, 0);
        expect(await vfs.read(hv, 64)).toEqual(refVoice.subarray(voice.pcmEnd - 2, voice.pcmEnd + 62));
    });
});

describe("negative controls", () => {
    test("a damaged audio index is rejected as a whole and the bundle refuses to mount", async () => {
        const a0 = await open(packed);
        const idx = a0.getEntry(WGB_AUDIO_INDEX_ENTRY)!;
        const at = await dataStart(a0, idx);
        const bad = rewrite(packed, at + 40, b => { b[0] ^= 0xff; });
        const a = await open(bad);
        expect(a.audioIndexState).toBe("rejected");
        expect(a.audioIndexError).toMatch(/CRC/);
        expect(a.getEntry("rom/Music/Track1.wav")!.audio).toBeUndefined();
        expect(() => checkAudioIndex({ audioIndex: { member: WGB_AUDIO_INDEX_ENTRY, version: 1 } }, a)).toThrow(/damaged/);
        installFakeOpfs();
        expect(() => new VirtualFileSystem().mountRom(a, "rom", buildRomIndex(a, "rom"))).toThrow(/compressed ZIP entr/);
    });

    test("a manifest that needs the audio index refuses a bundle without one or a newer version", async () => {
        const a = await open(packed);
        expect(() => checkAudioIndex({ audioIndex: { member: WGB_AUDIO_INDEX_ENTRY, version: 2 } }, a)).toThrow(/v2/);
        expect(() => checkAudioIndex({ audioIndex: { member: "other.idx", version: 1 } }, a)).toThrow(/other\.idx/);
        const stored = await open(new Uint8Array(readFileSync(storedPath)));
        expect(() => checkAudioIndex({ audioIndex: { member: WGB_AUDIO_INDEX_ENTRY, version: 1 } }, stored)).toThrow(/missing/);
    });

    test("an index row that does not describe its member is not applied", async () => {
        const a0 = await open(packed);
        const rows = decodeAudioIndex(await a0.readEntry(a0.getEntry(WGB_AUDIO_INDEX_ENTRY)!));
        const variants: Array<(r: typeof rows[number]) => void> = [
            r => { r.uncompressedSize += 2; },
            r => { r.totalFrames -= 1; },
            r => { r.rawStart = Float64Array.from(r.rawStart, (x, i) => i === r.rawStart.length - 1 ? r.totalFrames - 1 : x); },
            r => { r.chunkEnd = Uint32Array.from(r.chunkEnd, (x, i) => i === r.chunkEnd.length - 1 ? x - 1 : x); },
            r => { r.bitsPerSample = 8; },
        ];
        for (const mutate of variants) {
            const copy = decodeAudioIndex(encodeAudioIndex(rows));
            for (const r of copy) mutate(r);
            const enc = encodeAudioIndex(copy);
            const w = new ZipStoreWriter(join(root, "rows.wgb"));
            for (const e of a0.listEntries()) {
                if (e.name === WGB_AUDIO_INDEX_ENTRY) continue;
                if (e.audio) {
                    const ds = await dataStart(a0, e);
                    w.addEncoded(e.name, [packed.subarray(ds, ds + e.compressedSize)], e.uncompressedSize, e.crc32!, 0, WGB_AUDIO_METHOD);
                } else {
                    w.addStored(e.name, await a0.readEntry(e));
                }
            }
            w.addStored(WGB_AUDIO_INDEX_ENTRY, enc);
            w.finish();
            const a = await open(new Uint8Array(readFileSync(join(root, "rows.wgb"))));
            expect(a.audioIndexState).toBe("loaded");
            expect(a.getEntry("rom/Music/Track1.wav")!.audio).toBeUndefined();
            expect(() => checkAudioIndex({ audioIndex: { member: WGB_AUDIO_INDEX_ENTRY, version: 1 } }, a)).toThrow(/no valid row/);
        }
    });

    test("a damaged packet fails the read instead of serving wrong audio", async () => {
        const a0 = await open(packed);
        const e0 = a0.getEntry("rom/Music/Track1.wav")!;
        const map = e0.audio!;
        const ds = await dataStart(a0, e0);
        const c = 5;
        const bad = rewrite(packed, ds + map.chunkStart[c + 1] - 1, b => { b[0] = 0xff; b[1] = 0xff; b[2] = 0xff; b[3] ^= 0x01; });
        const a = await open(bad, 0);
        const e = a.getEntry("rom/Music/Track1.wav")!;
        const at = map.prefixLen + audioChunkRange(map, c).first * 4;
        expect(a.readEntryRangeSync(e, at, 16)).toBeNull();
        await expect(a.readEntryRange(e, at, 16)).rejects.toThrow(/audio chunk|vorbis/);
        const far = map.prefixLen + audioChunkRange(map, c + 3).first * 4;
        expect(a.readEntryRangeSync(e, far, 16)).toEqual(refMusic.subarray(far, far + 16));
    });

    test("without --audio nothing is transcoded and no audio index is written", async () => {
        const out = join(root, "plain.wgb");
        const r = await compressWgb(storedPath, out, { blockKiB: 16 });
        expect(r.audio).toBe(0);
        const a = await open(new Uint8Array(readFileSync(out)));
        expect(a.getEntry(WGB_AUDIO_INDEX_ENTRY)).toBeUndefined();
        expect(a.audioIndexState).toBe("absent");
        expect(await a.readEntry(a.getEntry("rom/Music/Track1.wav")!)).toEqual(music.bytes);
        const manifest = JSON.parse(new TextDecoder().decode(await a.readEntry(a.getEntry("manifest.json")!)));
        expect(manifest.audioIndex).toBeUndefined();
    });
});
