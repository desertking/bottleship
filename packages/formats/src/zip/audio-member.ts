import { VorbisPacketDecoder } from "../audio/vorbis-decoder";
import { audioBlockAlign, audioChunkAt, audioChunkRange, audioHeadBytes, type ZipAudioMap } from "./audio-index";

export interface AudioPlan {
    from: number;
    to: number;
    pcmStart: number;
    pcmEnd: number;
    first: number;
    last: number;
    needsHead: boolean;
}

export function planAudio(map: ZipAudioMap, size: number, offset: number, length: number): AudioPlan | null {
    if (length <= 0 || offset >= size) return null;
    const from = Math.max(0, offset);
    const to = Math.min(size, from + length);
    if (from >= to) return null;
    const ba = audioBlockAlign(map);
    const pcmStart = map.prefixLen;
    const pcmEnd = pcmStart + map.totalFrames * ba;
    let first = -1, last = -2;
    if (to > pcmStart && from < pcmEnd && map.totalFrames > 0) {
        first = audioChunkAt(map, Math.floor((Math.max(from, pcmStart) - pcmStart) / ba));
        last = audioChunkAt(map, Math.floor((Math.min(to, pcmEnd) - 1 - pcmStart) / ba));
    }
    return { from, to, pcmStart, pcmEnd, first, last, needsHead: from < pcmStart || to > pcmEnd };
}

export class AudioMemberDecoder {
    private readonly decoder: VorbisPacketDecoder;

    constructor(readonly map: ZipAudioMap, readonly head: Uint8Array) {
        if (head.length < audioHeadBytes(map)) throw new Error("audio member: short head");
        let p = map.prefixLen + map.suffixLen;
        const id = head.subarray(p, p += map.idLen);
        const comment = head.subarray(p, p += map.commentLen);
        const setup = head.subarray(p, p + map.setupLen);
        this.decoder = new VorbisPacketDecoder(id, comment, setup);
        if (this.decoder.channels !== map.channels) {
            this.decoder.close();
            throw new Error(`audio member: stream has ${this.decoder.channels} channels, index says ${map.channels}`);
        }
    }

    prefix(): Uint8Array {
        return this.head.subarray(0, this.map.prefixLen);
    }

    suffix(): Uint8Array {
        return this.head.subarray(this.map.prefixLen, this.map.prefixLen + this.map.suffixLen);
    }

    decodeChunk(c: number, bytes: Uint8Array): Uint8Array {
        const map = this.map;
        const rawFrames = map.rawStart[c + 1] - map.rawStart[c];
        const ch = map.channels;
        const pcm = new Int16Array(rawFrames * ch + 8192 * ch);
        const dec = this.decoder;
        dec.reset();
        let p = 0, frames = 0, packets = 0;
        while (p < bytes.length) {
            if (p + 2 > bytes.length) throw new Error(`audio chunk ${c}: truncated packet length`);
            const len = bytes[p] | (bytes[p + 1] << 8);
            p += 2;
            if (p + len > bytes.length) throw new Error(`audio chunk ${c}: truncated packet`);
            const got = dec.decodeInto(bytes.subarray(p, p + len), pcm, frames);
            if (packets === 0 && got !== 0) throw new Error(`audio chunk ${c}: preroll packet produced ${got} frames`);
            frames += got;
            packets++;
            p += len;
            if (frames > rawFrames) throw new Error(`audio chunk ${c}: ${frames} frames, expected ${rawFrames}`);
        }
        if (frames !== rawFrames) throw new Error(`audio chunk ${c}: ${frames} frames, expected ${rawFrames}`);
        const { first, last } = audioChunkRange(map, c);
        const skip = first - (map.rawStart[c] - map.lead);
        const bytesOut = new Uint8Array(pcm.buffer, (skip * ch) * 2, (last - first) * ch * 2);
        return bytesOut.slice();
    }

    close(): void {
        this.decoder.close();
    }
}
