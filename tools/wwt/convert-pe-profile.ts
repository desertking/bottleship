import { createHash } from "node:crypto";
import { readPeHeaders } from "@bottleship/formats/pe";
import { BlobSource, ZipArchive } from "@bottleship/formats/zip";

const PAGE_SIZE = 4096;
const MAX_PAGES = 4096;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROFILE_ENTRIES = 65536;
const MAX_AOT_IMAGE_BYTES = 32 * 1024 * 1024;
const FILE_HASH = /^[a-f0-9]{64}$/;
const EXECUTABLE = 0x20000000;

type Location = { imageHash: string; rva: number };
type Hint = { sha: string; entries: number[]; location?: Location };
type Match = Location & { executableRanges: { start: number; end: number }[] };
type PeProfile = Record<string, number[]>;

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function integerIn(value: unknown, max: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function isDigest(value: unknown): value is string {
    return typeof value === "string" && FILE_HASH.test(value);
}

function readHints(value: unknown): Hint[] {
    const document = value as { version?: unknown; pages?: unknown } | null;
    if (document?.version !== 1 || !Array.isArray(document.pages) || document.pages.length > MAX_PAGES) {
        throw new Error("expected a version 1 page hint document with at most 4096 pages");
    }
    return document.pages.map((row, index) => {
        if (!row || !isDigest(row.sha) ||
            (row.decode !== "flat32-user" && row.decode !== "flat32-supervisor") ||
            !Array.isArray(row.entries) || row.entries.length === 0 || row.entries.length > PAGE_SIZE ||
            !row.entries.every((offset: unknown) => integerIn(offset, PAGE_SIZE - 1))) {
            throw new Error(`invalid page hint at index ${index}`);
        }
        const { sha, entries } = row;
        if (row.kind === "phys" && integerIn(row.physPage, 0xfffff)) return { sha, entries };
        if (row.kind === "pe" && isDigest(row.imageHash) && integerIn(row.rva, 0xfffff000) && row.rva % PAGE_SIZE === 0) {
            return { sha, entries, location: { imageHash: row.imageHash, rva: row.rva } };
        }
        throw new Error(`invalid page location at index ${index}`);
    });
}

function indexPe(file: Uint8Array, wanted: ReadonlySet<string>, matches: Map<string, Match | null>): void {
    const pe = readPeHeaders(file);
    if (!pe || pe.is64 || pe.machine !== 0x14c || pe.sizeOfImage === 0 || pe.sizeOfImage > MAX_AOT_IMAGE_BYTES) return;
    const image = new Uint8Array(Math.ceil(pe.sizeOfImage / PAGE_SIZE) * PAGE_SIZE);
    const executableRanges = [];
    for (const section of pe.sections) {
        const start = section.virtualAddress;
        const end = Math.min(start + Math.max(section.virtualSize, section.rawSize), pe.sizeOfImage);
        if (end <= start) continue;
        const copySize = section.rawPointer === 0
            ? 0 : Math.min(end - start, section.rawSize, Math.max(0, file.length - section.rawPointer));
        image.set(file.subarray(section.rawPointer, section.rawPointer + copySize), start);
        image.fill(0, start + copySize, end);
        if (section.characteristics & EXECUTABLE) executableRanges.push({ start, end });
    }

    let imageHash: string | undefined;
    const visited = new Set<number>();
    for (const { start, end } of executableRanges) {
        for (let rva = Math.floor(start / PAGE_SIZE) * PAGE_SIZE; rva < end; rva += PAGE_SIZE) {
            if (visited.has(rva)) continue;
            visited.add(rva);
            const page = image.subarray(rva, rva + PAGE_SIZE);
            if (!page.some(byte => byte !== 0)) continue;
            const digest = sha256(page);
            if (!wanted.has(digest)) continue;
            imageHash ??= sha256(file);
            const previous = matches.get(digest);
            if (previous === undefined) {
                matches.set(digest, { imageHash, rva, executableRanges });
            } else if (previous && (previous.imageHash !== imageHash || previous.rva !== rva)) {
                matches.set(digest, null);
            }
        }
    }
}

export async function convertPeProfile(input: unknown, files: Iterable<Uint8Array> | AsyncIterable<Uint8Array> = []) {
    const hints = readHints(input);
    const wanted = new Set(hints.filter(hint => !hint.location).map(hint => hint.sha));
    const matches = new Map<string, Match | null>();
    if (wanted.size) {
        for await (const file of files) indexPe(file, wanted, matches);
    }

    let unmatched = 0;
    let ambiguous = 0;
    const byHash = new Map<string, Set<number>>();
    for (const hint of hints) {
        const match = hint.location ? undefined : matches.get(hint.sha);
        if (match === null) {
            ambiguous++;
            continue;
        }
        const location = hint.location ?? match;
        if (!location) {
            unmatched++;
            continue;
        }
        const { imageHash, rva } = location;
        const entries = byHash.get(imageHash) ?? new Set<number>();
        for (const offset of hint.entries) {
            const entry = rva + offset;
            if (!match || match.executableRanges.some(range => entry >= range.start && entry < range.end)) entries.add(entry);
        }
        if (entries.size > MAX_PROFILE_ENTRIES) {
            throw new Error(`profile for ${imageHash} exceeds ${MAX_PROFILE_ENTRIES} entries`);
        }
        if (entries.size) byHash.set(imageHash, entries);
    }

    const profile: PeProfile = Object.fromEntries([...byHash.keys()].sort().map(hash =>
        [hash, [...byHash.get(hash)!].sort((a, b) => a - b)],
    ));
    return { profile, unmatched, ambiguous };
}

async function* readFiles(paths: string[]): AsyncGenerator<Uint8Array> {
    for (const path of paths) {
        const file = Bun.file(path);
        if (!/\.wgb$/i.test(path)) {
            yield new Uint8Array(await file.arrayBuffer());
            continue;
        }
        if (!await file.exists()) throw new Error(`WGB file does not exist: ${path}`);
        const archive = new ZipArchive(new BlobSource(file));
        await archive.init();
        for (const entry of archive.listEntries()) {
            if (!entry.isDirectory && /\.(?:exe|dll|ocx|drv|ax|cpl|scr|asi)$/i.test(entry.name)) {
                yield await archive.readEntry(entry);
            }
        }
    }
}

const USAGE = "Usage: bun tools/wwt/convert-pe-profile.ts pages.v1.json [PE-or-WGB ...] > profile.json";

async function main([input, ...files]: string[]): Promise<void> {
    if (input === "--help") {
        console.log(USAGE);
        console.log("The JSON output is the value for globalThis.__wwtPeProfile. Supply matching PE files or WGBs for physical pages.");
        return;
    }
    if (!input) throw new Error(USAGE);
    const file = Bun.file(input);
    if (file.size > MAX_INPUT_BYTES) throw new Error("page hint document exceeds 4 MiB");
    const { profile, unmatched, ambiguous } = await convertPeProfile(await file.json(), readFiles(files));
    console.error(`Skipped ${unmatched} unmatched and ${ambiguous} ambiguous physical page hints.`);
    if (!Object.keys(profile).length) {
        throw new Error("no usable PE entries; physical pages need a unique page hash match in the supplied binaries");
    }
    console.log(JSON.stringify(profile));
}

if (import.meta.main) {
    await main(process.argv.slice(2)).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
