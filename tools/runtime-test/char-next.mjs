/**
 * CharNextA / CharNextW as WASM hypercalls (handler ids 46/47).
 *
 * The answers must be the JS thunks' (user32/system.ts): one unit on, the same pointer on
 * the terminator, NULL for NULL. A text loop that measures a buffer line by line calls
 * CharNextA once per character, which is why it is a hypercall at all.
 *
 * Requires V86_TEST_BINARY (a v86 build exporting get_char_next_abi).
 */
import { readFileSync } from 'node:fs';
import { createMachine, LEFT } from './bulk-machine.mjs';

const binaryPath = process.env.V86_TEST_BINARY;
if (!binaryPath) throw new Error('V86_TEST_BINARY is required');
const m = await createMachine(readFileSync(binaryPath), {});
m.paging();
if (typeof m.api.get_char_next_abi !== 'function' || m.api.get_char_next_abi() !== 1) {
    console.log('FAIL: engine does not export get_char_next_abi() == 1');
    process.exit(1);
}
const g = m.guest();
let failures = 0;
const expect = (label, got, want) => {
    if (got !== want) { failures++; console.log(`FAIL ${label}: got 0x${got.toString(16)}, want 0x${want.toString(16)}`); }
};
g.set([0x61, 0xfc, 0x00, 0x7a], LEFT);
expect('A on a letter', m.call('charNextA', LEFT, 0, 0) >>> 0, LEFT + 1);
expect('A on a high byte', m.call('charNextA', LEFT + 1, 0, 0) >>> 0, LEFT + 2);
expect('A on the terminator', m.call('charNextA', LEFT + 2, 0, 0) >>> 0, LEFT + 2);
expect('A on NULL', m.call('charNextA', 0, 0, 0) >>> 0, 0);
const W = LEFT + 4093;
g.set([0x41, 0x00, 0x00, 0x01, 0x00, 0x00], W);
expect('W on a unit across a page edge', m.call('charNextW', W, 0, 0) >>> 0, W + 2);
expect('W on a unit with a zero low byte', m.call('charNextW', W + 2, 0, 0) >>> 0, W + 4);
expect('W on the terminator', m.call('charNextW', W + 4, 0, 0) >>> 0, W + 4);
expect('W on NULL', m.call('charNextW', 0, 0, 0) >>> 0, 0);
m.close();
console.log(`char-next failures=${failures}`);
if (failures) process.exitCode = 1;
