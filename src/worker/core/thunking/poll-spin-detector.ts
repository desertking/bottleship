import { TARGET_INSN_PER_MS } from '../scheduler/timing';

export const POLL_SPIN_MAX_GAP_INSNS = TARGET_INSN_PER_MS / 50;
export const POLL_SPIN_STREAK = 256;

export const PollKind = { None: 0, VirtualClock: 1, WallClock: 2, Neutral: 3 } as const;
export type PollKind = typeof PollKind[keyof typeof PollKind];

export class PollSpinDetector {
    private streak = 0;
    private lastInsn = 0;

    other(): void {
        this.streak = 0;
    }

    poll(insnNow: number): boolean {
        const gap = (insnNow - this.lastInsn) >>> 0;
        this.lastInsn = insnNow;
        if (gap > POLL_SPIN_MAX_GAP_INSNS) {
            this.streak = 1;
            return false;
        }
        if (++this.streak < POLL_SPIN_STREAK) return false;
        this.streak = 0;
        return true;
    }
}
