import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { convertPeProfile } from "../wwt/convert-pe-profile";
import { peProfileEntries } from "../../src/worker/wwt/pe-profile";

const page = new Uint8Array(4096);
page.set([0x31, 0xc0, 0xc3], 0x10);

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function peFile(executable = true): Uint8Array {
    const file = new Uint8Array(0x401);
    const v = new DataView(file.buffer);
    const pe = 0x80;
    const optional = pe + 24;
    const section = optional + 0xe0;
    v.setUint16(0, 0x5a4d, true);
    v.setUint32(0x3c, pe, true);
    v.setUint32(pe, 0x4550, true);
    v.setUint16(pe + 4, 0x14c, true);
    v.setUint16(pe + 6, 1, true);
    v.setUint16(pe + 20, 0xe0, true);
    v.setUint16(optional, 0x10b, true);
    v.setUint32(optional + 28, 0x400000, true);
    v.setUint32(optional + 56, 0x3000, true);
    v.setUint32(section + 8, 0x300, true);
    v.setUint32(section + 12, 0x2000, true);
    v.setUint32(section + 16, 0x200, true);
    v.setUint32(section + 20, 0x200, true);
    v.setUint32(section + 36, executable ? 0x60000020 : 0x40000040, true);
    file.set(page.subarray(0, 0x200), 0x200);
    return file;
}

const physical = {
    kind: "phys", physPage: 1234, sha: sha256(page), decode: "flat32-supervisor", entries: [0x12, 0x10, 0x10, 0x800],
};

test("converts a unique file-backed page to RVAs that the WWT consumer rebases", async () => {
    const file = peFile();
    const imageHash = sha256(file);
    const tagged = { ...physical, kind: "pe", imageHash, rva: 0x2000, entries: [0x12, 0x11] };
    const input = { version: 1, pages: [physical, tagged] };
    const { profile, unmatched, ambiguous } = await convertPeProfile(input, [file, file]);
    expect({ profile, unmatched, ambiguous }).toEqual({
        profile: { [imageHash]: [0x2010, 0x2011, 0x2012] }, unmatched: 0, ambiguous: 0,
    });

    const scope = globalThis as typeof globalThis & { __wwtPeProfile?: unknown };
    const original = Object.getOwnPropertyDescriptor(scope, "__wwtPeProfile");
    try {
        scope.__wwtPeProfile = JSON.parse(JSON.stringify(profile));
        expect(await peProfileEntries(imageHash, 0x700000, 0x3000)).toEqual([0x702010, 0x702011, 0x702012]);
    } finally {
        if (original) Object.defineProperty(scope, "__wwtPeProfile", original);
        else delete scope.__wwtPeProfile;
    }
});

test("keeps explicit PE metadata without a file and skips a bare physical page", async () => {
    const imageHash = "a".repeat(64);
    const tagged = { ...physical, kind: "pe", imageHash, rva: 0xfffff000, entries: [4095, 0, 4095] };
    expect(await convertPeProfile({ version: 1, pages: [physical, tagged] })).toEqual({
        profile: { [imageHash]: [0xfffff000, 0xffffffff] }, unmatched: 1, ambiguous: 0,
    });
});

test("leaves out non-executable, unknown, and ambiguous physical pages", async () => {
    const file = peFile();
    const other = file.slice();
    other[other.length - 1] = 1;
    const absent = { ...physical, sha: "f".repeat(64) };
    expect(await convertPeProfile({ version: 1, pages: [physical, absent] }, [file, other])).toEqual({
        profile: {}, unmatched: 1, ambiguous: 1,
    });
    expect(await convertPeProfile({ version: 1, pages: [physical] }, [peFile(false)])).toEqual({
        profile: {}, unmatched: 1, ambiguous: 0,
    });
});

test("rejects an unsupported schema and invalid page offsets", async () => {
    await expect(convertPeProfile({ version: 2, pages: [] })).rejects.toThrow("version 1");
    await expect(convertPeProfile({ version: 1, pages: [{ ...physical, entries: [4096] }] })).rejects.toThrow("index 0");
});

test("rejects profiles that exceed the WWT consumer limit", async () => {
    const rows = Array.from({ length: 17 }, (_, index) => ({
        ...physical,
        kind: "pe",
        imageHash: "a".repeat(64),
        rva: index * 4096,
        entries: Array.from({ length: 4096 }, (_, offset) => offset),
    }));
    await expect(convertPeProfile({ version: 1, pages: rows })).rejects.toThrow("65536 entries");
});
