export interface SynthWav {
    bytes: Uint8Array;
    pcmStart: number;
    pcmEnd: number;
}

export function synthWav(channels: number, sampleRate: number, frames: number, trailer: Uint8Array | null, seed: number): SynthWav {
    const pcm = new Int16Array(frames * channels);
    let s = seed >>> 0;
    const noise = () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return (s / 4294967296) * 2 - 1;
    };
    for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        const click = i % 4410 < 40 ? 0.5 * (1 - (i % 4410) / 40) : 0;
        for (let c = 0; c < channels; c++) {
            const f = 220 * (c + 1) + 30 * Math.sin(2 * Math.PI * 0.5 * t);
            const v = 0.3 * Math.sin(2 * Math.PI * f * t) + 0.15 * Math.sin(2 * Math.PI * 1.5 * f * t) + 0.02 * noise() + click * (c ? -1 : 1);
            pcm[i * channels + c] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        }
    }
    const data = new Uint8Array(pcm.buffer);
    const tail = trailer ?? new Uint8Array(0);
    const out = new Uint8Array(44 + data.length + tail.length);
    const v = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0);
    v.setUint32(4, out.length - 8, true);
    out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * channels * 2, true);
    v.setUint16(32, channels * 2, true);
    v.setUint16(34, 16, true);
    out.set([0x64, 0x61, 0x74, 0x61], 36);
    v.setUint32(40, data.length, true);
    out.set(data, 44);
    out.set(tail, 44 + data.length);
    return { bytes: out, pcmStart: 44, pcmEnd: 44 + data.length };
}

export function listChunk(text: string): Uint8Array {
    const body = new TextEncoder().encode("INFOICMT" + "\0\0\0\0" + text);
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    out.set([0x4c, 0x49, 0x53, 0x54], 0);
    new DataView(out.buffer).setUint32(4, body.length, true);
    new DataView(out.buffer).setUint32(8 + 8, text.length, true);
    out.set(body, 8);
    return out;
}

export const MUSIC = () => synthWav(2, 22050, 37_000, null, 1);
export const VOICE = () => synthWav(1, 11025, 15_001, listChunk("fixture trailer"), 2);
