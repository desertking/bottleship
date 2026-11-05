import { System } from '../core/system';
import { TimeService } from '../runtime/time';
import { savestateParticipants } from './participant';
import { captureCpu, restoreCpu, type V86Cpu } from './participants/cpu';
import type { SaveValue } from './value-codec';

function v86Cpu(): V86Cpu {
    const v86 = System.getInstance().process?.v86 as { cpu?: V86Cpu; v86?: { cpu?: V86Cpu } } | undefined;
    const cpu = v86?.cpu ?? v86?.v86?.cpu;
    if (!cpu) throw new Error('savestate: no CPU');
    return cpu;
}

export function registerCoreParticipants(): void {
    savestateParticipants.add({
        id: 'time', version: 1,
        capture: () => TimeService.getInstance().captureClock() as unknown as SaveValue,
        restore: (s) => TimeService.getInstance().restoreClock(s as { nowMs: number }),
    });
    savestateParticipants.add({
        id: 'timer-wheel', version: 1,
        capture: () => System.getInstance().scheduler.timerWheel.captureState() as unknown as SaveValue,
        restore: (s) => System.getInstance().scheduler.timerWheel.restoreState(s as { nextId: number; entries: number[][] }),
    });
    savestateParticipants.add({
        id: 'cpu', version: 1,
        capture: () => captureCpu(v86Cpu()),
        restore: (s) => restoreCpu(v86Cpu(), s),
    });
}
