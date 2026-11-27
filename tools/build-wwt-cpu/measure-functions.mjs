import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const [compiler, file, mode, entryText, windowText, flagsText] = process.argv.slice(2);
if (process.argv.length !== 8 || !['region', 'pe'].includes(mode)) {
    throw new Error('Usage: measure-functions.mjs COMPILER INPUT region|pe ENTRY WINDOW_BYTES FLAGS');
}
const raw = readFileSync(file);
const entry = Number(entryText);
const windowSize = Number(windowText);
const flags = Number(flagsText);
for (const value of [entry, windowSize, flags]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error('Entry, window size and flags must be uint32 values');
    }
}
if (mode === 'region' && !windowSize) throw new Error('A region needs a nonzero window size');
let data = raw;
if (mode === 'region' && raw.readUInt16LE() === 0x5a4d) {
    const pe = raw.readUInt32LE(60);
    const opt = pe + 24;
    if (raw.readUInt32LE(pe) !== 0x4550 || raw.readUInt16LE(opt) !== 0x10b) {
        throw new Error('Region extraction requires PE32');
    }
    const image = raw.readUInt32LE(opt + 28);
    const count = raw.readUInt16LE(pe + 6);
    let sec = opt + raw.readUInt16LE(pe + 20);
    for (let i = 0; i < count; i++, sec += 40) {
        const length = Math.min(raw.readUInt32LE(sec + 8), raw.readUInt32LE(sec + 16));
        const start = image + raw.readUInt32LE(sec + 12);
        const offset = raw.readUInt32LE(sec + 20);
        const executable = raw.readUInt32LE(sec + 36) & 0x20000000;
        if (executable && entry >= start && entry < start + length) {
            const firstByte = offset + entry - start;
            data = raw.subarray(firstByte, Math.min(firstByte + windowSize, offset + length));
            break;
        }
    }
    if (data === raw) throw new Error('Entry is outside file-backed executable PE32 sections');
} else if (mode === 'region') {
    data = raw.subarray(0, windowSize);
}
const phases = [];
const { exports: ex } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(compiler)),
    { bottleship: { pe_progress: (phase, done, total) => {
        if (phases.at(-1)?.phase !== phase || done === total) phases.push({phase, done, total, at: performance.now()});
    } } });
const src = ex.wwt_alloc(data.length);
const seed = ex.wwt_alloc(8);
new Uint8Array(ex.memory.buffer, src, data.length).set(data);
new DataView(ex.memory.buffer).setBigUint64(seed, BigInt(entry), true);
const start = performance.now();
const result = mode === 'pe' ? ex.wwt_translate_pe_with_progress(src, data.length, seed, entry ? 1 : 0, 1, flags)
    : ex.wwt_translate(src, data.length, BigInt(entry), seed, 1, 0, 0, 1, flags);
const compilerMs = performance.now() - start;
const length = new DataView(ex.memory.buffer).getUint32(result, true);
if (length === 0) throw new Error('WWT returned an empty module');
const bytes = new Uint8Array(ex.memory.buffer, result + 4, length).slice();
ex.wwt_free(result, length + 4);
ex.wwt_free(seed, 8);
ex.wwt_free(src, data.length);
let pos = 8;
function uleb() {
    let n = 0, shift = 0;
    while (pos < bytes.length) {
        const b = bytes[pos++];
        n += (b & 127) * 2 ** shift;
        if (!(b & 128)) return n;
        shift += 7;
    }
    throw new Error('truncated leb');
}
const bodies = [];
while (pos < bytes.length) {
    const id = bytes[pos++];
    const size = uleb();
    const end = pos + size;
    if (id === 10) {
        const count = uleb();
        for (let i = 0; i < count; i++) {
            const n = uleb();
            bodies.push(n);
            pos += n;
        }
    }
    pos = end;
}
const engineStart = performance.now();
let engineError, module;
try {
    module = new WebAssembly.Module(bytes);
} catch (err) {
    engineError = err.message;
}
const engineMs = performance.now() - engineStart;
const section = name => WebAssembly.Module.customSections(module, name)[0];
const entries = module && new DataView(section("wwt.funcs")).getUint32(0, true);
const traps = module && section("wwt.traps");
const trapPcs = new Set();
if (traps) {
    const view = new DataView(traps);
    for (let i = 4; i < view.byteLength; i += 16) trapPcs.add(view.getUint32(i + 4, true));
}
console.log(JSON.stringify({ mode, entry: entryText, input: data.length, flags, compilerMs, bytes: bytes.length,
    entries, bodies: bodies.length, codeBytes: bodies.reduce((sum, x) => sum + x, 0),
    bodiesOver1MiB: bodies.filter(n => n > 1 << 20).length,
    topBodies: bodies.sort((a,b) => b-a).slice(0, 5), engineMs, engineError,
    traps: traps ? (traps.byteLength - 4) / 16 : 0, uniqueTrapPcs: trapPcs.size,
    phases: phases.map(x => ({...x, at: x.at - start})) }));
