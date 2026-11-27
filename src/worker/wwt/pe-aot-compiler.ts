import type { PeAotWork } from "./pe-aot-progress";

export interface PeAotCompileRequest {
    module: WebAssembly.Module;
    cacheId: string;
    file: Uint8Array<ArrayBuffer>;
    profile: number[];
    guestLimit: number;
}

export interface PeAotCompileUpdate {
    type: "compiling";
    startedAt: number;
    work?: PeAotWork;
}

export type PeAotCompileMessage =
    | PeAotCompileUpdate
    | { type: "done"; wasm: Uint8Array<ArrayBuffer> }
    | { type: "error"; error: string };

// A cold linked translation is optional. Keep a pathological PE from delaying
// guest entry indefinitely; demand translation remains available on ABI 11.
const COLD_COMPILE_BUDGET_MS = 30_000;

export class PeAotCompileTimeoutError extends Error {
    constructor(readonly budgetMs: number) {
        super(`Cold PE translation exceeded ${budgetMs} ms; using demand translation`);
    }
}

export interface PeAotCompileJob {
    result: Promise<Uint8Array<ArrayBuffer>>;
    timedOut: Promise<PeAotCompileTimeoutError>;
    cancel(): void;
}

export function startAbi11PeCompile(request: PeAotCompileRequest,
    onProgress?: (update: PeAotCompileUpdate) => void, budgetMs = COLD_COMPILE_BUDGET_MS): PeAotCompileJob {
    const worker = new Worker(new URL("./pe-aot-compiler.worker.ts", import.meta.url), { type: "module" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectJob!: (error: Error) => void;
    const timedOut = new Promise<PeAotCompileTimeoutError>(resolve => {
        timer = setTimeout(() => resolve(new PeAotCompileTimeoutError(budgetMs)), budgetMs);
    });
    const result = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        rejectJob = reject;
        worker.onmessage = (event: MessageEvent<PeAotCompileMessage>) => {
            const message = event.data;
            switch (message.type) {
                case "compiling": onProgress?.(message); break;
                case "done": resolve(message.wasm); break;
                case "error": reject(new Error(message.error)); break;
            }
        };
        worker.onerror = event => reject(new Error(event.message || "PE translation worker failed"));
        worker.onmessageerror = () => reject(new Error("Could not read PE translation worker result"));
        worker.postMessage(request);
    });
    const finish = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        worker.terminate();
    };
    result.then(finish, finish);
    return { result, timedOut, cancel: () => { finish(); rejectJob(new Error("WWT PE translation cancelled")); } };
}

export async function compileAbi11Pe(request: PeAotCompileRequest,
    onProgress?: (update: PeAotCompileUpdate) => void,
    onLateResult?: (wasm: Uint8Array<ArrayBuffer>) => void, budgetMs = COLD_COMPILE_BUDGET_MS): Promise<Uint8Array<ArrayBuffer>> {
    let foreground = true;
    const job = startAbi11PeCompile(request, update => {
        if (foreground) onProgress?.(update);
    }, budgetMs);
    const first = await Promise.race([job.result, job.timedOut]);
    foreground = false;
    if (first instanceof PeAotCompileTimeoutError) {
        if (onLateResult) job.result.then(onLateResult, () => undefined);
        else job.cancel();
        throw first;
    }
    return first;
}
