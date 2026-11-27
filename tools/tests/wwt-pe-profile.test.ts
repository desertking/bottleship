import { expect, test } from "bun:test";
import { convertPagesToPeProfile, sha256 } from "../aot/wwt-pe-profile";
import { peProfileEntries } from "../../src/worker/wwt/pe-profile";

function makePe(overlay: number, duplicatePage = false) {
    const bytes = new Uint8Array(0x2201);
    const view = new DataView(bytes.buffer);
    const pe = 0x80;
    const optional = pe + 24;
    const section = optional + 224;
    const u16 = (at: number, value: number) => view.setUint16(at, value, true);
    const u32 = (at: number, value: number) => view.setUint32(at, value, true);
    u16(0, 0x5a4d);
    u32(0x3c, pe);
    u32(pe, 0x4550);
    u16(pe + 4, 0x14c);
    u16(pe + 6, 2);
    u16(pe + 20, 224);
    u16(optional, 0x10b);
    u32(optional + 28, 0x400000);
    u32(optional + 56, 0x4000);
    u32(optional + 60, 0x200);

    u32(section + 8, 0x1000);
    u32(section + 12, 0x1000);
    u32(section + 16, 0x1000);
    u32(section + 20, 0x200);
    u32(section + 36, 0x60000020);
    u32(section + 40 + 8, 0x800);
    u32(section + 40 + 12, 0x2000);
    u32(section + 40 + 16, 0x800);
    u32(section + 40 + 20, 0x1200);
    u32(section + 40 + 36, duplicatePage ? 0x60000020 : 0x40000040);
    bytes[0x200] = 0xc3;
    bytes[0x1200] = duplicatePage ? 0xc3 : 0x90;
    bytes[0x2200] = overlay;
    return bytes;
}

const decode = "flat32-supervisor";

test("converts hash-verified PE and physical pages to canonical WWT RVAs", async () => {
    const file = makePe(1);
    const imageHash = sha256(file);
    const sha = sha256(file.subarray(0x200, 0x1200));
    const dataSha = sha256(file.subarray(0x1200, 0x2200));
    const physical = { kind: "phys", physPage: 0x12345, sha, decode, entries: [42, 2, 42] };
    const pe = { kind: "pe", imageHash, rva: 0x1000, sha, decode, entries: [10, 2] };

    const { profile, stats } = convertPagesToPeProfile({ version: 1, pages: [
        physical,
        pe,
        { ...pe, sha: dataSha },
        { ...pe, imageHash: sha256(makePe(2)) },
        { ...physical, sha: dataSha },
        { ...physical, entries: [4096] },
        { ...pe, rva: 0x1001 },
    ] }, [file, file]);
    expect(profile).toEqual({ [imageHash]: [0x1002, 0x100a, 0x102a] });
    expect(stats).toMatchObject({ matchedPhysical: 1, matchedPe: 1, unmatched: 3, invalid: 2, entries: 3 });

    const globals = globalThis as typeof globalThis & { __wwtPeProfile?: Record<string, number[]> };
    const previous = globals.__wwtPeProfile;
    try {
        globals.__wwtPeProfile = JSON.parse(JSON.stringify(profile));
        expect(await peProfileEntries(imageHash, 0x700000, 0x4000)).toEqual([0x701002, 0x70100a, 0x70102a]);
        expect(await peProfileEntries(sha256(makePe(2)), 0x700000, 0x4000)).toEqual([]);
    } finally {
        if (previous === undefined) delete globals.__wwtPeProfile;
        else globals.__wwtPeProfile = previous;
    }
});

test("rejects ambiguous physical matches and filters entries past executable bounds", () => {
    const file = makePe(1, true);
    const imageHash = sha256(file);
    const sha = sha256(file.subarray(0x200, 0x1200));
    const { profile, stats } = convertPagesToPeProfile({ version: 1, pages: [
        { kind: "phys", physPage: 7, sha, decode, entries: [2] },
        { kind: "pe", imageHash, rva: 0x2000, sha, decode, entries: [2, 0x800] },
    ] }, [file]);
    expect(profile).toEqual({ [imageHash]: [0x2002] });
    expect(stats).toMatchObject({ ambiguous: 1, outsideExecutable: 1, entries: 1 });
});

test("rejects invalid documents and incomplete PE data", () => {
    expect(() => convertPagesToPeProfile({ version: 2, pages: [] }, [])).toThrow("pages.v1");
    expect(() => convertPagesToPeProfile({ version: 1, pages: [] }, [makePe(1).slice(0, 0x1300)]))
        .toThrow("PE section data");
});
