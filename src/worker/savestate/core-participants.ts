import { System } from '../core/system';
import { TimeService } from '../runtime/time';
import { hypercallDataManager, type HypercallState } from '../core/cpu/hypercall-data';
import { ThreadState } from '../core/scheduler/types';
import type { SchedulerState } from '../core/scheduler/scheduler';
import type { ResourceProviderState } from '../core/resources/system-resource-provider';
import type { MemoryManagerState } from '../core/process';
import type { ThunkGeneratorState } from '../core/thunking/thunk-generator';
import { captureKernel32Memory, restoreKernel32Memory, type Kernel32MemoryState } from '../modules/kernel32/memory';
import { savestateParticipants } from './participant';
import { captureUser32Shared, restoreUser32Shared, type User32SharedState } from '../modules/user32/shared-state';
import { captureUser32Classes, restoreUser32Classes, type User32ClassState } from '../modules/user32/class';
import { captureCpu, restoreCpu, type V86Cpu } from './participants/cpu';
import { objectCodecs, PLAIN_KERNEL_KINDS } from './object-codecs';
import { patchSnapshotWord, ramFixups } from './session';
import type { SaveValue } from './value-codec';

function v86Cpu(): V86Cpu {
    const v86 = System.getInstance().process?.v86 as { cpu?: V86Cpu; v86?: { cpu?: V86Cpu } } | undefined;
    const cpu = v86?.cpu ?? v86?.v86?.cpu;
    if (!cpu) throw new Error('savestate: no CPU');
    return cpu;
}

function process() {
    const p = System.getInstance().process;
    if (!p) throw new Error('savestate: no process');
    return p;
}

const as = <T>(v: SaveValue) => v as unknown as T;
const save = (v: unknown) => v as SaveValue;

function rewindRestartableParks(state: SchedulerState): void {
    const p = process();
    for (const park of p.dispatcher.restartableParks()) {
        const stub = p.thunkGenerator.getStubById(park.functionId);
        const thread = state.threads.find(t => t.id === park.threadId);
        if (!stub || !thread?.context) throw new Error(`savestate: cannot rewind thread ${park.threadId}`);
        thread.context = { ...thread.context, eip: stub.address, esp: park.esp };
        thread.state = ThreadState.READY;
        thread.waitInfo = null;
        if (!state.runQueue.includes(thread.id)) state.runQueue.push(thread.id);
        const r = park.returnAddr >>> 0;
        ramFixups.push(snap => {
            patchSnapshotWord(snap, park.esp, [r & 0xff, (r >>> 8) & 0xff, (r >>> 16) & 0xff, (r >>> 24) & 0xff]);
            patchSnapshotWord(snap, park.spinAddr, park.spinBytes);
        });
    }
}

export function registerCoreParticipants(): void {
    registerUser32Participants();
    objectCodecs.add<Record<string, SaveValue>>({
        tag: 'kernel-record',
        matches: (o): o is Record<string, SaveValue> => o !== null && typeof o === 'object'
            && Object.getPrototypeOf(o) === Object.prototype && PLAIN_KERNEL_KINDS.has(String((o as { kind?: unknown }).kind)),
        capture: (o) => ({ ...o }),
        restore: (d) => ({ ...(d as Record<string, SaveValue>) }),
    });

    savestateParticipants.add({
        id: 'time', version: 1, order: 1,
        capture: () => save(TimeService.getInstance().captureClock()),
        restore: (s) => TimeService.getInstance().restoreClock(as<{ nowMs: number }>(s)),
    });
    savestateParticipants.add({
        id: 'address-space', version: 1, order: 2,
        capture: () => save(process().addressSpace.captureState()),
        restore: (s) => process().addressSpace.restoreState(as(s)),
    });
    savestateParticipants.add({
        id: 'memory-manager', version: 1, order: 3,
        capture: () => save(process().memory.captureState()),
        restore: (s) => process().memory.restoreState(as<MemoryManagerState>(s)),
    });
    savestateParticipants.add({
        id: 'kernel32-memory', version: 1, order: 4,
        capture: () => save(captureKernel32Memory()),
        restore: (s) => restoreKernel32Memory(as<Kernel32MemoryState>(s)),
    });
    savestateParticipants.add({
        id: 'thunk-generator', version: 1, order: 5,
        capture: () => save(process().thunkGenerator.captureState()),
        restore: (s) => process().thunkGenerator.restoreState(as<ThunkGeneratorState>(s)),
    });
    savestateParticipants.add({
        id: 'resources', version: 1, order: 10,
        capture: (ctx) => save(System.getInstance().resourceProvider.captureState((o, w) => ctx.ref(o, w))),
        restore: (s, ctx) => System.getInstance().resourceProvider.restoreState(as<ResourceProviderState>(s), r => ctx.object(r)),
    });
    savestateParticipants.add({
        id: 'hypercall-page', version: 1, order: 11,
        capture: () => save(hypercallDataManager.captureState()),
        restore: (s) => hypercallDataManager.restoreState(as<HypercallState>(s)),
    });
    savestateParticipants.add({
        id: 'scheduler', version: 1, order: 20,
        capture: (ctx) => {
            const state = System.getInstance().scheduler.captureState((o, w) => ctx.ref(o, w));
            rewindRestartableParks(state);
            return save(state);
        },
        restore: (s, ctx) => System.getInstance().scheduler.restoreState(as<SchedulerState>(s), r => ctx.object(r)),
    });
    savestateParticipants.add({
        id: 'timer-wheel', version: 1, order: 21,
        capture: () => save(System.getInstance().scheduler.timerWheel.captureState()),
        restore: (s) => System.getInstance().scheduler.timerWheel.restoreState(as<{ nextId: number; entries: number[][] }>(s)),
    });
    savestateParticipants.add({
        id: 'dispatcher', version: 1, order: 90,
        capture: () => save(process().dispatcher.captureState()),
        restore: (s) => process().dispatcher.restoreState(as(s)),
    });
    savestateParticipants.add({
        id: 'cpu', version: 1, order: 99,
        capture: () => captureCpu(v86Cpu()),
        restore: (s) => restoreCpu(v86Cpu(), s),
    });
}

export function registerUser32Participants(): void {
    savestateParticipants.add({
        id: 'window-manager', version: 1, order: 30,
        capture: () => save(System.getInstance().windowManager.captureState()),
        restore: (s) => System.getInstance().windowManager.restoreState(as(s)),
    });
    savestateParticipants.add({
        id: 'user32-windows', version: 1, order: 31,
        capture: () => save(captureUser32Shared()),
        restore: (s) => restoreUser32Shared(as<User32SharedState>(s)),
    });
    savestateParticipants.add({
        id: 'user32-classes', version: 1, order: 32,
        capture: () => save(captureUser32Classes()),
        restore: (s) => restoreUser32Classes(as<User32ClassState>(s)),
    });
}
