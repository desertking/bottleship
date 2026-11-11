/**
 * Strings longer than 1 MiB through the CRT string hypercalls.
 *
 * The CRT scans to the terminator whatever the length. A handler that stops counting at
 * some cap answers a short strlen, and every caller that sizes a buffer or validates a
 * length from it goes wrong: The Fall joins a 1,739,453-byte Base64 field, strlen answered
 * 1,048,577, the decoder saw a length that is not a multiple of four and returned NULL.
 *
 * Both arms run (SIMD kernels on and off) and every answer is checked against the exact
 * value, not only against the other arm.
 *
 * Requires V86_TEST_BINARY (a v86 build carrying the kernels).
 */
import { readFileSync } from 'node:fs';
import { createMachine, LEFT, RIGHT } from './bulk-machine.mjs';

const binaryPath = process.env.V86_TEST_BINARY;
if (!binaryPath) throw new Error(
    'V86_TEST_BINARY is required — point it at vendor/v86/build/wasm32-unknown-unknown/release/v86.wasm');
const binary = readFileSync(binaryPath);

const LENGTHS = [0x100000 - 1, 0x100000, 0x100001, 0x100002, 1739453];

function fill(g, at, length, wide, seed) {
    const stride = wide ? 2 : 1;
    for (let i = 0; i < length; i++) {
        g[at + i * stride] = 0x41 + ((i * 7 + seed) % 26);
        if (wide) g[at + i * stride + 1] = 0;
    }
    g[at + length * stride] = 0;
    if (wide) g[at + length * stride + 1] = 0;
}

let failures = 0;
const expect = (label, got, want) => {
    if (got !== want) {
        failures++;
        console.log(`FAIL ${label}: got ${got}, want ${want}`);
    }
};

for (const kernels of [true, false]) {
    const m = await createMachine(binary, {});
    m.paging();
    m.api.set_string_memory_enabled(kernels ? 1 : 0);
    const g = m.guest();
    const arm = kernels ? 'kernels' : 'scalar';
    for (const length of LENGTHS) {
        for (const wide of [0, 1]) {
            const stride = wide ? 2 : 1;
            const pre = wide ? 'wcs' : 'str';
            g.fill(0xcd, LEFT, RIGHT);
            g.fill(0xcd, RIGHT, RIGHT + (length + 2) * stride + 16);
            fill(g, LEFT, length, wide, 1);
            expect(`${arm} ${pre}len ${length}`, m.call(`${pre}len`, LEFT, 0, 0) >>> 0, length);

            m.call(`${pre}cpy`, RIGHT, LEFT, 0);
            let same = true;
            for (let i = 0; i < (length + 1) * stride; i++) {
                if (g[RIGHT + i] !== g[LEFT + i]) { same = false; break; }
            }
            expect(`${arm} ${pre}cpy ${length} copies through the terminator`, same, true);
            expect(`${arm} ${pre}cpy ${length} leaves the byte after`, g[RIGHT + (length + 1) * stride], 0xcd);

            const cmp = wide ? 'wcsicmp' : 'strcmp';
            expect(`${arm} ${cmp} ${length} equal`, m.call(cmp, LEFT, RIGHT, 0) | 0, 0);
            if (length) {
                g[RIGHT + (length - 1) * stride] = 0x7e;
                expect(`${arm} ${cmp} ${length} last unit differs`, Math.sign(m.call(cmp, LEFT, RIGHT, 0) | 0), -1);
            }
        }
    }
    m.close();
}

console.log(`lengths=${LENGTHS.join(',')} failures=${failures}`);
if (failures) process.exitCode = 1;
