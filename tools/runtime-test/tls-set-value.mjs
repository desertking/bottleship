/**
 * TlsSetValue as a WASM hypercall (handler 48) against TlsGetValue (handler 64).
 *
 * The value lands in the current TEB's TLS array, where TlsGetValue reads it; a slot the
 * allocation mask (hypercall page 0x0B8/0x0BC) does not carry, an index >= 64 and a page
 * without a TEB all decline to the JS thunk instead of answering.
 *
 * Requires V86_TEST_BINARY (a v86 build exporting get_tls_set_value_abi).
 */
import { readFileSync } from 'node:fs';
import { createMachine, LEFT } from './bulk-machine.mjs';

const binaryPath = process.env.V86_TEST_BINARY;
if (!binaryPath) throw new Error('V86_TEST_BINARY is required');
const m = await createMachine(readFileSync(binaryPath), {});
m.paging();
if (typeof m.api.get_tls_set_value_abi !== 'function' || m.api.get_tls_set_value_abi() !== 1) {
    console.log('FAIL: engine does not export get_tls_set_value_abi() == 1');
    process.exit(1);
}
const page = () => new DataView(m.cpu.wasm_memory.buffer, m.api.get_hypercall_page_ptr() >>> 0);
const g = () => new DataView(m.guest().buffer, m.guest().byteOffset);
const TEB = LEFT, ARRAY = LEFT + 0x1000;
let fallbacks = 0;
m.setFallback(() => { fallbacks++; });
let failures = 0;
const expect = (label, got, want) => {
    if (got !== want) { failures++; console.log(`FAIL ${label}: got ${got}, want ${want}`); }
};

g().setUint32(TEB + 0x2c, ARRAY, true);
page().setUint32(0x28, TEB, true);
page().setUint32(0xb8, (1 << 3) >>> 0, true);
page().setUint32(0xbc, (1 << 31) >>> 0, true);

expect('set slot 3 returns TRUE', m.call('tlsSetValue', 3, 0xdeadbeef, 0) >>> 0, 1);
expect('slot 3 in the TEB array', g().getUint32(ARRAY + 12, true), 0xdeadbeef);
expect('get slot 3', m.call('tlsGetValue', 3, 0, 0) >>> 0, 0xdeadbeef);
expect('set slot 63 returns TRUE', m.call('tlsSetValue', 63, 7, 0) >>> 0, 1);
expect('slot 63 in the TEB array', g().getUint32(ARRAY + 63 * 4, true), 7);
expect('no fallback for allocated slots', fallbacks, 0);

const before = fallbacks;
m.call('tlsSetValue', 4, 1, 0);
expect('unallocated slot 4 untouched', g().getUint32(ARRAY + 16, true), 0);
m.call('tlsSetValue', 64, 1, 0);
page().setUint32(0x28, 0, true);
m.call('tlsSetValue', 3, 5, 0);
expect('no TEB leaves slot 3', g().getUint32(ARRAY + 12, true), 0xdeadbeef);
expect('three declines reach the JS thunk', fallbacks - before, 3);
m.close();
console.log(`tls-set-value failures=${failures}`);
if (failures) process.exitCode = 1;
