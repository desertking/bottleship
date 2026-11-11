import type { FastPathImplementation, ThunkImplementation, X86Context } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";

export const GL_FAST_FUNCTIONS: ReadonlyArray<readonly [string, number]> = [
    ["glDrawElements", 4], ["glDrawArrays", 3], ["glDrawRangeElements", 6],
    ["glUnlockArraysEXT", 0], ["glLoadMatrixf", 1], ["glMultMatrixf", 1],
];

const NO_CONTEXT = {} as X86Context;

export function fastPathFromExport(name: string, impl: ThunkImplementation, argCount: number): FastPathImplementation {
    const args: number[] = new Array(argCount).fill(0);
    const end = 4 + argCount * 4;
    let warned = false;
    return (esp, view, mem8) => {
        if (esp + end > mem8.length) return null;
        for (let i = 0; i < argCount; i++) args[i] = view.getUint32(esp + 4 + i * 4, true);
        let result: unknown;
        try {
            result = impl(NO_CONTEXT, mem8, args);
        } catch (e) {
            if (!warned) {
                warned = true;
                Logger.warn(LogCategory.SYSTEM, `[GL fast] ${name} threw: ${e}`);
            }
            return 0;
        }
        return typeof result === "number" ? result : 0;
    };
}

export function registerFastPathGLFunctions(dispatcher: unknown, exports: Record<string, ThunkImplementation>): number {
    const d = dispatcher as { registerFastPath?: (dll: string, fn: string, impl: FastPathImplementation) => void };
    if (typeof d?.registerFastPath !== "function") return 0;
    if ((globalThis as { __noGlFastDraw?: boolean }).__noGlFastDraw) return 0;
    let n = 0;
    for (const [name, argCount] of GL_FAST_FUNCTIONS) {
        const impl = exports[name];
        if (typeof impl !== "function") continue;
        d.registerFastPath("opengl32", name, fastPathFromExport(name, impl, argCount));
        n++;
    }
    return n;
}
