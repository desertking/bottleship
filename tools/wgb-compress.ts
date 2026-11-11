#!/usr/bin/env bun
import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "fs";
import {
    BLOCK_STREAM_END, deflateRawBlock, encodeAudioIndex, encodeBlockIndex, unixToDosDateTime, WGB_AUDIO_INDEX_ENTRY, WGB_AUDIO_INDEX_VERSION,
    WGB_AUDIO_METHOD, WGB_BLOCK_INDEX_ENTRY, WGB_BLOCK_INDEX_VERSION, ZipArchive,
    type AudioIndexRow, type BlockIndexRow, type ZipEntry, type ZipSource,
} from "@bottleship/formats/zip";
import { crc32, ZipStoreWriter } from "./internal/zip-store-writer";
import { buildAudioMember, encodeVorbis, parsePcmWav, snrDb, type PcmWavLayout } from "./internal/wgb-audio";

const ALWAYS_STORED = ["manifest.json", "registry.json"];
const PRECOMPRESSED = new Set(["ogg", "mp3", "wma", "flac", "bik", "bk2", "smk", "avi", "wmv", "mpg", "mpeg", "xmv", "mp4", "webm", "jpg", "jpeg", "png", "gif", "cab", "zip", "7z", "rar", "gz"]);
const MAX_MEMBER_BYTES = 2 ** 31 - 1;
const INDEX_MEMBERS = new Set([WGB_BLOCK_INDEX_ENTRY, WGB_AUDIO_INDEX_ENTRY]);
export const MIN_AUDIO_SNR_DB = 8;

export interface CompressOptions {
    blockKiB?: number;
    level?: number;
    minSavingPct?: number;
    store?: readonly string[];
    verify?: boolean;
    compressAll?: boolean;
    audio?: readonly string[];
    audioQuality?: number;
    ffmpeg?: string;
    audioChunkFrames?: number;
    audioEncoder?: (data: Uint8Array, layout: PcmWavLayout, quality: number) => Uint8Array;
    log?: (line: string) => void;
}

export interface CompressReport {
    inputBytes: number;
    outputBytes: number;
    entries: number;
    deflated: number;
    stored: number;
    blockKiB: number;
    level: number;
    blocks: number;
    audio: number;
    audioInputBytes: number;
    audioOutputBytes: number;
    audioQuality: number;
    seconds: number;
}

class FdSource implements ZipSource {
    readonly size: number;
    constructor(private readonly fd: number) {
        this.size = Number(fstatSync(fd, { bigint: true }).size);
    }
    readRangeSync(start: number, end: number): Uint8Array {
        const len = Math.max(0, Math.min(end, this.size) - start);
        const out = new Uint8Array(len);
        let got = 0;
        while (got < len) {
            const n = readSync(this.fd, out, got, len - got, start + got);
            if (n <= 0) break;
            got += n;
        }
        return got === len ? out : out.subarray(0, got);
    }
    async readRange(start: number, end: number): Promise<Uint8Array> {
        return this.readRangeSync(start, end);
    }
}

export function withBlockIndexRef(manifest: Uint8Array, audioIndex = false): Uint8Array {
    const m = JSON.parse(new TextDecoder().decode(manifest)) as Record<string, unknown>;
    m.blockIndex = { member: WGB_BLOCK_INDEX_ENTRY, version: WGB_BLOCK_INDEX_VERSION };
    if (audioIndex) m.audioIndex = { member: WGB_AUDIO_INDEX_ENTRY, version: WGB_AUDIO_INDEX_VERSION };
    else delete m.audioIndex;
    return new TextEncoder().encode(JSON.stringify(m, null, 2));
}

function extOf(name: string): string {
    return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

export function audioMatcher(patterns: readonly string[]): (name: string) => boolean {
    const exts = new Set<string>();
    const globs: RegExp[] = [];
    for (const raw of patterns) {
        if (!/[/*?]/.test(raw)) { exts.add(raw.replace(/^\./, "").toLowerCase()); continue; }
        let re = "";
        for (let i = 0; i < raw.length; i++) {
            const c = raw[i];
            if (c === "*" && raw[i + 1] === "*") { re += ".*"; i++; }
            else if (c === "*") re += "[^/]*";
            else if (c === "?") re += "[^/]";
            else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
        globs.push(new RegExp(`^${re}$`, "i"));
    }
    return name => exts.has(extOf(name)) || globs.some(g => g.test(name));
}

async function audioCandidates(archive: ZipArchive, entries: readonly ZipEntry[], match: ((name: string) => boolean) | null): Promise<Set<string>> {
    const out = new Set<string>();
    if (!match) return out;
    for (const e of entries) {
        if (e.isDirectory || !match(e.name) || e.uncompressedSize < 4096) continue;
        if (e.compression !== 0) continue;
        const head = await archive.readEntryRange(e, 0, Math.min(e.uncompressedSize, 64 * 1024));
        if (parsePcmWav(head, e.uncompressedSize)) out.add(e.name);
    }
    return out;
}

export function deflateBlocks(data: Uint8Array, blockSize: number, level: number): { parts: Uint8Array[]; lengths: number[] } {
    const parts: Uint8Array[] = [];
    const lengths: number[] = [];
    for (let off = 0; off < data.byteLength; off += blockSize) {
        const block = deflateRawBlock(data.subarray(off, Math.min(data.byteLength, off + blockSize)), level);
        parts.push(block);
        lengths.push(block.byteLength);
    }
    parts.push(BLOCK_STREAM_END);
    return { parts, lengths };
}

export async function compressWgb(input: string, output: string, options: CompressOptions = {}): Promise<CompressReport> {
    const started = performance.now();
    const blockKiB = options.blockKiB ?? 64;
    const shift = Math.log2(blockKiB * 1024);
    if (!Number.isInteger(shift) || shift < 12 || shift > 24) throw new Error(`--block-kib must be a power of two between 4 and 16384 (got ${blockKiB})`);
    const blockSize = 2 ** shift;
    const level = options.level ?? 9;
    const minSaving = (options.minSavingPct ?? 5) / 100;
    const keep = new Set([...ALWAYS_STORED, ...(options.store ?? [])].map(n => n.toLowerCase()));
    const skipExt = options.compressAll ? new Set<string>() : PRECOMPRESSED;
    const audioMatch = options.audio?.length ? audioMatcher(options.audio) : null;
    const audioQuality = options.audioQuality ?? 5;
    const ffmpeg = options.ffmpeg ?? process.env.FFMPEG ?? "ffmpeg";
    const encode = options.audioEncoder ?? ((data: Uint8Array, layout: PcmWavLayout, q: number) => encodeVorbis(data, layout, q, ffmpeg));
    const log = options.log ?? (() => {});

    const fd = openSync(input, "r");
    const tmp = `${output}.tmp-${process.pid}`;
    let report: CompressReport;
    try {
        const source = new FdSource(fd);
        const archive = new ZipArchive(source, { blockCacheBytes: 0 });
        await archive.init();
        const entries = archive.listEntries()
            .filter(e => !INDEX_MEMBERS.has(e.name))
            .sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
        const candidates = await audioCandidates(archive, entries, audioMatch);
        const writer = new ZipStoreWriter(tmp);
        const rows: BlockIndexRow[] = [];
        const audioRows: AudioIndexRow[] = [];
        let deflated = 0, stored = 0, blocks = 0, audio = 0, audioInputBytes = 0, audioOutputBytes = 0;
        for (const entry of entries) {
            const stamp = entry.modified === undefined ? 0 : unixToDosDateTime(entry.modified);
            if (entry.uncompressedSize > MAX_MEMBER_BYTES) throw new Error(`${entry.name}: members of 2 GiB or more are not supported (each member is packed in RAM)`);
            let data = entry.isDirectory ? new Uint8Array(0) : await archive.readEntry(entry);
            let crc = crc32(data);
            if (entry.crc32 !== undefined && !entry.isDirectory && crc !== entry.crc32) {
                throw new Error(`${entry.name}: CRC mismatch in input`);
            }
            if (entry.name.toLowerCase() === "manifest.json") {
                data = withBlockIndexRef(data, candidates.size > 0);
                crc = crc32(data);
            }
            if (candidates.has(entry.name)) {
                const layout = parsePcmWav(data);
                let member: ReturnType<typeof buildAudioMember> | null = null;
                let why = "not plain PCM";
                try {
                    if (layout) member = buildAudioMember(data, layout, encode(data, layout, audioQuality), options.audioChunkFrames);
                } catch (e) {
                    why = e instanceof Error ? e.message : String(e);
                }
                if (member && member.snrDb >= MIN_AUDIO_SNR_DB && data.byteLength - member.compressedSize >= Math.max(4096, data.byteLength * minSaving)) {
                    const localHeaderOffset = writer.addEncoded(entry.name, member.parts, member.size, member.crc, stamp, WGB_AUDIO_METHOD);
                    audioRows.push({ name: entry.name, localHeaderOffset, ...member.row });
                    audio++;
                    audioInputBytes += data.byteLength;
                    audioOutputBytes += member.compressedSize;
                    log(`${entry.name}: ${data.byteLength} -> ${member.compressedSize} bytes, ${member.row.chunkStart.length} chunks, SNR ${member.snrDb.toFixed(1)} dB`);
                    continue;
                }
                log(`${entry.name}: kept as PCM (${member ? `SNR ${member.snrDb.toFixed(1)} dB, ${member.compressedSize} bytes` : why})`);
            }
            const ext = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
            if (entry.isDirectory || data.byteLength === 0 || keep.has(entry.name.toLowerCase()) || skipExt.has(ext)) {
                writer.addStored(entry.name, data, stamp, crc);
                stored++;
                continue;
            }
            const { parts, lengths } = deflateBlocks(data, blockSize, level);
            let compressedSize = 0;
            for (const p of parts) compressedSize += p.byteLength;
            if (data.byteLength - compressedSize < Math.max(4096, data.byteLength * minSaving)) {
                writer.addStored(entry.name, data, stamp, crc);
                stored++;
                continue;
            }
            const localHeaderOffset = writer.addDeflated(entry.name, parts, data.byteLength, crc, stamp);
            rows.push({ name: entry.name, localHeaderOffset, uncompressedSize: data.byteLength, compressedSize, crc32: crc, shift, blockLengths: lengths });
            deflated++;
            blocks += lengths.length;
        }
        writer.addStored(WGB_BLOCK_INDEX_ENTRY, encodeBlockIndex(rows));
        if (candidates.size) writer.addStored(WGB_AUDIO_INDEX_ENTRY, encodeAudioIndex(audioRows));
        const { bytes } = writer.finish();
        report = {
            inputBytes: source.size, outputBytes: bytes, entries: entries.length, deflated, stored, blockKiB, level, blocks,
            audio, audioInputBytes, audioOutputBytes, audioQuality, seconds: 0,
        };
        if (options.verify !== false) await verifyWgb(input, tmp);
    } catch (e) {
        if (existsSync(tmp)) unlinkSync(tmp);
        throw e;
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, output);
    report.seconds = (performance.now() - started) / 1000;
    return report;
}

export async function verifyWgb(original: string, packed: string): Promise<void> {
    const fa = openSync(original, "r"), fb = openSync(packed, "r");
    try {
        const a = new ZipArchive(new FdSource(fa), { blockCacheBytes: 0 });
        const b = new ZipArchive(new FdSource(fb), { blockCacheBytes: 0 });
        await a.init();
        await b.init();
        if (b.blockIndexState !== "loaded") throw new Error(`verify: block index ${b.blockIndexState} (${b.blockIndexError ?? ""})`);
        const hasAudioIndex = b.getEntry(WGB_AUDIO_INDEX_ENTRY) !== undefined;
        if (hasAudioIndex && b.audioIndexState !== "loaded") throw new Error(`verify: audio index ${b.audioIndexState} (${b.audioIndexError ?? ""})`);
        for (const ea of a.listEntries()) {
            if (INDEX_MEMBERS.has(ea.name)) continue;
            const eb = b.getEntry(ea.name);
            if (!eb) throw new Error(`verify: ${ea.name} missing`);
            if (ea.isDirectory) continue;
            if (eb.compression === 8 && !eb.blocks) throw new Error(`verify: ${ea.name} is deflated without a block index`);
            if (eb.compression === WGB_AUDIO_METHOD && !eb.audio) throw new Error(`verify: ${ea.name} is transcoded without an audio index`);
            const want = ea.name.toLowerCase() === "manifest.json" ? withBlockIndexRef(await a.readEntry(ea), hasAudioIndex) : await a.readEntry(ea);
            const whole = await b.readEntry(eb);
            if (eb.audio) {
                verifyAudio(ea.name, want, whole, eb.audio.prefixLen, eb.audio.prefixLen + eb.audio.totalFrames * eb.audio.channels * 2);
                const ranged = b.readEntryRangeSync(eb, 0, eb.uncompressedSize);
                if (!ranged || Buffer.compare(Buffer.from(whole), Buffer.from(ranged)) !== 0) throw new Error(`verify: ${ea.name} differs (audio sync range)`);
                if (crc32(whole) !== eb.crc32) throw new Error(`verify: ${ea.name} CRC differs from the central directory`);
                continue;
            }
            if (Buffer.compare(Buffer.from(want), Buffer.from(whole)) !== 0) throw new Error(`verify: ${ea.name} differs (whole)`);
            if (!eb.blocks) continue;
            const ranged = b.readEntryRangeSync(eb, 0, eb.uncompressedSize);
            if (!ranged || Buffer.compare(Buffer.from(want), Buffer.from(ranged)) !== 0) throw new Error(`verify: ${ea.name} differs (block range)`);
        }
    } finally {
        closeSync(fa);
        closeSync(fb);
    }
}

function parseArgs(argv: string[]): { input: string; output: string; options: CompressOptions; json?: string } {
    const pos: string[] = [];
    const options: CompressOptions = {};
    const store: string[] = [];
    const audio: string[] = [];
    let json: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--block-kib") options.blockKiB = Number(argv[++i]);
        else if (a === "--level") options.level = Number(argv[++i]);
        else if (a === "--min-saving-pct") options.minSavingPct = Number(argv[++i]);
        else if (a === "--store") store.push(argv[++i]);
        else if (a === "--no-verify") options.verify = false;
        else if (a === "--compress-all") options.compressAll = true;
        else if (a === "--audio") audio.push(argv[++i]);
        else if (a === "--audio-quality") options.audioQuality = Number(argv[++i]);
        else if (a === "--ffmpeg") options.ffmpeg = argv[++i];
        else if (a === "--json") json = argv[++i];
        else pos.push(a);
    }
    if (pos.length !== 2) {
        console.error("usage: bun tools/wgb-compress.ts <in.wgb> <out.wgb> [--block-kib 64] [--level 9] [--min-saving-pct 5] [--store <entry>]... [--compress-all] [--audio <ext|glob>]... [--audio-quality 5] [--ffmpeg <path>] [--no-verify] [--json <report.json>]\nMembers are packed in RAM one at a time; members of 2 GiB or more are not supported.\n--audio transcodes 16-bit PCM WAV members matching an extension (wav) or a member glob (rom/Music/*.wav) to Vorbis; the engine serves them back as WAV of the same size.");
        process.exit(2);
    }
    options.store = store;
    options.audio = audio;
    return { input: pos[0], output: pos[1], options, json };
}

if (import.meta.main) {
    const { input, output, options, json } = parseArgs(process.argv.slice(2));
    const r = await compressWgb(input, output, { ...options, log: line => console.log(line) });
    const mb = (n: number) => (n / 1048576).toFixed(1);
    const audioNote = r.audio ? `, ${r.audio} audio (${mb(r.audioInputBytes)} -> ${mb(r.audioOutputBytes)} MiB, q${r.audioQuality})` : "";
    console.log(`${input}: ${mb(r.inputBytes)} MiB -> ${mb(r.outputBytes)} MiB (${((r.outputBytes / r.inputBytes - 1) * 100).toFixed(1)} %), ${r.deflated} deflated / ${r.stored} stored${audioNote}, ${r.blocks} blocks of ${r.blockKiB} KiB, ${r.seconds.toFixed(1)} s`);
    if (json) writeFileSync(json, JSON.stringify(r, null, 1));
}

function verifyAudio(name: string, want: Uint8Array, got: Uint8Array, pcmStart: number, pcmEnd: number): void {
    if (got.byteLength !== want.byteLength) throw new Error(`verify: ${name} is ${got.byteLength} bytes, source ${want.byteLength}`);
    if (Buffer.compare(Buffer.from(want.subarray(0, pcmStart)), Buffer.from(got.subarray(0, pcmStart))) !== 0) throw new Error(`verify: ${name} header differs`);
    if (Buffer.compare(Buffer.from(want.subarray(pcmEnd)), Buffer.from(got.subarray(pcmEnd))) !== 0) throw new Error(`verify: ${name} trailer differs`);
    const snr = snrDb(want.subarray(pcmStart, pcmEnd), got.subarray(pcmStart, pcmEnd));
    if (!(snr >= MIN_AUDIO_SNR_DB)) throw new Error(`verify: ${name} SNR ${snr.toFixed(1)} dB`);
}
