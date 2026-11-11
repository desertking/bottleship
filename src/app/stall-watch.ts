export interface StallWatchOptions {
    thresholdMs: number;
    continuousPresents: number;
    busyFraction: number;
    maxPresentStallMs: number;
}

export interface StallWatch {
    tick(now: number): void;
    pong(seq: number, presents: number, busyMs: number, now: number): void;
}

export const DEFAULT_STALL_WATCH: StallWatchOptions = {
    thresholdMs: 1000,
    continuousPresents: 10,
    busyFraction: 0.7,
    maxPresentStallMs: 60_000,
};

export function createStallWatch(
    ping: (seq: number) => void,
    onStalled: (stalled: boolean) => void,
    options: StallWatchOptions = DEFAULT_STALL_WATCH,
): StallWatch {
    let seq = 0;
    let pendingSeq = -1;
    let sentAt = 0;
    let stalled = false;
    let lastPresents = -1;
    let lastAdvanceAt = 0;
    let continuous = false;
    let stallBusyFrom: { at: number; busyMs: number } | null = null;
    let busyNow = false;
    const history: Array<{ at: number; presents: number }> = [];
    const set = (value: boolean) => {
        if (value === stalled) return;
        stalled = value;
        onStalled(value);
    };
    const presentStalled = (now: number) =>
        continuous && busyNow
        && now - lastAdvanceAt > options.thresholdMs
        && now - lastAdvanceAt < options.maxPresentStallMs;
    return {
        tick(now: number) {
            if (pendingSeq < 0) {
                pendingSeq = ++seq;
                sentAt = now;
                ping(pendingSeq);
            } else if (now - sentAt > options.thresholdMs) {
                set(true);
                return;
            }
            set(presentStalled(now));
        },
        pong(answered: number, presents: number, busyMs: number, now: number) {
            if (answered !== pendingSeq) return;
            pendingSeq = -1;
            if (presents < lastPresents) {
                history.length = 0;
                continuous = false;
            }
            history.push({ at: now, presents });
            while (now - history[0]!.at > 2 * options.thresholdMs) history.shift();
            if (presents !== lastPresents) {
                continuous = presents - history[0]!.presents >= options.continuousPresents;
                lastPresents = presents;
                lastAdvanceAt = now;
                stallBusyFrom = null;
                busyNow = false;
            } else if (!stallBusyFrom) {
                stallBusyFrom = { at: now, busyMs };
            } else if (now > stallBusyFrom.at) {
                busyNow = (busyMs - stallBusyFrom.busyMs) / (now - stallBusyFrom.at) >= options.busyFraction;
            }
            set(presentStalled(now));
        },
    };
}

const STALL_HINT_LABELS: Record<string, string> = { de: "Lädt …", en: "Loading…", es: "Cargando…" };

export function stallHintLabel(lang: string | null | undefined): string {
    const primary = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
    return STALL_HINT_LABELS[primary] ?? STALL_HINT_LABELS.en!;
}
