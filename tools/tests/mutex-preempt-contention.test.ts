import { afterEach, beforeEach, expect, test } from 'bun:test';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';
import { eventSlotForKernelHandle, packMutexMirrorWord } from '../../src/worker/core/cpu/hypercall-event-mirror';
import { SyncObjectManager } from '../../src/worker/core/scheduler/sync-objects';

const GUEST_BASE = 0x8000;
const MIRROR = 0x4000;
const HP_BASE = 0x1000;
const T_MAIN = 1;
const T_TIMER = 2;

const m: any = hypercallDataManager;
const saved: Record<string, unknown> = {};
let buffer: ArrayBuffer;

beforeEach(() => {
    for (const k of ['cpu', 'wasmMemory', 'view', 'hpBase', 'initialized', 'mutexMirrorAddr']) saved[k] = m[k];
    buffer = new ArrayBuffer(0x20000);
    m.cpu = { wasm_memory: { buffer }, mem8: new Uint8Array(buffer, GUEST_BASE) };
    m.wasmMemory = buffer;
    m.view = new DataView(buffer);
    m.hpBase = HP_BASE;
    m.initialized = true;
    m.mutexMirrorAddr = MIRROR;
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) m[k] = v;
});

function wasmWrite(handle: number, owner: number, rec: number): void {
    const slot = eventSlotForKernelHandle(handle)!;
    new Uint32Array(buffer)[(GUEST_BASE + MIRROR) / 4 + slot] = packMutexMirrorWord(owner, rec, true, false);
}

test('a mutex held across a preemption is routed through the kernel until its owner frees it', () => {
    const objs = new SyncObjectManager();
    const h = objs.createMutex(false, 0);
    wasmWrite(h, T_MAIN, 1);

    objs.markOwnedMutexesContended(T_MAIN);
    expect(hypercallDataManager.readMutexMirrorState(h)!.hasWaiters).toBe(true);
    expect(objs.foreignMutexOwner(h, T_TIMER)).toBe(T_MAIN);
    expect(objs.foreignMutexOwner(h, T_MAIN)).toBeNull();

    expect(objs.releaseMutex(h, T_MAIN)).toBe(true);
    expect(objs.takeContendedMark(h)).toBe(true);
    expect(objs.takeContendedMark(h)).toBe(false);
});

test('negative control: a preemption marks nothing the switched-out thread does not own', () => {
    const objs = new SyncObjectManager();
    const free = objs.createMutex(false, 0);
    const other = objs.createMutex(false, 0);
    wasmWrite(other, T_TIMER, 1);

    objs.markOwnedMutexesContended(T_MAIN);
    expect(hypercallDataManager.readMutexMirrorState(free)!.hasWaiters).toBe(false);
    expect(hypercallDataManager.readMutexMirrorState(other)!.hasWaiters).toBe(false);
    expect(objs.foreignMutexOwner(free, T_TIMER)).toBeNull();
});
