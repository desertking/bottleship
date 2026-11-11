import { describe, expect, test } from 'bun:test';
import { ShadowHookRuntime } from '../../src/worker/core/hle-lib/shadow-validator';
import { libHleManager } from '../../src/worker/core/hle-lib/lib-hle-manager';
import type { ShadowSpec } from '../../src/worker/core/hle-lib/types';

const ESP = 0x1000;

function setup(spec: Partial<ShadowSpec>) {
    const buf = new ArrayBuffer(0x4000);
    const mem8 = new Uint8Array(buf);
    const mem32 = new Uint32Array(buf);
    const dv = new DataView(buf);
    mem32[ESP >> 2] = 0xdeadbeef;
    mem32[(ESP >> 2) + 1] = 0x2000;
    mem32[(ESP >> 2) + 2] = 7;
    const full: ShadowSpec = {
        ranges: () => [],
        kernel: (view, args) => { view.writeU32(args[0], args[1] * 3); return args[1] + 1; },
        ...spec,
    } as ShadowSpec;
    const rt = new ShadowHookRuntime('lib', 'fn', full, () => { });
    const key = 'lib|mod|fn';
    const impl = (libHleManager as any).buildShadowFastPath(rt, full, 2, 'lib', 'fn', 'mod', 0x401000, key);
    const call = (esp = ESP) => impl(esp, dv, mem8, mem32, null);
    return { rt, call, mem32 };
}

describe('HLE shadow fast path', () => {
    test('runs the kernel with stack args and returns EAX', () => {
        const { call, mem32 } = setup({});
        expect(call()).toBe(8);
        expect(mem32[0x2000 >> 2]).toBe(21);
    });

    test('counts hits into the report bookkeeping on flush', () => {
        const { call } = setup({});
        call(); call(); call();
        (libHleManager as any).flushFastHits();
        expect((libHleManager as any).hits.get('lib').get('fn')).toBe(3);
        (libHleManager as any).resetOnGameSwitch();
    });

    test('declines to the slow path when the guard rejects', () => {
        const { call, mem32 } = setup({ guard: () => false });
        expect(call()).toBeNull();
        expect(mem32[0x2000 >> 2]).toBe(0);
    });

    test('declines when the guard or the kernel throws', () => {
        expect(setup({ guard: () => { throw new Error('x'); } }).call()).toBeNull();
        expect(setup({ kernel: () => { throw new Error('x'); } }).call()).toBeNull();
    });

    test('declines while in-game validation is still shadowing', () => {
        const { rt, call } = setup({ validateInGame: true });
        expect(call()).toBeNull();
        rt.state = 'active';
        expect(call()).toBe(8);
    });

    test('declines once the hook is disabled', () => {
        const { rt, call } = setup({});
        rt.state = 'disabled';
        expect(call()).toBeNull();
    });

    test('declines on a misaligned or out-of-range stack', () => {
        const { call } = setup({});
        expect(call(ESP + 1)).toBeNull();
        expect(call(0x3ffc)).toBeNull();
    });
});
