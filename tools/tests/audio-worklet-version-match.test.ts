import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "src", "audio");

function constant(file: string, name: string): number {
    const m = readFileSync(join(root, file), "utf8").match(new RegExp(`const ${name} = (\\d+);`));
    if (!m) throw new Error(`${name} not found in ${file}`);
    return Number(m[1]);
}

test("the worklet's handshake version is the one the engine expects", () => {
    expect(constant("bottleship-audio-worklet.ts", "WORKLET_MODULE_VERSION"))
        .toBe(constant("audio-engine.ts", "AUDIO_WORKLET_VERSION"));
});
