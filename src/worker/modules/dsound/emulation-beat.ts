import { LCTRL_EMULATION_BEAT, LISTENER_SLOTS } from '../../../audio/audio-ring-buffer';

// @transient(host liveness beat, restarted with the listener block)
let beatTimer: ReturnType<typeof setInterval> | null = null;

export const EMULATION_BEAT_PERIOD_MS = 40;

export function tickEmulationBeat(ctrl: Int32Array): void {
    const next = (Atomics.load(ctrl, LCTRL_EMULATION_BEAT) % 0x7ffffffe) + 1;
    Atomics.store(ctrl, LCTRL_EMULATION_BEAT, next);
}

export function startEmulationBeat(sab: SharedArrayBuffer): void {
    stopEmulationBeat();
    const ctrl = new Int32Array(sab, 0, LISTENER_SLOTS);
    tickEmulationBeat(ctrl);
    beatTimer = setInterval(() => tickEmulationBeat(ctrl), EMULATION_BEAT_PERIOD_MS);
}

export function stopEmulationBeat(): void {
    if (beatTimer === null) return;
    clearInterval(beatTimer);
    beatTimer = null;
}
