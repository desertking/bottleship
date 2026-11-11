// Builds the Granny skinning kernel into public/.
//
// One rustc invocation, no cargo workspace. Needs the wasm32-unknown-unknown
// target. The module imports its memory (the guest's), so the artifact must
// not carry anything that would write there on its own: no data segments and
// no globals (a shadow stack pointer is a global). The build fails otherwise.
//
// Usage: bun tools/build-granny-kernel/build.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outDir = `${root}public`;
mkdirSync(outDir, { recursive: true });
const output = `${outDir}/granny-kernel.wasm`;

execFileSync(
    "rustc",
    [
        "--edition=2021",
        "--crate-type=cdylib",
        "--target=wasm32-unknown-unknown",
        "-C", "opt-level=3",
        "-C", "panic=abort",
        "-C", "lto=fat",
        "-C", "codegen-units=1",
        "-C", "target-feature=+simd128",
        "-C", "strip=symbols",
        "-C", "link-arg=--import-memory",
        "-C", "link-arg=-zstack-size=0",
        `${root}tools/build-granny-kernel/lib.rs`,
        "-o", output,
    ],
    { stdio: "inherit" }
);

const bytes = readFileSync(output);
const sections = [];
for (let at = 8; at < bytes.length;) {
    const id = bytes[at++];
    let size = 0;
    for (let shift = 0; ; shift += 7) {
        const b = bytes[at++];
        size |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
    }
    sections.push(id);
    at += size;
}
for (const [id, name] of [[6, "global"], [11, "data"], [12, "data count"], [8, "start"]]) {
    if (sections.includes(id)) throw new Error(`granny kernel: unexpected ${name} section`);
}
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}:${i.kind}`);
if (imports.join() !== "env.memory:memory") throw new Error(`granny kernel: unexpected imports ${imports}`);
console.log(output, bytes.length, "bytes");
