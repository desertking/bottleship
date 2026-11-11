import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { preemptionManager } from "../../src/worker/core/cpu/preemption-manager";

function fakeExports() {
    const state: Record<string, number> = {};
    let clears = 0;
    const ex: Record<string, unknown> = {
        set_fpu_fld80_relaxed: (v: number) => { state.fpu_fld80_relaxed = v; },
        get_fpu_fld80_relaxed: () => state.fpu_fld80_relaxed ?? 0,
        set_jit_mmx_inline: (v: number) => { state.jit_mmx_inline = v; },
        get_jit_mmx_inline: () => state.jit_mmx_inline ?? 0,
        jit_clear_cache_js: () => { clears++; },
    };
    return { ex, state, clears: () => clears };
}

describe("deployment codegen switches", () => {
    let saved: unknown;
    beforeAll(() => { saved = (preemptionManager as any).wasmExports; });
    afterAll(() => { (preemptionManager as any).wasmExports = saved; preemptionManager.setDeploymentCodegenSwitches(undefined); });

    test("an override is applied, read back and drops the JIT cache", () => {
        const f = fakeExports();
        (preemptionManager as any).wasmExports = f.ex;
        preemptionManager.setDeploymentCodegenSwitches({ fpu_fld80_relaxed: 1 });
        expect(f.state.fpu_fld80_relaxed).toBe(1);
        expect(f.clears()).toBe(1);
        preemptionManager.setDeploymentCodegenSwitches(undefined);
    });

    test("names outside the jit_/fpu_ switch space are ignored", () => {
        const f = fakeExports();
        (preemptionManager as any).wasmExports = f.ex;
        preemptionManager.setDeploymentCodegenSwitches({ set_jit_config: 5, "jit_mmx_inline; x": 1, jit_mmx_inline: 1 } as any);
        expect(f.state.jit_mmx_inline).toBe(1);
        expect(Object.keys(f.state)).toEqual(["jit_mmx_inline"]);
        preemptionManager.setDeploymentCodegenSwitches(undefined);
    });

    test("no override leaves the engine untouched", () => {
        const f = fakeExports();
        (preemptionManager as any).wasmExports = f.ex;
        preemptionManager.setDeploymentCodegenSwitches({});
        expect(f.clears()).toBe(0);
        expect(Object.keys(f.state)).toEqual([]);
    });
});
