import { System } from '../core/system';
import { bootState } from './host';

type Counts = Record<string, number>;

function tally(items: Iterable<unknown>): Counts {
    const out: Counts = {};
    for (const item of items) {
        const name = (item as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof item;
        out[name] = (out[name] ?? 0) + 1;
    }
    return out;
}

export function savestateCensus(): Record<string, unknown> {
    const system = System.getInstance();
    const sched = system.scheduler as unknown as {
        threads: Map<number, { id: number; state: number; waitInfo: { reason: number; timeoutTimerId: number } | null; apcQueue: unknown[] }>;
        timerWheel: { captureState(): { entries: number[][] } };
    };
    const rp = system.resourceProvider as unknown as Record<string, { items?: unknown[] }>;
    const table = (name: string) => tally((rp[name]?.items ?? []).filter(x => x !== undefined));
    const process = system.process as unknown as { modules?: Map<string, unknown>; loadedModules?: unknown } | null;
    const timers: Counts = {};
    for (const [, , , kind] of sched.timerWheel.captureState().entries) timers[kind] = (timers[kind] ?? 0) + 1;
    return {
        boot: bootState(),
        executable: { path: system.executablePath, args: system.executableArgs, commandLine: system.executableCommandLine, cwd: (system.fileSystem as unknown as { currentDir?: string }).currentDir ?? null, env: system.process ? [...((system.process as unknown as { environment?: Map<string, string> }).environment ?? new Map())] : null },
        threads: [...sched.threads.values()].map(t => ({
            id: t.id, state: t.state, wait: t.waitInfo?.reason ?? null, timed: !!t.waitInfo?.timeoutTimerId, apcs: t.apcQueue.length,
        })),
        timersByKind: timers,
        com: table('comObjects'),
        comByIid: (() => {
            const out: Counts = {};
            for (const o of (rp['comObjects']?.items ?? [])) {
                if (!o) continue;
                const iid = (o as { iid?: string }).iid ?? '?';
                out[iid] = (out[iid] ?? 0) + 1;
            }
            return out;
        })(),
        kernelKinds: tally((rp['kernelObjects']?.items ?? []).filter(x => x !== undefined).map(o => (o as { kind?: string }).kind ?? '?') as unknown[]),
        userTypes: (rp['userObjects']?.items ?? []).filter(x => x !== undefined).map(o => (o as { type?: string }).type ?? '?'),
        gdi: table('gdiObjects'),
        kernel: table('kernelObjects'),
        user: table('userObjects'),
        files: table('fileHandles'),
        modules: process?.modules ? [...process.modules.keys()] : null,
        windows: (system.windowManager as unknown as { windows?: Map<number, unknown> }).windows?.size ?? null,
    };
}
