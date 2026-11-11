export interface OggPacketStream {
    packets: Uint8Array[];
    pageOfPacket: number[];
    pageGranules: number[];
}

export function splitOggPackets(data: Uint8Array): OggPacketStream {
    const packets: Uint8Array[] = [];
    const pageOfPacket: number[] = [];
    const pageGranules: number[] = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pending: Uint8Array[] = [];
    let serial: number | null = null;
    let p = 0;
    let page = 0;
    while (p < data.length) {
        if (p + 27 > data.length || view.getUint32(p, true) !== 0x5367674f) throw new Error(`ogg: no page at ${p}`);
        if (data[p + 4] !== 0) throw new Error(`ogg: page version ${data[p + 4]} at ${p}`);
        const flags = data[p + 5];
        const granule = Number(view.getBigInt64(p + 6, true));
        const s = view.getUint32(p + 14, true);
        if (serial === null) serial = s;
        else if (s !== serial) throw new Error("ogg: more than one logical stream");
        const segs = data[p + 26];
        if (p + 27 + segs > data.length) throw new Error("ogg: truncated segment table");
        let body = p + 27 + segs;
        if (!(flags & 1) && pending.length) throw new Error(`ogg: packet not continued on page ${page}`);
        if ((flags & 1) && !pending.length) throw new Error(`ogg: continuation without a packet on page ${page}`);
        let start = body;
        for (let i = 0; i < segs; i++) {
            const len = data[p + 27 + i];
            body += len;
            if (body > data.length) throw new Error("ogg: truncated page body");
            if (len < 255) {
                pending.push(data.subarray(start, body));
                packets.push(concat(pending));
                pageOfPacket.push(page);
                pending = [];
                start = body;
            }
        }
        if (start < body) pending.push(data.subarray(start, body));
        pageGranules.push(granule);
        p = body;
        page++;
    }
    if (pending.length) throw new Error("ogg: stream ends inside a packet");
    return { packets, pageOfPacket, pageGranules };
}

function concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0].slice();
    let n = 0;
    for (const q of parts) n += q.length;
    const out = new Uint8Array(n);
    let w = 0;
    for (const q of parts) { out.set(q, w); w += q.length; }
    return out;
}
