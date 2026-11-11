import { AudioMemberDecoder, WGB_AUDIO_CODEC_VORBIS, type AudioIndexRow, type ZipAudioMap } from "@bottleship/formats/zip";
import { VorbisPacketDecoder, VORBIS_MAX_PACKET_BYTES } from "@bottleship/formats/audio/vorbis-decoder";
import { crc32 } from "./zip-store-writer";
import { splitOggPackets } from "./ogg-packets";

export interface PcmWavLayout {
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    prefixLen: number;
    totalFrames: number;
    suffixStart: number;
}

export interface AudioMember {
    parts: Uint8Array[];
    compressedSize: number;
    size: number;
    crc: number;
    row: Omit<AudioIndexRow, "name" | "localHeaderOffset">;
    pcm: Uint8Array;
    snrDb: number;
}

export const DEFAULT_AUDIO_CHUNK_FRAMES = 16384;

export function parsePcmWav(data: Uint8Array, fileSize = data.length): PcmWavLayout | null {
    if (data.length < 44) return null;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tag = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
    let p = 12;
    let fmt: { tag: number; channels: number; rate: number; align: number; bits: number } | null = null;
    while (p + 8 <= Math.min(data.length, fileSize)) {
        const id = tag(p);
        const size = v.getUint32(p + 4, true);
        if (id === "fmt ") {
            if (size < 16 || p + 8 + 16 > data.length) return null;
            fmt = {
                tag: v.getUint16(p + 8, true), channels: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true),
                align: v.getUint16(p + 20, true), bits: v.getUint16(p + 22, true),
            };
        } else if (id === "data") {
            if (!fmt || fmt.tag !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.channels > 2 || fmt.rate <= 0) return null;
            if (fmt.align !== fmt.channels * 2) return null;
            const start = p + 8;
            const avail = Math.min(size, fileSize - start);
            const frames = Math.floor(avail / fmt.align);
            if (frames <= 0) return null;
            return { channels: fmt.channels, sampleRate: fmt.rate, bitsPerSample: 16, prefixLen: start, totalFrames: frames, suffixStart: start + frames * fmt.align };
        }
        p += 8 + size + (size & 1);
    }
    return null;
}

export function encodeVorbis(data: Uint8Array, layout: PcmWavLayout, quality: number, ffmpeg: string): Uint8Array {
    const pcm = data.subarray(layout.prefixLen, layout.suffixStart);
    const r = Bun.spawnSync([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(layout.sampleRate), "-ac", String(layout.channels), "-i", "pipe:0",
        "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-c:a", "libvorbis", "-q:a", String(quality), "-f", "ogg", "pipe:1",
    ], { stdin: pcm, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`ffmpeg failed (${r.exitCode}): ${r.stderr.toString().trim()}`);
    return new Uint8Array(r.stdout);
}

export function buildAudioMember(data: Uint8Array, layout: PcmWavLayout, ogg: Uint8Array, chunkFrames = DEFAULT_AUDIO_CHUNK_FRAMES): AudioMember {
    const stream = splitOggPackets(ogg);
    if (stream.packets.length < 4) throw new Error("vorbis: no audio packets");
    const [id, comment, setup] = stream.packets;
    const audio = stream.packets.slice(3);
    for (const pk of audio) if (pk.length > VORBIS_MAX_PACKET_BYTES) throw new Error(`vorbis: packet of ${pk.length} bytes`);
    const dec = new VorbisPacketDecoder(id, comment, setup);
    const ch = layout.channels;
    if (dec.channels !== ch || dec.sampleRate !== layout.sampleRate) {
        dec.close();
        throw new Error(`vorbis: encoded ${dec.channels} ch ${dec.sampleRate} Hz, source ${ch} ch ${layout.sampleRate} Hz`);
    }
    const counts: number[] = [];
    const specCounts: number[] = [];
    const outs: Int16Array[] = [];
    try {
        let prevBlock = 0;
        for (const pk of audio) {
            const block = dec.packetBlocksize(pk);
            if (block <= 0) throw new Error("vorbis: unreadable packet mode");
            specCounts.push(prevBlock ? (prevBlock + block) / 4 : 0);
            prevBlock = block;
            const o = dec.decode(pk);
            outs.push(o);
            counts.push(o.length / ch);
        }
    } finally {
        dec.close();
    }
    if (counts[0] !== 0) throw new Error("vorbis: first audio packet produced output");
    const firstPage = stream.pageOfPacket[3];
    let onFirstPage = 0;
    for (let i = 0; i < audio.length; i++) if (stream.pageOfPacket[i + 3] === firstPage) onFirstPage += specCounts[i];
    const lead = onFirstPage - stream.pageGranules[firstPage];
    if (lead < 0) throw new Error(`vorbis: negative lead ${lead}`);
    const rawTotal = counts.reduce((a, b) => a + b, 0);
    if (rawTotal - lead < layout.totalFrames) throw new Error(`vorbis: ${rawTotal - lead} frames decoded, source has ${layout.totalFrames}`);

    const raw = new Int16Array(rawTotal * ch);
    let w = 0;
    for (const o of outs) { raw.set(o, w); w += o.length; }
    const virt = new Int16Array(raw.buffer, lead * ch * 2, layout.totalFrames * ch);

    const bounds: number[] = [0];
    let acc = 0;
    for (let i = 1; i < audio.length; i++) {
        acc += counts[i];
        if (acc >= chunkFrames && i < audio.length - 1) { bounds.push(i); acc = 0; }
    }
    const prefix = data.subarray(0, layout.prefixLen);
    const suffix = data.subarray(layout.suffixStart);
    const headLen = prefix.length + suffix.length + id.length + comment.length + setup.length;
    const packetOffset: number[] = [];
    let off = headLen;
    for (const pk of audio) { packetOffset.push(off); off += 2 + pk.length; }
    const n = bounds.length;
    const chunkStart = new Uint32Array(n);
    const chunkEnd = new Uint32Array(n);
    const rawStart = new Float64Array(n + 1);
    const cum = new Float64Array(audio.length + 1);
    for (let i = 0; i < audio.length; i++) cum[i + 1] = cum[i] + counts[i];
    for (let c = 0; c < n; c++) {
        const b = bounds[c];
        const nextLast = c + 1 < n ? bounds[c + 1] : audio.length - 1;
        chunkStart[c] = packetOffset[b];
        chunkEnd[c] = packetOffset[nextLast] + 2 + audio[nextLast].length;
        rawStart[c] = cum[b + 1];
    }
    rawStart[n] = cum[audio.length];

    const parts: Uint8Array[] = [prefix, suffix, id, comment, setup];
    for (const pk of audio) {
        parts.push(new Uint8Array([pk.length & 0xff, pk.length >> 8]));
        parts.push(pk);
    }
    const pcmBytes = new Uint8Array(virt.buffer, virt.byteOffset, virt.byteLength);
    const size = prefix.length + pcmBytes.length + suffix.length;
    const full = new Uint8Array(size);
    full.set(prefix, 0);
    full.set(pcmBytes, prefix.length);
    full.set(suffix, prefix.length + pcmBytes.length);
    const row: AudioMember["row"] = {
        uncompressedSize: size, compressedSize: off, crc32: crc32(full), codec: WGB_AUDIO_CODEC_VORBIS, channels: ch, bitsPerSample: 16,
        sampleRate: layout.sampleRate, totalFrames: layout.totalFrames, lead, prefixLen: prefix.length, suffixLen: suffix.length,
        idLen: id.length, commentLen: comment.length, setupLen: setup.length, chunkStart, chunkEnd, rawStart,
    };
    checkChunks(row, parts, full);
    return { parts, compressedSize: off, size, crc: row.crc32, row, pcm: full, snrDb: snrDb(data.subarray(layout.prefixLen, layout.suffixStart), pcmBytes) };
}

function checkChunks(row: AudioMember["row"], parts: Uint8Array[], full: Uint8Array): void {
    const member = new Uint8Array(row.compressedSize);
    let w = 0;
    for (const p of parts) { member.set(p, w); w += p.length; }
    const map: ZipAudioMap = { ...row, chunkStart: Uint32Array.from(row.chunkStart), chunkEnd: Uint32Array.from(row.chunkEnd), rawStart: Float64Array.from(row.rawStart) };
    const dec = new AudioMemberDecoder(map, member.subarray(0, row.chunkStart[0]));
    const ba = row.channels * 2;
    try {
        for (let c = 0; c < row.chunkStart.length; c++) {
            const pcm = dec.decodeChunk(c, member.subarray(row.chunkStart[c], row.chunkEnd[c]));
            const at = row.prefixLen + Math.max(0, row.rawStart[c] - row.lead) * ba;
            const want = full.subarray(at, at + pcm.length);
            if (want.length !== pcm.length || Buffer.compare(Buffer.from(want), Buffer.from(pcm)) !== 0) {
                throw new Error(`audio chunk ${c} decodes differently on its own`);
            }
        }
    } finally {
        dec.close();
    }
}

export function snrDb(a: Uint8Array, b: Uint8Array): number {
    const x = int16View(a);
    const y = int16View(b);
    let s = 0, n = 0;
    const len = Math.min(x.length, y.length);
    for (let i = 0; i < len; i++) { s += x[i] * x[i]; const e = x[i] - y[i]; n += e * e; }
    if (n === 0) return Infinity;
    if (s === 0) return -Infinity;
    return 10 * Math.log10(s / n);
}

function int16View(a: Uint8Array): Int16Array {
    const even = a.byteLength & ~1;
    if ((a.byteOffset & 1) === 0) return new Int16Array(a.buffer, a.byteOffset, even >> 1);
    return new Int16Array(a.slice(0, even).buffer);
}
