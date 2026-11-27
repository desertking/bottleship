import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readPeHeaders } from "../../packages/formats/src/pe";
import { PE_PROFILE_MAX_ENTRIES } from "../../src/worker/wwt/pe-profile";

const PAGE_SIZE = 4096;
const MAX_PAGES = 4096;
const MAX_HINT_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

type Range = { start: number; end: number };
type PageLocation = { digest: string; rva: number; ranges: Range[] };
type Profile = Record<string, number[]>;

export function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export function mapPeFile(file: Uint8Array) {
    const headers = readPeHeaders(file);
    if (!headers || headers.is64 || headers.machine !== 0x14c ||
        headers.sizeOfImage === 0 || headers.sizeOfImage > MAX_IMAGE_BYTES) {
        throw new Error("Expected an i386 PE image of at most 32 MiB");
    }
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const headerEnd = view.getUint32(headers.peOff + 24 + 60, true);
    if (headers.sections.length !== view.getUint16(headers.peOff + 6, true) ||
        headerEnd > Math.min(file.length, headers.sizeOfImage)) {
        throw new Error("Invalid PE headers");
    }
    const image = new Uint8Array(headers.sizeOfImage);
    image.set(file.subarray(0, headerEnd));
    const ranges: Range[] = [];
    for (const section of headers.sections) {
        const { virtualAddress: start, virtualSize, rawSize, rawPointer, characteristics } = section;
        const end = Math.min(image.length, start + Math.max(virtualSize, rawSize));
        if (rawPointer && rawSize) {
            if (rawPointer + rawSize > file.length || start + rawSize > image.length) {
                throw new Error("PE section data exceeds the file or image");
            }
            image.set(file.subarray(rawPointer, rawPointer + rawSize), start);
        }
        if (end > start && (characteristics & 0x20000000)) ranges.push({ start, end });
    }
    return { headers, image, ranges };
}

function indexPages(files: Iterable<Uint8Array>) {
    const modules = new Map<string, Map<number, { sha: string; location: PageLocation }>>();
    const bySha = new Map<string, PageLocation | null>();
    for (const file of files) {
        const digest = sha256(file);
        if (modules.has(digest)) continue;

        const { image, ranges } = mapPeFile(file);
        const pages = new Map<number, Range[]>();
        for (const range of ranges) {
            for (let rva = Math.floor(range.start / PAGE_SIZE) * PAGE_SIZE; rva < range.end; rva += PAGE_SIZE) {
                if (rva + PAGE_SIZE > image.length) break;
                const parts = pages.get(rva) ?? [];
                parts.push(range);
                pages.set(rva, parts);
            }
        }
        const index = new Map<number, { sha: string; location: PageLocation }>();
        modules.set(digest, index);
        for (const [rva, executable] of pages) {
            const bytes = image.subarray(rva, rva + PAGE_SIZE);
            const sha = sha256(bytes);
            const location = { digest, rva, ranges: executable };
            index.set(rva, { sha, location });
            if (bytes.some(byte => byte !== 0)) bySha.set(sha, bySha.has(sha) ? null : location);
        }
    }
    return { modules, bySha };
}

function isHash(value: unknown): value is string {
    return typeof value === "string" && SHA256.test(value);
}

function isIntIn(value: unknown, max: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

export function convertPagesToPeProfile(input: unknown, files: Iterable<Uint8Array>) {
    const document = input as { version?: unknown; pages?: unknown } | null;
    if (document?.version !== 1 || !Array.isArray(document.pages) || document.pages.length > MAX_PAGES) {
        throw new Error("Expected a pages.v1 document with at most 4096 rows");
    }

    const { modules, bySha } = indexPages(files);
    const seeds = new Map<string, Set<number>>();
    const stats = { rows: document.pages.length, matchedPe: 0, matchedPhysical: 0, unmatched: 0,
        ambiguous: 0, invalid: 0, outsideExecutable: 0, entries: 0 };
    for (const page of document.pages) {
        if (!isHash(page?.sha) || (page.decode !== "flat32-supervisor" && page.decode !== "flat32-user") ||
            !Array.isArray(page.entries) || page.entries.length === 0 || page.entries.length > PAGE_SIZE ||
            !page.entries.every((entry: unknown) => isIntIn(entry, PAGE_SIZE - 1))) {
            stats.invalid++;
            continue;
        }

        let location: PageLocation | null | undefined;
        if (page.kind === "pe" && isHash(page.imageHash) && isIntIn(page.rva, 0xfffff000) && page.rva % PAGE_SIZE === 0) {
            const match = modules.get(page.imageHash)?.get(page.rva);
            if (match?.sha === page.sha) location = match.location;
        } else if (page.kind === "phys" && isIntIn(page.physPage, 0xfffff)) {
            location = bySha.get(page.sha);
        } else {
            stats.invalid++;
            continue;
        }
        if (location === null) {
            stats.ambiguous++;
            continue;
        }
        if (!location) {
            stats.unmatched++;
            continue;
        }
        if (page.kind === "pe") stats.matchedPe++;
        else stats.matchedPhysical++;

        const entries = seeds.get(location.digest) ?? new Set<number>();
        seeds.set(location.digest, entries);
        for (const offset of page.entries) {
            const rva = location.rva + offset;
            if (location.ranges.some(range => range.start <= rva && rva < range.end)) entries.add(rva);
            else stats.outsideExecutable++;
        }
        if (entries.size > PE_PROFILE_MAX_ENTRIES) throw new Error(`Too many WWT entries for PE ${location.digest}`);
    }

    const profile: Profile = {};
    for (const digest of [...seeds.keys()].sort()) {
        const rvas = [...seeds.get(digest)!].sort((a, b) => a - b);
        if (!rvas.length) continue;
        profile[digest] = rvas;
        stats.entries += rvas.length;
    }
    return { profile, stats };
}

async function main([hintsPath, outputPath, ...pePaths]: string[]): Promise<void> {
    if (!hintsPath || !outputPath || !pePaths.length) {
        throw new Error("usage: bun tools/aot/wwt-pe-profile.ts PAGES.v1.json OUTPUT.json PE [PE ...]");
    }
    const hints = Bun.file(hintsPath);
    if (hints.size > MAX_HINT_BYTES) throw new Error("Page hints exceed 4 MiB");
    const { profile, stats } = convertPagesToPeProfile(await hints.json(), await Promise.all(pePaths.map(path => readFile(path))));
    await writeFile(outputPath, JSON.stringify(profile) + "\n");
    console.log(JSON.stringify(stats));
}

if (import.meta.main) {
    await main(process.argv.slice(2)).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
